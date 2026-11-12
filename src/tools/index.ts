import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { TellagenClient } from "../client.js";
import { formatError } from "../errors.js";
import { markLeadsInText } from "../cause-lead.js";
import { decorateToolResult, type ToolResultLike } from "../run-events.js";
import {
  DEFAULT_TOOLSETS,
  ENABLE_TOOLSET_TOOL,
  TOOL_CATALOG,
  TOOLSETS,
  TOOLSET_SUMMARY,
  type Toolset,
  type ToolsetSelection,
  toolAnnotations,
} from "./catalog.js";
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
import { registerResumeTools } from "./resume.js";
import { registerNextInvestigationTools } from "./next.js";
import { registerSignInTool } from "./signin.js";
import type { SignInManager } from "../signin.js";

type ToolHandler = (args: Record<string, unknown>, extra?: unknown) => Promise<ToolResultLike>;
type ToolConfig = Record<string, unknown>;
type ToolHandle = { enable?: () => void; disable?: () => void } | undefined | void;

export interface RegisterToolsOptions {
  /**
   * The toolsets that are listed at the start. Left out, every tool is
   * listed; the server entry point passes the person's choice.
   */
  toolsets?: ToolsetSelection;
  /** The browser sign-in of this process. Left out, no sign-in tool is listed. */
  signIn?: SignInManager;
}

/** Runs a tool only when Tellagen can be reached with a key, and adds waiting lines to its answer. */
function guarded(client: TellagenClient, handler: ToolHandler): ToolHandler {
  return async (args, extra) => {
    const problem = await client.accessProblem();
    if (problem) {
      return { content: [{ type: "text", text: formatError(problem) }], isError: true };
    }
    const named = [args?.investigation_run_id, args?.run_id].find(
      (value): value is string => typeof value === "string" && value.trim().length > 0,
    );
    const result = await handler(args, extra);
    // Every tool answer passes here: a lead from a past incident is cleaned and marked as untrusted data.
    for (const item of result?.content ?? []) {
      if (item.type === "text" && typeof item.text === "string") item.text = markLeadsInText(item.text);
    }
    return decorateToolResult(client, result, named?.trim());
  };
}

/**
 * Register the Tellagen MCP tools on the server, in the fixed order of the
 * catalog, each with its read-only and destructive annotations. Tools of a
 * toolset that is off stay registered and hidden, so tellagen_enable_toolset
 * can list them later.
 */
export function registerAllTools(
  server: McpServer,
  client: TellagenClient,
  options: RegisterToolsOptions = {},
): void {
  const collected = new Map<string, { config: ToolConfig; handler: ToolHandler }>();
  const collector = {
    registerTool(name: string, config: ToolConfig, handler: ToolHandler) {
      if (collected.has(name)) throw new Error(`tool registered twice: ${name}`);
      collected.set(name, { config, handler });
    },
  } as unknown as McpServer;

  registerIncidentTools(collector, client);
  registerInvestigationTools(collector, client);
  registerFindingTools(collector, client);
  registerCauseTools(collector, client);
  registerTimelineTools(collector, client);
  registerContextTools(collector, client);
  registerDatasourceTools(collector, client);
  registerDiagnosticTools(collector, client);
  registerPostmortemRunbookTools(collector, client);
  registerFigureTools(collector, client);
  registerSourceLinkTools(collector, client);
  registerAttachmentTools(collector, client);
  registerResumeTools(collector, client);
  registerNextInvestigationTools(collector, client);

  const selection = options.toolsets ?? "all";
  const on = new Set<Toolset>(selection === "all" ? TOOLSETS : selection);
  const handles = new Map<Toolset, ToolHandle[]>();
  const register = server.registerTool.bind(server) as unknown as (
    name: string,
    config: ToolConfig,
    handler: ToolHandler,
  ) => ToolHandle;

  for (const entry of TOOL_CATALOG) {
    const tool = collected.get(entry.name);
    if (!tool) throw new Error(`the tool catalog names a tool that is not registered: ${entry.name}`);
    collected.delete(entry.name);
    const handle = register(
      entry.name,
      { ...tool.config, annotations: toolAnnotations(entry) },
      guarded(client, tool.handler),
    );
    if (!on.has(entry.toolset)) handle?.disable?.();
    handles.set(entry.toolset, [...(handles.get(entry.toolset) ?? []), handle]);
  }
  if (collected.size > 0) {
    throw new Error(`tools missing from the tool catalog: ${[...collected.keys()].join(", ")}`);
  }

  const enabled = () => TOOLSETS.filter((toolset) => on.has(toolset));
  const enable = (toolset: string) => {
    const wanted = toolset === "all" ? [...TOOLSETS] : TOOLSETS.filter((name) => name === toolset);
    const added: Toolset[] = [];
    for (const name of wanted) {
      if (on.has(name)) continue;
      on.add(name);
      added.push(name);
      // Each handle tells the client that the tool list changed.
      for (const handle of handles.get(name) ?? []) handle?.enable?.();
    }
    return { enabled: enabled(), added };
  };
  client.session.toolsets = { enable, enabled };

  register(
    ENABLE_TOOLSET_TOOL,
    {
      description: `Turn on another set of Tellagen tools for this session. The client is told that the tool list changed. Sets: ${TOOLSETS.map((name) => `${name} (${TOOLSET_SUMMARY[name].replace(/\.$/, "")})`).join("; ")}; all turns every set on. It changes nothing in Tellagen.`,
      inputSchema: {
        toolset: z.enum([...TOOLSETS, "all"]).describe("The toolset to turn on, or all"),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async (args) => {
      const result = enable(String(args.toolset));
      const tools = TOOL_CATALOG.filter((entry) => result.added.includes(entry.toolset)).map((entry) => entry.name);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              enabled_toolsets: result.enabled,
              added_toolsets: result.added,
              added_tools: tools,
              message:
                result.added.length > 0
                  ? "The tools are listed now. If your client does not show them yet, ask the person to reconnect this MCP server."
                  : "That toolset was already on.",
            }),
          },
        ],
      };
    },
  );

  if (options.signIn) registerSignInTool(server, client, options.signIn);
}

export { DEFAULT_TOOLSETS };
