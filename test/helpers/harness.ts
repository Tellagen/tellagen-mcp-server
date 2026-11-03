import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { TellagenClient } from "../../src/client.js";
import { registerAllTools } from "../../src/tools/index.js";

type ToolResult = {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
};

type RegisteredTool = {
  config: { inputSchema?: Record<string, unknown> };
  handler: (input: Record<string, unknown>) => Promise<ToolResult>;
};

/** Registers every tool on a stub server and calls handlers directly. */
export function createToolHarness(apiUrl = "https://test.api.tellagen.com") {
  const client = new TellagenClient({ apiUrl, apiKey: "tllg_test" });
  const tools = new Map<string, RegisteredTool>();
  const server = {
    registerTool: (
      name: string,
      config: RegisteredTool["config"],
      handler: RegisteredTool["handler"],
    ) => {
      tools.set(name, { config, handler });
    },
  } as unknown as McpServer;
  registerAllTools(server, client);
  return {
    client,
    getTool(name: string) {
      const tool = tools.get(name);
      if (!tool) throw new Error(`tool not registered: ${name}`);
      return tool;
    },
    async callTool(name: string, input: Record<string, unknown>) {
      return this.getTool(name).handler(input);
    },
    json(result: ToolResult): Record<string, any> {
      return JSON.parse(result.content[0].text);
    },
  };
}

export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}
