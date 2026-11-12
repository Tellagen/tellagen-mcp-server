import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { httpDefaults, TellagenClient } from "../src/client.js";
import { TellagenAPIError } from "../src/errors.js";
import {
  base64Bytes,
  checkScreenshotSizes,
  findingIdempotencyKey,
  SCREENSHOT_LIMITS,
} from "../src/tools/findings.js";
import { createToolHarness, jsonResponse } from "./helpers/harness.js";

const API = "https://test.api.tellagen.com";
const ok = (body: unknown = { ok: true }) => jsonResponse(body);
const status = (code: number, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify({ code: "unavailable", message: "try later" }), { status: code, headers });

describe("timeouts and retries of Tellagen calls", () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;
  let client: TellagenClient;
  const saved = { ...httpDefaults };

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, "fetch");
    client = new TellagenClient({ apiUrl: API, apiKey: "tllg_test" });
    httpDefaults.baseDelayMs = 1;
  });
  afterEach(() => {
    fetchSpy.mockRestore();
    Object.assign(httpDefaults, saved);
    vi.useRealTimers();
  });

  it.each([429, 502, 503, 504])("repeats a read after HTTP %d and returns the later answer", async (code) => {
    fetchSpy.mockResolvedValueOnce(status(code)).mockResolvedValueOnce(ok({ incidents: [] }));
    await expect(client.get("/api/v1/incidents")).resolves.toEqual({ incidents: [] });
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it("repeats a read after a network error", async () => {
    fetchSpy.mockRejectedValueOnce(new TypeError("fetch failed")).mockResolvedValueOnce(ok());
    await expect(client.get("/api/v1/incidents")).resolves.toEqual({ ok: true });
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it("repeats at most 3 times, then reports the last answer", async () => {
    fetchSpy.mockImplementation(async () => status(503));
    await expect(client.get("/api/v1/incidents")).rejects.toMatchObject({ status: 503, code: "unavailable" });
    expect(fetchSpy).toHaveBeenCalledTimes(4);

    fetchSpy.mockClear();
    fetchSpy.mockRejectedValue(new TypeError("fetch failed"));
    await expect(client.get("/api/v1/incidents")).rejects.toThrow("fetch failed");
    expect(fetchSpy).toHaveBeenCalledTimes(4);
  });

  it.each([400, 401, 403, 404, 409, 422, 500])("does not repeat after HTTP %d", async (code) => {
    fetchSpy.mockImplementation(async () => status(code));
    await expect(client.get("/api/v1/incidents")).rejects.toBeInstanceOf(TellagenAPIError);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("waits with a growing delay, and as long as Retry-After says, up to the cap", async () => {
    const waits: number[] = [];
    const realSetTimeout = globalThis.setTimeout;
    const spy = vi.spyOn(globalThis, "setTimeout").mockImplementation(((fn: () => void, ms?: number, ...args: unknown[]) => {
      // The attempt limit is far longer than any delay under test.
      if (ms !== undefined && ms < 20_000 + 1 && ms !== httpDefaults.timeoutMs) waits.push(ms);
      return realSetTimeout(fn, 0, ...args);
    }) as typeof setTimeout);
    try {
      httpDefaults.baseDelayMs = 100;
      httpDefaults.maxDelayMs = 5000;
      fetchSpy.mockImplementation(async () => status(503));
      await expect(client.get("/api/v1/incidents")).rejects.toMatchObject({ status: 503 });
      expect(waits).toEqual([100, 200, 400]);

      waits.length = 0;
      fetchSpy.mockReset();
      fetchSpy
        .mockResolvedValueOnce(status(429, { "Retry-After": "2" }))
        .mockResolvedValueOnce(status(429, { "Retry-After": "3600" }))
        .mockResolvedValueOnce(ok());
      await client.get("/api/v1/incidents");
      expect(waits).toEqual([2000, 5000]);
    } finally {
      spy.mockRestore();
    }
  });

  it("never repeats a write that could create a second record", async () => {
    for (const send of [
      () => client.post("/api/v1/incidents", { title: "x" }),
      () => client.patch("/api/v1/investigations/run-1", { status: "completed" }),
    ]) {
      fetchSpy.mockReset();
      fetchSpy.mockImplementation(async () => status(503));
      await expect(send()).rejects.toMatchObject({ status: 503 });
      expect(fetchSpy).toHaveBeenCalledTimes(1);

      fetchSpy.mockReset();
      fetchSpy.mockRejectedValue(new TypeError("fetch failed"));
      await expect(send()).rejects.toThrow("fetch failed");
      expect(fetchSpy).toHaveBeenCalledTimes(1);
    }
  });

  it("repeats a write that is safe by design or carries an idempotency key, with the same key each time", async () => {
    fetchSpy.mockResolvedValueOnce(status(502)).mockResolvedValueOnce(ok());
    await client.put("/api/v1/investigation-runs/run-1/causes/deploy-1", { state: "open" });
    expect(fetchSpy).toHaveBeenCalledTimes(2);

    fetchSpy.mockReset();
    fetchSpy.mockResolvedValueOnce(status(503)).mockResolvedValueOnce(ok());
    await client.post("/api/v1/investigation-runs/run-1/trace", { step_id: "s1" }, { safeToRepeat: true });
    expect(fetchSpy).toHaveBeenCalledTimes(2);

    fetchSpy.mockReset();
    fetchSpy.mockRejectedValueOnce(new TypeError("fetch failed")).mockResolvedValueOnce(ok());
    await client.post("/api/v1/incidents/1/findings", { claim: "x" }, { idempotencyKey: "mcp-finding-abc" });
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    const keys = fetchSpy.mock.calls.map((call) => ((call[1] as RequestInit).headers as Record<string, string>)["Idempotency-Key"]);
    expect(keys).toEqual(["mcp-finding-abc", "mcp-finding-abc"]);
  });

  it("ends an attempt after the time limit and says what happened, without a second write", async () => {
    httpDefaults.timeoutMs = 20;
    fetchSpy.mockImplementation(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          (init as RequestInit).signal!.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
        }),
    );
    const failure = await client.post("/api/v1/incidents", { title: "x" }).catch((err) => err);
    expect(failure).toBeInstanceOf(TellagenAPIError);
    expect(failure.code).toBe("timeout");
    expect(failure.message).toContain("did not answer within");
    expect(failure.message).toContain("was not repeated");
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("repeats a read that timed out", async () => {
    httpDefaults.timeoutMs = 20;
    fetchSpy
      .mockImplementationOnce(
        (_url, init) =>
          new Promise((_resolve, reject) => {
            (init as RequestInit).signal!.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
          }),
      )
      .mockResolvedValueOnce(ok({ incidents: [] }));
    await expect(client.get("/api/v1/incidents")).resolves.toEqual({ incidents: [] });
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it("stops repeating when the time for the whole call is over", async () => {
    httpDefaults.totalMs = 60;
    httpDefaults.timeoutMs = 50;
    httpDefaults.baseDelayMs = 40;
    fetchSpy.mockImplementation(async () => status(503));
    const started = Date.now();
    await expect(client.get("/api/v1/incidents")).rejects.toMatchObject({ status: 503 });
    // 40 ms, then 80 ms: the second wait would pass the limit, so two attempts.
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(Date.now() - started).toBeLessThan(1000);

    fetchSpy.mockReset();
    fetchSpy.mockRejectedValue(new TypeError("fetch failed"));
    await expect(client.get("/api/v1/incidents")).rejects.toThrow("fetch failed");
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(saved.totalMs).toBe(60_000);
    expect(saved.uploadTotalMs).toBe(150_000);
  });

  it("uses 30 seconds by default and 120 for an upload", () => {
    expect(saved.timeoutMs).toBe(30_000);
    expect(saved.uploadTimeoutMs).toBe(120_000);
    expect(saved.retries).toBe(3);
  });

  it("puts no key and no body in a network error or a timeout", async () => {
    httpDefaults.timeoutMs = 10;
    fetchSpy.mockImplementation(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          (init as RequestInit).signal!.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
        }),
    );
    const harness = createToolHarness(API, { apiKey: "tllg_secret_value_123" });
    const result = await harness.callTool("tellagen_create_incident", { title: "Checkout is down", severity: "sev2" });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).not.toContain("tllg_secret_value_123");
    expect(result.content[0].text).not.toContain("Bearer");
  });
});

describe("a finding is safe to send twice", () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;
  const saved = { ...httpDefaults };
  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, "fetch");
    httpDefaults.baseDelayMs = 1;
  });
  afterEach(() => {
    fetchSpy.mockRestore();
    Object.assign(httpDefaults, saved);
  });

  const finding = {
    incident_id: 42,
    investigation_run_id: "run-1",
    finding_type: "observation",
    claim: "Errors rose after the deploy",
    evidence_summary: "847 errors in 30 minutes",
    confidence: 0.8,
    confidence_reason: "Direct log count",
  };
  const keyOf = (call: unknown[]) => ((call[1] as RequestInit).headers as Record<string, string>)["Idempotency-Key"];

  it("sends an idempotency key with every finding and repeats it after a network error", async () => {
    const harness = createToolHarness();
    fetchSpy.mockRejectedValueOnce(new TypeError("fetch failed")).mockResolvedValueOnce(jsonResponse({ finding: { id: 5 } }, 201));
    const result = await harness.callTool("tellagen_post_finding", finding);
    expect(result.isError).toBeUndefined();
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    const key = keyOf(fetchSpy.mock.calls[0]!);
    expect(key).toMatch(/^mcp-finding-[0-9a-f]{48}$/);
    expect(keyOf(fetchSpy.mock.calls[1]!)).toBe(key);
  });

  it("gives the same finding the same key when the model sends it again, and another finding another key", async () => {
    const harness = createToolHarness();
    fetchSpy.mockImplementation(async () => jsonResponse({ finding: { id: 5 } }, 201));
    await harness.callTool("tellagen_post_finding", finding);
    await harness.callTool("tellagen_post_finding", finding);
    await harness.callTool("tellagen_post_finding", { ...finding, claim: "Errors fell after the rollback" });
    await harness.callTool("tellagen_post_finding", { ...finding, incident_id: 43 });
    const keys = fetchSpy.mock.calls.map(keyOf);
    expect(keys[1]).toBe(keys[0]);
    expect(keys[2]).not.toBe(keys[0]);
    expect(keys[3]).not.toBe(keys[0]);
    expect(findingIdempotencyKey(42, { a: 1 })).toBe(findingIdempotencyKey(42, { a: 1 }));
    expect(findingIdempotencyKey(42, { a: 1 }).length).toBeLessThanOrEqual(128);
  });

  it("measures base64 screenshots before sending and names the limit", async () => {
    const harness = createToolHarness();
    expect(base64Bytes("AAAA")).toBe(3);
    expect(base64Bytes("AAA=")).toBe(2);
    expect(base64Bytes("data:image/png;base64,AAAA")).toBe(3);

    const big = "A".repeat(Math.ceil(((SCREENSHOT_LIMITS.bytesEach + 3) * 4) / 3));
    const one = await harness.callTool("tellagen_post_finding", { ...finding, screenshots: [{ base64: big }] });
    expect(one.isError).toBe(true);
    expect(harness.json(one).message).toContain("the limit is 10.0 MB for one screenshot");
    expect(harness.json(one).message).toContain("Nothing was sent");

    const six = "A".repeat(Math.ceil((6 * 1024 * 1024 * 4) / 3));
    const together = await harness.callTool("tellagen_post_finding", {
      ...finding,
      screenshots: [{ base64: six }],
      evidence_refs: [{ source: "grafana", result_summary: "panel", screenshots: [{ base64: six }, { base64: six }] }],
    });
    expect(harness.json(together).message).toContain("the limit is 15.0 MB for one finding");

    const many = await harness.callTool("tellagen_post_finding", {
      ...finding,
      screenshots: Array.from({ length: 21 }, () => ({ url: "https://example.com/a.png" })),
    });
    expect(harness.json(many).message).toContain("at most 20 screenshots");
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(() => checkScreenshotSizes([{ base64: "AAAA" }], undefined)).not.toThrow();
  });

  it("gives a finding with screenshots the longer time limit", async () => {
    const harness = createToolHarness();
    const limits: number[] = [];
    const realSetTimeout = globalThis.setTimeout;
    const spy = vi.spyOn(globalThis, "setTimeout").mockImplementation(((fn: () => void, ms?: number, ...args: unknown[]) => {
      if (ms === 30_000 || ms === 120_000) limits.push(ms);
      return realSetTimeout(fn, ms, ...args);
    }) as typeof setTimeout);
    try {
      fetchSpy.mockImplementation(async () => jsonResponse({ finding: { id: 5 } }, 201));
      await harness.callTool("tellagen_post_finding", finding);
      await harness.callTool("tellagen_post_finding", { ...finding, screenshots: [{ base64: "AAAA" }] });
      expect(limits).toEqual([30_000, 120_000]);
    } finally {
      spy.mockRestore();
    }
  });
});
