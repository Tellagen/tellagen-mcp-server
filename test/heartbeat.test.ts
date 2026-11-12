import { mkdtempSync, existsSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { Heartbeat, HEARTBEAT_MISSED_LINE } from "../src/heartbeat.js";
import { createToolHarness, jsonResponse } from "./helpers/harness.js";

const API = "https://acme.api.tellagen.com";
const pickupAnswer = (capabilities: string[]) =>
  jsonResponse({ run: { id: "run-1", status: "running" }, incident: { id: 42 }, server_capabilities: capabilities });
const beats = (spy: ReturnType<typeof vi.spyOn>) =>
  spy.mock.calls.filter((call) => String(call[0]).endsWith("/api/v1/investigation-runs/run-1/heartbeat"));

describe("the heartbeat of an active run", () => {
  let dir: string;
  let fetchSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "tellagen-hb-"));
    fetchSpy = vi.spyOn(globalThis, "fetch");
    vi.stubEnv("TELLAGEN_MCP_PROFILE_ID", "");
  });
  afterEach(() => {
    fetchSpy.mockRestore();
    vi.unstubAllEnvs();
    vi.useRealTimers();
    rmSync(dir, { recursive: true, force: true });
  });

  const start = async (capabilities: string[]) => {
    const harness = createToolHarness(API, { stateDir: join(dir, "state") });
    const heartbeat = new Heartbeat(harness.client, 30_000);
    fetchSpy.mockResolvedValueOnce(pickupAnswer(capabilities));
    await harness.callTool("tellagen_pick_up_investigation", { investigation_run_id: "run-1" });
    return { harness, heartbeat };
  };

  it("starts at pickup, beats every 30 seconds with the session ID, and stops when the run completes", async () => {
    vi.useFakeTimers();
    const { harness, heartbeat } = await start(["client_heartbeat_v1"]);
    expect(heartbeat.running()).toBe(true);
    fetchSpy.mockImplementation(async () => jsonResponse({ run_state: "running", responder_notes: [] }));

    await vi.advanceTimersByTimeAsync(29_000);
    expect(beats(fetchSpy)).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(beats(fetchSpy)).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(beats(fetchSpy)).toHaveLength(3);

    const [, init] = beats(fetchSpy)[0]!;
    expect((init as RequestInit).method).toBe("POST");
    expect(JSON.parse(String((init as RequestInit).body))).toEqual({ session_id: harness.client.session.sessionId });
    const headers = (init as RequestInit).headers as Record<string, string>;
    expect(headers["X-Tellagen-Client-Session"]).toBe(harness.client.session.sessionId);

    fetchSpy.mockResolvedValueOnce(jsonResponse({ run: { id: "run-1", status: "completed" } }));
    await harness.callTool("tellagen_complete_investigation", { status: "completed" });
    expect(heartbeat.running()).toBe(false);
    const count = beats(fetchSpy).length;
    await vi.advanceTimersByTimeAsync(120_000);
    expect(beats(fetchSpy)).toHaveLength(count);
  });

  it("sends no heartbeat to a Tellagen that does not list the capability", async () => {
    vi.useFakeTimers();
    const { heartbeat } = await start(["diagnosis_structure_v1"]);
    expect(heartbeat.running()).toBe(false);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(beats(fetchSpy)).toHaveLength(0);
  });

  it("never fails a tool call, and says so once after three failed heartbeats in a row", async () => {
    const { harness, heartbeat } = await start(["client_heartbeat_v1"]);
    fetchSpy.mockRejectedValueOnce(new TypeError("fetch failed"));
    await heartbeat.beat();
    fetchSpy.mockResolvedValueOnce(jsonResponse({ code: "internal", message: "internal error" }, 500));
    await heartbeat.beat();

    // Two failures: nothing is said yet.
    fetchSpy.mockResolvedValueOnce(jsonResponse({ steps: [] }));
    const quiet = await harness.callTool("tellagen_list_trace_steps", {});
    expect(quiet.isError).toBeUndefined();
    expect(quiet.content).toHaveLength(1);

    fetchSpy.mockRejectedValueOnce(new TypeError("fetch failed"));
    await heartbeat.beat();
    fetchSpy.mockRejectedValueOnce(new TypeError("fetch failed"));
    await heartbeat.beat();

    fetchSpy.mockResolvedValueOnce(jsonResponse({ steps: [] }));
    const told = await harness.callTool("tellagen_list_trace_steps", {});
    expect(told.isError).toBeUndefined();
    expect(told.content[0].text).toBe(HEARTBEAT_MISSED_LINE);
    expect(HEARTBEAT_MISSED_LINE).toBe("Tellagen has not heard from this client for 90 seconds.");
    expect(harness.lastJson(told)).toEqual({ steps: [] });

    // The line is said once.
    fetchSpy.mockResolvedValueOnce(jsonResponse({ steps: [] }));
    expect((await harness.callTool("tellagen_list_trace_steps", {})).content).toHaveLength(1);
    expect(heartbeat.running()).toBe(true);
    heartbeat.stop();
  });

  it("is not repeated on a failure: the next beat is the retry", async () => {
    const { heartbeat } = await start(["client_heartbeat_v1"]);
    fetchSpy.mockClear();
    fetchSpy.mockImplementation(async () => jsonResponse({ code: "unavailable", message: "later" }, 503));
    await heartbeat.beat();
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    heartbeat.stop();
  });

  it("stops and tells the model when the heartbeat learns that the run was taken over", async () => {
    const { harness, heartbeat } = await start(["client_heartbeat_v1"]);
    fetchSpy.mockResolvedValueOnce(
      jsonResponse({ code: "run_taken_over", message: "Another client took this run over.", details: { taken_over_at: "2026-06-18T09:30:00Z" } }, 409),
    );
    await heartbeat.beat();
    expect(heartbeat.running()).toBe(false);
    expect(harness.client.session.activeRun()).toBeUndefined();
    expect(existsSync(join(dir, "state", "acme.api.tellagen.com.json"))).toBe(false);

    fetchSpy.mockResolvedValueOnce(jsonResponse({ incidents: [] }));
    const next = await harness.callTool("tellagen_list_incidents", {});
    expect(next.content[0].text).toContain("Another client took this run over at 2026-06-18T09:30:00Z");
    expect(next.content[0].text).toContain("Stop");
  });

  it("passes a note that arrives with a heartbeat to the next tool answer", async () => {
    const { harness, heartbeat } = await start(["client_heartbeat_v1", "responder_notes_v1"]);
    fetchSpy.mockResolvedValueOnce(
      jsonResponse({
        run_state: "running",
        responder_notes: [{ id: 1, author_name: "Dana Lee", text: "Check the billing queue too.", created_at: "2026-06-18T09:31:00Z" }],
      }),
    );
    await heartbeat.beat();
    fetchSpy.mockResolvedValueOnce(jsonResponse({ incidents: [] }));
    const next = await harness.callTool("tellagen_list_incidents", {});
    expect(next.content[0].text).toContain('Note from Dana Lee in Tellagen, 2026-06-18T09:31:00Z: "Check the billing queue too."');
    heartbeat.stop();
  });
});

describe("a note that arrives with a heartbeat survives a restart of the client", () => {
  let dir: string;
  let fetchSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "tellagen-hb-restart-"));
    fetchSpy = vi.spyOn(globalThis, "fetch");
    vi.stubEnv("TELLAGEN_MCP_PROFILE_ID", "");
  });
  afterEach(() => {
    fetchSpy.mockRestore();
    vi.unstubAllEnvs();
    rmSync(dir, { recursive: true, force: true });
  });

  it("keeps the note in the state file, with no secret, and shows it once after the restart", async () => {
    const first = createToolHarness(API, { stateDir: join(dir, "state") });
    const heartbeat = new Heartbeat(first.client, 30_000);
    fetchSpy.mockResolvedValueOnce(pickupAnswer(["client_heartbeat_v1", "responder_notes_v1"]));
    await first.callTool("tellagen_pick_up_investigation", { investigation_run_id: "run-1" });
    fetchSpy.mockResolvedValueOnce(
      jsonResponse({ run_state: "running", responder_notes: [{ id: 5, author_name: "Dana Lee", text: "Check the billing queue too.", created_at: "2026-06-18T09:31:00Z" }] }),
    );
    await heartbeat.beat();
    heartbeat.stop();

    // The file holds the note, and nothing that works as a credential.
    const file = join(dir, "state", "acme.api.tellagen.com.json");
    const stored = readFileSync(file, "utf8");
    expect(stored).toContain("Check the billing queue too.");
    expect(stored).not.toMatch(/tllg_|Bearer|api_key|tgn_/);

    // A new process on the same computer: a new harness over the same folder.
    const second = createToolHarness(API, { stateDir: join(dir, "state") });
    second.client.session.setActiveRun({ runId: "run-1", pickedUpAt: "x", serverCapabilities: ["client_heartbeat_v1"] });
    fetchSpy.mockResolvedValueOnce(jsonResponse({ incidents: [] }));
    const answer = await second.callTool("tellagen_list_incidents", {});
    expect(answer.content[0].text).toContain('Note from Dana Lee in Tellagen, 2026-06-18T09:31:00Z: "Check the billing queue too."');
    fetchSpy.mockResolvedValueOnce(jsonResponse({ incidents: [] }));
    const again = await second.callTool("tellagen_list_incidents", {});
    expect(again.content).toHaveLength(1);
  });
});

describe("a run another client holds", () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, "fetch");
    vi.stubEnv("TELLAGEN_MCP_PROFILE_ID", "");
  });
  afterEach(() => {
    fetchSpy.mockRestore();
    vi.unstubAllEnvs();
  });

  const refused = () =>
    jsonResponse(
      {
        code: "run_has_active_client",
        message: "Another client drives this run.",
        details: { client_name: "codex", computer_name: "build-box", holder_name: "Dana Lee", last_contact_at: "2026-06-18T09:29:40Z" },
      },
      409,
    );

  it("answers a refused pickup with who holds the run and a question for the person", async () => {
    const harness = createToolHarness();
    fetchSpy.mockResolvedValueOnce(refused());
    const result = await harness.callTool("tellagen_pick_up_investigation", { investigation_run_id: "run-1" });
    expect(result.isError).toBe(true);
    const body = harness.json(result);
    expect(body.code).toBe("run_has_active_client");
    expect(body.message).toContain("Dana Lee runs this diagnosis in codex on build-box, last contact at 2026-06-18T09:29:40Z.");
    expect(body.message).toContain("Ask the person whether this session should take the run over");
    expect(body.next_input).toEqual({ takeover: true });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String((fetchSpy.mock.calls[0]![1] as RequestInit).body)).takeover).toBeUndefined();
    expect(harness.client.session.activeRun()).toBeUndefined();
  });

  it("takes the run over only after a yes: with the takeover input, or through the client's question", async () => {
    const harness = createToolHarness();
    fetchSpy.mockResolvedValueOnce(jsonResponse({ run: { id: "run-1" }, incident: { id: 42 }, server_capabilities: [] }));
    const result = await harness.callTool("tellagen_pick_up_investigation", { investigation_run_id: "run-1", takeover: true });
    expect(result.isError).toBeUndefined();
    expect(JSON.parse(String((fetchSpy.mock.calls[0]![1] as RequestInit).body)).takeover).toBe(true);

    const asking = createToolHarness();
    const ask = vi.fn(async () => true);
    asking.client.session.ask = ask;
    fetchSpy.mockReset();
    fetchSpy
      .mockResolvedValueOnce(refused())
      .mockResolvedValueOnce(jsonResponse({ run: { id: "run-1" }, incident: { id: 42 }, server_capabilities: [] }));
    const taken = await asking.callTool("tellagen_pick_up_investigation", { investigation_run_id: "run-1" });
    expect(taken.isError).toBeUndefined();
    expect(ask).toHaveBeenCalledTimes(1);
    // The dialog holds a plain question, with no instruction for the model.
    expect(ask.mock.calls[0]![0]).toBe(
      "Dana Lee runs this diagnosis in codex on build-box, last contact at 2026-06-18T09:29:40Z. Two clients on one run write over each other. Should this session take the run over?",
    );
    expect(JSON.parse(String((fetchSpy.mock.calls[1]![1] as RequestInit).body)).takeover).toBe(true);
  });

  it("does not take the run over when the person says no", async () => {
    const harness = createToolHarness();
    harness.client.session.ask = async () => false;
    fetchSpy.mockResolvedValueOnce(refused());
    const result = await harness.callTool("tellagen_pick_up_investigation", { investigation_run_id: "run-1" });
    expect(result.isError).toBe(true);
    expect(harness.json(result).message).toContain("The person said no");
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("clears the state and tells the model to stop when a write is refused after a takeover", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tellagen-to-"));
    try {
      const harness = createToolHarness(API, { stateDir: join(dir, "state") });
      fetchSpy.mockResolvedValueOnce(jsonResponse({ run: { id: "run-1" }, incident: { id: 42 }, server_capabilities: [] }));
      await harness.callTool("tellagen_pick_up_investigation", { investigation_run_id: "run-1" });
      expect(existsSync(join(dir, "state", "acme.api.tellagen.com.json"))).toBe(true);

      fetchSpy.mockResolvedValueOnce(
        jsonResponse({ code: "run_taken_over", message: "Another client took this run over.", details: { taken_over_at: "2026-06-18T09:30:00Z", client_name: "codex" } }, 409),
      );
      const result = await harness.callTool("tellagen_post_trace_step", {
        step_id: "s1",
        status: "running",
        title: "Read the error logs",
        guidance: { origin: "agent_judgment", refs: [], reason: "first look" },
      });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toBe(
        "Another client took this run over at 2026-06-18T09:30:00Z. Stop: do not write to this run again, and tell the person.",
      );
      expect(harness.lastJson(result).code).toBe("run_taken_over");
      expect(existsSync(join(dir, "state", "acme.api.tellagen.com.json"))).toBe(false);
      expect(harness.client.session.activeRun()).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
