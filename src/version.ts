export const MCP_SERVER_VERSION = "0.9.1";

export const INVESTIGATION_PROTOCOL_CAPABILITIES = [
  "runbook_plan_v2",
  "trace_check_id_v2",
  "finding_roles_v2",
  "gap_findings_v2",
  "completion_coverage_v2",
  "diagnosis_structure_v1",
  "diagnosis_changes_v1",
  "run_images_v1",
  "guidance_default_v1",
  "strict_fields_v1",
  "cause_lead_v1",
  "responder_notes_v1",
  "investigation_window_v1",
  "question_checks_v1",
  "run_requests_v1",
  "diagnosis_verdict_v1",
  "fix_options_v1",
  "code_locations_v1",
] as const;

/** The server capability of Tellagen: requests on a finished run, delivered to the client. */
export const RUN_REQUESTS_CAPABILITY = "run_requests_v1";

/** Client capabilities that a person can switch off with an environment variable. */
const OPTIONAL_CAPABILITY_SWITCH: Record<string, string> = { strict_fields_v1: "TELLAGEN_STRICT_FIELDS" };

/**
 * The capabilities sent at pickup. `strict_fields_v1` makes Tellagen refuse a
 * body with a field it does not know, with the field's path. A person who
 * hits a problem with it sets TELLAGEN_STRICT_FIELDS=0.
 */
export function protocolCapabilities(env: Record<string, string | undefined> = process.env): string[] {
  return INVESTIGATION_PROTOCOL_CAPABILITIES.filter((name) => {
    const variable = OPTIONAL_CAPABILITY_SWITCH[name];
    return !(variable && ["0", "false", "off", "no"].includes((env[variable] ?? "").trim().toLowerCase()));
  });
}

/** The header that tells Tellagen the capabilities of a request that has no picked-up run. */
export const CAPABILITIES_HEADER = "X-Tellagen-Capabilities";
