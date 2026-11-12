import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { TellagenClient } from "../src/client.js";
import { CredentialVault, MemoryStore } from "../src/credentials.js";
import { SignInIndex } from "../src/signin-index.js";
import { SignInManager } from "../src/signin.js";
import { registerAllTools } from "../src/tools/index.js";
import { MCP_SERVER_VERSION } from "../src/version.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const readText = (file: string) => readFileSync(join(root, file), "utf8");
const readJson = (file: string) => JSON.parse(readText(file));

async function listTools() {
  const server = new McpServer({ name: "catalog-test", version: "0.0.1" });
  const api = new TellagenClient({
    apiUrl: "https://test.api.tellagen.com",
    apiKey: "tllg_test",
  });
  // The sign-in tool is listed in a real server, so the README must list it.
  registerAllTools(server, api, {
    signIn: new SignInManager(api, {
      vault: new CredentialVault(new MemoryStore(), new MemoryStore("file"), false),
      index: new SignInIndex(undefined),
    }),
  });
  const client = new Client({ name: "catalog-client", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    return (await client.listTools()).tools;
  } finally {
    await client.close();
    await server.close();
  }
}

describe("tool names and descriptions", () => {
  it("gives every tool the tellagen_ prefix and a unique name", async () => {
    const names = (await listTools()).map((tool) => tool.name);

    expect(names.every((name) => /^tellagen_[a-z_]+$/.test(name))).toBe(true);
    expect(new Set(names).size).toBe(names.length);
  });

  it("describes every tool in full sentences without promotion", async () => {
    for (const tool of await listTools()) {
      const description = tool.description ?? "";

      expect(description.length, tool.name).toBeGreaterThanOrEqual(40);
      expect(description, tool.name).toMatch(/[.)]$/);
      expect(description, tool.name).not.toMatch(
        /\b(best|powerful|seamless|revolutionary|cutting-edge|blazing)\b/i,
      );
      expect(description, tool.name).not.toContain("—");
    }
  });

  it("never tells the model to call another vendor's tool", async () => {
    for (const tool of await listTools()) {
      expect(tool.description ?? "", tool.name).not.toMatch(
        /\b(call|use|run|query|invoke)\b[^.]{0,40}\b(grafana|github|pagerduty|datadog|slack|jira)\b[^.]{0,20}\b(tool|server|mcp)\b/i,
      );
    }
  });

  it("points only to tools that exist", async () => {
    const tools = await listTools();
    const names = new Set(tools.map((tool) => tool.name));

    for (const tool of tools) {
      const mentioned = (tool.description ?? "").match(/tellagen_[a-z_]+/g) ?? [];
      for (const name of mentioned) {
        expect(names.has(name), `${tool.name} mentions ${name}`).toBe(true);
      }
    }
  });

  it("states that no tool can accept a root cause", async () => {
    const byName = new Map(
      (await listTools()).map((tool) => [tool.name, tool.description ?? ""]),
    );

    for (const name of [
      "tellagen_post_finding",
      "tellagen_update_finding",
      "tellagen_complete_investigation",
    ]) {
      expect(byName.get(name), name).toMatch(/root cause/i);
    }
  });

  it("separates the tools that read a run from the tool that attaches to it", async () => {
    const byName = new Map(
      (await listTools()).map((tool) => [tool.name, tool.description ?? ""]),
    );

    expect(byName.get("tellagen_get_incident_context")).toContain(
      "tellagen_pick_up_investigation",
    );
    expect(byName.get("tellagen_pick_up_investigation")).toContain(
      "tellagen_start_investigation",
    );
    expect(byName.get("tellagen_get_investigation_workspace")).toContain(
      "tellagen_get_incident_context",
    );
  });

  it("marks the legacy postmortem writers and names the proposal tool", async () => {
    const byName = new Map(
      (await listTools()).map((tool) => [tool.name, tool.description ?? ""]),
    );

    for (const name of ["tellagen_post_postmortem", "tellagen_update_postmortem"]) {
      expect(byName.get(name), name).toMatch(/^Legacy import/);
      expect(byName.get(name), name).toContain(
        "tellagen_submit_postmortem_revision_proposal",
      );
    }
  });
});

describe("README tool table", () => {
  it("lists every registered tool exactly once, and no other", async () => {
    const names = (await listTools()).map((tool) => tool.name).sort();
    const readme = readText("README.md");
    const toolsSection = readme.slice(
      readme.indexOf("\n## Tools"),
      readme.indexOf("\n## Auditable runbook guidance"),
    );
    const listed = [...toolsSection.matchAll(/^\| `(tellagen_[a-z_]+)` \|/gm)]
      .map((match) => match[1])
      .sort();

    expect(listed).toEqual(names);
    expect(toolsSection).toContain(`The server offers ${names.length} tools`);
  });

  it("opens with what the server is and how to install it", () => {
    const lines = readText("README.md").split("\n");

    expect(lines[0]).toBe("# @tellagen/mcp-server");
    expect(lines.slice(1, 12).join("\n")).toContain("https://tellagen.com");
    expect(lines.slice(1, 12).join("\n")).toContain(
      "npx -y @tellagen/mcp-server",
    );
  });

  it("names the registry entry once", () => {
    const matches = readText("README.md").match(/io\.github\.tellagen\/mcp-server/g);

    expect(matches).toHaveLength(1);
  });
});

describe("package metadata", () => {
  const pkg = readJson("package.json");
  const serverJson = readJson("server.json");

  it("carries the registry name that server.json declares", () => {
    expect(pkg.mcpName).toBe("io.github.tellagen/mcp-server");
    expect(serverJson.name).toBe(pkg.mcpName);
  });

  it("points at the repository, the home page and the issue tracker", () => {
    expect(pkg.repository).toEqual({
      type: "git",
      url: "git+https://github.com/Tellagen/tellagen-mcp-server.git",
    });
    expect(pkg.homepage).toBe("https://tellagen.com");
    expect(pkg.bugs.url).toBe(
      "https://github.com/Tellagen/tellagen-mcp-server/issues",
    );
    expect(serverJson.repository.url).toBe(
      "https://github.com/Tellagen/tellagen-mcp-server",
    );
  });

  it("lists the search keywords", () => {
    expect(pkg.keywords).toEqual([
      "mcp",
      "mcp-server",
      "incident-management",
      "sre",
      "claude-code",
      "codex",
      "postmortem",
    ]);
  });

  it("keeps one version in package.json, the lock file, server.json and the code", () => {
    const lock = readJson("package-lock.json");

    expect(pkg.version).toBe(MCP_SERVER_VERSION);
    expect(lock.version).toBe(pkg.version);
    expect(lock.packages[""].version).toBe(pkg.version);
    expect(serverJson.version).toBe(pkg.version);
    expect(serverJson.packages[0].identifier).toBe(pkg.name);
  });

  it("keeps the registry description within its 100 character limit", () => {
    expect(serverJson.description.length).toBeLessThanOrEqual(100);
  });

  it("ships server.json and the skill file in the package", () => {
    expect(pkg.files).toEqual(
      expect.arrayContaining(["dist", "server.json", "SKILL.md", "contracts"]),
    );
  });
});

describe("public repository", () => {
  it("has a license and a security policy", () => {
    expect(readText("LICENSE")).toContain("MIT License");
    expect(readText("SECURITY.md")).toContain("Report a vulnerability");
    expect(existsSync(join(root, "LICENSE"))).toBe(true);
  });

  it("holds no ticket keys or private paths in its docs, metadata and tool text", () => {
    const sourceFiles = readdirSync(join(root, "src", "tools")).map(
      (file) => `src/tools/${file}`,
    );
    const files = [
      "README.md",
      "SECURITY.md",
      "SKILL.md",
      "package.json",
      "server.json",
      "src/server.ts",
      ...sourceFiles,
    ];

    for (const file of files) {
      const text = readText(file);
      expect(text, file).not.toMatch(/\bCORE-\d+/);
      expect(text, file).not.toMatch(/\/Users\/|\.claude\/worktrees/);
    }
  });
});
