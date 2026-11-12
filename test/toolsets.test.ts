import { describe, expect, it } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ToolListChangedNotificationSchema } from "@modelcontextprotocol/sdk/types.js";

import { TellagenClient } from "../src/client.js";
import { createServer } from "../src/server.js";
import {
  DEFAULT_TOOLSETS,
  ENABLE_TOOLSET_TOOL,
  SIGN_IN_TOOL,
  parseToolsets,
  TOOL_CATALOG,
  TOOLSETS,
  type Toolset,
  type ToolsetSelection,
  toolAnnotations,
} from "../src/tools/catalog.js";
import { registerAllTools } from "../src/tools/index.js";

const namesOf = (toolset: Toolset) =>
  TOOL_CATALOG.filter((entry) => entry.toolset === toolset).map((entry) => entry.name);

async function connect(toolsets?: ToolsetSelection) {
  const api = new TellagenClient({ apiUrl: "https://test.api.tellagen.com", apiKey: "tllg_test" });
  const server = toolsets === undefined ? createServer(api) : createServer(api, { toolsets });
  const mcp = new Client({ name: "toolset-test", version: "1.0.0" });
  let listChanged = 0;
  mcp.setNotificationHandler(ToolListChangedNotificationSchema, () => {
    listChanged += 1;
  });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), mcp.connect(b)]);
  return {
    api,
    mcp,
    listChanged: () => listChanged,
    names: async () => (await mcp.listTools()).tools.map((tool) => tool.name),
    close: async () => {
      await mcp.close();
      await server.close();
    },
  };
}

describe("toolsets", () => {
  it("puts every tool in exactly one toolset, with the diagnosis set at about 14 tools", () => {
    const names = TOOL_CATALOG.map((entry) => entry.name);
    expect(new Set(names).size).toBe(names.length);
    for (const entry of TOOL_CATALOG) expect(TOOLSETS).toContain(entry.toolset);
    expect(namesOf("diagnosis")).toEqual([
      "tellagen_next_investigation",
      "tellagen_pick_up_investigation",
      "tellagen_resume",
      "tellagen_get_incident_context",
      "tellagen_post_trace_step",
      "tellagen_post_runbook_check_attempt",
      "tellagen_update_cause",
      "tellagen_post_finding",
      "tellagen_update_finding",
      "tellagen_build_figure",
      "tellagen_build_source_link",
      "tellagen_get_context_attachment",
      "tellagen_get_investigation_coverage",
      "tellagen_post_timeline_event",
      "tellagen_complete_investigation",
    ]);
    for (const toolset of TOOLSETS) expect(namesOf(toolset).length, toolset).toBeGreaterThan(0);
  });

  it("lists diagnosis and incidents by default, in the catalog order, with the enable tool last", async () => {
    const session = await connect();
    try {
      expect(DEFAULT_TOOLSETS).toEqual(["diagnosis", "incidents"]);
      expect(await session.names()).toEqual([...namesOf("diagnosis"), ...namesOf("incidents"), ENABLE_TOOLSET_TOOL, SIGN_IN_TOOL]);
    } finally {
      await session.close();
    }
  });

  it.each(TOOLSETS)("lists only the %s set when it is the one chosen", async (toolset) => {
    const session = await connect([toolset]);
    try {
      expect(await session.names()).toEqual([...namesOf(toolset), ENABLE_TOOLSET_TOOL, SIGN_IN_TOOL]);
    } finally {
      await session.close();
    }
  });

  it("lists every tool for all, in the same order on every start", async () => {
    const first = await connect("all");
    const second = await connect("all");
    try {
      const names = await first.names();
      expect(names).toEqual([...TOOL_CATALOG.map((entry) => entry.name), ENABLE_TOOLSET_TOOL, SIGN_IN_TOOL]);
      expect(await second.names()).toEqual(names);
    } finally {
      await first.close();
      await second.close();
    }
  });

  it("turns a set on in the session and tells the client that the list changed", async () => {
    const session = await connect();
    try {
      expect(await session.names()).not.toContain("tellagen_promote_finding");
      const result = (await session.mcp.callTool({ name: ENABLE_TOOLSET_TOOL, arguments: { toolset: "timeline" } })) as {
        content: Array<{ text: string }>;
      };
      const body = JSON.parse(result.content[0]!.text);
      expect(body.added_toolsets).toEqual(["timeline"]);
      expect(body.enabled_toolsets).toEqual(["diagnosis", "incidents", "timeline"]);
      expect(body.added_tools).toEqual(namesOf("timeline"));
      expect(session.listChanged()).toBeGreaterThan(0);
      // The new tools sit at their catalog place, not at the end.
      expect(await session.names()).toEqual([
        ...namesOf("diagnosis"),
        ...namesOf("incidents"),
        ...namesOf("timeline"),
        ENABLE_TOOLSET_TOOL,
        SIGN_IN_TOOL,
      ]);

      const before = session.listChanged();
      const again = (await session.mcp.callTool({ name: ENABLE_TOOLSET_TOOL, arguments: { toolset: "timeline" } })) as {
        content: Array<{ text: string }>;
      };
      expect(JSON.parse(again.content[0]!.text).added_toolsets).toEqual([]);
      expect(session.listChanged()).toBe(before);

      await session.mcp.callTool({ name: ENABLE_TOOLSET_TOOL, arguments: { toolset: "all" } });
      expect(await session.names()).toEqual([...TOOL_CATALOG.map((entry) => entry.name), ENABLE_TOOLSET_TOOL, SIGN_IN_TOOL]);
    } finally {
      await session.close();
    }
  });

  it("refuses a toolset that does not exist, and a hidden tool cannot be called", async () => {
    const session = await connect();
    try {
      const bad = await session.mcp.callTool({ name: ENABLE_TOOLSET_TOOL, arguments: { toolset: "everything" } });
      expect(bad.isError).toBe(true);
      const hidden = await session.mcp.callTool({ name: "tellagen_post_postmortem", arguments: {} }).catch((err) => ({ isError: true, err }));
      expect(hidden.isError).toBe(true);
    } finally {
      await session.close();
    }
  });

  it("turns the settings set on when a tool check ID is used as a run ID", async () => {
    const session = await connect();
    try {
      const result = (await session.mcp.callTool({
        name: "tellagen_pick_up_investigation",
        arguments: { investigation_run_id: "diag_abc123" },
      })) as { content: Array<{ text: string }>; isError?: boolean };
      expect(result.isError).toBe(true);
      expect(JSON.parse(result.content[0]!.text).next_tool).toBe("tellagen_report_diagnostic_tools");
      expect(await session.names()).toContain("tellagen_report_diagnostic_tools");
    } finally {
      await session.close();
    }
  });

  it("puts read-only, destructive and idempotent annotations on every tool", async () => {
    const session = await connect("all");
    try {
      const tools = (await session.mcp.listTools()).tools;
      for (const tool of tools) {
        expect(typeof tool.annotations?.readOnlyHint, tool.name).toBe("boolean");
        expect(typeof tool.annotations?.destructiveHint, tool.name).toBe("boolean");
        expect(typeof tool.annotations?.idempotentHint, tool.name).toBe("boolean");
        // A tool that only reads is never marked destructive.
        if (tool.annotations?.readOnlyHint) expect(tool.annotations.destructiveHint, tool.name).toBe(false);
      }
      const byName = new Map(tools.map((tool) => [tool.name, tool.annotations!]));
      expect(byName.get("tellagen_get_incident")).toMatchObject({ readOnlyHint: true, destructiveHint: false });
      expect(byName.get("tellagen_post_finding")).toMatchObject({ readOnlyHint: false, destructiveHint: false });
      expect(byName.get("tellagen_update_incident")).toMatchObject({ readOnlyHint: false, destructiveHint: true });
      expect(byName.get("tellagen_complete_investigation")).toMatchObject({ readOnlyHint: false, destructiveHint: true });
      expect(byName.get("tellagen_update_cause")).toMatchObject({ idempotentHint: true });
      expect(byName.get("tellagen_probe_datasource")).toMatchObject({ readOnlyHint: true, openWorldHint: true });
    } finally {
      await session.close();
    }
  });

  it("marks as read-only only the tools whose name says they read or build", () => {
    for (const entry of TOOL_CATALOG) {
      const reads = /^tellagen_(get|list|search|build|probe|next)_?/.test(entry.name);
      expect(toolAnnotations(entry).readOnlyHint, entry.name).toBe(reads);
    }
  });

  it("lists every toolset when a caller registers the tools with no selection", () => {
    const server = new McpServer({ name: "t", version: "1" });
    const api = new TellagenClient({ apiUrl: "https://test.api.tellagen.com", apiKey: "tllg_test" });
    registerAllTools(server, api);
    expect(api.session.toolsets?.enabled()).toEqual([...TOOLSETS]);
  });

  it("reads a toolset list and refuses an unknown name", () => {
    expect(parseToolsets(undefined)).toEqual(["diagnosis", "incidents"]);
    expect(parseToolsets("  ")).toEqual(["diagnosis", "incidents"]);
    expect(parseToolsets("timeline, Diagnosis")).toEqual(["diagnosis", "timeline"]);
    expect(parseToolsets("diagnosis,all")).toBe("all");
    expect(() => parseToolsets("diagnosis,nope")).toThrow(/Unknown toolset "nope"/);
  });
});
