import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";

/**
 * Per-request Qobrix credentials for api_key and the signed-header path.
 * Tools continue to call getClient(); the factory prefers ALS over env.
 */
export type AuthCredentials = {
  apiUser: string;
  apiKey: string;
  apiUrl?: string;
  locale?: string;
  /** OAuth subject (the signed-header path). */
  subject?: string;
};

const authStorage = new AsyncLocalStorage<AuthCredentials>();

export function runWithAuth<T>(creds: AuthCredentials, fn: () => T): T {
  return authStorage.run(creds, fn);
}

export async function runWithAuthAsync<T>(
  creds: AuthCredentials,
  fn: () => Promise<T>
): Promise<T> {
  return authStorage.run(creds, fn);
}

export function getAuthContext(): AuthCredentials | undefined {
  return authStorage.getStore();
}

/** Stable fingerprint for cache key scoping (never the raw secret). */
export function credentialFingerprint(creds: {
  apiUser: string;
  apiKey: string;
  apiUrl?: string;
}): string {
  const material = `${creds.apiUrl ?? ""}|${creds.apiUser}|${creds.apiKey}`;
  return createHash("sha256").update(material).digest("hex").slice(0, 16);
}
