import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { TellagenClient } from "./client.js";
import { createServer, type CreateServerOptions } from "./server.js";

/**
 * Connect the MCP transport, then ask Tellagen once whether it accepts the
 * key. The handshake never waits for that answer: a client must be able to
 * list the tools when the Tellagen API is slow, unreachable or refuses the
 * key. A refused key is remembered, and every tool call then answers with a
 * clear message and the fix.
 */
export async function startTellagenServer(
  client: TellagenClient,
  transport: Transport,
  options: CreateServerOptions = {},
): Promise<McpServer> {
  const server = createServer(client, options);
  // The check starts when the client finished the handshake, so the call
  // already carries the client's name. It is not awaited, and it never throws.
  const initialized = server.server.oninitialized;
  server.server.oninitialized = () => {
    initialized?.();
    void client.checkAuth();
  };
  await server.connect(transport);
  return server;
}
