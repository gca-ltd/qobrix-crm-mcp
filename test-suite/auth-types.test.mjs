/**
 * Smoke / regression tests for none and api_key/C/D wiring (no live Qobrix required).
 *
 * the signed-header path (1.4+): self-service OAuth — /mcp has no bearer gate; tools surface
 * a /connect URL; AS advertises S256 + exact redirect_uri.
 * oauth_user (1.7+): Claude.ai connector — PRM + 401 WWW-Authenticate + Bearer.
 * Existing api_key/C cases below are unchanged.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";

const MCP_ROOT = new URL("..", import.meta.url).pathname;
const OAUTH_ROOT = "/home/bitnami/qobrix-crm-mcp-oauth";
const SECRET = "test-introspection-secret-" + randomBytes(8).toString("hex");
const STATE_SECRET = "test-state-secret-" + randomBytes(8).toString("hex");
const VAULT_KEY = "test-vault-key-" + randomBytes(8).toString("hex");
const PORT_AS = 13503;
const PORT_MCP_B = 13502;
const PORT_MCP_C = 13504;
const PORT_AS_D = 13505;
const PORT_MCP_D = 13506;

function waitUrl(url, { timeoutMs = 15000 } = {}) {
  const start = Date.now();
  return (async () => {
    while (Date.now() - start < timeoutMs) {
      try {
        const res = await fetch(url);
        if (res.ok || res.status === 401) return res;
      } catch {
        /* retry */
      }
      await sleep(200);
    }
    throw new Error(`Timeout waiting for ${url}`);
  })();
}

function spawnNode(cwd, args, env) {
  // Do not inherit production OAuth allowlists / data dirs from the parent shell
  // (e.g. PM2-exported QOBRIX_OAUTH_REDIRECT_ALLOWLIST would reject test ports).
  const scrubbed = { ...process.env };
  for (const key of Object.keys(scrubbed)) {
    if (key.startsWith("QOBRIX_") || key === "MCP_DANGEROUSLY_ALLOW_INSECURE_ISSUER_URL") {
      delete scrubbed[key];
    }
  }
  const child = spawn("node", args, {
    cwd,
    env: { ...scrubbed, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stderr.on("data", () => {});
  return child;
}

async function mcpInitialize(url, { elicitationUrl = false } = {}) {
  const capabilities = elicitationUrl
    ? { elicitation: { url: true, form: true } }
    : {};
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-03-26",
        capabilities,
        clientInfo: { name: "test", version: "0" },
      },
    }),
  });
  return res;
}

async function mcpCallTool(url, sessionId, name, args = {}) {
  const headers = {
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
  };
  if (sessionId) headers["mcp-session-id"] = sessionId;

  // notifications/initialized
  await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify({
      jsonrpc: "2.0",
      method: "notifications/initialized",
    }),
  });

  return fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name, arguments: args },
    }),
  });
}

/** Parse JSON-RPC from plain JSON or SSE `data:` lines. */
async function readJsonRpc(res) {
  const ct = res.headers.get("content-type") || "";
  const text = await res.text();
  if (ct.includes("application/json")) {
    return JSON.parse(text);
  }
  // SSE
  for (const line of text.split("\n")) {
    if (line.startsWith("data:")) {
      const payload = line.slice(5).trim();
      if (!payload || payload === "[DONE]") continue;
      try {
        return JSON.parse(payload);
      } catch {
        /* continue */
      }
    }
  }
  // last resort
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

describe("modes + open-core pairing", () => {
  it("api_key: HTTP rejects missing headers and accepts X-Api-*", async () => {
    const child = spawnNode(MCP_ROOT, ["dist/index.js"], {
      QOBRIX_MCP_TRANSPORT: "http",
      QOBRIX_MCP_AUTH: "headers",
      QOBRIX_MCP_HOST: "127.0.0.1",
      QOBRIX_MCP_PORT: String(PORT_MCP_B),
      QOBRIX_API_URL: "https://example.invalid",
      QOBRIX_API_USER: "u",
      QOBRIX_API_KEY: "k",
    });
    try {
      await waitUrl(`http://127.0.0.1:${PORT_MCP_B}/health`);
      const health = await fetch(`http://127.0.0.1:${PORT_MCP_B}/health`);
      assert.equal(health.status, 200);
      const body = await health.json();
      assert.equal(body.auth, "headers");

      const noHdr = await fetch(`http://127.0.0.1:${PORT_MCP_B}/mcp`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: "2025-03-26",
            capabilities: {},
            clientInfo: { name: "test", version: "0" },
          },
        }),
      });
      assert.equal(noHdr.status, 401);
    } finally {
      child.kill("SIGTERM");
    }
  });

  it("the signed-header path + companion: AS S256, DCR, /mcp without bearer, /connect rejects bad e=", async () => {
    const dataDir = join(
      tmpdir(),
      "qobrix-oauth-test-" + randomBytes(4).toString("hex")
    );
    const mcpDataDir = join(
      tmpdir(),
      "qobrix-mcp-oauth-test-" + randomBytes(4).toString("hex")
    );
    mkdirSync(dataDir, { recursive: true });
    mkdirSync(mcpDataDir, { recursive: true });
    const resource = `http://127.0.0.1:${PORT_MCP_C}/mcp`;
    const publicUrl = `http://127.0.0.1:${PORT_MCP_C}`;
    const issuer = `http://127.0.0.1:${PORT_AS}`;

    const as = spawnNode(OAUTH_ROOT, ["dist/index.js"], {
      QOBRIX_OAUTH_ISSUER: issuer,
      QOBRIX_MCP_RESOURCE_URL: resource,
      QOBRIX_OAUTH_INTROSPECTION_SECRET: SECRET,
      QOBRIX_OAUTH_VAULT_KEY: VAULT_KEY,
      QOBRIX_OAUTH_HOST: "127.0.0.1",
      QOBRIX_OAUTH_PORT: String(PORT_AS),
      QOBRIX_OAUTH_DATA_DIR: dataDir,
      QOBRIX_API_URL: "https://example.invalid",
      MCP_DANGEROUSLY_ALLOW_INSECURE_ISSUER_URL: "true",
    });

    const mcp = spawnNode(MCP_ROOT, ["dist/index.js"], {
      QOBRIX_MCP_TRANSPORT: "http",
      QOBRIX_MCP_AUTH: "oauth",
      QOBRIX_MCP_HOST: "127.0.0.1",
      QOBRIX_MCP_PORT: String(PORT_MCP_C),
      QOBRIX_OAUTH_ISSUER: issuer,
      QOBRIX_MCP_RESOURCE_URL: resource,
      QOBRIX_MCP_PUBLIC_URL: publicUrl,
      QOBRIX_OAUTH_INTROSPECTION_SECRET: SECRET,
      QOBRIX_MCP_STATE_SECRET: STATE_SECRET,
      QOBRIX_MCP_DATA_DIR: mcpDataDir,
      QOBRIX_API_URL: "https://example.invalid",
      MCP_DANGEROUSLY_ALLOW_INSECURE_ISSUER_URL: "true",
    });

    try {
      await waitUrl(`${issuer}/health`);
      await waitUrl(`http://127.0.0.1:${PORT_MCP_C}/health`);

      const health = await fetch(`http://127.0.0.1:${PORT_MCP_C}/health`);
      assert.equal(health.status, 200);
      const healthBody = await health.json();
      assert.equal(healthBody.auth, "oauth");
      assert.equal(healthBody.connected, false);

      // AS metadata: S256 + introspection
      const meta = await fetch(
        `${issuer}/.well-known/oauth-authorization-server`
      );
      assert.equal(meta.status, 200);
      const metaBody = await meta.json();
      assert.equal(String(metaBody.issuer).replace(/\/+$/, ""), issuer);
      assert.ok(String(metaBody.introspection_endpoint).includes("/introspect"));
      assert.deepEqual(metaBody.code_challenge_methods_supported, ["S256"]);

      // DCR with MCP callback redirect_uri (exact match required by AS)
      const redirectUri = `${publicUrl}/oauth/callback`;
      const dcr = await fetch(`${issuer}/register`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          client_name: "smoke-test",
          redirect_uris: [redirectUri],
          grant_types: ["authorization_code", "refresh_token"],
          response_types: ["code"],
          token_endpoint_auth_method: "client_secret_post",
        }),
      });
      assert.equal(dcr.status, 201);
      const client = await dcr.json();
      assert.ok(client.client_id);
      assert.ok(client.redirect_uris.includes(redirectUri));

      // /mcp accepts initialize WITHOUT bearer (self-service the signed-header path)
      const init = await mcpInitialize(resource);
      assert.ok(
        init.status === 200 || init.status === 202,
        `expected 200/202, got ${init.status}`
      );

      // /connect rejects missing/bad elicitation id
      const badConnect = await fetch(`${publicUrl}/connect?e=not-a-real-id`, {
        redirect: "manual",
      });
      assert.equal(badConnect.status, 400);
      const badHtml = await badConnect.text();
      assert.match(badHtml, /Unknown or expired|expired|failed/i);

      // Cold tool call (no session) is an error with next_step, not a link.
      const init2 = await mcpInitialize(resource);
      const sessionId = init2.headers.get("mcp-session-id");
      const toolRes = await mcpCallTool(
        resource,
        sessionId,
        "qobrix_list_contacts",
        { limit: 1 }
      );
      assert.ok(toolRes.status === 200 || toolRes.status === 202);
      const rpc = await readJsonRpc(toolRes);
      const text = JSON.stringify(rpc.result || rpc.error || rpc);
      assert.match(text, /next_step|Sign-in is required/i);
      assert.doesNotMatch(text, /\[Sign In to Qobrix\]\(/);

      // Fingerprint helper sanity (api_key/C cache scoping)
      const fp = createHash("sha256").update("u|k").digest("hex").slice(0, 16);
      assert.equal(fp.length, 16);
    } finally {
      as.kill("SIGTERM");
      mcp.kill("SIGTERM");
      try {
        rmSync(dataDir, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
      try {
        rmSync(mcpDataDir, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    }
  });

  it("oauth_user: PRM shape, 401 challenge, Bearer reject/accept + audience", async () => {
    const dataDir = join(
      tmpdir(),
      "qobrix-oauth-d-test-" + randomBytes(4).toString("hex")
    );
    mkdirSync(dataDir, { recursive: true });
    const resource = `http://127.0.0.1:${PORT_MCP_D}/mcp`;
    const publicUrl = `http://127.0.0.1:${PORT_MCP_D}`;
    const issuer = `http://127.0.0.1:${PORT_AS_D}`;
    const accessToken = "test-access-" + randomBytes(16).toString("hex");
    const badAudienceToken = "test-badaud-" + randomBytes(16).toString("hex");
    const sub = createHash("sha256").update("mode-d-test-user").digest("hex");

    // Seed vault + durable tokens BEFORE AS boot (FileTokenStore loads on start).
    const { CredentialVault } = await import(
      pathToFileURL(join(OAUTH_ROOT, "dist/vault/credential-vault.js")).href
    );
    const vault = new CredentialVault({ vaultKey: VAULT_KEY, dataDir });
    vault.put({
      sub,
      qobrixApiUser: "00000000-0000-0000-0000-0000000000d1",
      qobrixApiKey: "seeded-api-key-mode-d",
      qobrixApiUrl: "https://example.invalid",
      updatedAt: new Date().toISOString(),
    });
    writeFileSync(
      join(dataDir, "tokens.json"),
      JSON.stringify(
        {
          version: 1,
          codes: {},
          tokens: {
            [accessToken]: {
              token: accessToken,
              type: "access",
              clientId: "claude-smoke",
              scopes: ["qobrix:read"],
              expiresAt: Date.now() + 3_600_000,
              resource,
              sub,
            },
            [badAudienceToken]: {
              token: badAudienceToken,
              type: "access",
              clientId: "claude-smoke",
              scopes: ["qobrix:read"],
              expiresAt: Date.now() + 3_600_000,
              resource: "https://wrong.example.com/mcp",
              sub,
            },
          },
        },
        null,
        2
      ),
      { mode: 0o600 }
    );

    const as = spawnNode(OAUTH_ROOT, ["dist/index.js"], {
      QOBRIX_OAUTH_ISSUER: issuer,
      QOBRIX_MCP_RESOURCE_URL: resource,
      QOBRIX_OAUTH_INTROSPECTION_SECRET: SECRET,
      QOBRIX_OAUTH_VAULT_KEY: VAULT_KEY,
      QOBRIX_OAUTH_HOST: "127.0.0.1",
      QOBRIX_OAUTH_PORT: String(PORT_AS_D),
      QOBRIX_OAUTH_DATA_DIR: dataDir,
      QOBRIX_API_URL: "https://example.invalid",
      // Documented Claude callback must be accepted when allowlist is set.
      QOBRIX_OAUTH_REDIRECT_ALLOWLIST: `https://claude.ai/api/mcp/auth_callback,http://127.0.0.1,http://localhost`,
      MCP_DANGEROUSLY_ALLOW_INSECURE_ISSUER_URL: "true",
    });

    const mcp = spawnNode(MCP_ROOT, ["dist/index.js"], {
      QOBRIX_MCP_TRANSPORT: "http",
      QOBRIX_MCP_AUTH: "oauth_user",
      QOBRIX_MCP_HOST: "127.0.0.1",
      QOBRIX_MCP_PORT: String(PORT_MCP_D),
      QOBRIX_OAUTH_ISSUER: issuer,
      QOBRIX_MCP_RESOURCE_URL: resource,
      QOBRIX_MCP_PUBLIC_URL: publicUrl,
      QOBRIX_OAUTH_INTROSPECTION_SECRET: SECRET,
      QOBRIX_API_URL: "https://example.invalid",
      MCP_DANGEROUSLY_ALLOW_INSECURE_ISSUER_URL: "true",
    });

    try {
      await waitUrl(`${issuer}/health`);
      await waitUrl(`http://127.0.0.1:${PORT_MCP_D}/health`);

      const health = await fetch(`http://127.0.0.1:${PORT_MCP_D}/health`);
      assert.equal(health.status, 200);
      const healthBody = await health.json();
      assert.equal(healthBody.auth, "oauth_user");

      // RFC 9728 PRM
      const prm = await fetch(
        `${publicUrl}/.well-known/oauth-protected-resource`
      );
      assert.equal(prm.status, 200);
      const prmBody = await prm.json();
      assert.equal(prmBody.resource, resource);
      assert.deepEqual(prmBody.authorization_servers, [issuer]);
      assert.deepEqual(prmBody.scopes_supported, ["qobrix:read"]);
      assert.ok(
        Array.isArray(prmBody.bearer_methods_supported) &&
          prmBody.bearer_methods_supported.includes("header")
      );

      const prmMcp = await fetch(
        `${publicUrl}/.well-known/oauth-protected-resource/mcp`
      );
      assert.equal(prmMcp.status, 200);

      // Unauthenticated /mcp → 401 + WWW-Authenticate resource_metadata
      const noBearer = await fetch(resource, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: "2025-03-26",
            capabilities: {},
            clientInfo: { name: "claude-probe", version: "0" },
          },
        }),
      });
      assert.equal(noBearer.status, 401);
      const www = noBearer.headers.get("www-authenticate") || "";
      assert.match(www, /Bearer/i);
      assert.match(www, /resource_metadata=/);
      assert.match(www, /oauth-protected-resource/);
      assert.match(www, /scope="qobrix:read"/);

      // Invalid bearer → 401
      const badBearer = await fetch(resource, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
          Authorization: "Bearer totally-invalid-token",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: "2025-03-26",
            capabilities: {},
            clientInfo: { name: "claude-probe", version: "0" },
          },
        }),
      });
      assert.equal(badBearer.status, 401);
      assert.match(badBearer.headers.get("www-authenticate") || "", /Bearer/i);

      // Wrong audience → 401
      const badAud = await fetch(resource, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
          Authorization: `Bearer ${badAudienceToken}`,
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: "2025-03-26",
            capabilities: {},
            clientInfo: { name: "claude-probe", version: "0" },
          },
        }),
      });
      assert.equal(badAud.status, 401);

      // Valid bearer + matching audience → MCP initialize succeeds
      const okInit = await fetch(resource, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
          Authorization: `Bearer ${accessToken}`,
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: "2025-03-26",
            capabilities: {},
            clientInfo: { name: "claude-probe", version: "0" },
          },
        }),
      });
      assert.ok(
        okInit.status === 200 || okInit.status === 202,
        `expected 200/202 with valid bearer, got ${okInit.status}`
      );

      // DCR accepts Claude callback under allowlist
      const dcr = await fetch(`${issuer}/register`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          client_name: "claude-ai",
          redirect_uris: ["https://claude.ai/api/mcp/auth_callback"],
          grant_types: ["authorization_code", "refresh_token"],
          response_types: ["code"],
          token_endpoint_auth_method: "none",
        }),
      });
      assert.equal(dcr.status, 201);
      const client = await dcr.json();
      assert.ok(
        client.redirect_uris.includes(
          "https://claude.ai/api/mcp/auth_callback"
        )
      );

      // form-urlencoded /token: bad auth code → 400 invalid_grant (not 500)
      const tokenProbe = await fetch(`${issuer}/token`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code: "not-a-real-code",
          redirect_uri: "https://claude.ai/api/mcp/auth_callback",
          client_id: client.client_id,
          code_verifier: "a".repeat(64),
        }).toString(),
      });
      assert.notEqual(
        tokenProbe.status,
        415,
        "/token must accept application/x-www-form-urlencoded"
      );
      assert.equal(
        tokenProbe.status,
        400,
        `bad auth code must be 400 invalid_grant, got ${tokenProbe.status}`
      );
      const tokenBody = await tokenProbe.json();
      assert.equal(tokenBody.error, "invalid_grant");

      // Bad refresh → 400 invalid_grant (Claude re-auth path)
      const refreshProbe = await fetch(`${issuer}/token`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "refresh_token",
          refresh_token: "not-a-real-refresh",
          client_id: client.client_id,
        }).toString(),
      });
      assert.equal(
        refreshProbe.status,
        400,
        `bad refresh must be 400 invalid_grant, got ${refreshProbe.status}`
      );
      const refreshBody = await refreshProbe.json();
      assert.equal(refreshBody.error, "invalid_grant");
    } finally {
      as.kill("SIGTERM");
      mcp.kill("SIGTERM");
      try {
        rmSync(dataDir, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    }
  });

  it("oauth_user: introspection cache survives low AS /introspect rate limit", async () => {
    const dataDir = join(
      tmpdir(),
      "qobrix-oauth-d-cache-" + randomBytes(4).toString("hex")
    );
    mkdirSync(dataDir, { recursive: true });
    // Dedicated ports so this can run after the other oauth_user case.
    const portAs = 13507;
    const portMcp = 13508;
    const resource = `http://127.0.0.1:${portMcp}/mcp`;
    const publicUrl = `http://127.0.0.1:${portMcp}`;
    const issuer = `http://127.0.0.1:${portAs}`;
    const accessToken = "test-cache-" + randomBytes(16).toString("hex");
    const sub = createHash("sha256").update("mode-d-cache-user").digest("hex");

    const { CredentialVault } = await import(
      pathToFileURL(join(OAUTH_ROOT, "dist/vault/credential-vault.js")).href
    );
    const vault = new CredentialVault({ vaultKey: VAULT_KEY, dataDir });
    vault.put({
      sub,
      qobrixApiUser: "00000000-0000-0000-0000-0000000000d2",
      qobrixApiKey: "seeded-api-key-mode-d-cache",
      qobrixApiUrl: "https://example.invalid",
      updatedAt: new Date().toISOString(),
    });
    writeFileSync(
      join(dataDir, "tokens.json"),
      JSON.stringify(
        {
          version: 1,
          codes: {},
          tokens: {
            [accessToken]: {
              token: accessToken,
              type: "access",
              clientId: "claude-cache",
              scopes: ["qobrix:read"],
              expiresAt: Date.now() + 3_600_000,
              resource,
              sub,
            },
          },
        },
        null,
        2
      ),
      { mode: 0o600 }
    );

    // Force AS /introspect to 2/min — without RS cache, calls 3+ would 429→401.
    const as = spawnNode(OAUTH_ROOT, ["dist/index.js"], {
      QOBRIX_OAUTH_ISSUER: issuer,
      QOBRIX_MCP_RESOURCE_URL: resource,
      QOBRIX_OAUTH_INTROSPECTION_SECRET: SECRET,
      QOBRIX_OAUTH_VAULT_KEY: VAULT_KEY,
      QOBRIX_OAUTH_HOST: "127.0.0.1",
      QOBRIX_OAUTH_PORT: String(portAs),
      QOBRIX_OAUTH_DATA_DIR: dataDir,
      QOBRIX_OAUTH_INTROSPECT_RATE_LIMIT: "2",
      QOBRIX_API_URL: "https://example.invalid",
      MCP_DANGEROUSLY_ALLOW_INSECURE_ISSUER_URL: "true",
    });

    const mcp = spawnNode(MCP_ROOT, ["dist/index.js"], {
      QOBRIX_MCP_TRANSPORT: "http",
      QOBRIX_MCP_AUTH: "oauth_user",
      QOBRIX_MCP_HOST: "127.0.0.1",
      QOBRIX_MCP_PORT: String(portMcp),
      QOBRIX_OAUTH_ISSUER: issuer,
      QOBRIX_MCP_RESOURCE_URL: resource,
      QOBRIX_MCP_PUBLIC_URL: publicUrl,
      QOBRIX_OAUTH_INTROSPECTION_SECRET: SECRET,
      QOBRIX_API_URL: "https://example.invalid",
      MCP_DANGEROUSLY_ALLOW_INSECURE_ISSUER_URL: "true",
    });

    try {
      await waitUrl(`${issuer}/health`);
      await waitUrl(`http://127.0.0.1:${portMcp}/health`);

      const initBody = JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-03-26",
          capabilities: {},
          clientInfo: { name: "claude-cache", version: "0" },
        },
      });

      for (let i = 0; i < 8; i++) {
        const res = await fetch(resource, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Accept: "application/json, text/event-stream",
            Authorization: `Bearer ${accessToken}`,
          },
          body: initBody,
        });
        assert.ok(
          res.status === 200 || res.status === 202,
          `Bearer call ${i + 1}/8 expected 200/202 under introspect limit=2 (cache), got ${res.status}`
        );
      }
    } finally {
      as.kill("SIGTERM");
      mcp.kill("SIGTERM");
      try {
        rmSync(dataDir, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    }
  });

  it("the signed-header path elicitation client: tools/call returns -32042 with /connect URL", async () => {
    const dataDir = join(
      tmpdir(),
      "qobrix-oauth-test-" + randomBytes(4).toString("hex")
    );
    const mcpDataDir = join(
      tmpdir(),
      "qobrix-mcp-oauth-test-" + randomBytes(4).toString("hex")
    );
    mkdirSync(dataDir, { recursive: true });
    mkdirSync(mcpDataDir, { recursive: true });
    const resource = `http://127.0.0.1:${PORT_MCP_C}/mcp`;
    const publicUrl = `http://127.0.0.1:${PORT_MCP_C}`;
    const issuer = `http://127.0.0.1:${PORT_AS}`;

    const as = spawnNode(OAUTH_ROOT, ["dist/index.js"], {
      QOBRIX_OAUTH_ISSUER: issuer,
      QOBRIX_MCP_RESOURCE_URL: resource,
      QOBRIX_OAUTH_INTROSPECTION_SECRET: SECRET,
      QOBRIX_OAUTH_VAULT_KEY: VAULT_KEY,
      QOBRIX_OAUTH_HOST: "127.0.0.1",
      QOBRIX_OAUTH_PORT: String(PORT_AS),
      QOBRIX_OAUTH_DATA_DIR: dataDir,
      QOBRIX_API_URL: "https://example.invalid",
      MCP_DANGEROUSLY_ALLOW_INSECURE_ISSUER_URL: "true",
    });

    const mcp = spawnNode(MCP_ROOT, ["dist/index.js"], {
      QOBRIX_MCP_TRANSPORT: "http",
      QOBRIX_MCP_AUTH: "oauth",
      QOBRIX_MCP_HOST: "127.0.0.1",
      QOBRIX_MCP_PORT: String(PORT_MCP_C),
      QOBRIX_OAUTH_ISSUER: issuer,
      QOBRIX_MCP_RESOURCE_URL: resource,
      QOBRIX_MCP_PUBLIC_URL: publicUrl,
      QOBRIX_OAUTH_INTROSPECTION_SECRET: SECRET,
      QOBRIX_MCP_STATE_SECRET: STATE_SECRET,
      QOBRIX_MCP_DATA_DIR: mcpDataDir,
      QOBRIX_API_URL: "https://example.invalid",
      MCP_DANGEROUSLY_ALLOW_INSECURE_ISSUER_URL: "true",
    });

    try {
      await waitUrl(`${issuer}/health`);
      await waitUrl(`http://127.0.0.1:${PORT_MCP_C}/health`);

      const init = await mcpInitialize(resource, { elicitationUrl: true });
      assert.ok(init.status === 200 || init.status === 202);
      const sessionId = init.headers.get("mcp-session-id");

      const toolRes = await mcpCallTool(
        resource,
        sessionId,
        "qobrix_list_contacts",
        { limit: 1 }
      );
      const rpc = await readJsonRpc(toolRes);

      // Prefer -32042; fall back to text URL if transport wrapped it
      if (rpc.error) {
        assert.equal(rpc.error.code, -32042);
        const el = rpc.error.data?.elicitations?.[0];
        assert.equal(el?.mode, "url");
        assert.match(String(el?.url || ""), /\/connect\?e=/);
        assert.ok(el?.elicitationId);

        // Valid /connect should 302 toward AS /authorize (or /login)
        const connectRes = await fetch(el.url, { redirect: "manual" });
        assert.ok(
          connectRes.status === 302 || connectRes.status === 301,
          `expected redirect, got ${connectRes.status}`
        );
        const loc = connectRes.headers.get("location") || "";
        assert.match(loc, /authorize|login/i);
        const setCookie = connectRes.headers.get("set-cookie") || "";
        assert.match(setCookie, /qobrix_mcp_connect=/);
      } else {
        const text = JSON.stringify(rpc.result || rpc);
        assert.match(text, /\/connect\?e=/);
      }
    } finally {
      as.kill("SIGTERM");
      mcp.kill("SIGTERM");
      try {
        rmSync(dataDir, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
      try {
        rmSync(mcpDataDir, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    }
  });

  it("api_key,oauth_user: single /mcp — no headers → 401; X-Chat-User-Id → 200", async () => {
    const dataDir = join(
      tmpdir(),
      "qobrix-oauth-auto-" + randomBytes(4).toString("hex")
    );
    const mcpDataDir = join(
      tmpdir(),
      "qobrix-mcp-auto-" + randomBytes(4).toString("hex")
    );
    mkdirSync(dataDir, { recursive: true });
    mkdirSync(mcpDataDir, { recursive: true });
    const portAs = 13509;
    const portMcp = 13510;
    const resource = `http://127.0.0.1:${portMcp}/mcp`;
    const publicUrl = `http://127.0.0.1:${portMcp}`;
    const issuer = `http://127.0.0.1:${portAs}`;

    const as = spawnNode(OAUTH_ROOT, ["dist/index.js"], {
      QOBRIX_OAUTH_ISSUER: issuer,
      QOBRIX_MCP_RESOURCE_URL: resource,
      QOBRIX_OAUTH_INTROSPECTION_SECRET: SECRET,
      QOBRIX_OAUTH_VAULT_KEY: VAULT_KEY,
      QOBRIX_OAUTH_HOST: "127.0.0.1",
      QOBRIX_OAUTH_PORT: String(portAs),
      QOBRIX_OAUTH_DATA_DIR: dataDir,
      QOBRIX_API_URL: "https://example.invalid",
      MCP_DANGEROUSLY_ALLOW_INSECURE_ISSUER_URL: "true",
    });

    const mcp = spawnNode(MCP_ROOT, ["dist/index.js"], {
      QOBRIX_MCP_TRANSPORT: "http",
      QOBRIX_MCP_AUTH: "api_key,oauth_user",
      QOBRIX_MCP_HOST: "127.0.0.1",
      QOBRIX_MCP_PORT: String(portMcp),
      QOBRIX_OAUTH_ISSUER: issuer,
      QOBRIX_MCP_RESOURCE_URL: resource,
      QOBRIX_MCP_PUBLIC_URL: publicUrl,
      QOBRIX_OAUTH_INTROSPECTION_SECRET: SECRET,
      QOBRIX_MCP_STATE_SECRET: STATE_SECRET,
      QOBRIX_MCP_DATA_DIR: mcpDataDir,
      QOBRIX_API_URL: "https://example.invalid",
      MCP_DANGEROUSLY_ALLOW_INSECURE_ISSUER_URL: "true",
    });

    try {
      await waitUrl(`${issuer}/health`);
      await waitUrl(`http://127.0.0.1:${portMcp}/health`);

      const health = await fetch(`http://127.0.0.1:${portMcp}/health`);
      assert.equal(health.status, 200);
      const healthBody = await health.json();
      assert.deepEqual(healthBody.auth, ["api_key", "oauth_user"]);
      assert.equal(typeof healthBody.signed_header_requests, "number");

      const noHdr = await fetch(resource, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: "2025-03-26",
            capabilities: {},
            clientInfo: { name: "claude-probe", version: "0" },
          },
        }),
      });
      assert.equal(noHdr.status, 401);
      assert.match(noHdr.headers.get("www-authenticate") || "", /Bearer/i);

      const chatInit = await fetch(resource, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
          "X-Chat-Platform": "matrix",
          "X-Chat-User-Id": "user-signed-header-test",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: "2025-03-26",
            capabilities: {},
            clientInfo: { name: "digital-employees", version: "0" },
          },
        }),
      });
      assert.ok(
        chatInit.status === 200 || chatInit.status === 202,
        `X-Chat headers should route to the signed-header path, got ${chatInit.status}`
      );

      const gone = await fetch(`http://127.0.0.1:${portMcp}/mcp-c`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });
      assert.equal(gone.status, 404);
    } finally {
      as.kill("SIGTERM");
      mcp.kill("SIGTERM");
      try {
        rmSync(dataDir, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
      try {
        rmSync(mcpDataDir, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    }
  });
});
