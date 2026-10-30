/**
 * Identity tool. Sign-in is User OAuth on the client, not a tool.
 * qobrix_whoami returns the current profile.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getAuthContext } from "../auth-context.js";
import { getClient } from "../client.js";
import { resolveAuthMode } from "../auth-types.js";
import { getRequestAuthMode } from "../request-context.js";
import type { AuthMode } from "../auth-types.js";
import { getSessionCredentials } from "../oauth-client.js";
import { WhoAmISchema } from "../schemas.js";
import { errorResult, formatResult } from "./index.js";
import { notifyCredentialsInvalidate } from "../companion-invalidate.js";
import { evictIntrospectionCache } from "../oauth-rs.js";
import { classifyQobrixFailure, probeQobrixApiKey } from "../errors.js";

function effectiveAuthMode(): AuthMode {
  return getRequestAuthMode() ?? resolveAuthMode();
}

type ConnectionStatus =
  | "ok"
  | "not_connected"
  | "qobrix_key_rejected"
  | "qobrix_unavailable";

export function registerSessionTools(server: McpServer): void {
  server.tool(
    "qobrix_whoami",
    "Return the current Qobrix user profile. Use when you need to confirm which CRM identity this session is acting as. Returns email, user_id, display_name, scope, and live connection.status. Notes: a missing session is an error with next_step, not a link. Examples: {}. Related: qobrix_search_help.",
    WhoAmISchema.shape,
    async () => {
      try {
        const mode = effectiveAuthMode();
        const creds = getSessionCredentials();
        const ctx = getAuthContext();
        const client = getClient();
        const apiUrl =
          creds?.apiUrl || ctx?.apiUrl || process.env.QOBRIX_API_URL || "";
        const apiUser =
          creds?.apiUser || ctx?.apiUser || process.env.QOBRIX_API_USER || "";
        const apiKey =
          creds?.apiKey || ctx?.apiKey || process.env.QOBRIX_API_KEY || "";
        const checkedAt = new Date().toISOString();

        let connectionStatus: ConnectionStatus = "not_connected";
        let connectionHttpStatus: number | null = null;

        if (apiUrl && apiUser && apiKey) {
          const probe = await probeQobrixApiKey({ apiUrl, apiUser, apiKey });
          if (probe === "valid") {
            connectionStatus = "ok";
            connectionHttpStatus = 204;
          } else if (probe === "invalid") {
            connectionStatus = "qobrix_key_rejected";
            connectionHttpStatus = 401;
            const token = ctx?.accessToken;
            if (mode === "oauth_user" && token) {
              await notifyCredentialsInvalidate(token);
              evictIntrospectionCache(token);
            }
          } else {
            connectionStatus = "qobrix_unavailable";
          }
        }

        let profile: unknown | undefined;
        let profileSource: "live" | "stored" | undefined;
        if (connectionStatus === "ok") {
          const sessionProbe = await client.tryGetPath("session/");
          if (sessionProbe.ok && sessionProbe.data !== undefined) {
            profile = sessionProbe.data;
            profileSource = "live";
          } else if (apiUser) {
            const userProbe = await client.tryGetPath(`users/${apiUser}`);
            if (userProbe.ok && userProbe.data !== undefined) {
              profile = userProbe.data;
              profileSource = "live";
            }
          }
        }

        const profileRecord =
          profile && typeof profile === "object"
            ? (profile as Record<string, unknown>)
            : undefined;
        const userRecord =
          profileRecord?.user && typeof profileRecord.user === "object"
            ? (profileRecord.user as Record<string, unknown>)
            : profileRecord;
        const emailValue = [userRecord?.email, userRecord?.username, profileRecord?.email]
          .find((v) => typeof v === "string" && v.includes("@"));
        const nameValue = [userRecord?.name, userRecord?.display_name, profileRecord?.name]
          .find((v) => typeof v === "string" && v.trim());
        const idValue = [userRecord?.id, profileRecord?.id].find(
          (v) => typeof v === "string" || typeof v === "number"
        );

        const payload: Record<string, unknown> = {
          email: typeof emailValue === "string" ? emailValue : null,
          user_id: idValue != null ? String(idValue) : apiUser || null,
          display_name: typeof nameValue === "string" ? nameValue : null,
          scope: "qobrix:read",
          auth_mode: mode,
          connection: {
            status: connectionStatus,
            checked_at: checkedAt,
            http_status: connectionHttpStatus,
          },
          identity_source: profileSource ?? "stored",
        };
        if (mode === "oauth_user" && (creds?.subject || ctx?.subject)) {
          payload.oauth_subject = creds?.subject || ctx?.subject;
        }
        if (apiUser) payload.api_user = apiUser;

        if (connectionStatus === "qobrix_key_rejected") {
          const c = classifyQobrixFailure({
            httpStatus: 401,
            authMode: mode,
            body: { errors: ["Unauthorized"] },
            keyProbe: "invalid",
            credentialsInvalidated: mode === "oauth_user",
          });
          payload.user_action = c.user_action;
          payload.not_the_cause = c.not_the_cause;
        } else if (connectionStatus === "not_connected") {
          payload.user_action =
            mode === "oauth_user"
              ? "Connect Qobrix CRM in your client and complete sign-in."
              : "Provide Qobrix API credentials for this session.";
        }

        if (profile !== undefined) {
          payload.profile = profile;
          payload.profile_source = profileSource;
        } else if (connectionStatus === "qobrix_unavailable" && !profile) {
          payload.profile_unavailable =
            "Could not verify the live connection. Identity above may be from a prior session.";
        }
        return formatResult(payload);
      } catch (error) {
        return errorResult(error, "qobrix_whoami");
      }
    }
  );
}
