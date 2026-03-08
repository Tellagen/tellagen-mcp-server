#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { TellagenClient } from "./client.js";
import { validateAuth } from "./auth.js";
import { createServer } from "./server.js";

async function main(): Promise<void> {
  const apiKey = process.env.TELLAGEN_API_KEY;
  const apiUrl = process.env.TELLAGEN_API_URL;

  if (!apiKey) {
    process.stderr.write(
      "Error: TELLAGEN_API_KEY environment variable is required.\n",
    );
    process.exit(1);
  }
  if (!apiUrl) {
    process.stderr.write(
      "Error: TELLAGEN_API_URL environment variable is required.\n",
    );
    process.exit(1);
  }

  const client = new TellagenClient({ apiUrl, apiKey });

  // Validate credentials before starting the server.
  await validateAuth(client);

  const server = createServer(client);
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  process.stderr.write(`Fatal: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
