/**
 * Every tool of the server, in the order a client lists them, with the
 * toolset it belongs to and what it may change. The order is fixed so a
 * client can cache the list.
 */

export const TOOLSETS = ["diagnosis", "incidents", "timeline", "postmortem", "settings"] as const;
export type Toolset = (typeof TOOLSETS)[number];

/** The toolsets that are on when a person chooses nothing. */
export const DEFAULT_TOOLSETS: readonly Toolset[] = ["diagnosis", "incidents"];

export const TOOLSET_SUMMARY: Record<Toolset, string> = {
  diagnosis:
    "Run a diagnosis: find and pick up a run, post trace steps, checks, causes and findings, build figures and source links, and complete the run.",
  incidents:
    "Read and edit incidents, services, impact and affected customers, search, start a run, and read an incident's runs and findings.",
  timeline: "Read and edit timeline events and comments, and promote a finding to the timeline.",
  postmortem: "Postmortem revision proposals, legacy postmortem imports and runbook candidates from a postmortem.",
  settings:
    "Setup checks (data source probe, MCP tool check sessions) and run inspection (trace steps, matched runbooks, waivers, scope).",
};

/**
 * - read: changes nothing in Tellagen.
 * - add: creates a record or moves a run forward; it removes nothing.
 * - change: overwrites fields of an existing record, or ends a run.
 */
export type ToolEffect = "read" | "add" | "change";

export interface ToolCatalogEntry {
  name: string;
  toolset: Toolset;
  effect: ToolEffect;
  /** A repeat with the same input leaves the same state. */
  idempotent?: boolean;
  /** The tool reaches a system other than Tellagen (a Grafana health check, an image URL). */
  openWorld?: boolean;
}

export const TOOL_CATALOG: readonly ToolCatalogEntry[] = [
  // diagnosis
  { name: "tellagen_next_investigation", toolset: "diagnosis", effect: "read" },
  { name: "tellagen_pick_up_investigation", toolset: "diagnosis", effect: "add", idempotent: true },
  { name: "tellagen_resume", toolset: "diagnosis", effect: "add", idempotent: true },
  { name: "tellagen_get_incident_context", toolset: "diagnosis", effect: "read" },
  { name: "tellagen_post_trace_step", toolset: "diagnosis", effect: "add", idempotent: true },
  { name: "tellagen_post_runbook_check_attempt", toolset: "diagnosis", effect: "add", idempotent: true },
  { name: "tellagen_update_cause", toolset: "diagnosis", effect: "change", idempotent: true },
  { name: "tellagen_post_finding", toolset: "diagnosis", effect: "add" },
  { name: "tellagen_update_finding", toolset: "diagnosis", effect: "change" },
  { name: "tellagen_build_figure", toolset: "diagnosis", effect: "read" },
  { name: "tellagen_build_source_link", toolset: "diagnosis", effect: "read" },
  { name: "tellagen_get_context_attachment", toolset: "diagnosis", effect: "read" },
  { name: "tellagen_get_investigation_coverage", toolset: "diagnosis", effect: "read" },
  { name: "tellagen_post_timeline_event", toolset: "diagnosis", effect: "add" },
  { name: "tellagen_complete_investigation", toolset: "diagnosis", effect: "change" },
  // incidents
  { name: "tellagen_list_incidents", toolset: "incidents", effect: "read" },
  { name: "tellagen_get_incident", toolset: "incidents", effect: "read" },
  { name: "tellagen_get_incident_timeline", toolset: "incidents", effect: "read" },
  { name: "tellagen_create_incident", toolset: "incidents", effect: "add" },
  { name: "tellagen_update_incident", toolset: "incidents", effect: "change" },
  { name: "tellagen_search", toolset: "incidents", effect: "read" },
  { name: "tellagen_list_services", toolset: "incidents", effect: "read" },
  { name: "tellagen_get_service", toolset: "incidents", effect: "read" },
  { name: "tellagen_get_impact_summary", toolset: "incidents", effect: "read" },
  { name: "tellagen_list_affected_customers", toolset: "incidents", effect: "read" },
  { name: "tellagen_start_investigation", toolset: "incidents", effect: "add" },
  { name: "tellagen_list_investigation_runs", toolset: "incidents", effect: "read" },
  { name: "tellagen_get_investigation_workspace", toolset: "incidents", effect: "read" },
  { name: "tellagen_list_findings", toolset: "incidents", effect: "read" },
  { name: "tellagen_get_finding", toolset: "incidents", effect: "read" },
  // timeline
  { name: "tellagen_get_timeline_event", toolset: "timeline", effect: "read" },
  { name: "tellagen_update_timeline_event", toolset: "timeline", effect: "change" },
  { name: "tellagen_list_timeline_comments", toolset: "timeline", effect: "read" },
  { name: "tellagen_add_timeline_comment", toolset: "timeline", effect: "add" },
  { name: "tellagen_promote_finding", toolset: "timeline", effect: "add" },
  // postmortem
  { name: "tellagen_get_postmortem_revision_request", toolset: "postmortem", effect: "read" },
  { name: "tellagen_submit_postmortem_revision_proposal", toolset: "postmortem", effect: "add" },
  { name: "tellagen_post_postmortem", toolset: "postmortem", effect: "add" },
  { name: "tellagen_update_postmortem", toolset: "postmortem", effect: "add" },
  { name: "tellagen_get_postmortem_analysis_request", toolset: "postmortem", effect: "read" },
  { name: "tellagen_submit_postmortem_runbook_candidates", toolset: "postmortem", effect: "add" },
  // settings
  { name: "tellagen_probe_datasource", toolset: "settings", effect: "read", openWorld: true },
  { name: "tellagen_get_diagnostic_session", toolset: "settings", effect: "read" },
  { name: "tellagen_report_diagnostic_tools", toolset: "settings", effect: "add" },
  { name: "tellagen_list_trace_steps", toolset: "settings", effect: "read" },
  { name: "tellagen_list_runbooks", toolset: "settings", effect: "read" },
  { name: "tellagen_list_investigation_runbook_waivers", toolset: "settings", effect: "read" },
  { name: "tellagen_update_investigation_scope", toolset: "settings", effect: "change" },
];

/** The tool that turns a toolset on. It is always listed, last. */
export const ENABLE_TOOLSET_TOOL = "tellagen_enable_toolset";

/** The sign-in tool. It is always listed, after the enable tool, because it must work before any setup. */
export const SIGN_IN_TOOL = "tellagen_sign_in";

/** The MCP annotations of a catalog entry. */
export function toolAnnotations(entry: ToolCatalogEntry): {
  readOnlyHint: boolean;
  destructiveHint: boolean;
  idempotentHint: boolean;
  openWorldHint: boolean;
} {
  const readOnly = entry.effect === "read";
  return {
    readOnlyHint: readOnly,
    destructiveHint: entry.effect === "change",
    idempotentHint: readOnly || entry.idempotent === true,
    openWorldHint: entry.openWorld === true,
  };
}

export type ToolsetSelection = readonly Toolset[] | "all";

/**
 * Reads a toolset list such as "diagnosis,timeline" or "all". An unknown
 * name is an error that names the valid ones, so a typing mistake does not
 * silently hide tools.
 */
export function parseToolsets(value: string | undefined): ToolsetSelection {
  const names = (value ?? "")
    .split(",")
    .map((name) => name.trim().toLowerCase())
    .filter((name) => name.length > 0);
  if (names.length === 0) return DEFAULT_TOOLSETS;
  if (names.includes("all")) return "all";
  const unknown = names.filter((name) => !(TOOLSETS as readonly string[]).includes(name));
  if (unknown.length > 0) {
    throw new Error(
      `Unknown toolset ${unknown.map((name) => `"${name.slice(0, 40)}"`).join(", ")}. Use all, or a comma-separated list of: ${TOOLSETS.join(", ")}.`,
    );
  }
  return TOOLSETS.filter((toolset) => names.includes(toolset));
}
