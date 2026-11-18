import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import {
  KUBERNETES_SAFETY_CHECKS,
  KUBERNETES_SAFETY_PROTOCOL,
  kubernetesSafetyVerdict,
  type KubernetesSafetyCheck,
} from "../src/k8s-safety.js";
import { createToolHarness, jsonResponse } from "./helpers/harness.js";

const PATH = "https://test.api.tellagen.com/api/v1/settings/agent/tool-report";

// The config files of this computer, as the report tool reads them. A test sets the files.
const files = vi.hoisted(() => new Map<string, string>());
vi.mock("../src/doctor/real-fs.js", () => ({
  realDoctorFs: () => ({
    platform: "darwin",
    home: "/home/u",
    cwd: "/work",
    appData: "",
    xdgConfig: "",
    readText: (path: string) => files.get(path),
    isExecutable: () => false,
  }),
}));

describe("tellagen_report_available_sources", () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    files.clear();
    fetchSpy = vi.spyOn(globalThis, "fetch");
    vi.stubEnv("TELLAGEN_MCP_PROFILE_ID", "");
  });
  afterEach(() => {
    fetchSpy.mockRestore();
    vi.unstubAllEnvs();
  });
  const sentBody = (call = 0) => JSON.parse(String((fetchSpy.mock.calls[call]![1] as RequestInit).body));

  it("posts the sources and the profile to the report route and returns the answer", async () => {
    const harness = createToolHarness();
    const answer = { client: "claude-code", accepted_sources: [{ key: "grafana", state: "found" }], ignored_sources: [] };
    fetchSpy.mockResolvedValueOnce(jsonResponse(answer));
    const sources = [{ key: "grafana", state: "found", detail: "grafana.example.com" }, { key: "kubernetes", state: "not_found" }];
    const result = await harness.callTool("tellagen_report_available_sources", { available_sources: sources, profile_id: "prod" });
    expect(result.isError).toBeUndefined();
    expect(harness.json(result)).toEqual(answer);
    expect(fetchSpy.mock.calls[0]![0]).toBe(PATH);
    expect((fetchSpy.mock.calls[0]![1] as RequestInit).method).toBe("POST");
    expect(sentBody()).toEqual({ available_sources: sources, profile_id: "prod" });
  });

  it("takes the profile from the environment when the model gives none", async () => {
    vi.stubEnv("TELLAGEN_MCP_PROFILE_ID", "env-profile");
    const harness = createToolHarness();
    fetchSpy.mockResolvedValueOnce(jsonResponse({ accepted_sources: [] }));
    await harness.callTool("tellagen_report_available_sources", { available_sources: [{ key: "docs", state: "found" }] });
    expect(sentBody().profile_id).toBe("env-profile");
  });

  it("accepts only catalog keys, the two states, a short detail and at least one source", () => {
    const harness = createToolHarness();
    const schema = z.object(harness.getTool("tellagen_report_available_sources").config.inputSchema as z.ZodRawShape);
    const ok = (available_sources: unknown) => schema.safeParse({ available_sources }).success;
    expect(ok([{ key: "grafana", state: "found" }])).toBe(true);
    expect(ok([])).toBe(false);
    expect(ok([{ key: "jira", state: "found" }])).toBe(false);
    expect(ok([{ key: "local_host", state: "found" }])).toBe(false);
    expect(ok([{ key: "docs", state: "found", detail: "Confluence" }])).toBe(true);
    expect(ok([{ key: "grafana", state: "found", detail: "x".repeat(201) }])).toBe(false);
    expect(ok([{ key: "grafana", state: "found", token: "secret" }])).toBe(false);
    expect(schema.safeParse({ available_sources: [{ key: "grafana", state: "found" }], kubernetes_checks: [{ id: "k8s_made_up", status: "ok" }] }).success).toBe(false);
    expect(schema.safeParse({ available_sources: [{ key: "grafana", state: "found" }], kubernetes_checks: [{ id: "k8s_can_exec", status: "maybe" }] }).success).toBe(false);
  });

  it("sends the Kubernetes checks, and keeps the sources when an older Tellagen refuses the field", async () => {
    const harness = createToolHarness();
    const checks = KUBERNETES_SAFETY_CHECKS.map((check) => ({ id: check.id, status: "ok" }));
    fetchSpy.mockResolvedValueOnce(jsonResponse({ accepted_sources: [] }));
    await harness.callTool("tellagen_report_available_sources", { available_sources: [{ key: "kubernetes", state: "found" }], kubernetes_checks: checks });
    expect(sentBody().kubernetes_checks).toEqual(checks);

    fetchSpy.mockClear();
    fetchSpy
      .mockResolvedValueOnce(jsonResponse({ code: "unknown_field", message: "unknown field", fields: ["kubernetes_checks"] }, 400))
      .mockResolvedValueOnce(jsonResponse({ accepted_sources: [{ key: "kubernetes", state: "found" }] }));
    const result = await harness.callTool("tellagen_report_available_sources", { available_sources: [{ key: "kubernetes", state: "found" }], kubernetes_checks: checks });
    expect(result.isError).toBeUndefined();
    expect(sentBody(1)).not.toHaveProperty("kubernetes_checks");
    expect(harness.json(result).note).toContain("not the Kubernetes safety checks");
  });

  const kubernetesFound = [{ key: "kubernetes", state: "found" }];
  const claudeConfig = (args: string[]) =>
    JSON.stringify({ mcpServers: { kubernetes: { command: "npx", args: ["-y", "kubernetes-mcp-server@latest", ...args] } } });

  it("sends kubernetes_read_only_tools true when the server entry points at a config with read_only", async () => {
    files.set("/home/u/.claude.json", claudeConfig(["--config", "$HOME/.config/tellagen/kubernetes-mcp.toml"]));
    files.set("/home/u/.config/tellagen/kubernetes-mcp.toml", 'toolsets = ["core"]\nread_only = true\ndisable_destructive = true\n');
    const harness = createToolHarness();
    harness.client.session.identity = { name: "claude-code", label: "Claude Code", version: "" };
    fetchSpy.mockResolvedValueOnce(jsonResponse({ accepted_sources: [] }));
    await harness.callTool("tellagen_report_available_sources", { available_sources: kubernetesFound });
    expect(sentBody().kubernetes_read_only_tools).toBe(true);
    expect(JSON.stringify(sentBody())).not.toContain("/home/u");
  });

  it("sends true for a --read-only flag, false for a server with no guard, and nothing when it cannot know", async () => {
    const harness = createToolHarness();
    harness.client.session.identity = { name: "claude-code", label: "Claude Code", version: "" };
    fetchSpy.mockResolvedValue(jsonResponse({ accepted_sources: [] }));

    files.set("/home/u/.claude.json", claudeConfig(["--read-only"]));
    await harness.callTool("tellagen_report_available_sources", { available_sources: kubernetesFound });
    expect(sentBody(0).kubernetes_read_only_tools).toBe(true);

    files.set("/home/u/.claude.json", claudeConfig([]));
    await harness.callTool("tellagen_report_available_sources", { available_sources: kubernetesFound });
    expect(sentBody(1).kubernetes_read_only_tools).toBe(false);

    files.set("/home/u/.claude.json", claudeConfig(["--config", "/missing.toml"]));
    await harness.callTool("tellagen_report_available_sources", { available_sources: kubernetesFound });
    expect(sentBody(2)).not.toHaveProperty("kubernetes_read_only_tools");

    files.clear();
    await harness.callTool("tellagen_report_available_sources", { available_sources: kubernetesFound });
    expect(sentBody(3)).not.toHaveProperty("kubernetes_read_only_tools");

    files.set("/home/u/.claude.json", claudeConfig(["--read-only"]));
    await harness.callTool("tellagen_report_available_sources", { available_sources: [{ key: "kubernetes", state: "not_found" }] });
    expect(sentBody(4)).not.toHaveProperty("kubernetes_read_only_tools");
  });

  it("keeps the checks when an older Tellagen refuses only the read-only flag", async () => {
    files.set("/home/u/.claude.json", claudeConfig(["--read-only"]));
    const harness = createToolHarness();
    harness.client.session.identity = { name: "claude-code", label: "Claude Code", version: "" };
    const checks = KUBERNETES_SAFETY_CHECKS.map((check) => ({ id: check.id, status: "ok" }));
    fetchSpy
      .mockResolvedValueOnce(jsonResponse({ code: "unknown_field", message: "unknown field" }, 400))
      .mockResolvedValueOnce(jsonResponse({ accepted_sources: [] }));
    const result = await harness.callTool("tellagen_report_available_sources", { available_sources: kubernetesFound, kubernetes_checks: checks });
    expect(result.isError).toBeUndefined();
    expect(sentBody(1).kubernetes_checks).toEqual(checks);
    expect(sentBody(1)).not.toHaveProperty("kubernetes_read_only_tools");
    expect(harness.json(result).note).toContain("not whether the Kubernetes tools are read-only");
  });

  const kubernetesReport = (installed = true) => ({ tool_id: "kubernetes", installed, access_status: installed ? "ok" : "missing_tool" });
  const DIAG = "https://test.api.tellagen.com/api/v1/settings/agent/diagnostic-sessions/diag_1/reports";

  it("sends kubernetes_read_only_tools on the Recheck report of the kubernetes tool only", async () => {
    files.set("/home/u/.claude.json", claudeConfig(["--read-only"]));
    const harness = createToolHarness();
    harness.client.session.identity = { name: "claude-code", label: "Claude Code", version: "" };
    fetchSpy.mockResolvedValueOnce(jsonResponse({ ok: true }));
    await harness.callTool("tellagen_report_diagnostic_tools", {
      diagnostic_session_id: "diag_1",
      reports: [kubernetesReport(), { tool_id: "grafana", installed: true, access_status: "ok" }],
    });
    expect(fetchSpy.mock.calls[0]![0]).toBe(DIAG);
    const reports = sentBody().reports;
    expect(reports[0].kubernetes_read_only_tools).toBe(true);
    expect(reports[1]).not.toHaveProperty("kubernetes_read_only_tools");
  });

  it("leaves it out for a tool that was not found or an entry that cannot be read, and falls back for an older Tellagen", async () => {
    const harness = createToolHarness();
    harness.client.session.identity = { name: "claude-code", label: "Claude Code", version: "" };
    fetchSpy.mockImplementation(async () => jsonResponse({ ok: true }));
    files.set("/home/u/.claude.json", claudeConfig(["--read-only"]));
    await harness.callTool("tellagen_report_diagnostic_tools", { diagnostic_session_id: "diag_1", reports: [kubernetesReport(false)] });
    expect(sentBody(0).reports[0]).not.toHaveProperty("kubernetes_read_only_tools");
    files.clear();
    await harness.callTool("tellagen_report_diagnostic_tools", { diagnostic_session_id: "diag_1", reports: [kubernetesReport()] });
    expect(sentBody(1).reports[0]).not.toHaveProperty("kubernetes_read_only_tools");

    fetchSpy.mockReset();
    files.set("/home/u/.claude.json", claudeConfig(["--read-only"]));
    fetchSpy
      .mockResolvedValueOnce(jsonResponse({ code: "unknown_field", message: "unknown field" }, 400))
      .mockResolvedValueOnce(jsonResponse({ ok: true }));
    const result = await harness.callTool("tellagen_report_diagnostic_tools", { diagnostic_session_id: "diag_1", reports: [kubernetesReport()] });
    expect(result.isError).toBeUndefined();
    expect(sentBody(0).reports[0].kubernetes_read_only_tools).toBe(true);
    expect(sentBody(1).reports[0]).not.toHaveProperty("kubernetes_read_only_tools");
  });

  it("gives a clear message when Tellagen has no such route", async () => {
    const harness = createToolHarness();
    fetchSpy.mockResolvedValueOnce(jsonResponse({ error: "not found" }, 404));
    const result = await harness.callTool("tellagen_report_available_sources", { available_sources: [{ key: "grafana", state: "found" }] });
    expect(result.isError).toBe(true);
    const body = harness.json(result);
    expect(body.code).toBe("tool_report_not_supported");
    expect(body.message).toContain("does not take a tool report without a check yet");
  });

  it("passes other errors through", async () => {
    const harness = createToolHarness();
    fetchSpy.mockResolvedValueOnce(jsonResponse({ code: "forbidden", message: "A person must own this key." }, 403));
    const result = await harness.callTool("tellagen_report_available_sources", { available_sources: [{ key: "grafana", state: "found" }] });
    expect(result.isError).toBe(true);
    expect(harness.json(result).status).toBe(403);
  });

  it("teaches the safety check and never promises a read-only run it cannot guard", () => {
    const harness = createToolHarness();
    const description = (harness.getTool("tellagen_report_available_sources").config as { description?: string }).description!;
    expect(description).toContain("k8s_can_create_pods");
    expect(description).toContain("never call it read-only");
    expect(description).not.toMatch(/guaranteed read-only/i);
    for (const check of KUBERNETES_SAFETY_CHECKS) expect(KUBERNETES_SAFETY_PROTOCOL).toContain(check.id);
    const diag = (harness.getTool("tellagen_report_diagnostic_tools").config as { description?: string }).description!;
    expect(diag).toContain("k8s_can_exec");
  });
});

describe("the Kubernetes safety verdict", () => {
  const all = (status: KubernetesSafetyCheck["status"]): KubernetesSafetyCheck[] => KUBERNETES_SAFETY_CHECKS.map((c) => ({ id: c.id, status }));
  it("is read_only only when all four answers are no", () => {
    expect(kubernetesSafetyVerdict(all("ok"))).toBe("read_only");
  });
  it("is can_change when any answer is yes", () => {
    expect(kubernetesSafetyVerdict([...all("ok").slice(0, 3), { id: "k8s_can_read_secrets", status: "failed" }])).toBe("can_change");
  });
  it("is not_checked when a check is missing or could not run", () => {
    expect(kubernetesSafetyVerdict([])).toBe("not_checked");
    expect(kubernetesSafetyVerdict(all("ok").slice(0, 3))).toBe("not_checked");
    expect(kubernetesSafetyVerdict([...all("ok").slice(0, 3), { id: "k8s_can_read_secrets", status: "warning" }])).toBe("not_checked");
  });
});
