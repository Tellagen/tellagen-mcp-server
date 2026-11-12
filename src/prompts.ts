import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

const RUN_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;

/**
 * The text of the diagnose prompt. A run or an incident the person typed is
 * put in only when it looks like an id; anything else is left out, so the
 * prompt never carries free text as if it were an instruction.
 */
export function diagnosePromptText(args: { run?: string; incident?: string }): string {
  const run = args.run?.trim();
  const incident = args.incident?.trim().replace(/^#/, "");
  const lines: string[] = [];
  if (run && RUN_ID_PATTERN.test(run)) {
    lines.push(
      `Diagnose with Tellagen. Call tellagen_pick_up_investigation with investigation_run_id "${run}", your model name and the data sources you can reach.`,
    );
  } else if (incident && /^\d{1,12}$/.test(incident)) {
    lines.push(
      `Diagnose incident ${incident} with Tellagen. Call tellagen_next_investigation with incident_id ${incident}. If a run waits, pick it up with tellagen_pick_up_investigation. If none waits, start one with tellagen_start_investigation and pick it up.`,
    );
  } else {
    lines.push(
      "Diagnose with Tellagen. Call tellagen_next_investigation to find the run that waits for you, then call tellagen_pick_up_investigation with its ID, your model name and the data sources you can reach. If several runs wait and you are asked which one, ask the person.",
    );
  }
  lines.push(
    "Then follow the run guide: read the context and the resources the pickup answer names in mcp_resources, post each check as a trace step, post each cause you test and each finding when you find it, build figures with tellagen_build_figure, and complete the run with a result_summary whose headline has 15 words or fewer.",
    "If Tellagen answers that it is not set up, tell the person the setup steps and stop.",
  );
  return lines.join("\n\n");
}

/** The `diagnose` prompt: a client shows it as a command the person can run. */
export function registerDiagnosePrompt(server: McpServer): void {
  server.registerPrompt(
    "diagnose",
    {
      title: "Diagnose with Tellagen",
      description:
        "Find the diagnosis run that waits in Tellagen, pick it up and run it. Give a run ID or an incident number to choose one.",
      argsSchema: {
        run: z.string().max(128).optional().describe("A run ID from Tellagen. Optional."),
        incident: z.string().max(16).optional().describe("An incident number. Optional."),
      },
    },
    (args) => ({
      messages: [{ role: "user" as const, content: { type: "text" as const, text: diagnosePromptText(args) } }],
    }),
  );
}
