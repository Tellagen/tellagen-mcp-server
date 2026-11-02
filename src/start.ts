import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { TellagenClient } from "./client.js";
import { createServer } from "./server.js";

/**
 * Connect the MCP transport without performing network-dependent checks.
 * Codex must be able to complete the initialize handshake even when the
 * Tellagen API is unavailable or blocked during MCP startup. Individual tool
 * calls report authentication and connectivity errors through their normal
 * structured error responses.
 */
export async function startTellagenServer(
  client: TellagenClient,
  transport: Transport,
): Promise<McpServer> {
  const server = createServer(client);
  await server.connect(transport);
  return server;
}
