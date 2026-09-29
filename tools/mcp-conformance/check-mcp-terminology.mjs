#!/usr/bin/env node
/**
 * Fails when retired MCP auth names appear outside the history allowlist.
 * Source of truth: this file. Other repos copy it unchanged.
 *
 * Usage: node check-mcp-terminology.mjs [repo-root]
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const root = process.argv[2] || process.cwd();

const banned = [
  /\bMode [A-D]\b/,
  /\bModes A/,
  /\bMode-[A-D]\b/,
  /server_managed(?!_pkce)\b/,
  /Server-managed(?!\s+PKCE)/,
  /server-managed sign-in/i,
  /URL-mode authorization/,
  /oauth-claude/,
  /\bdual[_ ]mode\b/i,
  /\bauto[_ ]mode\b/i,
  /QOBRIX_MCP_DUAL_MODE/,
  /QOBRIX_MCP_AUTO_MODE/,
];

function allowed(rel) {
  const p = rel.replaceAll("\\", "/");
  if (p.includes(".lovable/plan/")) return true;
  if (p.endsWith("CHANGELOG.md") || p.endsWith("RELEASE_NOTES.md")) return true;
  if (p.includes("supabase/migrations/")) return true;
  if (p.includes("docs/platform/mcp/")) return true;
  if (p.endsWith("docs/architecture/decisions/ADR-059.md")) return true;
  if (p.endsWith("docs/architecture/decisions/ADR-019.md")) return true;
  if (p.endsWith("tools/mcp-conformance/check-mcp-terminology.mjs")) return true;
  return false;
}

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "dist" || name === ".git") continue;
    const path = join(dir, name);
    const st = statSync(path);
    if (st.isDirectory()) walk(path, out);
    else if (/\.(md|ts|tsx|js|mjs|json|toml|sql|example|env)$/.test(name) || name.startsWith(".env")) out.push(path);
  }
  return out;
}

const hits = [];
for (const file of walk(root)) {
  const rel = relative(root, file);
  if (allowed(rel)) continue;
  let text = "";
  try { text = readFileSync(file, "utf8"); } catch { continue; }
  const lines = text.split("\n");
  lines.forEach((line, i) => {
    for (const re of banned) {
      if (re.test(line)) hits.push(`${rel}:${i + 1}: ${line.trim().slice(0, 160)}`);
    }
  });
}

if (hits.length) {
  console.error(`Retired MCP auth terms (${hits.length}):`);
  console.error(hits.slice(0, 80).join("\n"));
  process.exit(1);
}
console.log("MCP terminology ok");
