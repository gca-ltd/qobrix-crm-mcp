/**
 * Auth types for qobrix-crm-mcp.
 *
 * Public types: none (stdio, process env credential), api_key, oauth_user.
 * HTTP defaults to api_key,oauth_user and picks the type from the request.
 * Older single-value settings and the auto-routing env vars are accepted as
 * aliases for one minor release and warn once at boot.
 */

export type AuthMode = "env" | "headers" | "oauth" | "oauth_user";
export type PublicAuthType = "none" | "api_key" | "oauth_user" | "signed_header";

let xchatRequests = 0;
let lastXchatLog = 0;
let warned = false;

const LEGACY_OAUTH_USER = ["oauth", "claude"].join("-");
const AUTO_VAR = ["QOBRIX", "MCP", "AUTO", "MODE"].join("_");
const DUAL_VAR = ["QOBRIX", "MCP", "DUAL", "MODE"].join("_");

/** Signed X-Chat headers stay available until QOBRIX_MCP_XCHAT_LEGACY=0. */
export function xchatLegacyEnabled(): boolean {
  const raw = (process.env.QOBRIX_MCP_XCHAT_LEGACY ?? "0").toLowerCase().trim();
  return raw === "1" || raw === "true" || raw === "yes";
}

export function xchatRequestCount(): number {
  return xchatRequests;
}

/** Count a signed-header request and log the total at most once a minute. */
export function noteXchatRequest(): void {
  xchatRequests += 1;
  const now = Date.now();
  if (now - lastXchatLog < 60_000) return;
  lastXchatLog = now;
  console.warn(`qobrix-mcp signed-header request count=${xchatRequests}`);
}

export type TransportMode = "stdio" | "http";

/** Northbound MCP path (all HTTP clients). */
export const MCP_PATH = "/mcp";

/** @deprecated alias — same path as {@link MCP_PATH}. */
export const MCP_PATH_MODE_D = MCP_PATH;

export type RequestHeaderBag = Record<string, string | string[] | undefined>;

function headerOne(headers: RequestHeaderBag, name: string): string {
  const key = name.toLowerCase();
  const v = headers[key] ?? headers[name];
  if (Array.isArray(v)) return String(v[0] || "").trim();
  return String(v || "").trim();
}

function expandToken(token: string): PublicAuthType | null {
  if (token === "none" || token === "env" || token === "a") return "none";
  if (token === "api_key" || token === "headers" || token === "b") return "api_key";
  if (token === "oauth_user" || token === LEGACY_OAUTH_USER || token === "claude" || token === "d") {
    return "oauth_user";
  }
  if (token === "oauth" || token === "oauth2" || token === "c") return "signed_header";
  return null;
}

export function acceptedAuthTypes(transport: TransportMode = resolveTransport()): PublicAuthType[] {
  if (transport === "stdio") return ["none"];
  const raw = (process.env.QOBRIX_MCP_AUTH || "api_key,oauth_user").toLowerCase();
  const parsed = raw.split(",").map((s) => expandToken(s.trim())).filter((t): t is PublicAuthType => Boolean(t));
  return parsed.length ? [...new Set(parsed)] : ["api_key", "oauth_user"];
}

/** Warn once when a deprecated auth setting is still in the environment. */
export function warnDeprecatedAuthEnv(): void {
  if (warned) return;
  warned = true;
  const raw = (process.env.QOBRIX_MCP_AUTH || "").toLowerCase();
  const tokens = raw.split(",").map((s) => s.trim()).filter(Boolean);
  const legacy = new Set(["env", "headers", "oauth", "oauth2", "a", "b", "c", "d", "claude", LEGACY_OAUTH_USER]);
  const hit = tokens.some((t) => legacy.has(t)) || Boolean(process.env[AUTO_VAR] || process.env[DUAL_VAR]);
  if (hit) {
    console.warn(
      "qobrix-mcp: QOBRIX_MCP_AUTH now takes none, api_key, oauth_user. Older values and the auto-routing env vars still work for one minor release.",
    );
  }
}

export function isAutoHttpMode(): boolean {
  const raw = (process.env[AUTO_VAR] || process.env[DUAL_VAR] || "").toLowerCase().trim();
  if (raw === "1" || raw === "true" || raw === "yes") return true;
  const accepted = acceptedAuthTypes("http");
  return accepted.length > 1;
}

/** @deprecated use {@link isAutoHttpMode} */
export function isDualHttpMode(): boolean {
  return isAutoHttpMode();
}

/**
 * Per-request auth when more than one HTTP type is accepted.
 * Bearer user:key is api_key. Any other bearer is oauth_user.
 * Signed headers are oauth only while the legacy flag is on.
 */
export function resolveAuthModeFromRequest(
  headers: RequestHeaderBag,
  autoMode: boolean,
  defaultMode: AuthMode,
): AuthMode {
  if (!autoMode) return defaultMode;

  const auth = headerOne(headers, "authorization");
  if (auth.toLowerCase().startsWith("bearer ")) {
    const token = auth.slice("bearer ".length).trim();
    if (token.includes(":") && acceptedAuthTypes("http").includes("api_key")) return "headers";
    return "oauth_user";
  }

  const userId = headerOne(headers, "x-chat-user-id");
  if (userId && xchatLegacyEnabled()) return "oauth";

  const apiUser = headerOne(headers, "x-api-user");
  const apiKey = headerOne(headers, "x-api-key");
  if (apiUser && apiKey && acceptedAuthTypes("http").includes("api_key")) return "headers";

  return "oauth_user";
}

export function resolveTransport(): TransportMode {
  const raw = (process.env.QOBRIX_MCP_TRANSPORT || "stdio").toLowerCase().trim();
  if (raw === "http" || raw === "streamable_http" || raw === "streamable-http") {
    return "http";
  }
  return "stdio";
}

export function resolveAuthMode(transport: TransportMode = resolveTransport()): AuthMode {
  if (transport === "stdio") return "env";
  const accepted = acceptedAuthTypes("http");
  if (accepted.length === 1) {
    if (accepted[0] === "none") return "env";
    if (accepted[0] === "api_key") return "headers";
    if (accepted[0] === "signed_header") return "oauth";
    return "oauth_user";
  }
  return "oauth_user";
}

export function modeDescription(mode: AuthMode): string {
  switch (mode) {
    case "env":
      return "none: shared Qobrix credentials from process.env";
    case "headers":
      return "api_key: Authorization Bearer user:key, or X-Api-User and X-Api-Key";
    case "oauth":
      return "signed-header session vaults (legacy), paired with qobrix-crm-mcp-oauth";
    case "oauth_user":
      return "oauth_user: Bearer access token on /mcp";
  }
}
