/**
 * Notify qobrix-crm-mcp-oauth that a stored Qobrix key is dead (oauth_user path).
 */

import { requireOAuthEnv } from "./oauth-rs.js";

export async function notifyCredentialsInvalidate(
  accessToken: string
): Promise<{ invalidated: boolean }> {
  const { issuer, introspectionSecret } = requireOAuthEnv();
  const url = new URL("credentials/invalidate", issuer);
  try {
    const res = await fetch(url.href, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${introspectionSecret}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({ token: accessToken }).toString(),
      signal: AbortSignal.timeout(8_000),
    });
    if (!res.ok) return { invalidated: false };
    const data = (await res.json()) as { invalidated?: boolean };
    return { invalidated: Boolean(data.invalidated) };
  } catch {
    return { invalidated: false };
  }
}
