/**
 * Auth modes for qobrix-crm-mcp (open-core).
 *
 * A — stdio + env shared key (default, local/single-tenant).
 * B — HTTP + per-request X-Api-User / X-Api-Key (trusted callers, localhost).
 * C — HTTP + self-service OAuth client paired ONLY with qobrix-crm-mcp-oauth.
 *     The MCP obtains Qobrix credentials via third-party authorization
 *     (URL-mode elicitation / tool-result URL + /connect → AS login).
 *     Northbound MCP clients need no bearer token.
 * D — HTTP + Claude.ai / Desktop remote-connector OAuth Resource Server
 *     (opt-in). Northbound clients (Claude) discover the AS via RFC 9728 PRM,
 *     complete DCR + PKCE, and send Authorization: Bearer on every /mcp call.
 *     Unauthenticated /mcp returns 401 + WWW-Authenticate. Modes A/B/C are
 *     unchanged; select Mode D only with QOBRIX_MCP_AUTH=oauth-claude.
 *
 * Trust boundaries:
 * - A: process owner controls env secrets; one shared Qobrix identity.
 * - B: caller is trusted (same host / private network); credentials are
 *   request-scoped and must never be logged. Bind to 127.0.0.1 by default.
 * - C: MCP is the OAuth client + per-user session holder. End-user authenticates
 *   at qobrix-crm-mcp-oauth; this server stores Qobrix API keys in encrypted
 *   per-user session vaults keyed by chat identity (X-Chat-* headers). Pin /mcp
 *   to loopback / trusted net and set QOBRIX_MCP_IDENTITY_SECRET so identity
 *   headers cannot be forged. No third-party authorization servers.
 * - D: MCP is the OAuth Resource Server for Claude custom connectors. Publish
 *   HTTPS /mcp + PRM publicly; pair with the same Enterprise OAuth AS as Mode C.
 */

export type AuthMode = "env" | "headers" | "oauth" | "oauth-claude";

export type TransportMode = "stdio" | "http";

/** Mode D northbound MCP path (Claude / Dust / Cursor). */
export const MCP_PATH_MODE_D = "/mcp";

/** Mode C northbound MCP path (Matrix Digital Employees / ragchat). */
export const MCP_PATH_MODE_C = "/mcp-c";

/**
 * When true, one process serves both /mcp (Mode D) and /mcp-c (Mode C) with
 * per-path auth. Claude/Dust/Cursor keep /mcp; trusted loopback clients use
 * /mcp-c without Bearer.
 */
export function isDualHttpMode(): boolean {
  const raw = (process.env.QOBRIX_MCP_DUAL_MODE || "").toLowerCase().trim();
  return raw === "1" || raw === "true" || raw === "yes";
}

/** Auth mode for a registered MCP HTTP path, or null if unknown. */
export function authModeForMcpPath(path: string): AuthMode | null {
  const normalized = path.replace(/\/+$/, "") || "/";
  if (normalized === MCP_PATH_MODE_D) return "oauth-claude";
  if (normalized === MCP_PATH_MODE_C) return "oauth";
  return null;
}

export function resolveTransport(): TransportMode {
  const raw = (process.env.QOBRIX_MCP_TRANSPORT || "stdio").toLowerCase().trim();
  if (raw === "http" || raw === "streamable_http" || raw === "streamable-http") {
    return "http";
  }
  return "stdio";
}

/**
 * Resolve the HTTP auth mode. Stdio always uses env credentials (Mode A).
 * HTTP defaults to headers (Mode B) unless QOBRIX_MCP_AUTH selects oauth (C)
 * or oauth-claude (D). Existing env/headers/oauth mappings are unchanged.
 */
export function resolveAuthMode(transport: TransportMode = resolveTransport()): AuthMode {
  if (transport === "stdio") return "env";
  const raw = (process.env.QOBRIX_MCP_AUTH || "headers").toLowerCase().trim();
  // Mode D selectors — checked before Mode C so "oauth-claude" is not
  // mis-parsed as starting with "oauth".
  if (raw === "oauth-claude" || raw === "claude" || raw === "d") {
    return "oauth-claude";
  }
  if (raw === "oauth" || raw === "oauth2" || raw === "c") return "oauth";
  if (raw === "env" || raw === "a") return "env";
  return "headers";
}

export function modeDescription(mode: AuthMode): string {
  switch (mode) {
    case "env":
      return "Mode A: shared Qobrix credentials from process.env";
    case "headers":
      return "Mode B: per-request X-Api-User / X-Api-Key (trusted callers)";
    case "oauth":
      return "Mode C: self-service OAuth client + per-user vaults (paired with qobrix-crm-mcp-oauth)";
    case "oauth-claude":
      return "Mode D: Claude.ai / Desktop remote connector (RFC 9728 PRM + Bearer on /mcp)";
  }
}
