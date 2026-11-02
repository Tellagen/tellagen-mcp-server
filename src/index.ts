#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { TellagenClient } from "./client.js";
import { startTellagenServer } from "./start.js";

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
  const transport = new StdioServerTransport();
  await startTellagenServer(client, transport);
}

main().catch((err) => {
  process.stderr.write(`Fatal: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
