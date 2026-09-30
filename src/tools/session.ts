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

function effectiveAuthMode(): AuthMode {
  return getRequestAuthMode() ?? resolveAuthMode();
}

export function registerSessionTools(server: McpServer): void {
  server.tool(
    "qobrix_whoami",
    "Return the current Qobrix user profile. Use when you need to confirm which CRM identity this session is acting as. Returns email, user_id, display_name, and scope. Notes: a missing session is an error with next_step, not a link. Examples: {}. Related: qobrix_search_help.",
    WhoAmISchema.shape,
    async () => {
      try {
        const mode = effectiveAuthMode();
        const creds = getSessionCredentials();
        const ctx = getAuthContext();
        const client = getClient();
        const userId = creds?.apiUser || ctx?.apiUser || process.env.QOBRIX_API_USER || "";

        let profile: unknown | undefined;
        let profileSource: string | undefined;
        const sessionProbe = await client.tryGetPath("session/");
        if (sessionProbe.ok && sessionProbe.data !== undefined) {
          profile = sessionProbe.data;
          profileSource = "session";
        } else if (userId) {
          const userProbe = await client.tryGetPath(`users/${userId}`);
          if (userProbe.ok && userProbe.data !== undefined) {
            profile = userProbe.data;
            profileSource = "users";
          }
        }

        const profileRecord = profile && typeof profile === "object" ? profile as Record<string, unknown> : undefined;
        const userRecord = profileRecord?.user && typeof profileRecord.user === "object"
          ? profileRecord.user as Record<string, unknown>
          : profileRecord;
        const emailValue = [userRecord?.email, userRecord?.username, profileRecord?.email]
          .find((v) => typeof v === "string" && v.includes("@"));
        const nameValue = [userRecord?.name, userRecord?.display_name, profileRecord?.name]
          .find((v) => typeof v === "string" && v.trim());
        const idValue = [userRecord?.id, profileRecord?.id].find((v) => typeof v === "string" || typeof v === "number");

        const payload: Record<string, unknown> = {
          email: typeof emailValue === "string" ? emailValue : null,
          user_id: idValue != null ? String(idValue) : userId || null,
          display_name: typeof nameValue === "string" ? nameValue : null,
          scope: "qobrix:read",
          auth_mode: mode,
        };
        if (mode === "oauth" && creds?.subject) payload.oauth_subject = creds.subject;
        if (creds?.apiUser || ctx?.apiUser) payload.api_user = creds?.apiUser || ctx?.apiUser;
        if (profile !== undefined) {
          payload.profile = profile;
          payload.profile_source = profileSource;
        } else {
          payload.profile_unavailable = "Could not load the live profile. Identity above is from the local vault or the request.";
        }
        return formatResult(payload);
      } catch (error) {
        return errorResult(error);
      }
    }
  );
}
