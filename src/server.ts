import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { TellagenClient } from "./client.js";
import { registerAllTools } from "./tools/index.js";

const INSTRUCTIONS = `Tellagen MCP server — incident investigation platform.

12 tools: get/list/create incidents, get timeline, start/list/complete investigations, post/list/get/update/promote findings.

Investigation lifecycle: get_incident → start_investigation (returns run_id) → gather evidence → post_finding (incrementally, not batched) → promote key findings to timeline → complete_investigation.

Findings require: finding_type (observation|correlation|hypothesis|evidence|recommendation|negative), claim, evidence_summary, confidence (0-1), confidence_reason. Attach evidence_refs with source, query, result_summary, url. Attach screenshots (url or base64) to evidence_refs or findings.

For the full guide on composing with Grafana, GitHub, PagerDuty MCP servers, read resource://tellagen/skill-guide.`;

function loadSkillGuide(): string {
  const dir = dirname(fileURLToPath(import.meta.url));
  const skillPath = join(dir, "..", "SKILL.md");
  return readFileSync(skillPath, "utf-8");
}

/** Create and configure the Tellagen MCP server with all tools registered. */
export function createServer(client: TellagenClient): McpServer {
  const server = new McpServer(
    {
      name: "tellagen",
      version: "0.1.0",
    },
    {
      instructions: INSTRUCTIONS,
    },
  );

  registerAllTools(server, client);

  const skillGuide = loadSkillGuide();
  server.registerResource(
    "skill-guide",
    "resource://tellagen/skill-guide",
    {
      title: "Tellagen Investigation Guide",
      description:
        "Complete guide for AI agents: investigation lifecycle, finding types, composing with Grafana/GitHub/PagerDuty MCP servers, screenshot support, and common mistakes.",
      mimeType: "text/markdown",
    },
    async (uri) => ({
      contents: [
        {
          uri: uri.href,
          mimeType: "text/markdown",
          text: skillGuide,
        },
      ],
    }),
  );

  return server;
}
