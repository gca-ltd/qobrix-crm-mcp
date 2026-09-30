/**
 * Signed chat-identity assertion for the signed-header path per-user vaults.
 *
 * ragchat (or any trusted loopback caller) sends:
 *   X-Chat-Platform, X-Chat-User-Id, X-Chat-Identity-Iat,
 *   X-Chat-Identity-Exp, X-Chat-Identity-Sig
 *
 * Sig = HMAC-SHA256(QOBRIX_MCP_IDENTITY_SECRET, `${platform}|${userId}|${iat}|${exp}`)
 * encoded as base64url. The identity secret is dedicated (separate from
 * QOBRIX_MCP_STATE_SECRET used for vault encryption + cookies).
 */

import { createHmac, timingSafeEqual } from "node:crypto";

export const DEFAULT_VAULT_KEY = "default";

/** Max clock skew accepted on iat (seconds). */
const IAT_SKEW_SEC = 60;
/** Default assertion lifetime when caller omits exp (seconds). */
const DEFAULT_TTL_SEC = 300;

function identitySecret(): string | null {
  const s = (process.env.QOBRIX_MCP_IDENTITY_SECRET || "").trim();
  if (!s || s.length < 16) return null;
  return s;
}

function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

function payload(platform: string, userId: string, iat: number, exp: number): string {
  return `${platform}|${userId}|${iat}|${exp}`;
}

export function signChatIdentity(opts: {
  platform: string;
  userId: string;
  ttlSec?: number;
  nowSec?: number;
}): { iat: number; exp: number; sig: string } | null {
  const secret = identitySecret();
  if (!secret) return null;
  const now = opts.nowSec ?? Math.floor(Date.now() / 1000);
  const iat = now;
  const exp = now + (opts.ttlSec ?? DEFAULT_TTL_SEC);
  const sig = createHmac("sha256", secret)
    .update(payload(opts.platform, opts.userId, iat, exp))
    .digest("base64url");
  return { iat, exp, sig };
}

export function verifyChatIdentity(opts: {
  platform: string;
  userId: string;
  iatRaw: string;
  expRaw: string;
  sig: string;
  nowSec?: number;
}): boolean {
  const secret = identitySecret();
  if (!secret) return false;
  const iat = Number(opts.iatRaw);
  const exp = Number(opts.expRaw);
  if (!Number.isFinite(iat) || !Number.isFinite(exp)) return false;
  const now = opts.nowSec ?? Math.floor(Date.now() / 1000);
  if (iat > now + IAT_SKEW_SEC) return false;
  if (exp < now) return false;
  if (exp - iat > 3600) return false; // refuse absurdly long assertions
  const expected = createHmac("sha256", secret)
    .update(payload(opts.platform, opts.userId, iat, exp))
    .digest("base64url");
  return safeEqual(expected, opts.sig);
}

export function identitySecretConfigured(): boolean {
  return identitySecret() !== null;
}

/**
 * Resolve vault key from chat-identity headers.
 *
 * - Verified signed identity → `{platform}:{userId}`
 * - No user id → `default`
 * - User id present but identity secret configured and sig invalid → `default`
 *   (refuse to select a claimed vault; cannot impersonate)
 * - User id present, secret not configured → `{platform}:{userId}` (legacy / loopback)
 */
export function resolveVaultKeyFromHeaders(headers: {
  platform?: string;
  userId?: string;
  iat?: string;
  exp?: string;
  sig?: string;
}): { vaultKey: string; verified: boolean; reason: string } {
  const platform = (headers.platform || "").trim() || "web";
  const userId = (headers.userId || "").trim();
  if (!userId) {
    return { vaultKey: DEFAULT_VAULT_KEY, verified: false, reason: "no-user" };
  }

  const requireSig = identitySecretConfigured();
  if (requireSig) {
    const ok = verifyChatIdentity({
      platform,
      userId,
      iatRaw: headers.iat || "",
      expRaw: headers.exp || "",
      sig: headers.sig || "",
    });
    if (!ok) {
      return {
        vaultKey: DEFAULT_VAULT_KEY,
        verified: false,
        reason: "bad-signature",
      };
    }
    return {
      vaultKey: `${platform}:${userId}`,
      verified: true,
      reason: "verified",
    };
  }

  return {
    vaultKey: `${platform}:${userId}`,
    verified: false,
    reason: "unsigned-accepted",
  };
}

/** Hash vaultKey for audit logs (never log the raw key if it contains PII). */
export function vaultKeyAuditHash(vaultKey: string): string {
  return createHmac("sha256", "qobrix-mcp-audit")
    .update(vaultKey)
    .digest("hex")
    .slice(0, 12);
}
