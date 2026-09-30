/**
 * Session / identity tools for the signed-header path (and sensible no-ops for none and api_key).
 *
 * - qobrix_sign_in  — start interactive OAuth connect (or report already signed in)
 * - qobrix_sign_out — full revoke (AS /disconnect + Qobrix api-key DELETE + local vault)
 * - qobrix_whoami   — current user profile + capabilities + portals
 *
 * the signed-header path vaults are per-user: keyed by the channel-native identity forwarded
 * as X-Chat-* headers (individual human). Deliver /connect links only to that
 * individual — never into a shared/group thread.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getAuthContext } from "../auth-context.js";
import { getClient } from "../client.js";
import { resolveAuthMode, modeDescription } from "../auth-types.js";
import { getRequestAuthMode } from "../request-context.js";
import type { AuthMode } from "../auth-types.js";

function effectiveAuthMode(): AuthMode {
  return getRequestAuthMode() ?? resolveAuthMode();
}
import {
  AuthRequiredError,
  beginConnect,
  getSessionCredentials,
  isConnected,
  revokeSession,
} from "../oauth-client.js";
import { SignInSchema, SignOutSchema, WhoAmISchema } from "../schemas.js";
import { errorResult, formatResult } from "./index.js";

function textResult(text: string) {
  return {
    content: [{ type: "text" as const, text }],
  };
}

/** Prefer a human-readable identity; avoid dumping raw SHA-256 OAuth subjects. */
function displayIdentity(opts: {
  subject?: string;
  apiUser?: string;
}): string {
  const sub = opts.subject?.trim();
  if (sub && !/^[a-f0-9]{40,}$/i.test(sub) && sub.length < 80) {
    return sub;
  }
  if (opts.apiUser) return opts.apiUser;
  return "your Qobrix account";
}

export function registerSessionTools(server: McpServer): void {
  server.tool(
    "qobrix_sign_in",
    "Start interactive Qobrix sign-in (the signed-header path only). " +
      "When not connected, returns a Sign In to Qobrix link (or native URL elicitation) " +
      "for the user to complete login + 2FA + consent. " +
      "When already connected, reports the current identity. " +
      "In none and api_key this is a no-op — credentials come from env / request headers. " +
      "the signed-header path uses a per-user encrypted session vault keyed by the chat identity " +
      "(X-Chat-Platform / X-Chat-User-Id). Deliver the Sign In link only to that " +
      "individual — never post it into a shared/group thread.",
    SignInSchema.shape,
    async () => {
      try {
        const mode = effectiveAuthMode();
        if (mode !== "oauth") {
          return textResult(
            `This MCP instance authenticates via ${modeDescription(mode)}; ` +
              "interactive sign-in is not required."
          );
        }
        if (isConnected()) {
          const creds = getSessionCredentials();
          const identity = displayIdentity({
            subject: creds?.subject,
            apiUser: creds?.apiUser,
          });
          return textResult(
            `Already signed in to Qobrix (identity \`${identity}\`). ` +
              "Use `qobrix_sign_out` to disconnect."
          );
        }
        const { elicitationId, connectUrl } = beginConnect();
        throw new AuthRequiredError({ elicitationId, connectUrl });
      } catch (error) {
        return errorResult(error);
      }
    }
  );

  server.tool(
    "qobrix_sign_out",
    "Sign out of Qobrix (the signed-header path only). Fully revokes the current user's session: " +
      "calls the Authorization Server /disconnect (deletes the minted Qobrix API key " +
      "and clears AS tokens/vault), then clears this user's local encrypted session vault. " +
      "Other users' vaults on this MCP process are not affected. " +
      "In none and api_key there is no interactive session to clear.",
    SignOutSchema.shape,
    async () => {
      try {
        const mode = effectiveAuthMode();
        if (mode !== "oauth") {
          return textResult(
            `No interactive session to clear in ${modeDescription(mode)}.`
          );
        }
        if (!isConnected()) {
          return textResult("No active Qobrix session.");
        }
        const result = await revokeSession();
        return formatResult({
          ok: true,
          message:
            "Signed out of Qobrix. The AS session was revoked, the minted API key " +
            "was deleted (when possible), and your local vault was cleared.",
          ...result,
        });
      } catch (error) {
        return errorResult(error);
      }
    }
  );

  server.tool(
    "qobrix_whoami",
    "Return the current Qobrix user profile, capabilities, and portals " +
      "(GET /api/v2/session/). In the signed-header path with no session for this chat identity, " +
      "surfaces a Sign In link so the user can authenticate first. Also includes " +
      "the OAuth subject when available. Use to confirm which CRM identity the " +
      "agent is acting as for this user.",
    WhoAmISchema.shape,
    async () => {
      try {
        const mode = effectiveAuthMode();
        const creds = getSessionCredentials();
        const ctx = getAuthContext();

        // Cold the signed-header path: throw AuthRequiredError → Sign In link. Never probes
        // session/ through fetchUpstream (that would clear the vault on 401).
        const client = getClient();

        const userId =
          creds?.apiUser ||
          ctx?.apiUser ||
          process.env.QOBRIX_API_USER ||
          "";

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

        const profileRecord = profile && typeof profile === "object"
          ? profile as Record<string, unknown>
          : undefined;
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
        if (mode === "oauth" && creds?.subject) {
          payload.oauth_subject = creds.subject;
        }
        if (creds?.apiUser || ctx?.apiUser) {
          payload.api_user = creds?.apiUser || ctx?.apiUser;
        }
        if (profile !== undefined) {
          payload.profile = profile;
          payload.profile_source = profileSource;
        } else {
          payload.profile_unavailable =
            "Could not load live profile (session/ may require a JWT; " +
            "users/{id} probe also failed). Identity above is from the local vault / request.";
        }
        return formatResult(payload);
      } catch (error) {
        return errorResult(error);
      }
    }
  );
}
