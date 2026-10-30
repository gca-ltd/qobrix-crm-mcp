import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  classifyQobrixFailure,
  qobrixErrorMessages,
  formatErrorHeadline,
  QobrixApiError,
} from "../dist/errors.js";

describe("Qobrix error classification", () => {
  it("parses OpenAPI string[] errors", () => {
    const msgs = qobrixErrorMessages({ errors: ["Unauthorized"] });
    assert.deepEqual(msgs, ["Unauthorized"]);
  });

  it("maps oauth_user 401 + invalid probe to qobrix_key_rejected", () => {
    const c = classifyQobrixFailure({
      httpStatus: 401,
      authMode: "oauth_user",
      body: { errors: ["Unauthorized"] },
      keyProbe: "invalid",
    });
    assert.equal(c.code, "qobrix_key_rejected");
    assert.equal(c.fix_owner, "user");
    assert.match(c.user_action, /Reconnect Qobrix CRM/);
    assert.match(c.not_the_cause, /no shared token/);
  });

  it("maps oauth_user 401 + valid probe to qobrix_auth_unconfirmed", () => {
    const c = classifyQobrixFailure({
      httpStatus: 401,
      authMode: "oauth_user",
      body: { errors: ["Unauthorized"] },
      keyProbe: "valid",
    });
    assert.equal(c.code, "qobrix_auth_unconfirmed");
    assert.equal(c.fix_owner, "qobrix_admin");
  });

  it("maps api_key 401 to qobrix_key_invalid", () => {
    const c = classifyQobrixFailure({
      httpStatus: 401,
      authMode: "headers",
      body: { errors: ["Authentication is required to continue"] },
    });
    assert.equal(c.code, "qobrix_key_invalid");
  });

  it("maps 404 record vs route missing", () => {
    const rec = classifyQobrixFailure({
      httpStatus: 404,
      authMode: "oauth_user",
      body: { errors: ["Record not found in table `opportunities`."] },
    });
    assert.equal(rec.code, "qobrix_not_found");

    const route = classifyQobrixFailure({
      httpStatus: 404,
      authMode: "oauth_user",
      body: {
        errors: ["A route matching `/api/v2/nosuchresource` could not be found."],
      },
    });
    assert.equal(route.code, "bridge_route_missing");
  });

  it("maps 400 search errors to invalid_arguments", () => {
    const c = classifyQobrixFailure({
      httpStatus: 400,
      authMode: "oauth_user",
      body: {
        errors: [
          'Invalid search expression: Variable "nosuchfield" is not valid around position 1 for expression `nosuchfield == 1`.',
        ],
      },
    });
    assert.equal(c.code, "invalid_arguments");
    assert.match(c.qobrix_message, /nosuchfield/);
  });

  it("QobrixApiError headline includes code", () => {
    const c = classifyQobrixFailure({
      httpStatus: 401,
      authMode: "oauth_user",
      body: { errors: ["Unauthorized"] },
      keyProbe: "invalid",
    });
    const err = new QobrixApiError(c);
    assert.match(err.message, /\[qobrix_key_rejected\]/);
    assert.equal(formatErrorHeadline(c), err.message);
  });
});
