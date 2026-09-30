import assert from "node:assert/strict";
import test from "node:test";
import { errorHtml, successHtml } from "../dist/auth-pages.js";

test("connected and error pages use the shared auth card", () => {
  for (const html of [successHtml("subject-1"), errorHtml("The sign-in failed.")]) {
    assert.match(html, /data-matrix-auth-page="1"/);
    assert.match(html, /Sharp Sotheby/);
    assert.match(html, /btn-primary/);
    assert.match(html, />Close</);
  }
  assert.match(successHtml(), /close this window/i);
});
