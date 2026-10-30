/**
 * Qobrix upstream error taxonomy for MCP tool responses.
 * Grounded in OpenAPI ErrorResponse { errors: string[] } and live status codes.
 */

import type { AuthMode } from "./auth-types.js";

export type FixOwner = "user" | "qobrix_admin" | "bridge_operator" | "agent";

export type QobrixErrorCode =
  | "qobrix_key_rejected"
  | "qobrix_auth_unconfirmed"
  | "qobrix_key_invalid"
  | "qobrix_forbidden"
  | "qobrix_not_found"
  | "bridge_route_missing"
  | "invalid_arguments"
  | "qobrix_server_error"
  | "qobrix_rate_limited"
  | "qobrix_unavailable"
  | "bridge_error";

export type ClassifiedQobrixError = {
  code: QobrixErrorCode;
  http_status: number;
  retryable: boolean;
  fix_owner: FixOwner;
  user_action: string;
  not_the_cause?: string;
  qobrix_message: string;
};

export class QobrixApiError extends Error {
  readonly classification: ClassifiedQobrixError;

  constructor(classification: ClassifiedQobrixError) {
    const line = formatErrorHeadline(classification);
    super(line);
    this.name = "QobrixApiError";
    this.classification = classification;
  }
}

export function qobrixErrorMessages(body: unknown): string[] {
  if (!body || typeof body !== "object") return [];
  const errors = (body as { errors?: unknown }).errors;
  if (!Array.isArray(errors)) return [];
  return errors
    .map((e) => {
      if (typeof e === "string") return e;
      if (e && typeof e === "object" && "message" in e) {
        const m = (e as { message?: unknown }).message;
        return typeof m === "string" ? m : "";
      }
      return "";
    })
    .filter(Boolean);
}

export function formatErrorHeadline(c: ClassifiedQobrixError): string {
  return `${c.user_action} [${c.code}]`;
}

export function classifyQobrixFailure(opts: {
  httpStatus: number;
  authMode: AuthMode;
  body: unknown;
  /** When set, refines 401 for oauth_user. */
  keyProbe?: "valid" | "invalid" | "unknown";
}): ClassifiedQobrixError {
  const msgs = qobrixErrorMessages(opts.body);
  const qobrix_message =
    msgs.join("; ") || `HTTP ${opts.httpStatus}`;

  const { httpStatus: status, authMode, keyProbe } = opts;

  if (status === 401) {
    if (authMode === "oauth_user") {
      if (keyProbe === "valid") {
        return {
          code: "qobrix_auth_unconfirmed",
          http_status: status,
          retryable: false,
          fix_owner: "qobrix_admin",
          user_action:
            "Qobrix accepted your saved API key but refused this endpoint. Ask a Qobrix admin to check this user's permissions for the resource you requested.",
          not_the_cause:
            "The MCP connector or a shared service token — your saved key is still valid.",
          qobrix_message,
        };
      }
      return {
        code: "qobrix_key_rejected",
        http_status: status,
        retryable: false,
        fix_owner: "user",
        user_action:
          "Qobrix rejected the saved API key for this connection, so it was reset. Reconnect Qobrix CRM in your connector settings and sign in again with your Qobrix credentials.",
        not_the_cause:
          "The MCP connector itself, the MCP server being down, or a shared service token — there is no shared token; each user has their own Qobrix API key.",
        qobrix_message,
      };
    }
    if (authMode === "headers") {
      return {
        code: "qobrix_key_invalid",
        http_status: status,
        retryable: false,
        fix_owner: "user",
        user_action:
          "The Qobrix API key in this client configuration is not accepted. Update X-Api-User / X-Api-Key (or Bearer user:key) with a valid key from Qobrix.",
        not_the_cause: "A connector OAuth flow — this mode uses credentials you configure directly.",
        qobrix_message,
      };
    }
    return {
      code: "qobrix_key_invalid",
      http_status: status,
      retryable: false,
      fix_owner: "user",
      user_action: "Sign in again or update the Qobrix API credentials for this session.",
      qobrix_message,
    };
  }

  if (status === 403) {
    return {
      code: "qobrix_forbidden",
      http_status: status,
      retryable: false,
      fix_owner: "qobrix_admin",
      user_action:
        "You are signed in to Qobrix, but this account cannot access the requested data. Ask a Qobrix admin to adjust role permissions. Reconnecting will not help.",
      not_the_cause: "An expired connector or MCP token.",
      qobrix_message,
    };
  }

  if (status === 404) {
    if (qobrix_message.includes("A route matching")) {
      return {
        code: "bridge_route_missing",
        http_status: status,
        retryable: false,
        fix_owner: "bridge_operator",
        user_action:
          "This MCP server called a Qobrix API path that does not exist. Report the tool name and arguments to the bridge operator.",
        not_the_cause: "Wrong record ID or search arguments from the agent.",
        qobrix_message,
      };
    }
    return {
      code: "qobrix_not_found",
      http_status: status,
      retryable: false,
      fix_owner: "agent",
      user_action:
        "The record was not found or is not visible to this Qobrix user. Verify the ID or broaden the search.",
      qobrix_message,
    };
  }

  if (status === 400 || status === 422) {
    return {
      code: "invalid_arguments",
      http_status: status,
      retryable: false,
      fix_owner: "agent",
      user_action:
        "Fix the tool arguments using Qobrix's message below, then call the tool again.",
      qobrix_message,
    };
  }

  if (status === 429) {
    return {
      code: "qobrix_rate_limited",
      http_status: status,
      retryable: true,
      fix_owner: "agent",
      user_action: "Qobrix rate-limited this request. Wait briefly and retry.",
      qobrix_message,
    };
  }

  if (status === 502 || status === 503 || status === 504) {
    return {
      code: "qobrix_unavailable",
      http_status: status,
      retryable: true,
      fix_owner: "user",
      user_action: "Qobrix is temporarily unreachable. Retry later.",
      not_the_cause: "Your sign-in or API key.",
      qobrix_message,
    };
  }

  if (status >= 500 && status <= 599) {
    return {
      code: "qobrix_server_error",
      http_status: status,
      retryable: true,
      fix_owner: "qobrix_admin",
      user_action:
        "Qobrix returned a server error. Retry once; if it persists, contact Qobrix support.",
      not_the_cause: "Invalid API credentials.",
      qobrix_message,
    };
  }

  return {
    code: "bridge_error",
    http_status: status,
    retryable: false,
    fix_owner: "bridge_operator",
    user_action: "An unexpected Qobrix response occurred. Report this to the bridge operator.",
    qobrix_message,
  };
}

export type ApiKeyProbeResult = "valid" | "invalid" | "unknown";

export async function probeQobrixApiKey(opts: {
  apiUrl: string;
  apiUser: string;
  apiKey: string;
}): Promise<ApiKeyProbeResult> {
  const base = opts.apiUrl.replace(/\/+$/, "");
  try {
    const res = await fetch(`${base}/api/v2/profile/api-key`, {
      method: "GET",
      headers: {
        Accept: "application/json",
        "X-Api-User": opts.apiUser,
        "X-Api-Key": opts.apiKey,
      },
    });
    if (res.status === 204) return "valid";
    if (res.status === 401) return "invalid";
    return "unknown";
  } catch {
    return "unknown";
  }
}
