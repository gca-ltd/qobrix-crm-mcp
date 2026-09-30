/**
 * Shared browser shell for Matrix MCP consent, success, and error pages.
 * Source of truth: this file plus sharp-sir-logo.svg beside it.
 * Other repos copy both unchanged.
 *
 * Visual contract: docs/platform/mcp/auth-pages.md
 * Matches the intranet SSO card (light canvas, white card, navy wordmark).
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));

function logoHtml() {
  try {
    const svg = readFileSync(join(HERE, "sharp-sir-logo.svg"), "utf8")
      .replaceAll('fill="white"', 'fill="#0f172a"');
    const b64 = Buffer.from(svg).toString("base64");
    return `<img class="logo" src="data:image/svg+xml;base64,${b64}" alt="Sharp Sotheby's International Realty" />`;
  } catch {
    return `<div class="logo-fallback" aria-hidden="true">Sharp SIR</div>`;
  }
}

const CSS = `
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
      display: flex; align-items: center; justify-content: center;
      padding: 1rem;
      background: var(--background);
    }
    .card {
      width: 100%; max-width: 28rem;
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
      font-weight: 400; font-size: 1.5rem; letter-spacing: 0.02em;
    }
    .body {
      padding: 0.5rem 1.5rem 1.25rem;
      display: flex; flex-direction: column; gap: 0.85rem;
      font-size: 0.95rem; line-height: 1.45;
    }
    .body p { margin: 0; color: var(--foreground); }
    .body p.message { text-align: center; }
    [hidden] { display: none !important; }
    .hint { margin: 0; color: var(--muted-foreground); font-size: 0.875rem; line-height: 1.45; }
    .alert {
      display: flex; gap: 0.5rem; align-items: flex-start;
      padding: 0.75rem; border-radius: var(--radius);
      font-size: 0.875rem; line-height: 1.35;
    }
    .alert .icon { width: 1rem; height: 1rem; flex-shrink: 0; margin-top: 0.1rem; }
    .alert-ok { background: #f0fdf4; border: 1px solid #bbf7d0; color: #0a7a3e; }
    .alert-err { background: hsl(0 86% 97%); border: 1px solid hsl(0 74% 85%); color: hsl(0 70% 35%); }
    .actions { display: flex; flex-direction: column; gap: 0.6rem; margin-top: 0.35rem; }
    .btn {
      width: 100%; height: 2.5rem; border-radius: var(--radius);
      font-size: 0.95rem; font-weight: 600; cursor: pointer;
      display: inline-flex; align-items: center; justify-content: center;
      font-family: inherit;
    }
    .btn-primary {
      color: var(--primary-foreground); background: var(--primary); border: 0;
    }
    .btn-primary:hover { background: hsl(222 47% 16%); }
    .btn-outline {
      background: var(--card); color: var(--foreground);
      border: 1px solid var(--border); font-weight: 500;
    }
    .btn-outline:hover { background: var(--muted); }
    .footer {
      border-top: 1px solid var(--border);
      padding: 0.85rem 1.5rem 1.25rem;
      text-align: center;
    }
    .footer p { margin: 0; font-size: 0.7rem; color: var(--muted-foreground); }
    .notice {
      background: var(--muted);
      border: 1px solid var(--border);
      border-radius: var(--radius);
      padding: 0.75rem 0.9rem;
      text-align: center;
      font-size: 0.875rem;
      line-height: 1.45;
    }
    .notice p { margin: 0; }
    .notice .notice-return { color: var(--muted-foreground); margin-top: 0.35rem; }
    .notice .notice-warn {
      margin-top: 0.5rem;
      color: hsl(32 80% 30%);
      background: hsl(43 90% 95%);
      border: 1px solid hsl(43 70% 80%);
      border-radius: var(--radius);
      padding: 0.45rem 0.6rem;
    }
`;

function escapeAttr(value) {
  return String(value).replace(/[&<>"']/g, (ch) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[ch]);
}

/**
 * One centred consent block. The shell owns the markup and the CSS.
 * `clientLine` is the `{{client}}` / `{{server}}` template. Names are escaped here.
 * @param {{ clientLine: string, clientName: string, server?: string, returnLine?: string, warning?: string }} opts
 */
export function consentNoticeHtml(opts) {
  const client = escapeAttr(opts.clientName || "");
  const server = escapeAttr(opts.server || "");
  const line = escapeAttr(opts.clientLine || "")
    .replace(/\{\{client\}\}/g, `<strong>${client}</strong>`)
    .replace(/\{\{server\}\}/g, server);
  const back = opts.returnLine ? `<p class="notice-return">${escapeAttr(opts.returnLine)}</p>` : "";
  const warning = opts.warning ? `<p class="notice-warn">${escapeAttr(opts.warning)}</p>` : "";
  return `<div class="notice"><p>${line}</p>${back}${warning}</div>`;
}

/**
 * Browsers only let a script close a tab that a script opened, so a refused
 * close swaps the button for the `blocked` line.
 */
function closeButtonHtml(close) {
  return `<button class="btn btn-outline" type="button" data-close-window>${escapeAttr(close.label)}</button>`
    + `<p class="message hint" data-close-blocked hidden>${escapeAttr(close.blocked)}</p>`
    + `<script>(function(){var b=document.querySelector("[data-close-window]");if(!b)return;b.addEventListener("click",function(){window.close();setTimeout(function(){if(window.closed)return;b.hidden=true;var m=document.querySelector("[data-close-blocked]");if(m)m.hidden=false;},300);});})();</script>`;
}

/**
 * @param {{ lang?: string, title: string, body: string, year?: number, actions?: Array<{ label: string, url: string, method?: string, variant?: "primary" | "outline" }>, close?: { label: string, blocked: string } }} opts
 * `body` is HTML the caller has already escaped. `actions` become Allow/Deny forms.
 * `close` adds a close-tab button (result pages only).
 * Pass `year` when the HTML is committed; the browser can replace `[data-year]`.
 */
export function renderAuthPage(opts) {
  const lang = opts.lang || "en";
  const actions = (opts.actions || []).map((action) => {
    const variant = action.variant === "outline" ? "btn-outline" : "btn-primary";
    const method = (action.method || "post").toLowerCase() === "get" ? "get" : "post";
    return `<form method="${method}" action="${escapeAttr(action.url)}"><button class="btn ${variant}" type="submit">${escapeAttr(action.label)}</button></form>`;
  }).join("") + (opts.close ? closeButtonHtml(opts.close) : "");
  const year = opts.year || new Date().getFullYear();
  return `<!DOCTYPE html>
<html lang="${escapeAttr(lang)}">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeAttr(opts.title)}</title>
  <link rel="preconnect" href="https://fonts.googleapis.com" />
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
  <link href="https://fonts.googleapis.com/css2?family=Cormorant+Garamond:wght@400;500;600&family=Nunito+Sans:wght@400;500;600&display=swap" rel="stylesheet" />
  <style>${CSS}</style>
</head>
<body>
  <div class="page">
    <main class="card" data-matrix-auth-page="1">
      <div class="header">
        <div class="brand">
          ${logoHtml()}
          <div class="divider"></div>
        </div>
        <h1>${escapeAttr(opts.title)}</h1>
      </div>
      <div class="body">
        ${opts.body || ""}
        ${actions ? `<div class="actions">${actions}</div>` : ""}
      </div>
      <div class="footer"><p>© <span data-year>${year}</span> Sharp Sotheby's International Realty</p></div>
    </main>
  </div>
</body>
</html>`;
}
