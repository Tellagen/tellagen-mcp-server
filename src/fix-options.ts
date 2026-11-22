/**
 * Ways to fix it (fix_options_v1).
 *
 * A diagnosis leads with how to fix the problem. The options are alternatives
 * a person picks from, not a to-do list. The client names the kind of each
 * option and its one target; Tellagen works out what each button does. A
 * client never sends a label, a web address or an action type, so this schema
 * has no such field and tellagen_build_fix_option never writes one.
 *
 * Tellagen checks the rest (the file of a change was read, the diff is short,
 * a rollback target is a last good deployment) and answers with warnings. The
 * checks here only catch what the client can know before it sends.
 */
import { z } from "zod";
import { diffBlockSchema, validateBlock } from "./figures.js";

export const FIX_KINDS = ["permanent_fix", "mitigation", "hand_off", "leave_as_is"] as const;
export const FIX_WHERE = ["our_code", "our_config", "infra", "vendor", "other_team"] as const;
export const FIX_STATES = ["offered", "no_effect", "not_recommended"] as const;
export const FIX_EFFORT = ["small", "medium", "large"] as const;
export const FIX_RISK = ["low", "medium", "high"] as const;

/** The limits of the contract (fix-options.guidance.json, x-limits). */
export const FIX_LIMITS = {
  options_max: 5,
  id_max_chars: 32,
  title_max_chars: 80,
  trade_offs_max: 3,
  trade_off_max_chars: 160,
  state_reason_max_chars: 200,
  verify_text_max_chars: 200,
  verify_command_max_chars: 300,
  finding_ids_max: 12,
  read_refs_max: 6,
  diff_changed_lines_max: 6,
  issue_title_max_chars: 200,
  issue_body_max_chars: 2000,
} as const;

const readRefSchema = z
  .object({
    repo: z.string().trim().min(1).max(200).optional().describe("owner/name"),
    path: z.string().trim().min(1).max(300),
    ref_or_sha: z.string().trim().min(1).max(120).optional().describe("The commit or ref you read the file at"),
    lines: z.string().trim().min(1).max(40).optional().describe("For example 470-480"),
  })
  .strict();

const changeSchema = z
  .object({
    repo: z.string().trim().min(1).max(200).optional().describe("owner/name"),
    path: z.string().trim().min(1).max(300).optional(),
    line: z.number().int().positive().optional().describe("The first changed line"),
    config_line: z.string().trim().min(1).max(300).optional().describe("The setting, for a configuration change"),
    diff: diffBlockSchema.optional().describe("One diff figure of at most 6 changed lines (build it with tellagen_build_figure, placement step_figure). A larger change has no diff: name the file and the owner."),
  })
  .strict();

const vendorSchema = z
  .object({
    key: z.string().trim().min(1).max(64).describe("The key of the vendor, such as posthog"),
    issue_title: z.string().trim().min(1).max(FIX_LIMITS.issue_title_max_chars).optional(),
    issue_body: z.string().trim().min(1).max(FIX_LIMITS.issue_body_max_chars).optional().describe("Written so a stranger can follow it. No secret and no customer data."),
  })
  .strict();

const handOffSchema = z.object({ team_id: z.number().int().positive() }).strict();

const rollbackSchema = z
  .object({
    change_ref_id: z.string().trim().min(1).max(64).describe("The id of a change ref of this result with the role last_good and the kind deployment or release"),
    runbook_ref: z
      .object({ runbook_id: z.number().int().positive(), version: z.number().int().positive(), step_index: z.number().int().min(0) })
      .strict()
      .optional()
      .describe("A runbook step a person wrote, only when the pickup showed one. Leave it out otherwise: you cannot know how the team rolls back."),
  })
  .strict();

const fixOptionBase = z
  .object({
    id: z.string().trim().min(1).max(FIX_LIMITS.id_max_chars).describe("A short key, unique in the result"),
    kind: z.enum(FIX_KINDS).describe("permanent_fix removes the cause; mitigation lowers or stops the harm; hand_off gives it to the team or vendor that owns it; leave_as_is says nothing should change"),
    where: z.enum(FIX_WHERE).describe("Whose system the change is in"),
    recommended: z.boolean().optional().describe("At most one option, and an offered one"),
    state: z.enum(FIX_STATES).describe("offered = a way to fix it; no_effect = harmless but does not fix this; not_recommended = a tempting option that would do harm"),
    state_reason: z.string().trim().min(1).max(FIX_LIMITS.state_reason_max_chars).optional().describe("Required unless the state is offered"),
    title: z.string().trim().min(1).max(FIX_LIMITS.title_max_chars),
    trade_offs: z.array(z.string().trim().min(1).max(FIX_LIMITS.trade_off_max_chars)).max(FIX_LIMITS.trade_offs_max).optional(),
    effort: z.enum(FIX_EFFORT).optional(),
    risk: z.enum(FIX_RISK).optional(),
    verify: z
      .object({
        text: z.string().trim().max(FIX_LIMITS.verify_text_max_chars).describe("What the person should see when it worked"),
        command: z.string().trim().max(FIX_LIMITS.verify_command_max_chars).optional().describe("A read-only command. Never one that changes a system."),
      })
      .strict(),
    finding_ids: z.array(z.number().int().positive()).max(FIX_LIMITS.finding_ids_max).optional().describe("Findings of this run that show why the option is right or wrong"),
    read_refs: z.array(readRefSchema).max(FIX_LIMITS.read_refs_max).optional().describe("The files you read in this run to write the option"),
    change: changeSchema.optional(),
    vendor: vendorSchema.optional(),
    hand_off: handOffSchema.optional(),
    rollback: rollbackSchema.optional(),
  })
  .strict();

/** One fix option. Handler, label and web address are never sent: Tellagen sets them. */
export const fixOptionSchema = fixOptionBase.describe(
  "One way to deal with the problem. Name at most one target (vendor, hand_off or rollback). Never send a label, a web address or an action type. Build it with tellagen_build_fix_option.",
);

export type FixOptionInput = z.infer<typeof fixOptionSchema>;

/** The list of a result: 2 to 5 options is the guidance, 5 is the limit. */
export const fixOptionsSchema = z
  .array(fixOptionSchema)
  .max(FIX_LIMITS.options_max)
  .describe(
    "How to fix it, at most 5 alternatives a person picks from, with at most one recommended. Read the file before you recommend a change to it. Only when this Tellagen lists fix_options_v1.",
  );

/** Words and commands that change a system. A verify command never holds one. */
const CHANGING_COMMAND =
  /\b(kubectl\s+(apply|create|delete|patch|replace|scale|rollout\s+(restart|undo)|set|edit|drain|cordon|annotate|label|exec)|helm\s+(upgrade|install|rollback|uninstall)|git\s+(push|reset|revert|checkout|merge|rebase|commit)|terraform\s+(apply|destroy)|systemctl\s+(restart|stop|start|reload)|docker\s+(restart|stop|rm|kill)|rm\s+-|sudo\b|redis-cli\s+(flushall|flushdb|del)|aws\s+\S+\s+(delete|terminate|update|put|create)-\S+)/i;
/** Case matters: curl -d sends a body, curl -D dumps the headers. */
const CURL_WRITE = /\bcurl\b[^|]*(\s-X\s*(POST|PUT|PATCH|DELETE)\b|--request\s+(POST|PUT|PATCH|DELETE)\b|\s-d\b|--data)/;
const SQL_WRITE = /\b(insert|update|delete|drop|truncate|alter|create|grant|revoke)\b/i;

/** Text outside quotes: a word inside a quoted filter or query is not a verb. */
const outsideQuotes = (command: string): string => command.replace(/'[^']*'|"[^"]*"/g, " ");

/** Whether a verify command looks like one that changes a system. */
export function changesASystem(command: string): boolean {
  if (CHANGING_COMMAND.test(command) || CURL_WRITE.test(command)) return true;
  if (/\bpsql\b/.test(command) && SQL_WRITE.test(command)) return true;
  return /\bgcloud\b/.test(command) && /\s(delete|update|create)(\s|$)/.test(outsideQuotes(command));
}

/** Changed lines (added or removed) of a diff figure. */
function changedLines(diff: unknown): number {
  if (typeof diff !== "object" || diff === null) return 0;
  const sized = (diff as { additions?: unknown; deletions?: unknown });
  const whole = (typeof sized.additions === "number" ? sized.additions : 0) + (typeof sized.deletions === "number" ? sized.deletions : 0);
  return Math.max(whole, shownLines(diff));
}

function shownLines(diff: object): number {
  const hunks = (diff as { hunks?: unknown }).hunks;
  if (!Array.isArray(hunks)) return 0;
  let count = 0;
  for (const hunk of hunks) {
    if (!Array.isArray(hunk)) continue;
    for (const line of hunk) {
      const op = (line as { op?: unknown } | null)?.op;
      if (op === "+" || op === "-") count++;
    }
  }
  return count;
}

export type BuildFixOptionResult =
  | { ok: true; fix_option: FixOptionInput; notes: string[] }
  | { ok: false; issues: string[] };

/**
 * Checks one option against the rules the client can check alone and returns
 * it unchanged, with notes for what Tellagen will judge with the run (a file
 * that the run did not read, a second recommended option).
 */
export function buildFixOption(input: FixOptionInput): BuildFixOptionResult {
  const issues: string[] = [];
  const notes: string[] = [];
  const option = input;

  if (option.state !== "offered" && !option.state_reason) {
    issues.push(`state_reason: say why the option is ${option.state === "not_recommended" ? "not recommended (the harm it would do)" : "without effect (why it does not fix this)"}`);
  }
  if (option.recommended && option.state !== "offered") {
    issues.push("recommended: only an offered option can be recommended");
  }
  if (option.kind === "leave_as_is" && [option.vendor, option.hand_off, option.rollback].some((target) => target !== undefined)) {
    issues.push("vendor, hand_off, rollback: a leave_as_is option has no target (Tellagen drops the option)");
  }
  const targets = [option.vendor, option.hand_off, option.rollback].filter((target) => target !== undefined).length;
  if (targets > 1) issues.push("vendor, hand_off, rollback: name at most one target");
  if (option.kind === "hand_off" && targets === 0) {
    notes.push("A hand-off option with no vendor and no hand_off team gets the warning hand_off_without_target. Name the team (hand_off.team_id) or the vendor (vendor.key).");
  }
  if (option.vendor && option.where !== "vendor") issues.push("where: an option with a vendor target is where vendor");
  if (option.rollback && option.kind !== "mitigation") issues.push("kind: a rollback is a mitigation");
  if (option.rollback && !option.rollback.runbook_ref) {
    notes.push("The rollback names only the target. Tellagen shows that the team's rollback steps are not recorded: you cannot know how the team rolls back, so never write a deploy, rollback or restart command.");
  }
  if (option.verify.text.length === 0) {
    issues.push("verify.text: say what the person should see when it worked");
  }
  if (option.verify.command && changesASystem(option.verify.command)) {
    issues.push("verify.command: a verify command is read-only. This one looks like it changes a system (change_step_without_runbook removes it). Say what to look at instead.");
  }
  if (option.change?.diff !== undefined) {
    const problems = validateBlock(option.change.diff);
    if (problems.length > 0) issues.push(...problems.map((problem) => `change.diff.${problem}`));
    const changed = changedLines(option.change.diff);
    if (changed > FIX_LIMITS.diff_changed_lines_max) {
      issues.push(`change.diff: ${changed} changed lines is more than ${FIX_LIMITS.diff_changed_lines_max}. Leave the diff out and name the file and the owner (fix_option_diff_too_large removes it).`);
    }
  }
  const changesCode = Boolean(option.change?.path || option.change?.config_line);
  if (changesCode) {
    const path = option.change?.path;
    const read = (option.read_refs ?? []).some((ref) => !path || ref.path === path);
    if (!read) {
      notes.push(
        option.recommended
          ? "This option changes a file that read_refs does not list. Tellagen recommends a change only to a file the run read (fix_option_unread_file): read the file, keep the step in the trace, and name it in read_refs."
          : "read_refs does not list the file of this change, so it is shown as not checked against your code.",
      );
    }
  }
  if (option.kind === "leave_as_is" && option.recommended) {
    notes.push("Leave as is closes the ticket as expected behavior once a person confirms. Recommend it only when the verdict is not a real problem and customer impact is verified as none (leave_as_is_with_exposure).");
  }
  if (option.state === "not_recommended") {
    notes.push("Keep the tempting wrong option in the list: it stops a person from trying it.");
  }
  if (option.recommended) {
    notes.push("Recommend at most one option in the result; with more, only the first offered one stays (fix_option_multiple_recommended). When the verdict is not_sure, recommend nothing.");
  }
  return issues.length > 0 ? { ok: false, issues } : { ok: true, fix_option: option, notes };
}

/** A result summary without fix_options, for a backend that does not list fix_options_v1. */
export function stripResultFixOptions(summary: unknown): { summary: unknown; removed: string[] } {
  if (typeof summary !== "object" || summary === null || Array.isArray(summary) || !("fix_options" in summary)) {
    return { summary, removed: [] };
  }
  const next: Record<string, unknown> = { ...(summary as Record<string, unknown>) };
  delete next.fix_options;
  return { summary: next, removed: ["fix_options"] };
}

/**
 * A verdict without what only diagnosis_verdict_v1 takes: the verdict
 * expected_behavior (the whole verdict goes, because a Tellagen without the
 * capability would drop it too) and the owner.
 */
export function stripVerdictExtras(summary: unknown): { summary: unknown; removed: string[] } {
  if (typeof summary !== "object" || summary === null || Array.isArray(summary)) return { summary, removed: [] };
  const record = summary as Record<string, unknown>;
  const verdict = record.alert_verdict;
  if (typeof verdict !== "object" || verdict === null || Array.isArray(verdict)) return { summary, removed: [] };
  const v = verdict as Record<string, unknown>;
  if (v.verdict === "expected_behavior") {
    const next = { ...record };
    delete next.alert_verdict;
    return { summary: next, removed: ["alert_verdict (expected_behavior)"] };
  }
  if ("owner" in v) {
    const { owner: _owner, ...rest } = v;
    return { summary: { ...record, alert_verdict: rest }, removed: ["alert_verdict.owner"] };
  }
  return { summary, removed: [] };
}
