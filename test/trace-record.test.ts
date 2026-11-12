import { describe, expect, it } from "vitest";

import { redactSecrets, redactValue } from "../src/redact.js";
import { mapToolCall, MAX_SUMMARY_CHARS, parseHookEvent, type HookEvent } from "../src/trace-record.js";

const NOW = new Date("2026-11-12T10:00:00.000Z");

function event(tool_name: string, tool_input: Record<string, unknown>, extra: Partial<HookEvent> = {}): HookEvent {
  return { tool_name, tool_input, tool_use_id: "toolu_01AbC", duration_ms: 1500, tool_response: { content: [{ type: "text", text: "ok" }] }, ...extra };
}

describe("parseHookEvent", () => {
  it("reads a hook event and drops anything else", () => {
    const parsed = parseHookEvent(JSON.stringify({ tool_name: "Bash", tool_input: { command: "kubectl get pods" }, tool_use_id: "t1", duration_ms: 12.4 }));
    expect(parsed).toMatchObject({ tool_name: "Bash", tool_use_id: "t1", duration_ms: 12 });
    expect(parseHookEvent("not json")).toBeUndefined();
    expect(parseHookEvent("{}")).toBeUndefined();
    expect(parseHookEvent("")).toBeUndefined();
    expect(parseHookEvent(JSON.stringify([1, 2]))).toBeUndefined();
  });
});

describe("Grafana", () => {
  it("records a Prometheus query with its expression, data source and range", () => {
    const step = mapToolCall(
      event("mcp__grafana__query_prometheus", {
        expr: 'sum(rate(http_requests_total{service="checkout",code=~"5.."}[5m]))',
        datasourceUid: "prom-1",
        startTime: "2026-11-11T13:30:00Z",
        endTime: "2026-11-11T14:30:00Z",
      }),
      NOW,
    )!;
    expect(step.source).toBe("grafana");
    expect(step.body).toMatchObject({
      recorded_by: "client",
      step_id: "toolu_01AbC",
      tool_use_id: "toolu_01AbC",
      status: "done",
      tool_name: "grafana.query_prometheus",
      duration_ms: 1500,
      started_at: "2026-11-12T09:59:58.500Z",
      completed_at: "2026-11-12T10:00:00.000Z",
    });
    expect(step.body.title).toContain("Prometheus query: sum(rate(http_requests_total");
    expect(step.body.input_json).toEqual({
      tool: "query_prometheus",
      query: 'sum(rate(http_requests_total{service="checkout",code=~"5.."}[5m]))',
      datasource: "prom-1",
      time_range: { start: "2026-11-11T13:30:00Z", end: "2026-11-11T14:30:00Z" },
    });
    // A recorded step carries none of the fields that the model adds.
    for (const forbidden of ["guidance", "outcome", "cause_key", "reuse_hint"]) expect(step.body).not.toHaveProperty(forbidden);
  });

  it.each([
    ["query_loki_logs", { logql: '{app="api"} |= "error"', datasourceUid: "loki-1", startRfc3339: "2026-11-11T13:30:00Z", endRfc3339: "2026-11-11T14:00:00Z" }, "Loki log query", "loki-1"],
    ["search_tempo_traces", { query: '{ status = error }' }, "Tempo trace search", undefined],
    ["search_dashboards", { query: "checkout" }, "Dashboard search", undefined],
    ["list_datasources", {}, "Grafana data sources", undefined],
    ["get_dashboard_by_uid", { uid: "abc123" }, "Dashboard", "abc123"],
  ])("maps %s", (tool, input, title, datasource) => {
    const step = mapToolCall(event(`mcp__mcp-grafana__${tool}`, input), NOW)!;
    expect(step.source).toBe("grafana");
    expect(step.body.title).toContain(title);
    expect(step.body.tool_name).toBe(`grafana.${tool}`);
    if (datasource) expect((step.body.input_json as any).datasource).toBe(datasource);
  });

  it("works with the name of the Grafana server inside the plugin", () => {
    expect(mapToolCall(event("mcp__plugin_acme_grafana__query_loki_logs", { logql: "{a=\"b\"}" }), NOW)?.source).toBe("grafana");
  });

  it("does not record a call that changes Grafana", () => {
    for (const tool of ["update_dashboard", "create_incident", "delete_annotation", "alerting_manage_rules", "create_folder"]) {
      expect(mapToolCall(event(`mcp__grafana__${tool}`, { uid: "x" }), NOW), tool).toBeUndefined();
    }
  });
});

describe("GitHub", () => {
  it("records a read of the GitHub MCP server", () => {
    const step = mapToolCall(event("mcp__github__get_file_contents", { owner: "acme", repo: "api", path: "src/pool.go", ref: "abc1234" }), NOW)!;
    expect(step.source).toBe("github");
    expect(step.body.tool_name).toBe("github.get_file_contents");
    expect(step.body.title).toContain("acme/api");
    expect(step.body.title).toContain("src/pool.go");
    expect(step.body.input_json).toMatchObject({ owner: "acme", repo: "api", path: "src/pool.go", ref: "abc1234" });
  });

  it("does not record a write", () => {
    for (const tool of ["create_pull_request", "merge_pull_request", "push_files", "create_issue", "add_issue_comment"]) {
      expect(mapToolCall(event(`mcp__github__${tool}`, { owner: "a", repo: "b" }), NOW), tool).toBeUndefined();
    }
  });
});

describe("shell commands", () => {
  it("records kubectl and gh", () => {
    const kube = mapToolCall(event("Bash", { command: "kubectl -n prod get pods -l app=checkout" }), NOW)!;
    expect(kube.source).toBe("kubernetes");
    expect(kube.body.tool_name).toBe("kubectl");
    expect(kube.body.title).toBe("kubectl -n prod get pods -l app=checkout");
    expect(kube.body.input_json).toEqual({ command: "kubectl -n prod get pods -l app=checkout" });
    const gh = mapToolCall(event("Bash", { command: "gh pr list --repo acme/api --state merged" }), NOW)!;
    expect(gh.source).toBe("github-cli");
    expect(gh.body.tool_name).toBe("gh");
  });

  it("sees a command inside a chain, and after variables or sudo", () => {
    expect(mapToolCall(event("Bash", { command: "cd /tmp && KUBECONFIG=/x kubectl get nodes" }), NOW)?.source).toBe("kubernetes");
    expect(mapToolCall(event("Bash", { command: "sudo kubectl get nodes | grep Ready" }), NOW)?.source).toBe("kubernetes");
  });

  it("ignores every other command and every other tool", () => {
    for (const command of ["ls -la", "git status", "npm test", "echo kubectl", "curl https://example.com"]) {
      expect(mapToolCall(event("Bash", { command }), NOW), command).toBeUndefined();
    }
    expect(mapToolCall(event("Read", { file_path: "/x" }), NOW)).toBeUndefined();
    expect(mapToolCall(event("mcp__slack__post_message", { text: "hi" }), NOW)).toBeUndefined();
  });

  it("masks a secret in a command", () => {
    const step = mapToolCall(
      event("Bash", {
        command:
          "kubectl --token=abcdef0123456789abcdef get pods && gh api -H 'Authorization: Bearer ghp_abcdefghijklmnopqrstuvwxyz0123456789' /user && kubectl get cm --password hunter2secret",
      }),
      NOW,
    )!;
    const serialized = JSON.stringify(step.body);
    expect(serialized).not.toContain("abcdef0123456789abcdef");
    expect(serialized).not.toContain("ghp_abcdefghijklmnopqrstuvwxyz0123456789");
    expect(serialized).not.toContain("hunter2secret");
    expect(serialized).toContain("[redacted]");
  });

  it("does not keep the result of a command that shows secrets", () => {
    const step = mapToolCall(event("Bash", { command: "kubectl get secret db -o yaml" }, { tool_response: { stdout: "data:\n  password: c3VwZXJzZWNyZXQ=" } }), NOW)!;
    expect(step.body.result_summary).toContain("not recorded");
    expect(JSON.stringify(step.body)).not.toContain("c3VwZXJzZWNyZXQ");
  });
});

describe("the result", () => {
  it("sends the size and at most 300 characters, never the whole result", () => {
    const big = "line of a log ".repeat(5000);
    const step = mapToolCall(event("mcp__grafana__query_loki_logs", { logql: "{a=\"b\"}" }, { tool_response: { content: [{ type: "text", text: big }] } }), NOW)!;
    expect((step.body.result_summary as string).length).toBeLessThanOrEqual(MAX_SUMMARY_CHARS);
    expect(step.body.result_bytes).toBeGreaterThan(70_000);
    expect(JSON.stringify(step.body).length).toBeLessThan(3_000);
    expect(step.body).not.toHaveProperty("result_json");
  });

  it("masks a secret that the result starts with", () => {
    const step = mapToolCall(event("Bash", { command: "kubectl logs api-1" }, { tool_response: { stdout: "token=abcdefghij0123456789 started" } }), NOW)!;
    expect(step.body.result_summary).not.toContain("abcdefghij0123456789");
  });

  it("marks a failed call as an error with a short message", () => {
    const failed = mapToolCall(event("mcp__grafana__query_prometheus", { expr: "up" }, { tool_response: { isError: true, content: [{ type: "text", text: "datasource not found" }] } }), NOW)!;
    expect(failed.body.status).toBe("error");
    expect(failed.body.error).toBe("datasource not found");
    const hookFailure = mapToolCall(event("Bash", { command: "kubectl get pods" }, { hook_event_name: "PostToolUseFailure", error: "Command exited with code 1", tool_response: undefined }), NOW)!;
    expect(hookFailure.body.status).toBe("error");
  });

  it("uses the tool use id as the step id, and makes a stable one when a client sends none", () => {
    const withId = mapToolCall(event("Bash", { command: "kubectl get pods" }), NOW)!;
    expect(withId.body.step_id).toBe("toolu_01AbC");
    const none = mapToolCall(event("Bash", { command: "kubectl get pods" }, { tool_use_id: undefined }), NOW)!;
    expect(String(none.body.step_id)).toMatch(/^hook-[0-9a-f]{32}$/);
    expect(none.body).not.toHaveProperty("tool_use_id");
  });
});

describe("secrets that a command or a header can hold", () => {
  const masked = (text: string) => redactSecrets(text);
  it("masks a literal of kubectl create secret, a curl user and a bare key in an address", () => {
    expect(masked("kubectl create secret generic db --from-literal=db=hunter2")).not.toContain("hunter2");
    expect(masked("curl -u admin:hunter2 https://x.example")).not.toContain("hunter2");
    expect(masked("curl --user admin:hunter2 https://x.example")).not.toContain("hunter2");
    expect(masked("https://abcdef0123456789abcdef@sentry.example/1")).not.toContain("abcdef0123456789abcdef");
    expect(masked("X-Grafana-Key: eyJrIjoiQWJDZGVmR2hpSmtsTW5PcFFyU3RVdld4WXo")).not.toContain("QWJDZGVm".toLowerCase());
    expect(masked("X-Grafana-Key: eyJrIjoiQWJDZGVmR2hpSmtsTW5PcFFyU3RVdld4WXo")).not.toContain("eyJrIjoi");
  });

  it("does not print a double bracket after a masked value", () => {
    const out = masked("password=hunter2 and token=abcdef0123456789abcdef");
    expect(out).not.toContain("]]");
    expect(masked("Authorization: Bearer abcdefghijklmnop")).not.toContain("]]");
  });

  it("keeps no part of the result of a chained command, and does not send the working folder", () => {
    const chained = mapToolCall(event("Bash", { command: "cat .env && gh pr list", cwd: "/home/someone/project" }, { tool_response: { stdout: "DB_PASSWORD=hunter2\nsecret stuff" } }), NOW)!;
    expect(chained.body.result_summary).toContain("more than one part");
    expect(JSON.stringify(chained.body)).not.toContain("hunter2");
    expect(JSON.stringify(chained.body)).not.toContain("someone");
    const single = mapToolCall(event("Bash", { command: "kubectl get pods", cwd: "/home/someone/project" }, { tool_response: { stdout: "NAME READY" } }), NOW)!;
    expect(single.body.result_summary).toBe("NAME READY");
    expect(JSON.stringify(single.body)).not.toContain("someone");
  });
});

describe("redaction", () => {
  it("masks tokens, passwords and key names, and keeps ordinary text", () => {
    const text = 'password: p4ss word here\n{"api_key":"abc123def456ghi789","host":"db.example"} Authorization: Bearer abcdefghijklmnop AKIAABCDEFGHIJKLMNOP see https://u:pw@example.com/x';
    const out = redactSecrets(text);
    for (const secret of ["p4ss word here", "abc123def456ghi789", "abcdefghijklmnop", "AKIAABCDEFGHIJKLMNOP", "u:pw@"]) expect(out).not.toContain(secret);
    expect(out).toContain("db.example");
    expect(redactSecrets("rate(http_requests_total[5m]) by (service)")).toBe("rate(http_requests_total[5m]) by (service)");
  });

  it("masks the value of a secret key in JSON", () => {
    expect(redactValue({ token: "abc", nested: { password: "x", ok: "fine" }, list: ["Bearer abcdefghijklmnop"] })).toEqual({
      token: "[redacted]",
      nested: { password: "[redacted]", ok: "fine" },
      list: ["[redacted]"],
    });
  });
});
