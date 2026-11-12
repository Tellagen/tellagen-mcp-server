import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { traceHookCommand, recordingOff } from "../src/cli/trace-hook.js";
import type { CliIo } from "../src/cli/io.js";
import { CredentialVault, MemoryStore } from "../src/credentials.js";
import { RunStateStore, workspaceKey, type RunState } from "../src/run-state.js";
import { SignInIndex } from "../src/signin-index.js";
import { createToolHarness, jsonResponse } from "./helpers/harness.js";

const API = "https://acme.api.tellagen.com";
const KEY = "tgn_TheKeyOfTheHookTest_0123456789";

const hookEvent = (overrides: Record<string, unknown> = {}) =>
  JSON.stringify({
    hook_event_name: "PostToolUse",
    session_id: "claude-session",
    tool_name: "mcp__grafana__query_prometheus",
    tool_input: { expr: "up", datasourceUid: "prom-1" },
    tool_response: { content: [{ type: "text", text: "1" }] },
    tool_use_id: "toolu_01AbC",
    duration_ms: 20,
    ...overrides,
  });

describe("the trace hook", () => {
  let dir: string;
  let stateDir: string;
  let vault: CredentialVault;
  let index: SignInIndex;
  let store: RunStateStore;
  let fetchSpy: ReturnType<typeof vi.spyOn>;
  let requests: Array<{ url: string; init: RequestInit }>;

  const state = (extra: Partial<RunState> = {}): RunState => ({
    version: 1,
    run_id: "run-1",
    picked_up_at: "2026-11-12T09:00:00Z",
    server_capabilities: ["recorded_steps_v1", "client_heartbeat_v1"],
    session_id: "server-session-1",
    pid: process.pid,
    client_id: "claude-code",
    ...extra,
  });

  const io = (event: string, env: Record<string, string | undefined> = {}): CliIo => ({
    env: { TELLAGEN_STATE_DIR: stateDir, TELLAGEN_API_URL: API, TELLAGEN_API_KEY: KEY, ...env },
    stdout: () => undefined,
    stderr: () => undefined,
    readStdin: async () => event,
  });

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "tellagen-hook-"));
    stateDir = join(dir, "state");
    vault = new CredentialVault(new MemoryStore(), new MemoryStore("file"), false);
    index = new SignInIndex(join(dir, "home"));
    store = new RunStateStore(stateDir, workspaceKey(API));
    requests = [];
    fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      requests.push({ url: String(input), init: init ?? {} });
      return jsonResponse({ steps: [{ step_id: "toolu_01AbC", recorded_by: "client" }] });
    });
  });
  afterEach(() => {
    fetchSpy.mockRestore();
    rmSync(dir, { recursive: true, force: true });
  });

  it("does nothing, and makes no request, when no run is open", async () => {
    expect(await traceHookCommand([], io(hookEvent()), { vault, index })).toBe(0);
    expect(requests).toHaveLength(0);
  });

  it("does not touch the keychain when no run is open", async () => {
    const spyVault = { load: vi.fn() } as unknown as CredentialVault;
    await traceHookCommand([], io(hookEvent(), { TELLAGEN_API_KEY: undefined }), { vault: spyVault, index });
    expect((spyVault as any).load).not.toHaveBeenCalled();
  });

  it("posts one recorded step as the server that holds the run", async () => {
    store.write(state());
    expect(await traceHookCommand([], io(hookEvent()), { vault, index })).toBe(0);
    expect(requests).toHaveLength(1);
    const request = requests[0]!;
    expect(request.url).toBe(`${API}/api/v1/investigation-runs/run-1/trace`);
    const headers = new Headers(request.init.headers);
    expect(headers.get("x-tellagen-client-session")).toBe("server-session-1");
    expect(headers.get("x-tellagen-client")).toBe("claude-code");
    expect(headers.get("authorization")).toBe(`Bearer ${KEY}`);
    const body = JSON.parse(String(request.init.body));
    expect(body).toMatchObject({ recorded_by: "client", step_id: "toolu_01AbC", status: "done", tool_name: "grafana.query_prometheus" });
    expect(JSON.stringify(body)).not.toContain(KEY);
  });

  it("uses the key of the sign-in when the environment has none", async () => {
    store.write(state());
    await vault.save("acme.api.tellagen.com", KEY);
    index.save("acme.api.tellagen.com", { api_url: API, signed_in_at: "x", storage: "macos-keychain" });
    await traceHookCommand([], io(hookEvent(), { TELLAGEN_API_KEY: undefined, TELLAGEN_API_URL: undefined }), { vault, index });
    expect(requests).toHaveLength(1);
    expect(new Headers(requests[0]!.init.headers).get("authorization")).toBe(`Bearer ${KEY}`);
  });

  it("skips a tool that a diagnosis does not record", async () => {
    store.write(state());
    await traceHookCommand([], io(hookEvent({ tool_name: "Read", tool_input: { file_path: "/x" } })), { vault, index });
    await traceHookCommand([], io(hookEvent({ tool_name: "mcp__grafana__update_dashboard", tool_input: { uid: "x" } })), { vault, index });
    expect(requests).toHaveLength(0);
  });

  it("sends nothing to a server that does not accept recorded steps", async () => {
    store.write(state({ server_capabilities: ["client_heartbeat_v1"] }));
    await traceHookCommand([], io(hookEvent()), { vault, index });
    expect(requests).toHaveLength(0);
  });

  it("is off when the option or the variable says so", async () => {
    store.write(state());
    await traceHookCommand([], io(hookEvent(), { CLAUDE_PLUGIN_OPTION_RECORD_STEPS: "false" }), { vault, index });
    await traceHookCommand([], io(hookEvent(), { TELLAGEN_RECORD_STEPS: "0" }), { vault, index });
    expect(requests).toHaveLength(0);
    expect(recordingOff({ TELLAGEN_RECORD_STEPS: "true" })).toBe(false);
    expect(recordingOff({})).toBe(false);
  });

  it("returns on time and with 0 when the backend does not answer", async () => {
    store.write(state());
    fetchSpy.mockImplementation(
      (_input, init) =>
        new Promise((_resolve, reject) => {
          (init?.signal as AbortSignal | undefined)?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
        }),
    );
    const started = Date.now();
    expect(await traceHookCommand([], io(hookEvent()), { vault, index, timeoutMs: 300 })).toBe(0);
    expect(Date.now() - started).toBeLessThan(1500);
  });

  it("returns 0 when the backend fails or the network is down, and does not repeat", async () => {
    store.write(state());
    fetchSpy.mockImplementation(async (input, init) => {
      requests.push({ url: String(input), init: init ?? {} });
      return jsonResponse({ code: "internal", message: "x" }, 503);
    });
    expect(await traceHookCommand([], io(hookEvent()), { vault, index })).toBe(0);
    expect(requests).toHaveLength(1);
    fetchSpy.mockImplementation(async () => {
      throw new TypeError("fetch failed");
    });
    expect(await traceHookCommand([], io(hookEvent()), { vault, index })).toBe(0);
  });

  it("returns 0 for garbage on standard input", async () => {
    store.write(state());
    expect(await traceHookCommand([], io("not json {"), { vault, index })).toBe(0);
    expect(requests).toHaveLength(0);
  });

  it("keeps a note from a responder for the model, once", async () => {
    store.write(state());
    fetchSpy.mockImplementation(async () =>
      jsonResponse({
        steps: [{}],
        run_state: "running",
        responder_notes: [{ id: 7, author_name: "Ann Lee", text: "Look at the payments queue", created_at: "2026-11-12T10:00:00Z", origin: "responder" }],
      }),
    );
    await traceHookCommand([], io(hookEvent()), { vault, index });
    await traceHookCommand([], io(hookEvent({ tool_use_id: "toolu_2" })), { vault, index });
    const notes = store.read()?.pending_notes;
    expect(notes).toHaveLength(1);
    expect(notes![0]).toMatchObject({ id: 7, author: "Ann Lee", text: "Look at the payments queue" });
  });

  it("records that the run ended or was taken over, so the next tool answer tells the model", async () => {
    store.write(state());
    fetchSpy.mockImplementation(async () =>
      jsonResponse({ code: "investigation_run_ended", message: "This diagnosis was cancelled. Stop writing to it.", details: { reason: "cancelled" } }, 409),
    );
    await traceHookCommand([], io(hookEvent()), { vault, index });
    expect(store.read()?.stop?.reason).toBe("cancelled");
    store.write(state());
    fetchSpy.mockImplementation(async () => jsonResponse({ code: "run_taken_over", message: "x", details: {} }, 409));
    await traceHookCommand([], io(hookEvent()), { vault, index });
    expect(store.read()?.stop?.reason).toContain("took it over");
    store.write(state());
    fetchSpy.mockImplementation(async () => jsonResponse({ steps: [{}], run_state: "cancel_requested" }));
    await traceHookCommand([], io(hookEvent()), { vault, index });
    expect(store.read()?.stop?.reason).toContain("cancelled");
  });
});

describe("a recorded step and the later post of the model", () => {
  it("merge into one step: the hook's facts stay, the model adds the outcome", async () => {
    // A small Tellagen that merges as the contract says.
    const steps = new Map<string, Record<string, any>>();
    const dir = mkdtempSync(join(tmpdir(), "tellagen-merge-"));
    const stateDir = join(dir, "state");
    const store = new RunStateStore(stateDir, workspaceKey(API));
    store.write({ version: 1, run_id: "run-1", picked_up_at: "x", server_capabilities: ["recorded_steps_v1"], session_id: "server-session-1", pid: process.pid, client_id: "claude-code" });
    const spy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const body = JSON.parse(String(init?.body ?? "{}"));
      if (!String(input).endsWith("/trace")) return jsonResponse({ server_capabilities: ["diagnosis_structure_v1", "recorded_steps_v1"] });
      const existing = steps.get(body.step_id);
      if (body.recorded_by === "client") {
        steps.set(body.step_id, { ...body, guidance: { origin: "system_recorded" } });
      } else if (existing) {
        steps.set(body.step_id, {
          ...existing,
          guidance: body.guidance,
          outcome: body.outcome,
          cause_key: body.cause_key,
          result_summary: existing.result_summary ?? body.result_summary,
        });
      } else {
        steps.set(body.step_id, body);
      }
      return jsonResponse({ steps: [steps.get(body.step_id)] });
    });
    try {
      // The server picks the run up first, then the hook records.
      const harness = createToolHarness(API, { stateDir });
      harness.client.session.setActiveRun({ runId: "run-1", pickedUpAt: "x", serverCapabilities: ["recorded_steps_v1"] });
      await traceHookCommand(
        [],
        {
          env: { TELLAGEN_STATE_DIR: stateDir, TELLAGEN_API_URL: API, TELLAGEN_API_KEY: KEY },
          stdout: () => undefined,
          stderr: () => undefined,
          readStdin: async () => hookEvent(),
        },
        {},
      );
      const recorded = steps.get("toolu_01AbC")!;
      expect(recorded.guidance.origin).toBe("system_recorded");
      // The hook leaves the step id for the model, which cannot see a tool use id.
      expect(store.recordedSteps("run-1")).toEqual([expect.objectContaining({ step_id: "toolu_01AbC" })]);

      // The model posts the same step id, with its outcome and no recorded_by.
      const result = await harness.callTool("tellagen_post_trace_step", {
        step_id: "recorded:latest",
        status: "done",
        title: "Checkout 5xx rate",
        outcome: "supports",
        cause_key: "pool-exhausted",
        guidance: { origin: "agent_judgment", reason: "checks the error rate" },
      });
      expect(result.isError).toBeUndefined();
      const merged = steps.get("toolu_01AbC")!;
      expect(merged).toMatchObject({ recorded_by: "client", tool_name: "grafana.query_prometheus", outcome: "supports", cause_key: "pool-exhausted" });
      expect(merged.guidance.origin).toBe("agent_judgment");
      expect(merged.input_json.query).toBe("up");
      const manualBody = JSON.parse(String(spy.mock.calls.at(-1)![1]!.body));
      expect(manualBody).not.toHaveProperty("recorded_by");
      expect(manualBody.step_id).toBe("toolu_01AbC");
      // The step has its outcome now, so it is no longer waiting for one.
      expect(store.recordedSteps("run-1")).toEqual([]);
      const none = await harness.callTool("tellagen_post_trace_step", { step_id: "recorded:latest", status: "done", title: "x" });
      expect(none.isError).toBe(true);
      expect(none.content[0]!.text).toContain("No step was recorded by a hook");
    } finally {
      spy.mockRestore();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
