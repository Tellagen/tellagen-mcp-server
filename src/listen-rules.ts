import { TOOL_CATALOG } from "./tools/catalog.js";

/**
 * What a run that nobody watches may do.
 *
 * A listened run reads. It may use the Tellagen tools of a diagnosis, the read
 * tools of Grafana and GitHub, and read-only `kubectl` and `gh` commands. It
 * may not change a cluster, a repository, a dashboard or an incident.
 *
 * Everything not on the list is refused, and the client runs in a mode that
 * answers a refusal itself instead of asking a person. This file is the one
 * place the list lives; the command line of the client and the tests both
 * read it.
 */

// ---------------------------------------------------------------------------
// Tellagen

/** The Tellagen tools a listened run may call: the diagnosis set, and the reads of the incidents set. */
export function tellagenToolNames(): string[] {
  return TOOL_CATALOG.filter(
    (entry) => entry.toolset === "diagnosis" || (entry.toolset === "incidents" && entry.effect === "read"),
  ).map((entry) => entry.name);
}

// ---------------------------------------------------------------------------
// Grafana and GitHub: read tools by name

/** The read tools of the Grafana MCP server. Its update, create and delete tools are not here. */
export const GRAFANA_READ_TOOLS: readonly string[] = [
  "analyze_loki_labels",
  "check_datasources_health",
  "diff_tempo_traces",
  "find_error_pattern_logs",
  "find_slow_requests",
  "generate_deeplink",
  "get_alert_group",
  "get_annotation_tags",
  "get_annotations",
  "get_assertions",
  "get_current_oncall_users",
  "get_dashboard_by_uid",
  "get_dashboard_panel_queries",
  "get_dashboard_property",
  "get_dashboard_summary",
  "get_datasource",
  "get_incident",
  "get_oncall_shift",
  "get_panel_image",
  "get_tempo_trace",
  "list_alert_groups",
  "list_dashboard_versions",
  "list_datasources",
  "list_incidents",
  "list_loki_label_names",
  "list_loki_label_values",
  "list_oncall_schedules",
  "list_oncall_teams",
  "list_oncall_users",
  "list_prometheus_label_names",
  "list_prometheus_label_values",
  "list_prometheus_metric_metadata",
  "list_prometheus_metric_names",
  "list_pyroscope_label_names",
  "list_pyroscope_label_values",
  "list_pyroscope_profile_types",
  "list_tempo_attribute_names",
  "list_tempo_attribute_values",
  "query_loki_logs",
  "query_loki_patterns",
  "query_loki_stats",
  "query_prometheus",
  "query_prometheus_histogram",
  "query_pyroscope",
  "query_tempo_metrics",
  "search_dashboards",
  "search_folders",
  "search_tempo_traces",
  "alerting_rules_read",
  "alerting_silences_read",
];

/** The read tools of the GitHub MCP server, by the names its versions use. */
export const GITHUB_READ_TOOLS: readonly string[] = [
  "get_file_contents",
  "get_commit",
  "list_commits",
  "list_branches",
  "list_tags",
  "get_tag",
  "list_releases",
  "get_latest_release",
  "get_release_by_tag",
  "list_pull_requests",
  "pull_request_read",
  "get_pull_request",
  "get_pull_request_files",
  "get_pull_request_diff",
  "get_pull_request_status",
  "get_pull_request_comments",
  "get_pull_request_reviews",
  "list_issues",
  "issue_read",
  "get_issue",
  "get_issue_comments",
  "search_code",
  "search_issues",
  "search_pull_requests",
  "search_repositories",
  "actions_get",
  "actions_list",
  "list_workflows",
  "list_workflow_runs",
  "get_workflow_run",
  "list_workflow_jobs",
  "get_job_logs",
  "get_workflow_run_logs",
];

/** The default names of the MCP servers of Grafana and GitHub. A person lists their own in the settings. */
export const DEFAULT_MCP_SERVER_NAMES = {
  grafana: ["grafana", "mcp-grafana"],
  github: ["github"],
} as const;

/** The name the client gives an MCP tool: `mcp__<server>__<tool>`. */
export function mcpToolName(server: string, tool: string): string {
  return `mcp__${server}__${tool}`;
}

/** A tool name that a person may add to the list: one named tool of one server, no wildcard. */
const EXTRA_TOOL = /^mcp__[A-Za-z0-9_-]+__([A-Za-z0-9_-]+)$/;
const WRITE_VERB = /^(create|update|delete|remove|write|post|put|patch|send|add|set|run|exec|execute|apply|merge|close|reopen|restart|scale|cancel|rerun|trigger|install|upload|push|commit|edit|assign|archive|resolve|acknowledge|silence|mute|enable|disable|import|rollback)(_|$)/;

/** Whether a tool name of the person's own list is acceptable. It returns a reason when it is not. */
export function checkExtraTool(name: string): string | undefined {
  const match = EXTRA_TOOL.exec(name);
  if (!match) return `"${name.slice(0, 80)}" must be one tool, written mcp__<server>__<tool>, with no wildcard.`;
  if (WRITE_VERB.test(match[1]!.toLowerCase())) {
    return `"${name.slice(0, 80)}" looks like a tool that changes something. A listened run reads only.`;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Shell commands: one parser decides (src/shell-rules.ts)

export { evaluateCommand, guardDecision, GH_READ_COMMANDS, GH_BARE_COMMANDS, KUBECTL_KINDS, KUBECTL_VERBS } from "./shell-rules.js";
export type { CommandVerdict } from "./shell-rules.js";

/** Whether the run may call an MCP tool. */
export function evaluateTool(
  name: string,
  options: { grafana?: readonly string[]; github?: readonly string[]; extra?: readonly string[] } = {},
): { allowed: boolean; reason: string } {
  return buildAllowedTools(options).includes(name)
    ? { allowed: true, reason: "" }
    : { allowed: false, reason: `${name.slice(0, 100)} is not on the read-only list.` };
}

// ---------------------------------------------------------------------------
// What the client is given

export interface ToolOptions {
  /** Names of the person's Grafana MCP servers. */
  grafana?: readonly string[];
  /** Names of the person's GitHub MCP servers. */
  github?: readonly string[];
  /** Extra read tools of the person, each `mcp__<server>__<tool>`. */
  extra?: readonly string[];
}

/**
 * The tools the client may call without asking. These are MCP tools by exact
 * name. There is NO Bash rule here, on purpose: a pattern cannot say "only
 * these flags", and a wide rule would let every shell call through when the
 * hook is missing or broken. A shell call runs only on an explicit pass of
 * the hook (`buildClientSettings`), so with no hook the client refuses it.
 */
export function buildAllowedTools(options: ToolOptions = {}): string[] {
  const rules: string[] = [];
  // The Tellagen MCP server runs under its own name or under the plugin's.
  for (const server of ["tellagen", "plugin_tellagen_tellagen"]) {
    for (const tool of tellagenToolNames()) rules.push(mcpToolName(server, tool));
  }
  for (const server of options.grafana ?? DEFAULT_MCP_SERVER_NAMES.grafana) {
    for (const tool of GRAFANA_READ_TOOLS) rules.push(mcpToolName(server, tool));
  }
  for (const server of options.github ?? DEFAULT_MCP_SERVER_NAMES.github) {
    for (const tool of GITHUB_READ_TOOLS) rules.push(mcpToolName(server, tool));
  }
  for (const name of options.extra ?? []) {
    if (checkExtraTool(name) === undefined) rules.push(name);
  }
  return [...new Set(rules)];
}

/**
 * A coarse outer layer that refuses, whatever the hook says: a refusal wins
 * over an allowance. It is shorter than the parser on purpose; the parser is
 * the rule, and a test checks that this list never refuses a command the
 * parser allows.
 */
export function buildDeniedTools(): string[] {
  return [
    "Bash(*;*)",
    "Bash(*&*)",
    "Bash(*|*)",
    "Bash(*`*)",
    "Bash(*$*)",
    "Bash(*>*)",
    "Bash(*<*)",
    "Bash(*\n*)",
    "Bash(*\r*)",
    "Bash(kubectl * --server*)",
    "Bash(kubectl * -s *)",
    "Bash(kubectl * --kubeconfig*)",
    "Bash(kubectl * --token*)",
    "Bash(kubectl * --as*)",
    "Bash(kubectl * --insecure-skip-tls-verify*)",
    "Bash(gh api *)",
    "Bash(gh auth token*)",
    "Write",
    "Edit",
    "NotebookEdit",
    "WebFetch",
    "WebSearch",
  ];
}

/** Single-quotes a word for a shell command line. */
function shellQuote(word: string): string {
  return `'${word.replace(/'/g, `'\\''`)}'`;
}

/** The command line the client runs for its hook: our own server, by absolute path. */
export function guardCommandLine(nodePath: string, scriptPath: string): string {
  return `${shellQuote(nodePath)} ${shellQuote(scriptPath)} listen-guard`;
}

export const GUARD_TIMEOUT_SECONDS = 20;

/**
 * The settings the client gets with `--settings`. The only hook is the
 * guard, on the shell tool. The guard prints an explicit pass or a refusal;
 * a crash, a timeout or a missing script is no pass, and the client refuses
 * a shell call that no rule allows (checked with the real client).
 */
export function buildClientSettings(guardCommand: string): { hooks: { PreToolUse: Array<{ matcher: string; hooks: Array<{ type: "command"; command: string; timeout: number }> }> } } {
  return {
    hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: guardCommand, timeout: GUARD_TIMEOUT_SECONDS }] }] },
  };
}

/** Flags a listened run must never carry, whoever asks for them. */
export const FORBIDDEN_CLIENT_FLAGS: readonly string[] = [
  "--dangerously-skip-permissions",
  "--allow-dangerously-skip-permissions",
  "--dangerously-bypass-approvals-and-sandbox",
  "--dangerously-bypass-hook-trust",
  "--yolo",
  "bypassPermissions",
  "danger-full-access",
  "--approve-for-me",
];

// ---------------------------------------------------------------------------
// The client's matching, for the tests and for the check of its settings

/** Turns a rule of the notation `Bash(<glob>)` into a test of a whole command. */
export function bashRuleMatcher(rule: string): ((command: string) => boolean) | undefined {
  const match = /^Bash\((.*)\)$/s.exec(rule);
  if (!match) return undefined;
  const pattern = match[1]!
    .split("*")
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
    .join(".*");
  const regex = new RegExp(`^${pattern}$`, "s");
  return (command) => regex.test(command);
}

/** Whether the lists, as the client reads them, let a command run: an allow rule matches and no deny rule does. */
export function listsAllow(command: string, allowed: readonly string[], denied: readonly string[]): boolean {
  const matches = (rules: readonly string[]) => rules.some((rule) => bashRuleMatcher(rule)?.(command) === true);
  return matches(allowed) && !matches(denied);
}
