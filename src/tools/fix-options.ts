import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { buildFixOption, fixOptionSchema } from "../fix-options.js";

/**
 * tellagen_build_fix_option: checks one way to fix it and returns it as
 * result_summary.fix_options wants it, so the model never writes the JSON by
 * hand. Like tellagen_build_figure it has no data of its own and changes
 * nothing in Tellagen.
 */
export function registerFixOptionTools(server: McpServer): void {
  server.registerTool(
    "tellagen_build_fix_option",
    {
      title: "Build a fix option",
      description:
        "Check one way to fix the problem and return it in the shape result_summary.fix_options takes, so you never write that JSON by hand. A diagnosis leads with how to fix it: give 2 to 5 options, recommend at most one (an offered one), and keep a tempting wrong option in the list: not_recommended with the harm it would do, or no_effect when it is harmless but does not fix this. Name at most one target: vendor {key, issue_title, issue_body}, hand_off {team_id} or rollback {change_ref_id, runbook_ref}. Never send a label, a web address or an action type: Tellagen works out what each button does from the kind and the target. Read the file before you recommend a change to it, and name it in read_refs. A diff is for a change of 6 changed lines or fewer (build it with tellagen_build_figure, placement step_figure); a larger change has no diff, name the file and the owner. verify.command is read-only; never write a deploy, rollback, restart, scale, flag or purge command, and name a runbook step in a rollback only when the pickup showed one. Returns fix_option and notes about what Tellagen will judge with the run. Put each result in result_summary.fix_options of tellagen_complete_investigation, only when this Tellagen lists fix_options_v1. It changes nothing in Tellagen.",
      inputSchema: fixOptionSchema.shape,
    },
    async (input) => {
      const parsed = fixOptionSchema.safeParse(input);
      const result = parsed.success
        ? buildFixOption(parsed.data)
        : { ok: false as const, issues: parsed.error.issues.map((issue) => `${issue.path.join(".") || "option"}: ${issue.message}`) };
      if (!result.ok) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                ok: false,
                issues: result.issues,
                next: "Fix exactly these fields and call again. Do not drop the option unless it is not true.",
              }),
            },
          ],
          isError: true,
        };
      }
      return { content: [{ type: "text" as const, text: JSON.stringify({ ok: true, fix_option: result.fix_option, notes: result.notes }) }] };
    },
  );
}
