import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

const saved = { ...process.env };

async function load() {
  const mod = await import(`../dist/auth-types.js?t=${Date.now()}`);
  return mod;
}

describe("auth types", () => {
  beforeEach(() => {
    process.env = { ...saved };
    delete process.env.QOBRIX_MCP_AUTH;
    delete process.env.QOBRIX_MCP_TRANSPORT;
    delete process.env[["QOBRIX", "MCP", "AUTO", "MODE"].join("_")];
    delete process.env[["QOBRIX", "MCP", "DUAL", "MODE"].join("_")];
  });
  afterEach(() => {
    process.env = saved;
  });

  it("HTTP defaults to api_key and oauth_user", async () => {
    process.env.QOBRIX_MCP_TRANSPORT = "http";
    const { acceptedAuthTypes, isAutoHttpMode } = await load();
    assert.deepEqual(acceptedAuthTypes("http"), ["api_key", "oauth_user"]);
    assert.equal(isAutoHttpMode(), true);
  });

  it("a bearer user:key selects api_key when both types are accepted", async () => {
    process.env.QOBRIX_MCP_TRANSPORT = "http";
    process.env.QOBRIX_MCP_AUTH = "api_key,oauth_user";
    const { resolveAuthModeFromRequest, isAutoHttpMode } = await load();
    const mode = resolveAuthModeFromRequest(
      { authorization: "Bearer ada:secret" },
      isAutoHttpMode(),
      "oauth_user",
    );
    assert.equal(mode, "headers");
  });

  it("a bearer without a colon selects oauth_user", async () => {
    process.env.QOBRIX_MCP_TRANSPORT = "http";
    process.env.QOBRIX_MCP_AUTH = "api_key,oauth_user";
    const { resolveAuthModeFromRequest, isAutoHttpMode } = await load();
    const mode = resolveAuthModeFromRequest(
      { authorization: "Bearer opaque-token" },
      isAutoHttpMode(),
      "headers",
    );
    assert.equal(mode, "oauth_user");
  });

  it("signed headers are ignored when the legacy flag is off", async () => {
    process.env.QOBRIX_MCP_TRANSPORT = "http";
    process.env.QOBRIX_MCP_AUTH = "api_key,oauth_user";
    process.env.QOBRIX_MCP_XCHAT_LEGACY = "0";
    const { resolveAuthModeFromRequest, isAutoHttpMode } = await load();
    const mode = resolveAuthModeFromRequest(
      { "x-chat-user-id": "person-1" },
      isAutoHttpMode(),
      "headers",
    );
    assert.equal(mode, "oauth_user");
  });
});
