/**
 * Browser pages after the signed-header callback.
 * The card is the shared Matrix auth shell (tools/mcp-conformance/auth-page.mjs).
 */

import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const { renderAuthPage } = (await import(
  pathToFileURL(join(dirname(fileURLToPath(import.meta.url)), "../tools/mcp-conformance/auth-page.mjs")).href
)) as {
  renderAuthPage: (opts: { title: string; body: string }) => string;
};

const CLOSE_SCRIPT = `
<script>
(function () {
  var btn = document.getElementById("close-btn");
  var hint = document.getElementById("close-hint");
  if (!btn) return;
  btn.addEventListener("click", function () {
    window.close();
    if (hint) hint.hidden = false;
  });
})();
</script>
`;

function escapeHtml(s: string): string {
  return s.replace(/[<>&"']/g, (c) =>
    ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&#39;" }[c] || c)
  );
}

function shellPage(opts: {
  title: string;
  h1: string;
  subtitle: string;
  bodyHtml: string;
}): string {
  return renderAuthPage({
    title: opts.h1,
    body: `<p class="hint">${escapeHtml(opts.subtitle)}</p>
      ${opts.bodyHtml}
      <button type="button" class="btn btn-primary" id="close-btn">Close</button>
      <p class="hint" id="close-hint" hidden>If this window does not close, close it manually and return to the chat.</p>
      ${CLOSE_SCRIPT}`,
  });
}

/** Successful the signed-header path callback — vault written. */
export function successHtml(subject?: string): string {
  const who =
    subject && subject.trim()
      ? `<p class="hint">Session subject ${escapeHtml(subject.slice(0, 12))}…</p>`
      : "";
  return shellPage({
    title: "Connected — Sharp Matrix",
    h1: "Sharp Matrix",
    subtitle: "Connected — authorization completed",
    bodyHtml: `
      <div class="alert alert-ok" role="status">
        <svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
          <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/>
        </svg>
        <span>You can close this window and return to the chat to continue.</span>
      </div>
      ${who}`,
  });
}

/** Failed the signed-header path callback or /connect error. */
export function errorHtml(message: string): string {
  return shellPage({
    title: "Authorization failed — Sharp Matrix",
    h1: "Sharp Matrix",
    subtitle: "Authorization failed",
    bodyHtml: `
      <div class="alert alert-err" role="alert">
        <svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
          <circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/>
        </svg>
        <span>${escapeHtml(message)}</span>
      </div>
      <p class="hint">Return to the chat and try Sign In again.</p>`,
  });
}
