/**
 * the signed-header path browser pages after /oauth/callback.
 * Visual shell matches qobrix-crm-mcp-oauth Sharp Matrix login (duplicated CSS —
 * no cross-repo import).
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const YEAR = new Date().getFullYear();

function sharpLogoImgHtml(): string {
  try {
    const svg = readFileSync(
      join(__dirname, "assets", "sharp-sir-logo.svg"),
      "utf8"
    ).replace(/fill="white"/g, 'fill="#0f172a"');
    const b64 = Buffer.from(svg).toString("base64");
    return `<img class="logo" src="data:image/svg+xml;base64,${b64}" alt="Sharp Sotheby's International Realty" />`;
  } catch {
    return `<div class="logo-fallback" aria-hidden="true">Sharp SIR</div>`;
  }
}

const SHELL_CSS = `
    :root {
      --background: hsl(220 20% 98%);
      --foreground: hsl(222 47% 11%);
      --card: hsl(0 0% 100%);
      --card-foreground: hsl(222 47% 11%);
      --primary: hsl(222 47% 11%);
      --primary-foreground: hsl(0 0% 100%);
      --muted: hsl(220 15% 95%);
      --muted-foreground: hsl(220 10% 45%);
      --accent: hsl(43 74% 49%);
      --border: hsl(220 15% 90%);
      --ok: #0a7a3e;
      --ok-bg: #f0fdf4;
      --ok-border: #bbf7d0;
      --err: hsl(0 70% 35%);
      --err-bg: hsl(0 86% 97%);
      --err-border: hsl(0 74% 85%);
      --radius: 0.375rem;
    }
    * { box-sizing: border-box; }
    html, body {
      margin: 0; padding: 0;
      background: var(--background);
      color: var(--foreground);
      font-family: "Nunito Sans", system-ui, sans-serif;
      -webkit-font-smoothing: antialiased;
    }
    .page {
      min-height: 100vh; min-height: 100dvh;
      position: relative; overflow: hidden;
      background: var(--background);
    }
    .center {
      height: 100dvh;
      display: flex; align-items: center; justify-content: center;
      padding: 0 1rem;
    }
    .card {
      width: 100%; max-width: 28rem;
      position: relative; z-index: 10;
      background: var(--card); color: var(--card-foreground);
      border: 1px solid var(--border);
      border-radius: var(--radius);
      box-shadow: 0 20px 25px -5px rgb(0 0 0 / 0.1), 0 8px 10px -6px rgb(0 0 0 / 0.1);
    }
    .header { text-align: center; padding: 1.5rem 1.5rem 0.75rem; }
    .brand { display: flex; flex-direction: column; align-items: center; margin-bottom: 1rem; }
    .logo { height: 2.75rem; width: auto; display: block; }
    .logo-fallback {
      font-family: "Cormorant Garamond", Georgia, serif;
      font-size: 1.25rem; font-weight: 600;
    }
    .divider { width: 4rem; height: 1px; background: var(--accent); margin: 0.75rem auto 0; }
    h1 {
      margin: 0;
      font-family: "Cormorant Garamond", Georgia, serif;
      font-weight: 400; font-size: 1.25rem; letter-spacing: 0.02em;
    }
    .subtitle {
      margin: 0.35rem 0 0; font-weight: 300; font-size: 0.875rem;
      color: var(--muted-foreground);
    }
    .body { padding: 0 1.5rem 1rem; display: flex; flex-direction: column; gap: 1rem; }
    .alert {
      display: flex; gap: 0.5rem; align-items: flex-start;
      padding: 0.75rem; border-radius: var(--radius);
      font-size: 0.875rem; line-height: 1.35;
    }
    .alert .icon { width: 1rem; height: 1rem; flex-shrink: 0; margin-top: 0.1rem; }
    .alert-ok { background: var(--ok-bg); border: 1px solid var(--ok-border); color: var(--ok); }
    .alert-err { background: var(--err-bg); border: 1px solid var(--err-border); color: var(--err); }
    .hint { margin: 0; color: var(--muted-foreground); font-size: 0.8rem; line-height: 1.45; text-align: center; }
    .btn {
      width: 100%; height: 2.5rem; border-radius: var(--radius); border: 0;
      font-size: 0.95rem; font-weight: 600; cursor: pointer;
      display: inline-flex; align-items: center; justify-content: center;
      font-family: inherit;
      color: var(--primary-foreground); background: var(--primary);
    }
    .btn:hover { background: hsl(222 47% 16%); }
    .footer {
      border-top: 1px solid var(--border);
      padding: 0.85rem 1.5rem 1.25rem;
      text-align: center;
    }
    .footer p { margin: 0; font-size: 0.7rem; color: var(--muted-foreground); }
`;

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
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(opts.title)}</title>
  <link rel="preconnect" href="https://fonts.googleapis.com" />
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
  <link href="https://fonts.googleapis.com/css2?family=Cormorant+Garamond:wght@400;500;600;700&family=Nunito+Sans:wght@300;400;500;600;700&display=swap" rel="stylesheet" />
  <style>${SHELL_CSS}</style>
</head>
<body>
  <div class="page">
    <div class="center">
      <div class="card">
        <div class="header">
          <div class="brand">
            ${sharpLogoImgHtml()}
            <div class="divider"></div>
          </div>
          <h1>${escapeHtml(opts.h1)}</h1>
          <p class="subtitle">${escapeHtml(opts.subtitle)}</p>
        </div>
        <div class="body">
          ${opts.bodyHtml}
          <button type="button" class="btn" id="close-btn">Close</button>
          <p class="hint" id="close-hint" hidden>If this window does not close, close it manually and return to the chat.</p>
        </div>
        <div class="footer">
          <p>© ${YEAR} G.C.A. Global Citizen Advisory Limited</p>
        </div>
      </div>
    </div>
  </div>
  ${CLOSE_SCRIPT}
</body>
</html>`;
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
