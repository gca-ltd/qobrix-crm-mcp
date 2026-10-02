#!/usr/bin/env node
/**
 * Fails when an MCP repo drifts from the shared sign-in card.
 * Usage: node check-auth-pages.mjs [repo-root]
 * Canonical files are read from MCP_KB_ROOT (default /home/bitnami/matrix-platform-kb).
 */
import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const repo = process.argv[2] || process.cwd();
const kb = process.env.MCP_KB_ROOT || "/home/bitnami/matrix-platform-kb";
const canonicalDir = join(kb, "tools/mcp-conformance");
const COPIES = ["auth-page.mjs", "sharp-sir-logo.svg", "first-party-clients.json", "redirect-allowlist.json"];

const problems = [];

function same(a, b) {
  try {
    return readFileSync(a, "utf8") === readFileSync(b, "utf8");
  } catch {
    return false;
  }
}

if (repo !== kb) {
  for (const name of COPIES) {
    const local = join(repo, "tools/mcp-conformance", name);
    const canon = join(canonicalDir, name);
    if (!existsSync(local)) {
      problems.push(`missing tools/mcp-conformance/${name}`);
      continue;
    }
    if (!same(local, canon)) problems.push(`tools/mcp-conformance/${name} differs from the KB`);
  }
}

function walk(dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "dist" || name === ".git") continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) walk(path, out);
    else if (/\.(ts|tsx|mjs|js)$/.test(name)) out.push(path);
  }
  return out;
}

const plainSend = /\.send\(\s*(["'`])(?:\\.|(?!\1).){1,240}\1\s*\)/;
const sharedCss = /(?:^|[\s;}])\.(notice|message|btn|alert)\s*\{/;

for (const file of walk(join(repo, "src"))) {
  const rel = relative(repo, file);
  if (rel.includes("tools/mcp-conformance/")) continue;
  const text = readFileSync(file, "utf8");
  const lines = text.split("\n");
  lines.forEach((line, i) => {
    if (plainSend.test(line) && !/renderAuthPage|messagePageHtml|loginPageHtml|consentPage/.test(line)) {
      problems.push(`${rel}:${i + 1}: plain-text browser body`);
    }
    if (sharedCss.test(line)) problems.push(`${rel}:${i + 1}: page CSS for a shared card block`);
  });
}

if (problems.length) {
  console.error(`Auth page drift (${problems.length}):`);
  console.error(problems.slice(0, 40).join("\n"));
  process.exit(1);
}
console.log("Auth pages ok");
