import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  classifyQobrixFailure,
  classifyQobrixNetworkFailure,
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
      credentialsInvalidated: true,
    });
    assert.equal(c.code, "qobrix_key_rejected");
    assert.match(c.user_action, /was reset/);
    const noReset = classifyQobrixFailure({
      httpStatus: 401,
      authMode: "oauth_user",
      body: { errors: ["Unauthorized"] },
      keyProbe: "invalid",
      credentialsInvalidated: false,
    });
    assert.doesNotMatch(noReset.user_action, /was reset/);
  });

  it("maps oauth_user 401 + unknown probe to qobrix_auth_unverified", () => {
    const c = classifyQobrixFailure({
      httpStatus: 401,
      authMode: "oauth_user",
      body: { errors: ["Unauthorized"] },
      keyProbe: "unknown",
    });
    assert.equal(c.code, "qobrix_auth_unverified");
    assert.equal(c.retryable, true);
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

  it("maps 403 429 500 503", () => {
    assert.equal(
      classifyQobrixFailure({
        httpStatus: 403,
        authMode: "oauth_user",
        body: { errors: ["Forbidden"] },
      }).code,
      "qobrix_forbidden"
    );
    assert.equal(
      classifyQobrixFailure({
        httpStatus: 429,
        authMode: "oauth_user",
        body: { errors: ["Too many"] },
      }).code,
      "qobrix_rate_limited"
    );
    assert.equal(
      classifyQobrixFailure({
        httpStatus: 500,
        authMode: "oauth_user",
        body: { errors: ["Unsuccessful operation"] },
      }).code,
      "qobrix_server_error"
    );
    assert.equal(
      classifyQobrixFailure({
        httpStatus: 503,
        authMode: "oauth_user",
        body: { errors: ["Unavailable"] },
      }).code,
      "qobrix_unavailable"
    );
  });

  it("classifyQobrixNetworkFailure", () => {
    assert.equal(classifyQobrixNetworkFailure("timeout").code, "qobrix_unavailable");
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

  it("errorResult snapshots for key codes", async () => {
    const { errorResult } = await import("../dist/tools/index.js");
    const rejected = errorResult(
      new QobrixApiError(
        classifyQobrixFailure({
          httpStatus: 401,
          authMode: "oauth_user",
          body: { errors: ["Unauthorized"] },
          keyProbe: "invalid",
          credentialsInvalidated: true,
        })
      ),
      "qobrix_list_opportunities"
    );
    assert.equal(rejected.isError, true);
    assert.equal(rejected.structuredContent.error.code, "qobrix_key_rejected");
    assert.match(rejected.structuredContent.error.user_action, /reset/i);

    const args = errorResult(
      new QobrixApiError(
        classifyQobrixFailure({
          httpStatus: 400,
          authMode: "oauth_user",
          body: { errors: ["bad field"] },
        })
      ),
      "qobrix_search_opportunities"
    );
    assert.equal(args.structuredContent.error.code, "invalid_arguments");

    const route = errorResult(
      new QobrixApiError(
        classifyQobrixFailure({
          httpStatus: 404,
          authMode: "oauth_user",
          body: {
            errors: ["A route matching `/api/v2/nosuch` could not be found."],
          },
        })
      ),
      "qobrix_meta"
    );
    assert.equal(route.structuredContent.error.code, "bridge_route_missing");
  });
});
