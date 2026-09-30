/**
 * Response cache for QobrixClient.request().
 *
 * Design:
 * - Cache-aside (lazy loading) with a single read-through wrapper at the HTTP chokepoint.
 * - Tier 1: in-memory LRU with TTL (always on, zero deps).
 * - Tier 2: optional Redis via node-redis (dynamic import; only loaded when QOBRIX_REDIS_URL is set).
 * - Single-flight in-process coalescing to prevent cache stampede on parallel identical requests.
 * - Errors never cached.
 *
 * Aligned with Redis docs and 2026 MCP caching best practices:
 *   - Canonical, versioned cache key
 *   - TTL via SET ... EX
 *   - SCAN+DEL (never KEYS *) for prefix clears
 *   - allkeys-lru recommended on the Redis server side (documented in README)
 */

const SCHEMA_VERSION = "v1";

type RedisLike = {
  isOpen?: boolean;
  isReady?: boolean;
  connect: () => Promise<void>;
  get: (key: string) => Promise<string | null>;
  set: (key: string, value: string, opts?: { EX?: number }) => Promise<unknown>;
  del: (keys: string | string[]) => Promise<number>;
  scanIterator: (opts?: { MATCH?: string; COUNT?: number }) => AsyncIterable<string>;
  quit: () => Promise<unknown>;
  on: (event: string, listener: (...args: unknown[]) => void) => unknown;
};

type CacheValue = unknown;
type MemoryEntry = { value: CacheValue; expiresAt: number };

export type CacheStats = {
  enabled: boolean;
  hits: number;
  misses: number;
  sets: number;
  evictions: number;
  size: number;
  max_entries: number;
  inflight: number;
  ttl_seconds: number;
  redis: "off" | "on" | "degraded";
  redis_url_set: boolean;
  redis_key_prefix: string;
};

function canonicalize(value: unknown): unknown {
  if (value === undefined || value === null) return null;
  if (Array.isArray(value)) {
    return [...value].map(canonicalize).sort((a, b) => {
      const sa = JSON.stringify(a);
      const sb = JSON.stringify(b);
      return sa < sb ? -1 : sa > sb ? 1 : 0;
    });
  }
  if (typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(obj).sort()) {
      const v = obj[k];
      if (v === undefined) continue;
      out[k] = canonicalize(v);
    }
    return out;
  }
  return value;
}

export function cacheKey(
  method: string,
  path: string,
  params?: Record<string, unknown>,
  /** Credential fingerprint so api_key/C users never share cached rows. */
  credentialFp?: string
): string {
  const canon = JSON.stringify(canonicalize(params ?? {}));
  const scope = credentialFp ? `cred:${credentialFp}:` : "";
  return `${SCHEMA_VERSION}:${scope}${method}:${path}?${canon}`;
}

export class CacheStore {
  readonly enabled: boolean;
  readonly ttlSeconds: number;
  readonly maxEntries: number;
  readonly redisKeyPrefix: string;
  readonly redisUrl: string;

  private mem = new Map<string, MemoryEntry>();
  private inflight = new Map<string, Promise<CacheValue>>();
  private redis: RedisLike | null = null;
  private redisStatus: "off" | "on" | "degraded" = "off";
  private redisConnectAttempted = false;

  private hits = 0;
  private misses = 0;
  private sets = 0;
  private evictions = 0;

  constructor(env: NodeJS.ProcessEnv = process.env) {
    this.enabled = env.QOBRIX_CACHE_ENABLED !== "false";
    this.ttlSeconds = Number(env.QOBRIX_CACHE_TTL ?? 300);
    this.maxEntries = Number(env.QOBRIX_CACHE_MAX_ENTRIES ?? 5000);
    this.redisKeyPrefix = env.QOBRIX_REDIS_KEY_PREFIX ?? "qobrix:";
    this.redisUrl = env.QOBRIX_REDIS_URL ?? "";

    if (this.enabled && this.redisUrl) {
      this.redisStatus = "degraded";
      void this.initRedis();
    }
  }

  private async initRedis(): Promise<void> {
    if (this.redisConnectAttempted) return;
    this.redisConnectAttempted = true;
    try {
      const mod = (await import("redis")) as unknown as {
        createClient: (opts: { url: string }) => RedisLike;
      };
      const client = mod.createClient({ url: this.redisUrl });
      client.on("error", (err: unknown) => {
        this.redisStatus = "degraded";
        const msg = err instanceof Error ? err.message : String(err);
        process.stderr.write(`[qobrix-cache] redis error: ${msg}\n`);
      });
      client.on("ready", () => {
        this.redisStatus = "on";
      });
      client.on("end", () => {
        this.redisStatus = "degraded";
      });
      await client.connect();
      this.redis = client;
      this.redisStatus = "on";
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(
        `[qobrix-cache] redis disabled (install \`redis\` or check QOBRIX_REDIS_URL): ${msg}\n`
      );
      this.redis = null;
      this.redisStatus = "off";
    }
  }

  private memGet(key: string): CacheValue | undefined {
    const entry = this.mem.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt < Date.now()) {
      this.mem.delete(key);
      return undefined;
    }
    this.mem.delete(key);
    this.mem.set(key, entry);
    return entry.value;
  }

  private memSet(key: string, value: CacheValue): void {
    if (this.mem.has(key)) this.mem.delete(key);
    this.mem.set(key, {
      value,
      expiresAt: Date.now() + this.ttlSeconds * 1000,
    });
    while (this.mem.size > this.maxEntries) {
      const oldest = this.mem.keys().next().value;
      if (oldest === undefined) break;
      this.mem.delete(oldest);
      this.evictions++;
    }
  }

  private redisKey(key: string): string {
    return `${this.redisKeyPrefix}${key}`;
  }

  async get(key: string): Promise<CacheValue | undefined> {
    if (!this.enabled) return undefined;
    const fromMem = this.memGet(key);
    if (fromMem !== undefined) {
      this.hits++;
      return fromMem;
    }
    if (this.redis && this.redisStatus === "on") {
      try {
        const raw = await this.redis.get(this.redisKey(key));
        if (raw !== null && raw !== undefined) {
          const parsed = JSON.parse(raw) as CacheValue;
          this.memSet(key, parsed);
          this.hits++;
          return parsed;
        }
      } catch (err) {
        this.redisStatus = "degraded";
        const msg = err instanceof Error ? err.message : String(err);
        process.stderr.write(`[qobrix-cache] redis get failed: ${msg}\n`);
      }
    }
    this.misses++;
    return undefined;
  }

  async set(key: string, value: CacheValue): Promise<void> {
    if (!this.enabled) return;
    this.memSet(key, value);
    this.sets++;
    if (this.redis && this.redisStatus === "on") {
      try {
        await this.redis.set(this.redisKey(key), JSON.stringify(value), {
          EX: this.ttlSeconds,
        });
      } catch (err) {
        this.redisStatus = "degraded";
        const msg = err instanceof Error ? err.message : String(err);
        process.stderr.write(`[qobrix-cache] redis set failed: ${msg}\n`);
      }
    }
  }

  /**
   * Single-flight coalescing: identical concurrent requests share one upstream call.
   * Caller passes the loader; we run it exactly once per in-flight key.
   */
  async fetch<T>(key: string, loader: () => Promise<T>): Promise<T> {
    if (!this.enabled) return loader();

    const cached = await this.get(key);
    if (cached !== undefined) return cached as T;

    const existing = this.inflight.get(key);
    if (existing) return existing as Promise<T>;

    const promise = (async () => {
      try {
        const fresh = await loader();
        await this.set(key, fresh);
        return fresh;
      } finally {
        this.inflight.delete(key);
      }
    })();

    this.inflight.set(key, promise as Promise<CacheValue>);
    return promise;
  }

  async clear(prefix?: string): Promise<{ memory_cleared: number; redis_cleared: number }> {
    let memCleared = 0;
    if (prefix) {
      for (const k of [...this.mem.keys()]) {
        if (k.startsWith(prefix)) {
          this.mem.delete(k);
          memCleared++;
        }
      }
    } else {
      memCleared = this.mem.size;
      this.mem.clear();
    }
    this.inflight.clear();

    let redisCleared = 0;
    if (this.redis && this.redisStatus === "on") {
      try {
        const match = prefix
          ? `${this.redisKeyPrefix}${prefix}*`
          : `${this.redisKeyPrefix}*`;
        const batch: string[] = [];
        for await (const k of this.redis.scanIterator({ MATCH: match, COUNT: 500 })) {
          batch.push(k);
          if (batch.length >= 500) {
            redisCleared += await this.redis.del(batch);
            batch.length = 0;
          }
        }
        if (batch.length > 0) {
          redisCleared += await this.redis.del(batch);
        }
      } catch (err) {
        this.redisStatus = "degraded";
        const msg = err instanceof Error ? err.message : String(err);
        process.stderr.write(`[qobrix-cache] redis clear failed: ${msg}\n`);
      }
    }

    return { memory_cleared: memCleared, redis_cleared: redisCleared };
  }

  stats(): CacheStats {
    return {
      enabled: this.enabled,
      hits: this.hits,
      misses: this.misses,
      sets: this.sets,
      evictions: this.evictions,
      size: this.mem.size,
      max_entries: this.maxEntries,
      inflight: this.inflight.size,
      ttl_seconds: this.ttlSeconds,
      redis: this.redisStatus,
      redis_url_set: this.redisUrl !== "",
      redis_key_prefix: this.redisKeyPrefix,
    };
  }

  resetStats(): void {
    this.hits = 0;
    this.misses = 0;
    this.sets = 0;
    this.evictions = 0;
  }
}

let _cache: CacheStore | null = null;

export function getCache(): CacheStore {
  if (!_cache) {
    _cache = new CacheStore();
  }
  return _cache;
}

export function __resetCacheForTests(): void {
  _cache = null;
}
