/**
 * Browser pages after the signed-header callback.
 * The card is the shared Matrix auth shell (tools/mcp-conformance/auth-page.mjs).
 */

import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const { renderAuthPage } = (await import(
  pathToFileURL(join(dirname(fileURLToPath(import.meta.url)), "../tools/mcp-conformance/auth-page.mjs")).href
)) as {
  renderAuthPage: (opts: { lang?: string; title: string; body: string }) => string;
};

export type Lang = "en" | "ru" | "hu";

export function langFromHeader(header: string | string[] | undefined): Lang {
  const value = (Array.isArray(header) ? header.join(",") : header || "").toLowerCase();
  if (value.includes("ru")) return "ru";
  if (value.includes("hu")) return "hu";
  return "en";
}

const STATUS = {
  en: {
    connected: "Connected",
    connectedDetail: "You can close this window and return to the chat to continue.",
    failed: "Authorization failed",
    tryAgain: "Return to the chat and try Sign In again.",
    close: "Close",
    closeHint: "If this window does not close, close it manually and return to the chat.",
  },
  ru: {
    connected: "Подключено",
    connectedDetail: "Можно закрыть это окно и продолжить в чате.",
    failed: "Не удалось авторизоваться",
    tryAgain: "Вернитесь в чат и начните вход снова.",
    close: "Закрыть",
    closeHint: "Если окно не закрылось, закройте его вручную и вернитесь в чат.",
  },
  hu: {
    connected: "Csatlakozva",
    connectedDetail: "Bezárhatja ezt az ablakot, és folytathatja a csevegésben.",
    failed: "A hitelesítés nem sikerült",
    tryAgain: "Térjen vissza a csevegésbe, és indítsa újra a bejelentkezést.",
    close: "Bezárás",
    closeHint: "Ha az ablak nem záródik be, zárja be kézzel, és térjen vissza a csevegésbe.",
  },
} as const;

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
  lang: Lang;
  title: string;
  subtitle: string;
  bodyHtml: string;
}): string {
  const copy = STATUS[opts.lang];
  return renderAuthPage({
    lang: opts.lang,
    title: opts.title,
    body: `<p class="hint">${escapeHtml(opts.subtitle)}</p>
      ${opts.bodyHtml}
      <button type="button" class="btn btn-primary" id="close-btn">${escapeHtml(copy.close)}</button>
      <p class="hint" id="close-hint" hidden>${escapeHtml(copy.closeHint)}</p>
      ${CLOSE_SCRIPT}`,
  });
}

/** Successful the signed-header path callback — vault written. */
export function successHtml(subject?: string, lang: Lang = "en"): string {
  const copy = STATUS[lang];
  const who =
    subject && subject.trim()
      ? `<p class="hint">Session subject ${escapeHtml(subject.slice(0, 12))}…</p>`
      : "";
  return shellPage({
    lang,
    title: copy.connected,
    subtitle: copy.connected,
    bodyHtml: `
      <div class="alert alert-ok" role="status">
        <svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
          <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/>
        </svg>
        <span>${escapeHtml(copy.connectedDetail)}</span>
      </div>
      ${who}`,
  });
}

/** Failed the signed-header path callback or /connect error. */
export function errorHtml(message: string, lang: Lang = "en"): string {
  const copy = STATUS[lang];
  return shellPage({
    lang,
    title: copy.failed,
    subtitle: copy.failed,
    bodyHtml: `
      <div class="alert alert-err" role="alert">
        <svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
          <circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/>
        </svg>
        <span>${escapeHtml(message)}</span>
      </div>
      <p class="hint">${escapeHtml(copy.tryAgain)}</p>`,
  });
}
