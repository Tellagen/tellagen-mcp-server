import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { TellagenClient } from "../src/client.js";
import { startTellagenServer } from "../src/start.js";

describe("Tellagen MCP startup", () => {

  it("requires resource identity proof and inconclusive output when topology is unknown", () => {
    const root = join(dirname(fileURLToPath(import.meta.url)), "..");
    const serverSource = readFileSync(join(root, "src", "server.ts"), "utf8");
    const skillGuide = readFileSync(join(root, "SKILL.md"), "utf8");

    for (const text of [serverSource, skillGuide]) {
      expect(text).toContain("same host, device, and mountpoint");
      expect(text).toContain("cross-resource");
      expect(text).toContain("inconclusive");
      expect(text).toContain("bounded read-only host");
      expect(text).toContain("infrastructure documentation");
    }
  });

  it("advertises tools without contacting the Tellagen API", async () => {
    const apiClient = new TellagenClient({
      apiUrl: "https://test.api.tellagen.com",
      apiKey: "tllg_test",
    });
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValue(new Error("network unavailable"));
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    const mcpClient = new Client(
      { name: "startup-regression-test", version: "1.0.0" },
      { capabilities: {} },
    );
    const server = await startTellagenServer(apiClient, serverTransport);

    try {
      await mcpClient.connect(clientTransport);
      const tools = await mcpClient.listTools();

      expect(tools.tools.length).toBeGreaterThan(0);
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      await mcpClient.close();
      await server.close();
      fetchSpy.mockRestore();
    }
  });
});
