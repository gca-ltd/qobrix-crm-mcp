#!/usr/bin/env node

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createServer } from "./server.js";
import { resolveTransport, resolveAuthMode, modeDescription } from "./auth-types.js";

async function main(): Promise<void> {
  const transportMode = resolveTransport();

  if (transportMode === "http") {
    const { startHttpServer } = await import("./http.js");
    await startHttpServer();
    return;
  }

  // none — stdio + env (default)
  process.stderr.write(
    `[qobrix-crm-mcp] ${modeDescription(resolveAuthMode("stdio"))}\n`
  );
  const server = createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);

  process.on("SIGINT", async () => {
    await server.close();
    process.exit(0);
  });

  process.on("SIGTERM", async () => {
    await server.close();
    process.exit(0);
  });
}

main().catch((error) => {
  console.error("Server startup error:", error);
  process.exit(1);
});
