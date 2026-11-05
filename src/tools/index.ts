import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { TellagenClient } from "../client.js";
import { registerIncidentTools } from "./incidents.js";
import { registerInvestigationTools } from "./investigations.js";
import { registerCauseTools } from "./causes.js";
import { registerFindingTools } from "./findings.js";
import { registerTimelineTools } from "./timeline.js";
import { registerContextTools } from "./context.js";
import { registerDatasourceTools } from "./datasources.js";
import { registerDiagnosticTools } from "./diagnostics.js";
import { registerPostmortemRunbookTools } from "./postmortem-runbooks.js";
import { registerFigureTools } from "./figures.js";
import { registerSourceLinkTools } from "./source-links.js";
import { registerAttachmentTools } from "./attachments.js";

/** Register all Tellagen MCP tools on the server. */
export function registerAllTools(
  server: McpServer,
  client: TellagenClient,
): void {
  registerIncidentTools(server, client);
  registerInvestigationTools(server, client);
  registerFindingTools(server, client);
  registerCauseTools(server, client);
  registerTimelineTools(server, client);
  registerContextTools(server, client);
  registerDatasourceTools(server, client);
  registerDiagnosticTools(server, client);
  registerPostmortemRunbookTools(server, client);
  registerFigureTools(server);
  registerSourceLinkTools(server, client);
  registerAttachmentTools(server, client);
}
