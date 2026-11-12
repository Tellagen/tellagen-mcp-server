import { createHash } from "node:crypto";
import { redactSecrets, redactValue } from "./redact.js";

/**
 * Turns the event of a client hook (a tool call that just ran) into one
 * recorded trace step. Nothing here talks to Tellagen or the disk.
 *
 * What a step holds: the tool, the query or command with secrets masked, the
 * time range when the tool had one, how long the call took, how big the
 * result was, and at most 300 characters of its start. It never holds the
 * result itself.
 */

export const RECORDED_STEPS_CAPABILITY = "recorded_steps_v1";
export const MAX_SUMMARY_CHARS = 300;
const MAX_TITLE_CHARS = 160;
const MAX_QUERY_CHARS = 1000;
const MAX_FIELD_CHARS = 200;
const MAX_STEP_ID_CHARS = 200;
export const MAX_HOOK_EVENT_BYTES = 4 * 1024 * 1024;

export type StepSource = "grafana" | "github" | "kubernetes" | "github-cli";

export interface HookEvent {
  hook_event_name?: string;
  tool_name: string;
  tool_input: Record<string, unknown>;
  tool_response?: unknown;
  tool_use_id?: string;
  duration_ms?: number;
  error?: string;
  session_id?: string;
}

export interface RecordedStep {
  source: StepSource;
  body: Record<string, unknown>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Reads the JSON of a hook event. Anything that is not a tool event gives nothing. */
export function parseHookEvent(raw: string): HookEvent | undefined {
  if (!raw || raw.length > MAX_HOOK_EVENT_BYTES) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (!isRecord(parsed) || typeof parsed.tool_name !== "string" || !parsed.tool_name) return undefined;
  const input = isRecord(parsed.tool_input) ? parsed.tool_input : {};
  const duration = Number(parsed.duration_ms);
  return {
    hook_event_name: typeof parsed.hook_event_name === "string" ? parsed.hook_event_name : undefined,
    tool_name: parsed.tool_name.slice(0, 300),
    tool_input: input,
    tool_response: parsed.tool_response ?? parsed.tool_result,
    tool_use_id: typeof parsed.tool_use_id === "string" ? parsed.tool_use_id : undefined,
    duration_ms: Number.isFinite(duration) && duration >= 0 ? Math.round(duration) : undefined,
    error: typeof parsed.error === "string" ? parsed.error : undefined,
    session_id: typeof parsed.session_id === "string" ? parsed.session_id : undefined,
  };
}

function clean(value: string, max: number): string {
  return value.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, max).trim();
}

function text(value: unknown, max = MAX_FIELD_CHARS): string | undefined {
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (typeof value !== "string" || !value.trim()) return undefined;
  return clean(redactSecrets(value), max);
}

function firstText(input: Record<string, unknown>, keys: readonly string[], max = MAX_QUERY_CHARS): string | undefined {
  for (const key of keys) {
    const value = text(input[key], max);
    if (value) return value;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Which tool is it

interface McpName {
  server: string;
  tool: string;
}

function mcpName(toolName: string): McpName | undefined {
  const match = /^mcp__(.+?)__(.+)$/.exec(toolName);
  return match ? { server: match[1]!, tool: match[2]! } : undefined;
}

const GRAFANA_TITLES: Record<string, string> = {
  query_prometheus: "Prometheus query",
  query_prometheus_histogram: "Prometheus histogram query",
  list_prometheus_metric_names: "Prometheus metric names",
  list_prometheus_label_values: "Prometheus label values",
  query_loki_logs: "Loki log query",
  query_loki_stats: "Loki stats query",
  query_loki_patterns: "Loki log patterns",
  find_error_pattern_logs: "Error patterns in logs",
  find_slow_requests: "Slow requests",
  search_tempo_traces: "Tempo trace search",
  get_tempo_trace: "Tempo trace",
  query_tempo_metrics: "Tempo metrics query",
  query_pyroscope: "Profile query",
  search_dashboards: "Dashboard search",
  get_dashboard_by_uid: "Dashboard",
  get_dashboard_summary: "Dashboard summary",
  get_dashboard_panel_queries: "Dashboard panel queries",
  list_datasources: "Grafana data sources",
  get_datasource: "Grafana data source",
  list_alert_groups: "Alert groups",
  alerting_rules_read: "Alert rules",
  get_annotations: "Annotations",
  get_panel_image: "Panel image",
  generate_deeplink: "Grafana link",
};

const READ_VERB = /^(get|list|query|search|find|analyze|check|diff|generate|alerting_rules_read|alerting_silences_read)/;

const QUERY_KEYS = ["expr", "expression", "logql", "traceql", "query", "queryExpr", "q", "search", "pattern"] as const;
const DATASOURCE_KEYS = ["datasourceUid", "datasource_uid", "datasourceUID", "datasource", "dataSourceUid", "uid"] as const;
const START_KEYS = ["startTime", "start", "startRfc3339", "start_time", "from", "since"] as const;
const END_KEYS = ["endTime", "end", "endRfc3339", "end_time", "to", "until"] as const;

function grafanaStep(name: McpName, input: Record<string, unknown>): { title: string; tool: string; recorded: Record<string, unknown> } | undefined {
  // The server may hold write tools too. A call that is not a read is not a diagnosis step.
  if (!READ_VERB.test(name.tool)) return undefined;
  const query = firstText(input, QUERY_KEYS);
  const label = GRAFANA_TITLES[name.tool] ?? `Grafana ${name.tool.replace(/_/g, " ")}`;
  const recorded: Record<string, unknown> = { tool: name.tool };
  if (query) recorded.query = query;
  const datasource = firstText(input, DATASOURCE_KEYS, MAX_FIELD_CHARS);
  if (datasource) recorded.datasource = datasource;
  const start = firstText(input, START_KEYS, 64);
  const end = firstText(input, END_KEYS, 64);
  if (start || end) recorded.time_range = { ...(start ? { start } : {}), ...(end ? { end } : {}) };
  const limit = text(input.limit, 20);
  if (limit) recorded.limit = limit;
  const title = query ? `${label}: ${query}` : datasource ? `${label}: ${datasource}` : label;
  return { title, tool: `grafana.${name.tool}`, recorded };
}

const GITHUB_KEYS = ["owner", "repo", "path", "ref", "sha", "branch", "pull_number", "pullNumber", "issue_number", "issueNumber", "state", "workflow_id", "run_id", "method"] as const;

function githubStep(name: McpName, input: Record<string, unknown>): { title: string; tool: string; recorded: Record<string, unknown> } | undefined {
  if (!READ_VERB.test(name.tool) && !/(_read|^actions_)/.test(name.tool)) return undefined;
  const recorded: Record<string, unknown> = { tool: name.tool };
  for (const key of GITHUB_KEYS) {
    const value = text(input[key], 120);
    if (value) recorded[key] = value;
  }
  const query = firstText(input, ["query", "q"], 300);
  if (query) recorded.query = query;
  const repo = recorded.owner && recorded.repo ? `${recorded.owner}/${recorded.repo}` : (recorded.repo as string | undefined);
  const what = `GitHub ${name.tool.replace(/_/g, " ")}`;
  const detail = [repo, recorded.path as string | undefined, query].filter(Boolean).join(" ");
  return { title: detail ? `${what}: ${detail}` : what, tool: `github.${name.tool}`, recorded };
}

/** The shell segments that start with kubectl or gh. */
function shellSegments(command: string): Array<{ program: string; text: string }> {
  const out: Array<{ program: string; text: string }> = [];
  for (const part of command.split(/&&|\|\||;|\||\r?\n/)) {
    const tokens = part.trim().split(/\s+/);
    let i = 0;
    // VAR=value prefixes and a few wrappers do not change what runs.
    while (i < tokens.length && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[i]!) || ["sudo", "time", "env", "command"].includes(tokens[i]!))) i++;
    const program = (tokens[i] ?? "").replace(/^.*\//, "");
    if (program === "kubectl" || program === "gh") out.push({ program, text: tokens.slice(i).join(" ") });
  }
  return out;
}

/** A command whose result is a secret, so no part of it is kept. */
export function resultIsSecret(command: string): boolean {
  return /\b(secrets?|serviceaccounts?\/token|--raw)\b/i.test(command) || /\bconfig\s+view\b/.test(command);
}

function shellStep(input: Record<string, unknown>): { source: StepSource; title: string; tool: string; recorded: Record<string, unknown>; secret: boolean; single: boolean } | undefined {
  const raw = typeof input.command === "string" ? input.command : "";
  if (!raw || raw.length > 20_000) return undefined;
  const segments = shellSegments(raw);
  if (segments.length === 0) return undefined;
  const command = clean(redactSecrets(raw), MAX_QUERY_CHARS);
  const first = segments[0]!;
  const source: StepSource = first.program === "kubectl" ? "kubernetes" : "github-cli";
  const recorded: Record<string, unknown> = { command };
  // The working folder often holds the user name, so it is not sent.
  // A command with more than one part has a result that belongs to all parts
  // (`cat .env && gh pr list`), so no part of the result is kept.
  const parts = raw.split(/&&|\|\||;|\||\r?\n/).filter((part) => part.trim().length > 0);
  const single = parts.length === 1 && segments.length === 1;
  return { source, title: clean(redactSecrets(first.text), MAX_TITLE_CHARS), tool: first.program, recorded, secret: resultIsSecret(raw), single };
}

// ---------------------------------------------------------------------------
// The result

function resultText(response: unknown): string {
  if (typeof response === "string") return response;
  if (!isRecord(response)) return response === undefined ? "" : JSON.stringify(response) ?? "";
  if (Array.isArray(response.content)) {
    return response.content
      .map((item) => (isRecord(item) && typeof item.text === "string" ? item.text : ""))
      .filter(Boolean)
      .join("\n");
  }
  const parts = [response.stdout, response.output, response.result, response.text].filter((v): v is string => typeof v === "string");
  if (parts.length > 0) return parts.join("\n");
  return JSON.stringify(response) ?? "";
}

function resultBytes(response: unknown): number | undefined {
  if (response === undefined) return undefined;
  try {
    return Buffer.byteLength(typeof response === "string" ? response : JSON.stringify(response) ?? "", "utf8");
  } catch {
    return undefined;
  }
}

function failed(event: HookEvent): string | undefined {
  if (event.hook_event_name === "PostToolUseFailure" || event.error) {
    return clean(redactSecrets(event.error ?? "The tool call failed."), MAX_SUMMARY_CHARS);
  }
  const response = event.tool_response;
  if (isRecord(response) && (response.isError === true || response.is_error === true)) {
    return clean(redactSecrets(resultText(response) || "The tool call failed."), MAX_SUMMARY_CHARS);
  }
  if (isRecord(response) && typeof response.exitCode === "number" && response.exitCode !== 0) {
    return clean(redactSecrets(resultText(response) || `The command exited with ${response.exitCode}.`), MAX_SUMMARY_CHARS);
  }
  return undefined;
}

// ---------------------------------------------------------------------------

/**
 * The step for a hook event, or nothing when the tool is not one that a
 * diagnosis records (Grafana and GitHub reads, kubectl and gh commands).
 */
export function mapToolCall(event: HookEvent, now: Date = new Date()): RecordedStep | undefined {
  let mapped: { source: StepSource; title: string; tool: string; recorded: Record<string, unknown>; secret?: boolean; single?: boolean } | undefined;
  const mcp = mcpName(event.tool_name);
  if (mcp) {
    const server = mcp.server.toLowerCase();
    if (server.includes("grafana")) {
      const step = grafanaStep(mcp, event.tool_input);
      if (step) mapped = { source: "grafana", ...step };
    } else if (server.includes("github")) {
      const step = githubStep(mcp, event.tool_input);
      if (step) mapped = { source: "github", ...step };
    }
  } else if (event.tool_name === "Bash" || event.tool_name === "shell" || event.tool_name === "local_shell") {
    mapped = shellStep(event.tool_input);
  }
  if (!mapped) return undefined;

  const error = failed(event);
  const completedAt = now;
  const startedAt = event.duration_ms !== undefined ? new Date(now.getTime() - event.duration_ms) : now;
  const stepId = (event.tool_use_id && clean(event.tool_use_id, MAX_STEP_ID_CHARS)) ||
    `hook-${createHash("sha256").update(`${event.session_id ?? ""}|${event.tool_name}|${JSON.stringify(mapped.recorded)}|${now.getTime()}`).digest("hex").slice(0, 32)}`;

  const body: Record<string, unknown> = {
    recorded_by: "client",
    step_id: stepId,
    status: error ? "error" : "done",
    title: clean(mapped.title, MAX_TITLE_CHARS) || mapped.tool,
    tool_name: mapped.tool,
    input_json: redactValue(mapped.recorded),
    started_at: startedAt.toISOString(),
    completed_at: completedAt.toISOString(),
  };
  if (event.tool_use_id) body.tool_use_id = clean(event.tool_use_id, MAX_STEP_ID_CHARS);
  if (event.duration_ms !== undefined) body.duration_ms = event.duration_ms;
  const bytes = resultBytes(event.tool_response);
  if (bytes !== undefined) body.result_bytes = bytes;
  if (error) {
    body.error = error;
  } else if (mapped.secret) {
    body.result_summary = "The result is not recorded: the command can show secrets.";
  } else if (mapped.single === false) {
    body.result_summary = "The result is not recorded: the command has more than one part.";
  } else {
    const summary = clean(redactSecrets(resultText(event.tool_response)), MAX_SUMMARY_CHARS);
    if (summary) body.result_summary = summary;
  }
  return { source: mapped.source, body };
}
