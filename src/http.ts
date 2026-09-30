/**
 * Streamable HTTP transport for qobrix-crm-mcp.
 *
 * api_key: Authorization Bearer user:key, or X-Api-User / X-Api-Key.
 * oauth_user: RFC 9728 PRM, 401 WWW-Authenticate, Bearer introspection on /mcp.
 * Signed-header session vaults stay behind QOBRIX_MCP_XCHAT_LEGACY.
 */

import { randomUUID } from "node:crypto";
import type { Request, Response } from "express";
import rateLimit from "express-rate-limit";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { OAuthTokenVerifier } from "@modelcontextprotocol/sdk/server/auth/provider.js";
import { createServer } from "./server.js";
import { disableEnvFallback } from "./client.js";
import { runWithAuthAsync, type AuthCredentials } from "./auth-context.js";
import {
  resolveAuthMode,
  acceptedAuthTypes,
  isAutoHttpMode,
  MCP_PATH,
  resolveAuthModeFromRequest,
  noteXchatRequest,
  xchatLegacyEnabled,
  xchatRequestCount,
  warnDeprecatedAuthEnv,
} from "./auth-types.js";
import type { AuthMode } from "./auth-types.js";
import {
  buildProtectedResourceMetadata,
  createCompanionTokenVerifier,
  credentialsFromAuthInfo,
  fetchAuthorizationServerMetadata,
  requireOAuthEnv,
  wwwAuthenticateChallenge,
} from "./oauth-rs.js";
import { runWithRequestContext } from "./request-context.js";
import {
  authorizeRedirect,
  connectCookieName,
  countSessionVaults,
  ensureClientRegistered,
  getSessionCredentials,
  handleCallback,
  refreshIfNeeded,
  signCookie,
} from "./oauth-client.js";
import {
  resolveVaultKeyFromHeaders,
  vaultKeyAuditHash,
} from "./identity.js";
import { errorHtml, langFromHeader, successHtml } from "./auth-pages.js";

function modeCEnabled(autoMode: boolean, authMode: AuthMode): boolean {
  return autoMode || authMode === "oauth";
}

function modeDEnabled(autoMode: boolean, authMode: AuthMode): boolean {
  return autoMode || authMode === "oauth_user";
}

function readHeaderCreds(req: Request): AuthCredentials | null {
  const apiUrl = String(req.headers["x-qobrix-api-url"] || "").trim() || undefined;
  const locale = String(req.headers["x-locale"] || "").trim() || undefined;
  const auth = String(req.headers.authorization || "");
  if (auth.toLowerCase().startsWith("bearer ")) {
    const token = auth.slice("bearer ".length).trim();
    const split = token.indexOf(":");
    if (split > 0) {
      return { apiUser: token.slice(0, split), apiKey: token.slice(split + 1), apiUrl, locale };
    }
  }
  const apiUser = String(req.headers["x-api-user"] || "").trim();
  const apiKey = String(req.headers["x-api-key"] || "").trim();
  if (!apiUser || !apiKey) return null;
  return { apiUser, apiKey, apiUrl, locale };
}

function isLoopbackHost(host: string): boolean {
  return host === "127.0.0.1" || host === "localhost" || host === "::1";
}

/**
 * Host header allowlist for createMcpExpressApp.
 * When the server binds to loopback (typical for ragchat → 127.0.0.1:3502),
 * always include loopback Host values even if ALLOWED_HOSTS only lists the
 * public hostname used behind a reverse proxy.
 */
function resolveAllowedHosts(bindHost: string): string[] | undefined {
  const fromEnv = process.env.QOBRIX_MCP_ALLOWED_HOSTS
    ? process.env.QOBRIX_MCP_ALLOWED_HOSTS.split(",")
        .map((s) => s.trim())
        .filter(Boolean)
    : [];
  if (!fromEnv.length) return undefined;
  if (!isLoopbackHost(bindHost)) return fromEnv;
  const loopback = ["127.0.0.1", "localhost", "::1"];
  return [...new Set([...fromEnv, ...loopback])];
}

export async function startHttpServer(): Promise<void> {
  const port = Number(process.env.QOBRIX_MCP_PORT || 3502);
  const host = process.env.QOBRIX_MCP_HOST || "127.0.0.1";
  warnDeprecatedAuthEnv();
  const authMode = resolveAuthMode("http");
  const autoMode = isAutoHttpMode();

  const app = createMcpExpressApp({
    host,
    allowedHosts: resolveAllowedHosts(host),
  });
  // Behind Apache/Cloudflare — required for express-rate-limit + X-Forwarded-For
  // Cloudflare -> Apache -> Node (two trusted hops for X-Forwarded-For).
  app.set("trust proxy", 2);

  const allowedOrigins = (process.env.QOBRIX_MCP_ALLOWED_ORIGINS || "https://intranet.sharpsir.group")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  app.use((req, res, next) => {
    const origin = req.header("origin");
    if (origin && !allowedOrigins.includes(origin)) {
      res.status(403).json({ jsonrpc: "2.0", error: { code: -32000, message: "Forbidden origin" } });
      return;
    }
    next();
  });

  app.use(
    rateLimit({
      windowMs: 60_000,
      max: Number(process.env.QOBRIX_MCP_RATE_LIMIT || 300),
      standardHeaders: true,
      legacyHeaders: false,
    })
  );

  app.get("/health", (_req, res) => {
    const vaultCount = modeCEnabled(autoMode, authMode)
      ? countSessionVaults()
      : undefined;
    res.json({
      ok: true,
      transport: "http",
      auth: acceptedAuthTypes("http"),
      endpoints: { [MCP_PATH]: "http" },
      routing: autoMode
        ? "Authorization Bearer selects oauth_user; an API key selects api_key"
        : undefined,
      description: "Streamable HTTP. Authentication: API key or User OAuth 2.1.",
      signed_header_requests: xchatRequestCount(),
      connected:
        modeCEnabled(autoMode, authMode)
          ? Boolean(vaultCount && vaultCount > 0)
          : undefined,
      session_vaults: vaultCount,
    });
  });

  // api_key, signed-header, and oauth_user are per-request: never fall back to
  // a shared env account inside tool handlers.
  if (
    autoMode ||
    authMode === "oauth" ||
    authMode === "headers" ||
    authMode === "oauth_user"
  ) {
    disableEnvFallback();
  }

  /** oauth_user only — bearer verifier wired after AS metadata fetch. */
  let modeDVerifier: OAuthTokenVerifier | undefined;
  let modeDResourceUrl: URL | undefined;

  if (authMode === "env" && !isLoopbackHost(host)) {
    process.stderr.write(
      "[qobrix-crm-mcp] WARNING: none over HTTP shares one Qobrix account with every caller and is bound to a non-loopback host. Use QOBRIX_MCP_AUTH=headers or oauth for multi-user access.\n"
    );
  }

  if (modeCEnabled(autoMode, authMode)) {
    // Validate env early; DCR can wait until first /connect.
    requireOAuthEnv();
    if (!isLoopbackHost(host) && !process.env.QOBRIX_MCP_ALLOWED_HOSTS) {
      process.stderr.write(
        "[qobrix-crm-mcp] WARNING: the signed-header path leaves /mcp unauthenticated to the MCP client and uses per-user session vaults keyed by identity headers. Bind QOBRIX_MCP_HOST to 127.0.0.1 (or set QOBRIX_MCP_ALLOWED_HOSTS) and configure QOBRIX_MCP_IDENTITY_SECRET so only trusted callers can select a vault.\n"
      );
    }

    // Pre-register as AS client so /connect is fast; non-fatal if AS is down at boot.
    try {
      await ensureClientRegistered();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(
        `[qobrix-crm-mcp] the signed-header path DCR deferred (will retry on /connect): ${msg}\n`
      );
    }

    // Tighter limit on the OAuth browser paths (code-exchange / connect start).
    const oauthRouteLimit = rateLimit({
      windowMs: 60_000,
      max: Number(process.env.QOBRIX_MCP_OAUTH_RATE_LIMIT || 30),
      standardHeaders: true,
      legacyHeaders: false,
    });
    app.use(["/connect", "/oauth/callback"], oauthRouteLimit);

    app.get("/connect", async (req, res) => {
      const elicitationId = String(req.query.e || "").trim();
      if (!elicitationId) {
        res.status(400).send(errorHtml("Missing connect parameter e=", langFromHeader(req.headers["accept-language"])));
        return;
      }
      try {
        const { authorizeUrl, cookiePayload } =
          await authorizeRedirect(elicitationId);
        const signed = signCookie(cookiePayload);
        const secure = publicUrlIsHttps();
        const cookiePath = connectCookiePath();
        res.setHeader(
          "Set-Cookie",
          `${connectCookieName()}=${encodeURIComponent(signed)}; Path=${cookiePath}; HttpOnly; SameSite=Lax; Max-Age=600${secure ? "; Secure" : ""}`
        );
        res.redirect(302, authorizeUrl);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        res.status(400).send(errorHtml(msg, langFromHeader(req.headers["accept-language"])));
      }
    });

    app.get("/oauth/callback", async (req, res) => {
      const err = String(req.query.error || "").trim();
      if (err) {
        const desc = String(req.query.error_description || err);
        res.status(400).send(errorHtml(desc, langFromHeader(req.headers["accept-language"])));
        return;
      }
      const code = String(req.query.code || "").trim();
      const state = String(req.query.state || "").trim();
      if (!code || !state) {
        res.status(400).send(errorHtml("Missing code or state", langFromHeader(req.headers["accept-language"])));
        return;
      }
      try {
        const result = await handleCallback({
          code,
          state,
          cookieHeader: req.headers.cookie,
        });
        // Clear connect cookie
        res.setHeader(
          "Set-Cookie",
          `${connectCookieName()}=; Path=${connectCookiePath()}; HttpOnly; SameSite=Lax; Max-Age=0`
        );
        res.status(200).send(successHtml(result.subject, langFromHeader(req.headers["accept-language"])));
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        res.status(400).send(errorHtml(msg, langFromHeader(req.headers["accept-language"])));
      }
    });
  }

  // oauth_user — Claude.ai / Desktop remote connector (opt-in; does not alter the signed-header path).
  if (modeDEnabled(autoMode, authMode)) {
    const { issuer, resourceServerUrl, introspectionSecret } = requireOAuthEnv();
    modeDResourceUrl = resourceServerUrl;
    const prm = buildProtectedResourceMetadata({
      resourceServerUrl,
      issuer,
    });

    const servePrm = (_req: Request, res: Response) => {
      res.setHeader("Cache-Control", "no-store");
      res.json(prm);
    };
    // RFC 9728 well-known + Claude path-aware probe fallback.
    app.get("/.well-known/oauth-protected-resource", servePrm);
    app.get("/.well-known/oauth-protected-resource/mcp", servePrm);
    const resourcePath = resourceServerUrl.pathname.replace(/\/+$/, "");
    if (resourcePath && resourcePath !== "/" && resourcePath !== "/mcp") {
      app.get(
        `/.well-known/oauth-protected-resource${resourcePath}`,
        servePrm
      );
    }

    try {
      const meta = await fetchAuthorizationServerMetadata(issuer);
      const introspectionEndpoint =
        meta.introspection_endpoint ||
        new URL("/introspect", issuer).href;
      modeDVerifier = createCompanionTokenVerifier({
        issuer,
        resourceServerUrl,
        introspectionEndpoint,
        introspectionSecret,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(
        `[qobrix-crm-mcp] oauth_user AS metadata deferred (will fail Bearer until AS is up): ${msg}\n`
      );
      // Still construct verifier with /introspect default so late AS comes online.
      modeDVerifier = createCompanionTokenVerifier({
        issuer,
        resourceServerUrl,
        introspectionEndpoint: new URL("/introspect", issuer).href,
        introspectionSecret,
      });
    }

    if (!isLoopbackHost(host) && !process.env.QOBRIX_MCP_ALLOWED_HOSTS) {
      process.stderr.write(
        "[qobrix-crm-mcp] oauth_user: publish HTTPS /mcp + PRM for Claude.ai custom connectors. Set QOBRIX_MCP_ALLOWED_HOSTS to your public hostname(s). Allowlist Anthropic egress 160.79.104.0/21 if WAF'd.\n"
      );
    }
  }

  const transports = new Map<string, StreamableHTTPServerTransport>();
  /** Keep McpServer refs for request-context (elicitation capabilities). */
  const servers = new WeakMap<StreamableHTTPServerTransport, McpServer>();

  const handleMcp = async (
    req: Request,
    res: Response,
    routeAuthMode: AuthMode,
  ): Promise<void> => {
    const run = async (vaultKey = "default") => {
      const sessionId = req.headers["mcp-session-id"] as string | undefined;
      let transport: StreamableHTTPServerTransport | undefined;
      let activeServer: McpServer | undefined;

      if (sessionId && transports.has(sessionId)) {
        transport = transports.get(sessionId);
        activeServer = transport ? servers.get(transport) : undefined;
      } else if (req.method === "POST" && isInitializeRequest(req.body)) {
        const server = createServer();
        transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (sid) => {
            transports.set(sid, transport!);
          },
        });
        transport.onclose = () => {
          const sid = transport?.sessionId;
          if (sid) transports.delete(sid);
        };
        servers.set(transport, server);
        activeServer = server;
        await server.connect(transport);
      } else if (sessionId) {
        res.status(404).json({
          jsonrpc: "2.0",
          error: { code: -32001, message: "Session not found" },
          id: null,
        });
        return;
      } else {
        // Stateless single-shot: create ephemeral transport for this request.
        const server = createServer();
        transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: undefined,
        });
        servers.set(transport, server);
        activeServer = server;
        await server.connect(transport);
      }

      // Only POST carries a JSON-RPC body. The SDK treats any non-undefined
      // parsedBody as the message, so passing Express's `{}` on a GET/DELETE
      // would corrupt the SSE stream / delete handling.
      const parsedBody = req.method === "POST" ? req.body : undefined;
      await runWithRequestContext(
        { mcpServer: activeServer, vaultKey, authMode: routeAuthMode },
        async () => {
          await transport!.handleRequest(req, res, parsedBody);
        }
      );
    };

    // oauth_user — Claude remote connector: require Bearer; never fall into the signed-header path.
    if (routeAuthMode === "oauth_user") {
      const resourceUrl = modeDResourceUrl;
      const verifier = modeDVerifier;
      if (!resourceUrl || !verifier) {
        res.status(503).json({
          error: "temporarily_unavailable",
          error_description: "oauth_user OAuth Resource Server is not ready",
        });
        return;
      }

      const authHeader = String(req.headers.authorization || "");
      if (!authHeader.startsWith("Bearer ")) {
        res.setHeader(
          "WWW-Authenticate",
          wwwAuthenticateChallenge(resourceUrl)
        );
        res.status(401).json({
          error: "unauthorized",
          error_description:
            "oauth_user requires Authorization: Bearer <access_token> (Claude.ai custom connector OAuth)",
        });
        return;
      }

      const token = authHeader.slice("Bearer ".length).trim();
      if (!token) {
        res.setHeader(
          "WWW-Authenticate",
          wwwAuthenticateChallenge(resourceUrl)
        );
        res.status(401).json({
          error: "invalid_token",
          error_description: "Empty bearer token",
        });
        return;
      }

      try {
        const authInfo = await verifier.verifyAccessToken(token);
        const scopes = authInfo.scopes || [];
        if (!scopes.includes("qobrix:read")) {
          res.setHeader("WWW-Authenticate", `${wwwAuthenticateChallenge(resourceUrl)}, error="insufficient_scope"`);
          res.status(403).json({ error: "insufficient_scope", error_description: "qobrix:read is required" });
          return;
        }
        const creds = credentialsFromAuthInfo(authInfo);
        if (!creds) {
          res.setHeader(
            "WWW-Authenticate",
            wwwAuthenticateChallenge(resourceUrl)
          );
          res.status(401).json({
            error: "invalid_token",
            error_description:
              "Token introspection did not return Qobrix credentials",
          });
          return;
        }
        await runWithAuthAsync(creds, () => run());
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        res.setHeader(
          "WWW-Authenticate",
          wwwAuthenticateChallenge(resourceUrl)
        );
        res.status(401).json({
          error: "invalid_token",
          error_description: msg,
        });
      }
      return;
    }

    if (routeAuthMode === "oauth") {
      if (!xchatLegacyEnabled()) {
        res.status(401).json({
          error: "unauthorized",
          error_description: "Signed-header authentication is disabled.",
        });
        return;
      }
      noteXchatRequest();
      const { vaultKey, reason } = resolveVaultKeyFromHeaders({
        platform: String(req.headers["x-chat-platform"] || ""),
        userId: String(req.headers["x-chat-user-id"] || ""),
        iat: String(req.headers["x-chat-identity-iat"] || ""),
        exp: String(req.headers["x-chat-identity-exp"] || ""),
        sig: String(req.headers["x-chat-identity-sig"] || ""),
      });
      if (reason === "bad-signature") {
        process.stderr.write(
          `[qobrix-crm-mcp] Rejected forged/unsigned identity; vault=default audit=${vaultKeyAuditHash(vaultKey)}\n`
        );
      } else if (
        req.method === "POST" &&
        process.env.QOBRIX_MCP_DEBUG === "1"
      ) {
        process.stderr.write(
          `[qobrix-crm-mcp] /mcp vault audit=${vaultKeyAuditHash(vaultKey)} reason=${reason}\n`
        );
      }

      // Self-service the signed-header path: no bearer required. Use vault creds when present.
      let creds = await refreshIfNeeded(vaultKey);
      if (!creds) creds = getSessionCredentials(vaultKey);
      if (creds) {
        await runWithAuthAsync(creds, () => run(vaultKey));
      } else {
        // Unauthenticated marker path: tools raise AuthRequiredError → URL.
        await run(vaultKey);
      }
      return;
    }

    if (routeAuthMode === "headers") {
      const creds = readHeaderCreds(req);
      if (!creds) {
        res.status(401).json({
          error: "unauthorized",
          error_description:
            "api_key requires Authorization: Bearer <user>:<key> or X-Api-User and X-Api-Key",
        });
        return;
      }
      await runWithAuthAsync(creds, () => run());
      return;
    }

    // none over HTTP: shared env credentials (rare; useful for smoke tests).
    await run();
  };

  const routeMcp = (req: Request, res: Response) => {
    if (req.method === "GET" || req.method === "DELETE") {
      res.setHeader("Allow", "POST");
      res.status(405).json({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed" } });
      return;
    }
    const routeAuthMode = resolveAuthModeFromRequest(
      req.headers,
      autoMode,
      authMode,
    );
    void handleMcp(req, res, routeAuthMode);
  };

  app.post(MCP_PATH, routeMcp);
  app.get(MCP_PATH, routeMcp);
  app.delete(MCP_PATH, routeMcp);

  await new Promise<void>((resolve, reject) => {
    const server = app.listen(port, host, () => {
      process.stderr.write(
        `[qobrix-crm-mcp] HTTP listening on http://${host}:${port}` +
          ` ${MCP_PATH} (api_key, oauth_user)` +
          "\n"
      );
      if (modeCEnabled(autoMode, authMode)) {
        try {
          const { resourceServerUrl } = requireOAuthEnv();
          process.stderr.write(
            `[qobrix-crm-mcp] Resource URL: ${resourceServerUrl.href}\n`
          );
          process.stderr.write(
            `[qobrix-crm-mcp] Connect URL base: ${process.env.QOBRIX_MCP_PUBLIC_URL || `http://${host}:${port}`}/connect\n`
          );
        } catch {
          /* already validated above */
        }
      }
      if (modeDEnabled(autoMode, authMode)) {
        try {
          const { resourceServerUrl, issuer } = requireOAuthEnv();
          process.stderr.write(
            `[qobrix-crm-mcp] oauth_user resource: ${resourceServerUrl.href}\n`
          );
          process.stderr.write(
            `[qobrix-crm-mcp] oauth_user AS issuer: ${issuer.href.replace(/\/+$/, "")}\n`
          );
          process.stderr.write(
            `[qobrix-crm-mcp] oauth_user PRM: ${resourceServerUrl.origin}/.well-known/oauth-protected-resource\n`
          );
        } catch {
          /* already validated above */
        }
      }
      resolve();
    });
    server.on("error", reject);
  });

  const shutdown = async () => {
    for (const t of transports.values()) {
      await t.close().catch(() => undefined);
    }
    process.exit(0);
  };
  process.on("SIGINT", () => {
    void shutdown();
  });
  process.on("SIGTERM", () => {
    void shutdown();
  });
}

function publicUrlIsHttps(): boolean {
  const raw =
    process.env.QOBRIX_MCP_PUBLIC_URL ||
    `http://127.0.0.1:${process.env.QOBRIX_MCP_PORT || "3502"}`;
  return raw.startsWith("https://");
}

/** Cookie Path from PUBLIC_URL pathname — avoids vhost-wide ProxyPassReverseCookiePath (/ → /eldes) stealing Path=/. */
function connectCookiePath(): string {
  try {
    const raw =
      process.env.QOBRIX_MCP_PUBLIC_URL ||
      `http://127.0.0.1:${process.env.QOBRIX_MCP_PORT || "3502"}`;
    const pathname = new URL(raw).pathname.replace(/\/+$/, "");
    return pathname || "/";
  } catch {
    return "/";
  }
}
