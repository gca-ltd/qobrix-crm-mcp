/**
 * Per-request MCP server handle so tool handlers can inspect client
 * capabilities (e.g. URL-mode elicitation) and send completion notifications.
 * Also carries the the signed-header path vaultKey for per-user session isolation.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AuthMode } from "./auth-types.js";
import { DEFAULT_VAULT_KEY } from "./identity.js";

export type RequestContext = {
  mcpServer?: McpServer;
  /** the signed-header path per-user vault key (`{platform}:{userId}` or `default`). */
  vaultKey?: string;
  /** HTTP auth mode for this MCP request (dual-mode per-path routing). */
  authMode?: AuthMode;
};

const requestStorage = new AsyncLocalStorage<RequestContext>();

export function runWithRequestContext<T>(
  ctx: RequestContext,
  fn: () => Promise<T>
): Promise<T> {
  return requestStorage.run(ctx, fn);
}

export function getRequestContext(): RequestContext | undefined {
  return requestStorage.getStore();
}

export function getRequestMcpServer(): McpServer | undefined {
  return requestStorage.getStore()?.mcpServer;
}

export function getRequestVaultKey(): string {
  return requestStorage.getStore()?.vaultKey || DEFAULT_VAULT_KEY;
}

/** Per-request auth mode when dual HTTP mode is active; undefined on stdio. */
export function getRequestAuthMode(): AuthMode | undefined {
  return requestStorage.getStore()?.authMode;
}

/** True when the connected client declared elicitation.url capability. */
export function clientSupportsUrlElicitation(): boolean {
  const caps = getRequestMcpServer()?.server.getClientCapabilities();
  const elicitation = caps?.elicitation as
    | { url?: boolean; form?: boolean }
    | undefined;
  return Boolean(elicitation?.url);
}
