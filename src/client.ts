import type {
  QobrixPaginatedResponse,
  QobrixSingleResponse,
  QobrixErrorResponse,
  ListOpts,
  GetOpts,
  ChangesOpts,
} from "./types.js";
import { getCache, cacheKey } from "./cache.js";
import {
  getAuthContext,
  credentialFingerprint,
  type AuthCredentials,
} from "./auth-context.js";
import { resolveAuthMode } from "./modes.js";
import type { AuthMode } from "./modes.js";
import { getRequestAuthMode } from "./request-context.js";

function effectiveAuthMode(): AuthMode {
  return getRequestAuthMode() ?? resolveAuthMode();
}
import {
  AuthRequiredError,
  beginConnect,
  clearSession,
} from "./oauth-client.js";

export { AuthRequiredError } from "./oauth-client.js";

/**
 * Coerce tool `sort` into the OpenAPI `sort[]` array form.
 * Accepts a string, comma-separated multi-key string, or string[].
 */
export function normalizeSort(
  sort?: string | string[]
): string[] | undefined {
  if (sort === undefined || sort === null) return undefined;
  const arr = Array.isArray(sort) ? sort : String(sort).split(",");
  const cleaned = arr.map((s) => s.trim()).filter(Boolean);
  return cleaned.length ? cleaned : undefined;
}

/**
 * Build a Qobrix `/api/v2/...` URL. Array values are emitted as `key[]=`
 * (OpenAPI form for `sort[]`, `fields[]`, `include[]`).
 */
export function buildQobrixUrl(
  baseUrl: string,
  path: string,
  params?: Record<string, string | string[] | boolean | number | undefined>
): string {
  const url = new URL(`${baseUrl.replace(/\/+$/, "")}/api/v2/${path}`);

  if (params) {
    for (const [key, value] of Object.entries(params)) {
      if (value === undefined || value === null) continue;

      if (Array.isArray(value)) {
        for (const item of value) {
          url.searchParams.append(`${key}[]`, String(item));
        }
      } else {
        url.searchParams.set(key, String(value));
      }
    }
  }

  return url.toString();
}

export type QobrixClientOptions = {
  apiUrl: string;
  apiUser: string;
  apiKey: string;
  locale?: string;
};

export class QobrixClient {
  private baseUrl: string;
  private headers: Record<string, string>;
  readonly fingerprint: string;

  constructor(opts: QobrixClientOptions) {
    if (!opts.apiUrl || !opts.apiUser || !opts.apiKey) {
      throw new Error(
        "Missing required Qobrix credentials: apiUrl, apiUser, apiKey"
      );
    }

    this.baseUrl = opts.apiUrl.replace(/\/+$/, "");
    this.headers = {
      "X-Api-User": opts.apiUser,
      "X-Api-Key": opts.apiKey,
      Accept: "application/json",
    };
    if (opts.locale) {
      this.headers["X-Locale"] = opts.locale;
    }
    this.fingerprint = credentialFingerprint({
      apiUrl: this.baseUrl,
      apiUser: opts.apiUser,
      apiKey: opts.apiKey,
    });
  }

  static fromEnv(env: NodeJS.ProcessEnv = process.env): QobrixClient {
    const url = env.QOBRIX_API_URL;
    const apiUser = env.QOBRIX_API_USER;
    const apiKey = env.QOBRIX_API_KEY;
    if (!url || !apiUser || !apiKey) {
      throw new Error(
        "Missing required environment variables: QOBRIX_API_URL, QOBRIX_API_USER, QOBRIX_API_KEY"
      );
    }
    return new QobrixClient({
      apiUrl: url,
      apiUser,
      apiKey,
      locale: env.QOBRIX_LOCALE,
    });
  }

  static fromContext(creds: AuthCredentials): QobrixClient {
    const apiUrl = creds.apiUrl || process.env.QOBRIX_API_URL;
    if (!apiUrl) {
      throw new Error(
        "Missing Qobrix API URL: set QOBRIX_API_URL or include apiUrl in auth context"
      );
    }
    return new QobrixClient({
      apiUrl,
      apiUser: creds.apiUser,
      apiKey: creds.apiKey,
      locale: creds.locale || process.env.QOBRIX_LOCALE,
    });
  }

  private buildUrl(path: string, params?: Record<string, string | string[] | boolean | number | undefined>): string {
    return buildQobrixUrl(this.baseUrl, path, params);
  }

  async request<T>(path: string, params?: Record<string, string | string[] | boolean | number | undefined>): Promise<T> {
    const cache = getCache();
    if (!cache.enabled) {
      return this.fetchUpstream<T>(path, params);
    }
    const key = cacheKey("request", path, params, this.fingerprint);
    return cache.fetch<T>(key, () => this.fetchUpstream<T>(path, params));
  }

  /** Bypass response cache — use for audit / change-log reads that must be fresh. */
  async requestFresh<T>(
    path: string,
    params?: Record<string, string | string[] | boolean | number | undefined>
  ): Promise<T> {
    return this.fetchUpstream<T>(path, params);
  }

  private changesParams(opts: ChangesOpts = {}): Record<string, string | string[] | boolean | number | undefined> {
    const params: Record<string, string | string[] | boolean | number | undefined> = {
      limit: opts.limit,
      page: opts.page,
      search: opts.search,
    };
    const sort = normalizeSort(opts.sort);
    if (sort) params.sort = sort;
    if (opts.fields) params.fields = opts.fields;
    return params;
  }

  async listChanges(resource: string, opts: ChangesOpts = {}): Promise<QobrixPaginatedResponse> {
    return this.request<QobrixPaginatedResponse>(`${resource}/changes`, this.changesParams(opts));
  }

  async getRecordChanges(
    resource: string,
    id: string,
    opts: ChangesOpts = {}
  ): Promise<QobrixPaginatedResponse> {
    return this.request<QobrixPaginatedResponse>(
      `${resource}/${id}/changes`,
      this.changesParams(opts)
    );
  }

  private async fetchUpstream<T>(
    path: string,
    params?: Record<string, string | string[] | boolean | number | undefined>
  ): Promise<T> {
    const url = this.buildUrl(path, params);

    const response = await fetch(url, {
      method: "GET",
      headers: this.headers,
    });

    if (!response.ok) {
      // Mode C: expired / revoked Qobrix keys → clear vault and re-prompt connect.
      if (
        (response.status === 401 || response.status === 403) &&
        effectiveAuthMode() === "oauth"
      ) {
        clearSession(); // scoped to current request vaultKey via ALS
        const { elicitationId, connectUrl } = beginConnect();
        throw new AuthRequiredError({
          elicitationId,
          connectUrl,
          message:
            "Qobrix session expired or was revoked. Open the connect URL to sign in again.",
        });
      }
      let errorBody: string;
      try {
        const errJson = (await response.json()) as QobrixErrorResponse;
        errorBody = errJson.errors
          ?.map((e) => e.message || JSON.stringify(e))
          .join("; ") || `HTTP ${response.status}`;
      } catch {
        errorBody = `HTTP ${response.status} ${response.statusText}`;
      }
      throw new Error(`Qobrix API error: ${errorBody}`);
    }

    return (await response.json()) as T;
  }

  async list(resource: string, opts: ListOpts = {}): Promise<QobrixPaginatedResponse> {
    // Defaults: compact payloads. Qobrix's own defaults expand all FKs into
    // nested objects and inline media metadata, which blows up tool outputs
    // (a single Properties row can be 30 KB+). Default expand/media to false
    // so list/get tools return short, FK-as-UUID rows. Callers can opt in
    // explicitly with expand: true or media: true.
    const params: Record<string, string | string[] | boolean | number | undefined> = {
      limit: opts.limit,
      page: opts.page,
      search: opts.search,
      expand: opts.expand ?? false,
      media: opts.media ?? false,
      trashed: opts.trashed,
      segment: opts.segment,
      related_model: opts.related_model,
      related_id: opts.related_id,
    };

    const sort = normalizeSort(opts.sort);
    if (sort) params.sort = sort;
    if (opts.fields) params.fields = opts.fields;
    if (opts.include) params.include = opts.include;

    return this.request<QobrixPaginatedResponse>(resource, params);
  }

  async get(resource: string, id: string, opts: GetOpts = {}): Promise<QobrixSingleResponse> {
    const params: Record<string, string | string[] | boolean | number | undefined> = {
      expand: opts.expand ?? false,
      trashed: opts.trashed,
    };

    if (opts.include) params.include = opts.include;

    return this.request<QobrixSingleResponse>(`${resource}/${id}`, params);
  }

  async getSubresource(resource: string, id: string, sub: string, params?: Record<string, string | string[] | boolean | number | undefined>): Promise<unknown> {
    return this.request<unknown>(`${resource}/${id}/${sub}`, params);
  }

  async getPath(path: string, params?: Record<string, string | string[] | boolean | number | undefined>): Promise<unknown> {
    return this.request<unknown>(path, params);
  }

  /**
   * Best-effort GET that never clears the Mode C vault and never throws on HTTP
   * errors. Used by identity probes (whoami) where a 401 from a JWT-only endpoint
   * must not revoke a valid API-key session.
   */
  async tryGetPath(
    path: string,
    params?: Record<string, string | string[] | boolean | number | undefined>
  ): Promise<{ ok: boolean; status: number; data?: unknown }> {
    const url = this.buildUrl(path, params);
    try {
      const res = await fetch(url, {
        method: "GET",
        headers: this.headers,
      });
      if (!res.ok) {
        return { ok: false, status: res.status };
      }
      return {
        ok: true,
        status: res.status,
        data: await res.json().catch(() => undefined),
      };
    } catch {
      return { ok: false, status: 0 };
    }
  }
}

/** LRU of credential-scoped clients (Modes B/C). Cap keeps memory bounded. */
const CLIENT_LRU_MAX = 64;
const _clientByFp = new Map<string, QobrixClient>();
let _envClient: QobrixClient | null = null;
let _envFallbackEnabled = true;

/**
 * Disable the process.env credential fallback. Modes B/C call this so a tool
 * that somehow runs outside the request auth scope fails closed instead of
 * silently using a shared service account.
 */
export function disableEnvFallback(): void {
  _envFallbackEnabled = false;
}

function touchLru(fp: string, client: QobrixClient): QobrixClient {
  if (_clientByFp.has(fp)) _clientByFp.delete(fp);
  _clientByFp.set(fp, client);
  while (_clientByFp.size > CLIENT_LRU_MAX) {
    const oldest = _clientByFp.keys().next().value;
    if (oldest === undefined) break;
    _clientByFp.delete(oldest);
  }
  return client;
}

/**
 * Prefer AsyncLocalStorage credentials (Modes B/C); fall back to process.env (Mode A).
 * Mode C without a session vault entry throws AuthRequiredError (connect URL).
 */
export function getClient(): QobrixClient {
  const ctx = getAuthContext();
  if (ctx?.apiUser && ctx?.apiKey) {
    const tmp = QobrixClient.fromContext(ctx);
    const existing = _clientByFp.get(tmp.fingerprint);
    if (existing) return touchLru(tmp.fingerprint, existing);
    return touchLru(tmp.fingerprint, tmp);
  }
  if (!_envFallbackEnabled) {
    if (effectiveAuthMode() === "oauth") {
      const { elicitationId, connectUrl } = beginConnect();
      throw new AuthRequiredError({ elicitationId, connectUrl });
    }
    throw new Error(
      "No per-request Qobrix credentials in scope and env fallback is disabled (Mode B/C)"
    );
  }
  if (!_envClient) {
    _envClient = QobrixClient.fromEnv();
  }
  return _envClient;
}

/** Test helper — clears cached clients. */
export function __resetClientsForTests(): void {
  _envClient = null;
  _clientByFp.clear();
  _envFallbackEnabled = true;
}
