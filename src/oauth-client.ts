/**
 * the signed-header path — self-service OAuth client for qobrix-crm-mcp.
 *
 * The MCP registers itself (DCR + PKCE) against the paired
 * qobrix-crm-mcp-oauth AS, drives /connect → authorize → /oauth/callback,
 * introspects the access token for Qobrix credentials, and stores them in
 * a **per-user encrypted session vault** keyed by channel-native identity
 * (`vaultKey`, typically `{platform}:{chatUserId}` from X-Chat-* headers).
 *
 * This is MCP "External (third-party) Authorization" (SEP-1036): northbound
 * clients never see Qobrix secrets — only a /connect URL.
 */

import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  hkdfSync,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import {
  mkdirSync,
  readFileSync,
  writeFileSync,
  existsSync,
  unlinkSync,
  renameSync,
  readdirSync,
  statSync,
} from "node:fs";
import { join } from "node:path";
import type { OAuthMetadata } from "@modelcontextprotocol/sdk/shared/auth.js";
import type { AuthCredentials } from "./auth-context.js";
import { DEFAULT_VAULT_KEY } from "./identity.js";
import {
  fetchAuthorizationServerMetadata,
  requireOAuthEnv,
  type IntrospectionResult,
} from "./oauth-rs.js";
import { getRequestVaultKey } from "./request-context.js";

const PENDING_TTL_MS = 10 * 60 * 1000;
const AS_META_TTL_MS = 5 * 60 * 1000;
const CONNECT_COOKIE = "qobrix_mcp_connect";
const CLIENT_FILE = "oauth-client.json";
/** Legacy single-slot vault (pre-1.6.0); migrated into sessions/ as `default`. */
const LEGACY_SESSION_FILE = "session.enc";
const SESSIONS_DIR = "sessions";
const VAULT_HKDF_INFO = "qobrix-mcp-vault-v1";
const REFRESH_SKEW_MS = 60_000;
const PROACTIVE_REFRESH_RATIO = 0.8;
const DEFAULT_MAX_VAULTS = 500;
/** Idle vaults older than this are eligible for eviction (default 30 days). */
const DEFAULT_IDLE_MS = 30 * 24 * 60 * 60 * 1000;

export class AuthRequiredError extends Error {
  readonly connectUrl: string;
  readonly elicitationId: string;

  constructor(opts: {
    connectUrl: string;
    elicitationId: string;
    message?: string;
  }) {
    super(
      opts.message ||
        "Qobrix authorization required. Open the connect URL to sign in."
    );
    this.name = "AuthRequiredError";
    this.connectUrl = opts.connectUrl;
    this.elicitationId = opts.elicitationId;
  }
}

type RegisteredClient = {
  client_id: string;
  client_secret?: string;
  redirect_uri: string;
  issuer: string;
};

type PendingConnect = {
  elicitationId: string;
  state: string;
  codeVerifier: string;
  createdAt: number;
  vaultKey: string;
  /** Optional notifier to fire after successful callback (elicitation clients). */
  completionNotifier?: () => Promise<void>;
};

type SessionRecord = {
  apiUser: string;
  apiKey: string;
  apiUrl?: string;
  locale?: string;
  subject?: string;
  accessToken?: string;
  refreshToken?: string;
  accessExpiresAt?: number;
  /** When the current access token was issued (for proactive 80% refresh). */
  accessIssuedAt?: number;
  /** Last successful use / refresh of this vault (idle eviction). */
  lastAccessAt?: number;
  updatedAt: string;
};

type SessionFile = {
  version: 1;
  vaultKey?: string;
  session: SessionRecord | null;
};

let _client: RegisteredClient | null = null;
/** In-memory vault cache keyed by vaultKey. */
const _sessions = new Map<string, SessionRecord | null>();
const _sessionsLoaded = new Set<string>();
/** One reusable pending connect per vaultKey (unexpired). */
const _activePendingByKey = new Map<string, PendingConnect>();
const _pending = new Map<string, PendingConnect>(); // by elicitationId
const _pendingByState = new Map<string, PendingConnect>();
/** In-flight refresh promises — one per vaultKey (mutex). */
const _refreshLocks = new Map<string, Promise<AuthCredentials | null>>();
let _asMeta: { meta: OAuthMetadata; at: number; issuer: string } | null = null;

async function getAsMetadata(issuer: URL): Promise<OAuthMetadata> {
  const key = issuer.href.replace(/\/+$/, "");
  if (
    _asMeta &&
    _asMeta.issuer === key &&
    Date.now() - _asMeta.at < AS_META_TTL_MS
  ) {
    return _asMeta.meta;
  }
  const meta = await fetchAuthorizationServerMetadata(issuer);
  _asMeta = { meta, at: Date.now(), issuer: key };
  return meta;
}

function clearActivePending(pending: PendingConnect | null): void {
  if (!pending) return;
  const active = _activePendingByKey.get(pending.vaultKey);
  if (active?.elicitationId === pending.elicitationId) {
    _activePendingByKey.delete(pending.vaultKey);
  }
  _pending.delete(pending.elicitationId);
  _pendingByState.delete(pending.state);
}

function dataDir(): string {
  return (
    process.env.QOBRIX_MCP_DATA_DIR || join(process.cwd(), "data", "mcp-oauth")
  );
}

function sessionsDir(): string {
  return join(dataDir(), SESSIONS_DIR);
}

function stateSecret(): string {
  const s =
    process.env.QOBRIX_MCP_STATE_SECRET ||
    process.env.QOBRIX_OAUTH_INTROSPECTION_SECRET ||
    "";
  if (!s || s.length < 16) {
    throw new Error(
      "the signed-header path requires QOBRIX_MCP_STATE_SECRET (16+ chars) for signed cookies and vault encryption"
    );
  }
  return s;
}

/** Normalize vault key; empty/null → default. */
export function normalizeVaultKey(vaultKey?: string | null): string {
  const k = (vaultKey || "").trim();
  return k || DEFAULT_VAULT_KEY;
}

/** Resolve vault key for the current request (ALS) or explicit override. */
export function currentVaultKey(override?: string | null): string {
  if (override !== undefined && override !== null && String(override).trim()) {
    return normalizeVaultKey(override);
  }
  return normalizeVaultKey(getRequestVaultKey());
}

/** Filename-safe hash of vaultKey (not the encryption key). */
function vaultFileId(vaultKey: string): string {
  return createHash("sha256").update(vaultKey).digest("hex").slice(0, 32);
}

function sessionPath(vaultKey: string): string {
  return join(sessionsDir(), `${vaultFileId(vaultKey)}.enc`);
}

/**
 * Per-vault DEK via HKDF(master=STATE_SECRET, salt=vaultKey).
 * Distinct DEKs limit blast radius if a single ciphertext leaks.
 */
function deriveVaultDek(vaultKey: string): Buffer {
  return Buffer.from(
    hkdfSync("sha256", stateSecret(), vaultKey, VAULT_HKDF_INFO, 32)
  );
}

/** Legacy single-key derivation (pre-1.6.0 session.enc). */
function deriveLegacyKey(): Buffer {
  return createHash("sha256").update(stateSecret()).digest();
}

function encryptJson(key: Buffer, plaintext: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const enc = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, enc]).toString("base64url");
}

function decryptJson(key: Buffer, blob: string): string {
  const buf = Buffer.from(blob, "base64url");
  const iv = buf.subarray(0, 12);
  const tag = buf.subarray(12, 28);
  const data = buf.subarray(28);
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString(
    "utf8"
  );
}

/** Atomic write: temp file in same dir + rename. */
function atomicWriteFile(path: string, contents: string): void {
  const dir = join(path, "..");
  mkdirSync(dir, { recursive: true });
  const tmp = `${path}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  writeFileSync(tmp, contents, { mode: 0o600 });
  renameSync(tmp, path);
}

function publicBaseUrl(): string {
  const raw =
    process.env.QOBRIX_MCP_PUBLIC_URL ||
    `http://127.0.0.1:${process.env.QOBRIX_MCP_PORT || "3502"}`;
  return raw.replace(/\/+$/, "");
}

function redirectUri(): string {
  return `${publicBaseUrl()}/oauth/callback`;
}

export function connectUrlFor(elicitationId: string): string {
  return `${publicBaseUrl()}/connect?e=${encodeURIComponent(elicitationId)}`;
}

function pkceChallenge(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

/** Signed cookie value: `${payload}.${hmac}` */
export function signCookie(payload: string): string {
  const sig = createHmac("sha256", stateSecret())
    .update(payload)
    .digest("base64url");
  return `${payload}.${sig}`;
}

export function verifySignedCookie(raw: string | undefined): string | null {
  if (!raw) return null;
  const idx = raw.lastIndexOf(".");
  if (idx <= 0) return null;
  const payload = raw.slice(0, idx);
  const sig = raw.slice(idx + 1);
  const expected = createHmac("sha256", stateSecret())
    .update(payload)
    .digest("base64url");
  if (!safeEqual(sig, expected)) return null;
  return payload;
}

export function parseCookieHeader(
  header: string | undefined,
  name: string
): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const [k, ...rest] = part.trim().split("=");
    if (k === name) return decodeURIComponent(rest.join("="));
  }
  return undefined;
}

export function connectCookieName(): string {
  return CONNECT_COOKIE;
}

function loadRegisteredClient(): RegisteredClient | null {
  if (_client) return _client;
  const path = join(dataDir(), CLIENT_FILE);
  if (!existsSync(path)) return null;
  try {
    _client = JSON.parse(readFileSync(path, "utf8")) as RegisteredClient;
    return _client;
  } catch {
    return null;
  }
}

function persistRegisteredClient(client: RegisteredClient): void {
  const dir = dataDir();
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, CLIENT_FILE), JSON.stringify(client, null, 2), {
    mode: 0o600,
  });
  _client = client;
}

function quarantineBrokenVault(path: string): void {
  try {
    const broken = `${path}.broken.${Date.now()}`;
    renameSync(path, broken);
    unlinkSync(broken);
  } catch {
    try {
      unlinkSync(path);
    } catch {
      /* ignore */
    }
  }
}

function tryDecryptSession(
  path: string,
  key: Buffer
): SessionRecord | null | undefined {
  try {
    const blob = readFileSync(path, "utf8").trim();
    if (!blob) return null;
    const parsed = JSON.parse(decryptJson(key, blob)) as SessionFile;
    return parsed.session;
  } catch {
    return undefined; // undecryptable with this key
  }
}

/**
 * One-time migration: legacy `session.enc` → `sessions/<default>.enc`.
 */
function migrateLegacyDefaultVault(): SessionRecord | null {
  const legacyPath = join(dataDir(), LEGACY_SESSION_FILE);
  if (!existsSync(legacyPath)) return null;
  const session = tryDecryptSession(legacyPath, deriveLegacyKey());
  if (session === undefined) {
    process.stderr.write(
      "[qobrix-crm-mcp] WARNING: legacy session.enc unreadable; quarantining\n"
    );
    quarantineBrokenVault(legacyPath);
    return null;
  }
  if (session === null) {
    try {
      unlinkSync(legacyPath);
    } catch {
      /* ignore */
    }
    return null;
  }
  // Re-persist under keyed vault with HKDF DEK, then remove legacy file.
  persistSession(session, DEFAULT_VAULT_KEY);
  try {
    unlinkSync(legacyPath);
  } catch {
    /* ignore */
  }
  process.stderr.write(
    "[qobrix-crm-mcp] Migrated legacy session.enc → per-user default vault\n"
  );
  return session;
}

function loadSession(vaultKey?: string | null): SessionRecord | null {
  const key = normalizeVaultKey(vaultKey ?? getRequestVaultKey());
  if (_sessionsLoaded.has(key)) {
    return _sessions.get(key) ?? null;
  }
  _sessionsLoaded.add(key);

  const path = sessionPath(key);
  if (existsSync(path)) {
    const session = tryDecryptSession(path, deriveVaultDek(key));
    if (session === undefined) {
      const msg = "decrypt failed";
      process.stderr.write(
        `[qobrix-crm-mcp] WARNING: session vault unreadable (${msg}); clearing and requiring re-auth\n`
      );
      quarantineBrokenVault(path);
      _sessions.set(key, null);
      return null;
    }
    _sessions.set(key, session);
    return session;
  }

  // Migrate legacy single vault only for the default key.
  if (key === DEFAULT_VAULT_KEY) {
    const migrated = migrateLegacyDefaultVault();
    if (migrated) {
      _sessions.set(key, migrated);
      return migrated;
    }
  }

  _sessions.set(key, null);
  return null;
}

function maxVaults(): number {
  const n = Number(process.env.QOBRIX_MCP_MAX_VAULTS || DEFAULT_MAX_VAULTS);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : DEFAULT_MAX_VAULTS;
}

function idleTtlMs(): number {
  const n = Number(process.env.QOBRIX_MCP_VAULT_IDLE_MS || DEFAULT_IDLE_MS);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_IDLE_MS;
}

type VaultMeta = {
  vaultKeyHint: string; // file id
  path: string;
  mtimeMs: number;
};

function listVaultFiles(): VaultMeta[] {
  const dir = sessionsDir();
  if (!existsSync(dir)) return [];
  const out: VaultMeta[] = [];
  for (const name of readdirSync(dir)) {
    if (!name.endsWith(".enc") || name.includes(".tmp") || name.includes(".broken.")) {
      continue;
    }
    const path = join(dir, name);
    try {
      const st = statSync(path);
      out.push({
        vaultKeyHint: name.replace(/\.enc$/, ""),
        path,
        mtimeMs: st.mtimeMs,
      });
    } catch {
      /* skip */
    }
  }
  return out;
}

const EVICT_THROTTLE_MS = 60_000;
let _lastEvictAt = 0;

/**
 * Evict idle / expired-refresh vaults and enforce MAX_VAULTS (LRU by mtime).
 * Never evicts the vault currently being written.
 * Throttled to ~once/60s unless already over the vault cap (forces immediate run).
 */
function evictVaultsIfNeeded(preserveKey: string): void {
  const now = Date.now();
  const files = listVaultFiles();
  const cap = maxVaults();
  const overCap = files.length > cap;
  if (!overCap && now - _lastEvictAt < EVICT_THROTTLE_MS) {
    return;
  }
  _lastEvictAt = now;

  const idleMs = idleTtlMs();
  const preserveId = vaultFileId(preserveKey);

  for (const f of files) {
    if (f.vaultKeyHint === preserveId) continue;
    // Idle by mtime
    if (now - f.mtimeMs > idleMs) {
      try {
        unlinkSync(f.path);
      } catch {
        /* ignore */
      }
      continue;
    }
  }

  // Re-list after idle sweep; LRU trim to max.
  let remaining = listVaultFiles().filter((f) => f.vaultKeyHint !== preserveId);
  // Cap includes the preserved vault slot.
  while (remaining.length >= cap) {
    remaining.sort((a, b) => a.mtimeMs - b.mtimeMs);
    const oldest = remaining.shift();
    if (!oldest) break;
    try {
      unlinkSync(oldest.path);
    } catch {
      /* ignore */
    }
  }
}

function persistSession(
  session: SessionRecord | null,
  vaultKey?: string | null
): void {
  const key = normalizeVaultKey(vaultKey ?? getRequestVaultKey());
  const path = sessionPath(key);
  if (session === null) {
    _sessions.set(key, null);
    _sessionsLoaded.add(key);
    try {
      if (existsSync(path)) unlinkSync(path);
    } catch {
      /* ignore */
    }
    return;
  }

  const now = Date.now();
  const enriched: SessionRecord = {
    ...session,
    lastAccessAt: session.lastAccessAt ?? now,
    updatedAt: session.updatedAt || new Date().toISOString(),
  };

  const dek = deriveVaultDek(key);
  const file: SessionFile = { version: 1, vaultKey: key, session: enriched };
  const blob = encryptJson(dek, JSON.stringify(file));
  mkdirSync(sessionsDir(), { recursive: true });
  atomicWriteFile(path, blob);
  _sessions.set(key, enriched);
  _sessionsLoaded.add(key);
  try {
    evictVaultsIfNeeded(key);
  } catch {
    /* eviction best-effort */
  }
}

/** Count on-disk vault files (for /health). */
export function countSessionVaults(): number {
  return listVaultFiles().length;
}

export function isConnected(vaultKey?: string | null): boolean {
  const s = loadSession(vaultKey);
  return Boolean(s?.apiUser && s?.apiKey);
}

export function getSessionCredentials(
  vaultKey?: string | null
): AuthCredentials | null {
  const key = normalizeVaultKey(vaultKey ?? getRequestVaultKey());
  const s = loadSession(key);
  if (!s?.apiUser || !s?.apiKey) return null;
  // Touch lastAccessAt in memory (persisted on next write/refresh).
  s.lastAccessAt = Date.now();
  _sessions.set(key, s);
  return {
    apiUser: s.apiUser,
    apiKey: s.apiKey,
    apiUrl: s.apiUrl,
    locale: s.locale,
    subject: s.subject,
  };
}

export function clearSession(vaultKey?: string | null): void {
  persistSession(null, vaultKey);
}

/**
 * Full the signed-header path disconnect: revoke at the AS (deletes minted Qobrix API key +
 * AS vault/tokens), fall back to direct Qobrix api-key DELETE if needed, then
 * clear the local session vault for this vaultKey.
 */
export async function revokeSession(
  vaultKey?: string | null
): Promise<{
  revoked: boolean;
  asDisconnect: boolean;
  qobrixKeyDeleted: boolean;
}> {
  const key = normalizeVaultKey(vaultKey ?? getRequestVaultKey());
  // Snapshot before refresh — refreshIfNeeded() clears the vault on failure,
  // which would otherwise skip the Qobrix key DELETE fallback.
  const before = loadSession(key);
  if (!before?.apiUser || !before?.apiKey) {
    clearSession(key);
    return { revoked: false, asDisconnect: false, qobrixKeyDeleted: false };
  }
  const snapshot = {
    apiUser: before.apiUser,
    apiKey: before.apiKey,
    apiUrl: (before.apiUrl || process.env.QOBRIX_API_URL || "").replace(
      /\/+$/,
      ""
    ),
    accessToken: before.accessToken,
  };

  // Best-effort refresh so /disconnect gets a currently-valid Bearer token.
  await refreshIfNeeded(key);
  const after = loadSession(key);
  const accessToken = after?.accessToken || snapshot.accessToken;

  let asDisconnect = false;
  let qobrixKeyDeleted = false;

  // Prefer AS /disconnect (Bearer access token) — deletes key + AS vault.
  if (accessToken) {
    try {
      const { issuer } = requireOAuthEnv();
      const issuerBase = issuer.href.replace(/\/+$/, "");
      const res = await fetch(`${issuerBase}/disconnect`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          Accept: "application/json",
        },
      });
      if (res.ok) {
        asDisconnect = true;
        qobrixKeyDeleted = true;
      } else {
        const text = await res.text().catch(() => "");
        process.stderr.write(
          `[qobrix-crm-mcp] AS /disconnect failed: HTTP ${res.status} ${text}\n`
        );
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(
        `[qobrix-crm-mcp] AS /disconnect error: ${msg}\n`
      );
    }
  }

  // Fallback: delete the minted Qobrix API key directly so it never lingers.
  // Always use the pre-refresh snapshot — refresh may have cleared the vault.
  if (!qobrixKeyDeleted && snapshot.apiUrl) {
    try {
      const res = await fetch(`${snapshot.apiUrl}/api/v2/profile/api-key`, {
        method: "DELETE",
        headers: {
          Accept: "application/json",
          "X-Api-User": snapshot.apiUser,
          "X-Api-Key": snapshot.apiKey,
        },
      });
      if (res.ok || res.status === 204 || res.status === 404) {
        qobrixKeyDeleted = true;
      } else {
        process.stderr.write(
          `[qobrix-crm-mcp] Qobrix api-key DELETE failed: HTTP ${res.status}\n`
        );
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(
        `[qobrix-crm-mcp] Qobrix api-key DELETE error: ${msg}\n`
      );
    }
  }

  clearSession(key);
  return {
    revoked: true,
    asDisconnect,
    qobrixKeyDeleted,
  };
}

export function registerElicitationNotifier(
  elicitationId: string,
  notifier: () => Promise<void>
): void {
  const pending = _pending.get(elicitationId);
  if (pending) pending.completionNotifier = notifier;
}

function purgeExpiredPending(): void {
  const now = Date.now();
  for (const p of [..._pending.values()]) {
    if (now - p.createdAt > PENDING_TTL_MS) {
      clearActivePending(p);
    }
  }
}

/**
 * Ensure this MCP is registered as a confidential DCR client of the companion AS.
 */
export async function ensureClientRegistered(): Promise<RegisteredClient> {
  const { issuer } = requireOAuthEnv();
  const issuerHref = issuer.href.replace(/\/+$/, "");
  const existing = loadRegisteredClient();
  if (
    existing &&
    existing.issuer === issuerHref &&
    existing.redirect_uri === redirectUri() &&
    existing.client_id
  ) {
    return existing;
  }

  const meta = await getAsMetadata(issuer);
  const registerUrl =
    meta.registration_endpoint || new URL("/register", issuer).href;

  const res = await fetch(registerUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({
      client_name: "qobrix-crm-mcp",
      redirect_uris: [redirectUri()],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "client_secret_post",
      scope: "qobrix:read",
    }),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(
      `DCR failed at ${registerUrl}: HTTP ${res.status} ${text}`
    );
  }

  const body = (await res.json()) as {
    client_id: string;
    client_secret?: string;
  };
  if (!body.client_id) {
    throw new Error("DCR response missing client_id");
  }

  const client: RegisteredClient = {
    client_id: body.client_id,
    client_secret: body.client_secret,
    redirect_uri: redirectUri(),
    issuer: issuerHref,
  };
  persistRegisteredClient(client);
  return client;
}

/**
 * Mint a pending connect (PKCE + state + elicitationId) bound to vaultKey.
 * Reuses an active, unexpired pending for the same vaultKey so repeated cold
 * tool calls share one URL. Do not log the full connect URL (capability URL).
 */
export function beginConnect(vaultKey?: string | null): {
  elicitationId: string;
  state: string;
  connectUrl: string;
} {
  const key = normalizeVaultKey(vaultKey ?? getRequestVaultKey());
  purgeExpiredPending();
  const active = _activePendingByKey.get(key);
  if (active && Date.now() - active.createdAt <= PENDING_TTL_MS) {
    return {
      elicitationId: active.elicitationId,
      state: active.state,
      connectUrl: connectUrlFor(active.elicitationId),
    };
  }

  const elicitationId = randomBytes(16).toString("hex");
  const state = randomBytes(24).toString("base64url");
  const codeVerifier = randomBytes(32).toString("base64url");
  const pending: PendingConnect = {
    elicitationId,
    state,
    codeVerifier,
    createdAt: Date.now(),
    vaultKey: key,
  };
  _pending.set(elicitationId, pending);
  _pendingByState.set(state, pending);
  _activePendingByKey.set(key, pending);
  setTimeout(() => {
    const p = _pending.get(elicitationId);
    if (p && p.state === state) {
      clearActivePending(p);
    }
  }, PENDING_TTL_MS).unref?.();

  return {
    elicitationId,
    state,
    connectUrl: connectUrlFor(elicitationId),
  };
}

/**
 * Resolve /connect?e=... → set cookie binding + AS authorize URL.
 */
export async function authorizeRedirect(elicitationId: string): Promise<{
  authorizeUrl: string;
  cookiePayload: string;
}> {
  purgeExpiredPending();
  const pending = _pending.get(elicitationId);
  if (!pending) {
    throw new Error(
      "Unknown or expired connect session. Ask the agent to request authorization again."
    );
  }
  if (Date.now() - pending.createdAt > PENDING_TTL_MS) {
    clearActivePending(pending);
    throw new Error(
      "Connect session expired. Ask the agent to request authorization again."
    );
  }

  const client = await ensureClientRegistered();
  const { issuer, resourceServerUrl } = requireOAuthEnv();
  const meta = await getAsMetadata(issuer);
  const authorizeEndpoint =
    meta.authorization_endpoint || new URL("/authorize", issuer).href;

  const url = new URL(authorizeEndpoint);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", client.client_id);
  url.searchParams.set("redirect_uri", client.redirect_uri);
  url.searchParams.set("scope", "qobrix:read");
  url.searchParams.set("state", pending.state);
  url.searchParams.set("code_challenge", pkceChallenge(pending.codeVerifier));
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("resource", resourceServerUrl.href);

  return {
    authorizeUrl: url.href,
    cookiePayload: pending.state,
  };
}

async function introspectAccessToken(
  accessToken: string
): Promise<IntrospectionResult> {
  const { issuer, introspectionSecret, resourceServerUrl } = requireOAuthEnv();
  const meta = await getAsMetadata(issuer);
  const endpoint =
    meta.introspection_endpoint || new URL("/introspect", issuer).href;

  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: `Bearer ${introspectionSecret}`,
    },
    body: new URLSearchParams({ token: accessToken }).toString(),
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`Introspection failed: HTTP ${response.status} ${text}`);
  }

  const data = (await response.json()) as IntrospectionResult;
  if (!data.active) {
    throw new Error("Token is not active after exchange");
  }
  if (!data.qobrix_api_user || !data.qobrix_api_key) {
    throw new Error(
      "Introspection did not return Qobrix credentials (check introspection secret pairing)"
    );
  }

  // Soft audience check — companion should bind aud to our resource URL.
  if (data.aud) {
    const aud = Array.isArray(data.aud) ? data.aud[0] : data.aud;
    const expected = resourceServerUrl.href.replace(/\/+$/, "");
    const got = String(aud).replace(/\/+$/, "");
    if (got !== expected && !got.startsWith(expected)) {
      process.stderr.write(
        `[qobrix-crm-mcp] WARNING: token aud ${got} != resource ${expected}\n`
      );
    }
  }

  return data;
}

/**
 * Handle AS redirect: verify state + cookie binding, exchange code, vault creds
 * into the pending flow's vaultKey. elicitationId is one-time-use (removed
 * before network I/O to prevent replay).
 */
export async function handleCallback(opts: {
  code: string;
  state: string;
  cookieHeader?: string;
}): Promise<{ elicitationId: string; subject?: string; vaultKey: string }> {
  purgeExpiredPending();

  const cookieRaw = parseCookieHeader(opts.cookieHeader, CONNECT_COOKIE);
  const cookieState = verifySignedCookie(cookieRaw);
  if (!cookieState || !safeEqual(cookieState, opts.state)) {
    throw new Error(
      "Connect cookie / state mismatch. Restart authorization from the agent."
    );
  }

  const pending = _pendingByState.get(opts.state);
  if (!pending) {
    throw new Error(
      "Unknown or already-used authorization state. Restart from the agent."
    );
  }

  // Single-use: remove before network calls to prevent replay.
  const vaultKey = pending.vaultKey;
  clearActivePending(pending);

  const client = await ensureClientRegistered();
  const { issuer, resourceServerUrl } = requireOAuthEnv();
  const meta = await getAsMetadata(issuer);
  const tokenEndpoint = meta.token_endpoint || new URL("/token", issuer).href;

  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code: opts.code,
    redirect_uri: client.redirect_uri,
    client_id: client.client_id,
    code_verifier: pending.codeVerifier,
    resource: resourceServerUrl.href,
  });
  if (client.client_secret) {
    body.set("client_secret", client.client_secret);
  }

  const tokenRes = await fetch(tokenEndpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body: body.toString(),
  });

  if (!tokenRes.ok) {
    const text = await tokenRes.text().catch(() => "");
    throw new Error(`Token exchange failed: HTTP ${tokenRes.status} ${text}`);
  }

  const tokens = (await tokenRes.json()) as {
    access_token: string;
    refresh_token?: string;
    expires_in?: number;
  };
  if (!tokens.access_token) {
    throw new Error("Token response missing access_token");
  }

  const intro = await introspectAccessToken(tokens.access_token);
  const issuedAt = Date.now();
  const expiresAt =
    typeof tokens.expires_in === "number"
      ? issuedAt + tokens.expires_in * 1000
      : intro.exp
        ? intro.exp * 1000
        : undefined;

  persistSession(
    {
      apiUser: intro.qobrix_api_user!,
      apiKey: intro.qobrix_api_key!,
      apiUrl: intro.qobrix_api_url,
      locale: intro.qobrix_locale,
      subject: intro.sub,
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token,
      accessExpiresAt: expiresAt,
      accessIssuedAt: issuedAt,
      lastAccessAt: issuedAt,
      updatedAt: new Date().toISOString(),
    },
    vaultKey
  );

  if (pending.completionNotifier) {
    pending.completionNotifier().catch((err) => {
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(
        `[qobrix-crm-mcp] elicitation complete notify failed: ${msg}\n`
      );
    });
  }

  return {
    elicitationId: pending.elicitationId,
    subject: intro.sub,
    vaultKey,
  };
}

function needsTokenRefresh(s: SessionRecord): boolean {
  if (!s.refreshToken || !s.accessExpiresAt) return false;
  const now = Date.now();
  // Proactive refresh at ~80% of access-token lifetime when issuedAt known.
  if (s.accessIssuedAt && s.accessExpiresAt > s.accessIssuedAt) {
    const ttl = s.accessExpiresAt - s.accessIssuedAt;
    const proactiveAt = s.accessIssuedAt + Math.floor(ttl * PROACTIVE_REFRESH_RATIO);
    return now >= proactiveAt;
  }
  // Legacy records: refresh within 60s of expiry.
  return s.accessExpiresAt - now <= REFRESH_SKEW_MS;
}

/**
 * Whether a failed refresh should destroy the vault.
 * Proactive 80%-TTL refresh must not wipe a still-valid access token /
 * minted Qobrix key on transient AS failures — only dead refresh tokens
 * (invalid_grant) or already-expired access tokens force clear.
 */
export function shouldClearVaultOnRefreshFailure(opts: {
  stillValid: boolean;
  errorBody: string;
}): boolean {
  const deadRefresh = /invalid_grant/i.test(opts.errorBody || "");
  return deadRefresh || !opts.stillValid;
}

async function doRefresh(vaultKey: string): Promise<AuthCredentials | null> {
  // Double-checked read under the caller's mutex slot.
  const s = loadSession(vaultKey);
  if (!s?.apiUser || !s?.apiKey) return null;
  if (!needsTokenRefresh(s)) {
    return getSessionCredentials(vaultKey);
  }

  const stillValid =
    typeof s.accessExpiresAt === "number" &&
    s.accessExpiresAt - Date.now() > REFRESH_SKEW_MS;

  try {
    const client = await ensureClientRegistered();
    const { issuer, resourceServerUrl } = requireOAuthEnv();
    const meta = await getAsMetadata(issuer);
    const tokenEndpoint = meta.token_endpoint || new URL("/token", issuer).href;

    const body = new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: s.refreshToken!,
      client_id: client.client_id,
      resource: resourceServerUrl.href,
    });
    if (client.client_secret) {
      body.set("client_secret", client.client_secret);
    }

    const tokenRes = await fetch(tokenEndpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
      },
      body: body.toString(),
    });

    if (!tokenRes.ok) {
      const errorBody = await tokenRes.text().catch(() => "");
      if (shouldClearVaultOnRefreshFailure({ stillValid, errorBody })) {
        clearSession(vaultKey);
        return null;
      }
      // Access token / Qobrix key still usable — keep vault, retry later.
      process.stderr.write(
        `[qobrix-crm-mcp] WARNING: token refresh HTTP ${tokenRes.status}; keeping vault (access still valid)\n`
      );
      return getSessionCredentials(vaultKey);
    }

    const tokens = (await tokenRes.json()) as {
      access_token: string;
      refresh_token?: string;
      expires_in?: number;
    };
    const intro = await introspectAccessToken(tokens.access_token);
    const issuedAt = Date.now();
    persistSession(
      {
        apiUser: intro.qobrix_api_user!,
        apiKey: intro.qobrix_api_key!,
        apiUrl: intro.qobrix_api_url,
        locale: intro.qobrix_locale,
        subject: intro.sub,
        accessToken: tokens.access_token,
        refreshToken: tokens.refresh_token || s.refreshToken,
        accessExpiresAt:
          typeof tokens.expires_in === "number"
            ? issuedAt + tokens.expires_in * 1000
            : undefined,
        accessIssuedAt: issuedAt,
        lastAccessAt: issuedAt,
        updatedAt: new Date().toISOString(),
      },
      vaultKey
    );
    return getSessionCredentials(vaultKey);
  } catch (err) {
    // Network / transient errors must not destroy a still-valid vault.
    // Authoritative clear happens on Qobrix 401/403 in client.ts.
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(
      `[qobrix-crm-mcp] WARNING: token refresh error (${msg}); keeping vault\n`
    );
    return getSessionCredentials(vaultKey);
  }
}

/**
 * Refresh access token if near / past 80% TTL; returns session credentials or null.
 * Serialized per vaultKey (mutex) so concurrent tool calls share one AS refresh.
 */
export async function refreshIfNeeded(
  vaultKey?: string | null
): Promise<AuthCredentials | null> {
  const key = normalizeVaultKey(vaultKey ?? getRequestVaultKey());
  const inFlight = _refreshLocks.get(key);
  if (inFlight) return inFlight;

  const p = doRefresh(key).finally(() => {
    _refreshLocks.delete(key);
  });
  _refreshLocks.set(key, p);
  return p;
}

/** Test helper — wipe in-memory + on-disk the signed-header path state (tests only). */
export function __resetOauthClientForTests(): void {
  _client = null;
  _sessions.clear();
  _sessionsLoaded.clear();
  _activePendingByKey.clear();
  _asMeta = null;
  _pending.clear();
  _pendingByState.clear();
  _refreshLocks.clear();
  _lastEvictAt = 0;
}

/** Test helper — write a vault record without going through OAuth. */
export function __persistSessionForTests(
  session: SessionRecord | null,
  vaultKey: string
): void {
  persistSession(session, vaultKey);
}
