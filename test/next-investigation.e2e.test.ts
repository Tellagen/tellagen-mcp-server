/**
 * End-to-end: an MCP client talks to the real server, which talks to a fake
 * Tellagen REST server over HTTP. Covers the waiting list (one run, several,
 * none, an older Tellagen) and the pickup that follows with no ID typed.
 */
import { createServer as createHttpServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ElicitRequestSchema } from "@modelcontextprotocol/sdk/types.js";

import { TellagenClient } from "../src/client.js";
import { createServer } from "../src/server.js";
import { waitingRuns } from "../src/tools/next.js";

type Recorded = { method: string; path: string; headers: Record<string, string | string[] | undefined>; body?: any };

const run = (id: string, extra: Record<string, unknown> = {}) => ({
  run_id: id,
  incident_id: 42,
  incident_human_id: "INC-42",
  incident_title: "Checkout errors",
  question: "",
  requested_by: "Dana Lee",
  requested_by_me: false,
  requested_at: "2026-06-18T09:00:00Z",
  follow_up: false,
  screenshot_count: 0,
  link_count: 0,
  ...extra,
});

async function startBackend(options: { runs?: unknown[]; waitingList: boolean; heldByAnother?: boolean }) {
  const requests: Recorded[] = [];
  const server: Server = createHttpServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      const path = req.url ?? "";
      requests.push({ method: req.method ?? "", path, headers: req.headers, body: raw ? JSON.parse(raw) : undefined });
      const send = (status: number, body: unknown) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(body));
      };
      if (req.method === "GET" && path === "/api/v1/investigations?status=awaiting_agent" && options.waitingList) {
        return send(200, { runs: options.runs ?? [] });
      }
      const pickup = /^\/api\/v1\/investigations\/([^/]+)\/pickup$/.exec(path);
      if (req.method === "POST" && pickup) {
        if (options.heldByAnother && JSON.parse(raw).takeover !== true) {
          return send(409, {
            code: "run_has_active_client",
            message: "Another client drives this run.",
            details: { client_name: "codex", computer_name: "build-box", holder_name: "Dana Lee", last_contact_at: "2026-06-18T09:29:40Z" },
          });
        }
        return send(200, { run: { id: pickup[1], status: "running" }, incident: { id: 42 }, request: { skills: [] }, server_capabilities: [] });
      }
      return send(404, { code: "not_found", message: "not found" });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

async function connect(apiUrl: string, elicit?: (message: string, schema: any) => { action: string; content?: Record<string, unknown> }) {
  const server = createServer(new TellagenClient({ apiUrl, apiKey: "tllg_test" }));
  const client = new Client(
    { name: "claude-code", version: "2.1.0" },
    { capabilities: elicit ? { elicitation: {} } : {} },
  );
  const asked: string[] = [];
  if (elicit) {
    client.setRequestHandler(ElicitRequestSchema, async (request) => {
      asked.push(request.params.message);
      return elicit(request.params.message, (request.params as any).requestedSchema) as any;
    });
  }
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const result = (await client.callTool({ name, arguments: args })) as {
      content: Array<{ text: string }>;
      isError?: boolean;
    };
    return { isError: result.isError === true, json: () => JSON.parse(result.content.at(-1)!.text) };
  };
  return { call, asked, client, close: async () => { await client.close(); await server.close(); } };
}

describe("finding the run that waits, end to end", () => {
  let backend: Awaited<ReturnType<typeof startBackend>> | undefined;
  beforeEach(() => {
    vi.stubEnv("TELLAGEN_MCP_CLIENT", "");
    vi.stubEnv("TELLAGEN_MCP_PROFILE_ID", "");
  });
  afterEach(async () => {
    await backend?.close();
    backend = undefined;
    vi.unstubAllEnvs();
  });

  it("returns the one waiting run, and the pickup that follows needs no ID from the person", async () => {
    backend = await startBackend({ waitingList: true, runs: [run("run-7", { requested_by_me: true, screenshot_count: 2 })] });
    const agent = await connect(backend.url);
    try {
      const next = await agent.call("tellagen_next_investigation");
      expect(next.isError).toBe(false);
      const body = next.json();
      expect(body.waiting).toBe(1);
      expect(body.run).toMatchObject({ run_id: "run-7", incident_id: 42, incident_title: "Checkout errors", requested_by_me: true, screenshot_count: 2 });
      expect(body.next).toContain('tellagen_pick_up_investigation with investigation_run_id "run-7"');

      const pickup = await agent.call("tellagen_pick_up_investigation", { investigation_run_id: body.run.run_id, model: "Example Model 5" });
      expect(pickup.isError).toBe(false);
      const sent = backend.requests.find((request) => request.path.endsWith("/run-7/pickup"))!;
      expect(sent.body.client.name).toBe("claude-code");
      expect(sent.body.model).toBe("Example Model 5");
      // The list was read, never written.
      expect(backend.requests[0]).toMatchObject({ method: "GET", path: "/api/v1/investigations?status=awaiting_agent" });
    } finally {
      await agent.close();
    }
  });

  it("returns the list with the person's own runs first when several wait and the client cannot ask", async () => {
    backend = await startBackend({
      waitingList: true,
      runs: [run("run-a"), run("run-b", { requested_by_me: true, incident_id: 43, incident_human_id: "INC-43" }), run("run-c")],
    });
    const agent = await connect(backend.url);
    try {
      const body = (await agent.call("tellagen_next_investigation")).json();
      expect(body.waiting).toBe(3);
      expect(body.runs.map((item: { run_id: string }) => item.run_id)).toEqual(["run-b", "run-a", "run-c"]);
      expect(body.run).toBeUndefined();
      expect(body.message).toContain("ask which one to take");
      expect(body.message).toContain("Do not choose for them");
      // Nothing was picked up.
      expect(backend.requests.every((request) => request.method === "GET")).toBe(true);
    } finally {
      await agent.close();
    }
  });

  it("asks the person which run through the client when it can, and returns their choice", async () => {
    backend = await startBackend({ waitingList: true, runs: [run("run-a"), run("run-b", { requested_by_me: true })] });
    let offered: string[] = [];
    const agent = await connect(backend.url, (_message, schema) => {
      offered = schema.properties.choice.enum;
      return { action: "accept", content: { choice: "run-a" } };
    });
    try {
      const body = (await agent.call("tellagen_next_investigation")).json();
      expect(agent.asked).toHaveLength(1);
      expect(agent.asked[0]).toContain("2 diagnosis runs are waiting");
      expect(offered).toEqual(["run-b", "run-a"]);
      expect(body.chosen_by).toBe("person");
      expect(body.run.run_id).toBe("run-a");
      expect(body.next).toContain('"run-a"');
    } finally {
      await agent.close();
    }
  });

  it("picks nothing when the person declines, or the client returns a run that was not offered", async () => {
    backend = await startBackend({ waitingList: true, runs: [run("run-a"), run("run-b")] });
    for (const [answer, message] of [
      [{ action: "decline" }, "did not choose a run"],
      [{ action: "cancel" }, "did not choose a run"],
      // An answer that is not one of the offered runs is not a choice.
      [{ action: "accept", content: { choice: "run-zzz" } }, "Do not"],
    ] as const) {
      const agent = await connect(backend.url, () => answer);
      try {
        const body = (await agent.call("tellagen_next_investigation")).json();
        expect(body.run, answer.action).toBeUndefined();
        expect(body.chosen_by, answer.action).toBeUndefined();
        expect(body.message, answer.action).toContain(message);
        expect(body.runs).toHaveLength(2);
      } finally {
        await agent.close();
      }
    }
    expect(backend.requests.every((request) => request.method === "GET")).toBe(true);
  });

  it("says that no run waits and offers to start one, also for one incident", async () => {
    backend = await startBackend({ waitingList: true, runs: [run("run-a", { incident_id: 7 })] });
    const agent = await connect(backend.url);
    try {
      const none = (await agent.call("tellagen_next_investigation", { incident_id: 42 })).json();
      expect(none).toMatchObject({ waiting: 0, runs: [] });
      expect(none.message).toContain("No run is waiting for incident 42");
      expect(none.message).toContain("tellagen_start_investigation with the incident ID 42");
      const one = (await agent.call("tellagen_next_investigation", { incident_id: 7 })).json();
      expect(one.run.run_id).toBe("run-a");
    } finally {
      await agent.close();
    }

    await backend.close();
    backend = await startBackend({ waitingList: true, runs: [] });
    const empty = await connect(backend.url);
    try {
      const body = (await empty.call("tellagen_next_investigation")).json();
      expect(body.waiting).toBe(0);
      expect(body.message).toContain("No run is waiting.");
    } finally {
      await empty.close();
    }
  });

  it("explains that an older Tellagen has no waiting list and falls back to the run ID", async () => {
    backend = await startBackend({ waitingList: false });
    const agent = await connect(backend.url);
    try {
      const next = await agent.call("tellagen_next_investigation");
      expect(next.isError).toBe(false);
      const body = next.json();
      expect(body.code).toBe("waiting_list_unavailable");
      expect(body.message).toContain("needs an update");
      expect(body.message).toContain("ask the person for the run ID");
      // The run ID path still works.
      const pickup = await agent.call("tellagen_pick_up_investigation", { investigation_run_id: "run-9" });
      expect(pickup.isError).toBe(false);
    } finally {
      await agent.close();
    }
  });

  it("asks the person before it takes a run over from another client, through the client's own question", async () => {
    backend = await startBackend({ waitingList: true, heldByAnother: true });
    const yes = await connect(backend.url, () => ({ action: "accept", content: { confirm: true } }));
    try {
      const pickup = await yes.call("tellagen_pick_up_investigation", { investigation_run_id: "run-7" });
      expect(pickup.isError).toBe(false);
      expect(yes.asked).toHaveLength(1);
      expect(yes.asked[0]).toContain("Dana Lee runs this diagnosis in codex on build-box");
      const pickups = backend.requests.filter((request) => request.path.endsWith("/pickup"));
      expect(pickups.map((request) => request.body.takeover === true)).toEqual([false, true]);
    } finally {
      await yes.close();
    }

    backend.requests.length = 0;
    for (const answer of [{ action: "accept", content: { confirm: false } }, { action: "decline" }]) {
      const no = await connect(backend.url, () => answer);
      try {
        const pickup = await no.call("tellagen_pick_up_investigation", { investigation_run_id: "run-7" });
        expect(pickup.isError).toBe(true);
        expect(pickup.json().message).toContain("The person said no");
      } finally {
        await no.close();
      }
    }
    expect(backend.requests.some((request) => request.body?.takeover === true)).toBe(false);
  });

  it("reads a list defensively: drops rows with no run ID and cuts long text", () => {
    const runs = waitingRuns({ runs: [{ incident_id: 1 }, "x", run("run-a", { incident_title: "t".repeat(900) }), run("run-b", { requested_by_me: true })] });
    expect(runs.map((item) => item.run_id)).toEqual(["run-b", "run-a"]);
    expect(runs[1]!.incident_title!.length).toBe(200);
    expect(waitingRuns(undefined)).toEqual([]);
    expect(waitingRuns({ runs: "no" })).toEqual([]);
  });
});
