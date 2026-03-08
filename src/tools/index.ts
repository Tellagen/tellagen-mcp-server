import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { TellagenClient } from "../client.js";
import { registerIncidentTools } from "./incidents.js";
import { registerInvestigationTools } from "./investigations.js";
import { registerFindingTools } from "./findings.js";

/** Register all Tellagen MCP tools on the server. */
export function registerAllTools(
  server: McpServer,
  client: TellagenClient,
): void {
  registerIncidentTools(server, client);
  registerInvestigationTools(server, client);
  registerFindingTools(server, client);
}
