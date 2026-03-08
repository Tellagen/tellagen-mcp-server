import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { TellagenClient } from "./client.js";
import { registerAllTools } from "./tools/index.js";

/** Create and configure the Tellagen MCP server with all tools registered. */
export function createServer(client: TellagenClient): McpServer {
  const server = new McpServer({
    name: "tellagen",
    version: "0.1.0",
  });

  registerAllTools(server, client);

  return server;
}
