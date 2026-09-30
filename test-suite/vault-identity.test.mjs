/**
 * Unit tests for the signed-header path per-user vaults + signed identity (no live AS).
 */
import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHmac, randomBytes } from "node:crypto";
import { pathToFileURL } from "node:url";

const MCP_ROOT = new URL("..", import.meta.url).pathname;
const STATE_SECRET = "test-state-secret-" + randomBytes(8).toString("hex");
const IDENTITY_SECRET =
  "test-identity-secret-" + randomBytes(8).toString("hex");

describe("the signed-header path per-user vaults + identity", () => {
  let dataDir;
  /** @type {typeof import('../dist/oauth-client.js')} */
  let oauth;
  /** @type {typeof import('../dist/identity.js')} */
  let identity;

  before(async () => {
    dataDir = mkdtempSync(join(tmpdir(), "qobrix-mcp-vault-"));
    process.env.QOBRIX_MCP_STATE_SECRET = STATE_SECRET;
    process.env.QOBRIX_MCP_IDENTITY_SECRET = IDENTITY_SECRET;
    process.env.QOBRIX_MCP_DATA_DIR = dataDir;
    process.env.QOBRIX_MCP_MAX_VAULTS = "10";

    oauth = await import(
      pathToFileURL(join(MCP_ROOT, "dist/oauth-client.js")).href
    );
    identity = await import(
      pathToFileURL(join(MCP_ROOT, "dist/identity.js")).href
    );
  });

  after(() => {
    try {
      rmSync(dataDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  beforeEach(() => {
    oauth.__resetOauthClientForTests();
  });

  it("resolveVaultKeyFromHeaders: verified identity → platform:user", () => {
    const signed = identity.signChatIdentity({
      platform: "teams",
      userId: "teams_abc",
    });
    assert.ok(signed);
    const r = identity.resolveVaultKeyFromHeaders({
      platform: "teams",
      userId: "teams_abc",
      iat: String(signed.iat),
      exp: String(signed.exp),
      sig: signed.sig,
    });
    assert.equal(r.vaultKey, "teams:teams_abc");
    assert.equal(r.verified, true);
    assert.equal(r.reason, "verified");
  });

  it("resolveVaultKeyFromHeaders: forged sig falls back to default", () => {
    const r = identity.resolveVaultKeyFromHeaders({
      platform: "teams",
      userId: "teams_victim",
      iat: String(Math.floor(Date.now() / 1000)),
      exp: String(Math.floor(Date.now() / 1000) + 300),
      sig: "not-a-real-sig",
    });
    assert.equal(r.vaultKey, "default");
    assert.equal(r.reason, "bad-signature");
  });

  it("beginConnect scopes pending URLs per vaultKey", () => {
    const a = oauth.beginConnect("web:alice");
    const b = oauth.beginConnect("web:bob");
    assert.notEqual(a.elicitationId, b.elicitationId);
    const a2 = oauth.beginConnect("web:alice");
    assert.equal(a.elicitationId, a2.elicitationId);
  });

  it("persist/load isolates two vault keys on disk", () => {
    oauth.__persistSessionForTests(
      {
        apiUser: "alice-uuid",
        apiKey: "alice-key",
        subject: "alice@example.com",
        updatedAt: new Date().toISOString(),
      },
      "web:alice"
    );
    oauth.__persistSessionForTests(
      {
        apiUser: "bob-uuid",
        apiKey: "bob-key",
        subject: "bob@example.com",
        updatedAt: new Date().toISOString(),
      },
      "web:bob"
    );

    const Alice = oauth.getSessionCredentials("web:alice");
    const Bob = oauth.getSessionCredentials("web:bob");
    assert.equal(Alice?.apiUser, "alice-uuid");
    assert.equal(Bob?.apiUser, "bob-uuid");
    assert.notEqual(Alice?.apiKey, Bob?.apiKey);

    oauth.clearSession("web:alice");
    assert.equal(oauth.getSessionCredentials("web:alice"), null);
    assert.equal(oauth.getSessionCredentials("web:bob")?.apiUser, "bob-uuid");

    const sessions = join(dataDir, "sessions");
    assert.ok(existsSync(sessions));
    const files = readdirSync(sessions).filter((f) => f.endsWith(".enc"));
    assert.equal(files.length, 1); // only bob remains
    assert.equal(oauth.countSessionVaults(), 1);
  });

  it("vaultKeyAuditHash is stable and short", () => {
    const h1 = identity.vaultKeyAuditHash("web:alice");
    const h2 = identity.vaultKeyAuditHash("web:alice");
    assert.equal(h1, h2);
    assert.equal(h1.length, 12);
    assert.notEqual(h1, identity.vaultKeyAuditHash("web:bob"));
  });

  it("signChatIdentity payload matches HMAC formula", () => {
    const platform = "telegram";
    const userId = "12345";
    const signed = identity.signChatIdentity({
      platform,
      userId,
      nowSec: 1_700_000_000,
    });
    assert.ok(signed);
    const expected = createHmac("sha256", IDENTITY_SECRET)
      .update(`${platform}|${userId}|${signed.iat}|${signed.exp}`)
      .digest("base64url");
    assert.equal(signed.sig, expected);
  });

  it("shouldClearVaultOnRefreshFailure: transient keeps vault when stillValid", () => {
    assert.equal(
      oauth.shouldClearVaultOnRefreshFailure({
        stillValid: true,
        errorBody: "HTTP 503 service unavailable",
      }),
      false
    );
    assert.equal(
      oauth.shouldClearVaultOnRefreshFailure({
        stillValid: true,
        errorBody: '{"error":"temporarily_unavailable"}',
      }),
      false
    );
  });

  it("shouldClearVaultOnRefreshFailure: invalid_grant or expired clears", () => {
    assert.equal(
      oauth.shouldClearVaultOnRefreshFailure({
        stillValid: true,
        errorBody: '{"error":"invalid_grant","error_description":"revoked"}',
      }),
      true
    );
    assert.equal(
      oauth.shouldClearVaultOnRefreshFailure({
        stillValid: false,
        errorBody: "HTTP 500",
      }),
      true
    );
  });
});
