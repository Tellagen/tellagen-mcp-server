import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { TellagenClient } from "../client.js";
import { isRunId } from "../active-run.js";
import { formatError, TellagenAPIError } from "../errors.js";

/** The list of local runs that wait for a client. */
export const WAITING_LIST_PATH = "/api/v1/investigations?status=awaiting_agent";
const MAX_LISTED = 20;

export interface WaitingRun {
  run_id: string;
  incident_id?: number;
  incident_human_id?: string;
  incident_title?: string;
  question?: string;
  requested_by?: string;
  requested_by_me: boolean;
  requested_at?: string;
  follow_up?: boolean;
  screenshot_count?: number;
  link_count?: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A text field of the list as one clean line, cut to max characters. */
const str = (value: unknown, max: number) => {
  if (typeof value !== "string") return undefined;
  const clean = value.replace(/[\u0000-\u001f\u007f]+/g, " ").trim().slice(0, max).trim();
  return clean || undefined;
};

/** The waiting runs of an answer, the caller's own first, in the order Tellagen gave. */
export function waitingRuns(data: unknown): WaitingRun[] {
  const list = Array.isArray(data)
    ? data
    : isRecord(data)
      ? ["runs", "waiting_runs", "waiting", "investigations", "items"]
          .map((key) => data[key])
          .find((value) => Array.isArray(value))
      : undefined;
  if (!Array.isArray(list)) return [];
  const runs: WaitingRun[] = [];
  for (const item of list) {
    if (!isRecord(item)) continue;
    const runId = str(item.run_id ?? item.id, 200);
    if (!runId || !isRunId(runId)) continue;
    const run: WaitingRun = { run_id: runId, requested_by_me: item.requested_by_me === true };
    if (typeof item.incident_id === "number") run.incident_id = item.incident_id;
    const humanId = str(item.incident_human_id, 40);
    if (humanId) run.incident_human_id = humanId;
    const title = str(item.incident_title, 200);
    if (title) run.incident_title = title;
    const question = str(item.question, 500);
    if (question) run.question = question;
    const by = str(item.requested_by, 120);
    if (by) run.requested_by = by;
    const at = str(item.requested_at, 40);
    if (at) run.requested_at = at;
    if (item.follow_up === true) run.follow_up = true;
    if (typeof item.screenshot_count === "number" && item.screenshot_count > 0) run.screenshot_count = item.screenshot_count;
    if (typeof item.link_count === "number" && item.link_count > 0) run.link_count = item.link_count;
    runs.push(run);
  }
  // A stable sort: own runs first, the order of the list otherwise.
  return [...runs.filter((run) => run.requested_by_me), ...runs.filter((run) => !run.requested_by_me)];
}

function runLabel(run: WaitingRun): string {
  const incident = run.incident_human_id ?? (run.incident_id !== undefined ? `#${run.incident_id}` : "incident");
  const parts = [incident, run.incident_title, run.requested_by_me ? "yours" : run.requested_by && `from ${run.requested_by}`];
  return parts.filter(Boolean).join(" · ");
}

function answer(payload: Record<string, unknown>, isError = false) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(payload) }],
    ...(isError ? { isError: true as const } : {}),
  };
}

const pickUpLine = (runId: string) =>
  `Call tellagen_pick_up_investigation with investigation_run_id "${runId}", your model name and the data sources you can reach.`;

export function registerNextInvestigationTools(server: McpServer, client: TellagenClient): void {
  server.registerTool(
    "tellagen_next_investigation",
    {
      description:
        "Find the diagnosis run that waits for a client, so nobody has to paste a run ID. With one waiting run it returns that run. With several it returns the list, your own runs first, and the person chooses: the client asks them when it can, otherwise ask them yourself in plain text and do not choose for them. With none it says so; you can then start a run for an incident with tellagen_start_investigation. Pass incident_id to look at one incident only. It changes nothing and picks nothing up: call tellagen_pick_up_investigation with the run ID next. On a Tellagen workspace that has no waiting list yet, it explains that and you use the run ID from the Tellagen page.",
      inputSchema: {
        incident_id: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("Only the waiting runs of this incident"),
      },
    },
    async ({ incident_id }) => {
      try {
        let data: unknown;
        try {
          data = await client.get(WAITING_LIST_PATH);
        } catch (err) {
          if (err instanceof TellagenAPIError && (err.status === 404 || err.status === 405)) {
            return answer({
              waiting_list: "unavailable",
              code: "waiting_list_unavailable",
              message:
                "This Tellagen workspace has no waiting list yet: it needs an update. Until then, ask the person for the run ID that the Tellagen page shows and call tellagen_pick_up_investigation with it, or start a run with tellagen_start_investigation and an incident ID.",
            });
          }
          throw err;
        }
        let runs = waitingRuns(data);
        if (incident_id !== undefined) runs = runs.filter((run) => run.incident_id === incident_id);
        if (runs.length === 0) {
          return answer({
            waiting: 0,
            runs: [],
            message: `No run is waiting${incident_id !== undefined ? ` for incident ${incident_id}` : ""}. To start one, call tellagen_start_investigation with the incident ID${incident_id !== undefined ? ` ${incident_id}` : ""}, then pick it up.`,
          });
        }
        if (runs.length === 1) {
          return answer({ waiting: 1, run: runs[0], next: pickUpLine(runs[0]!.run_id) });
        }
        const listed = runs.slice(0, MAX_LISTED);
        const choice = await client.session.choose?.(
          `${runs.length} diagnosis runs are waiting in Tellagen. Which one should this client take?`,
          listed.map((run) => ({ value: run.run_id, label: runLabel(run) })),
        );
        if (typeof choice === "string") {
          const run = listed.find((item) => item.run_id === choice)!;
          return answer({ waiting: runs.length, chosen_by: "person", run, next: pickUpLine(run.run_id) });
        }
        return answer({
          waiting: runs.length,
          runs: listed,
          ...(runs.length > listed.length ? { not_listed: runs.length - listed.length } : {}),
          message:
            choice === null
              ? "The person did not choose a run. Do not pick one up. Ask them what they want."
              : "Several runs are waiting. Show the person this list, their own runs first, and ask which one to take. Do not choose for them. Then call tellagen_pick_up_investigation with that run ID.",
        });
      } catch (err) {
        return { content: [{ type: "text" as const, text: formatError(err) }], isError: true };
      }
    },
  );
}
