import { appendFileSync } from "node:fs";
import { guardDecision } from "../shell-rules.js";
import type { CliIo } from "./io.js";

const MAX_EVENT_BYTES = 256 * 1024;

/**
 * `listen-guard`: the hook that the listener gives the client for every shell
 * call of a listened run. It reads the hook event on standard input and
 * prints an explicit pass or a refusal. The client runs the shell call only
 * on a pass. If this process fails to start, crashes or is too slow, no pass
 * is given and the client refuses the call: the guard fails closed.
 *
 * With TELLAGEN_GUARD_LOG set it appends one line for each decision, which
 * is how the listener proves at its start that the client calls the guard.
 */
export async function listenGuardCommand(_args: readonly string[], io: CliIo): Promise<number> {
  let decision: ReturnType<typeof guardDecision>;
  let mode = "";
  try {
    const raw = await io.readStdin(MAX_EVENT_BYTES);
    decision = guardDecision(raw);
    try {
      const event = JSON.parse(raw) as { permission_mode?: unknown };
      mode = typeof event.permission_mode === "string" ? event.permission_mode : "";
    } catch {
      // Not JSON: the decision above is a refusal.
    }
  } catch {
    decision = { decision: "deny", reason: "The hook event could not be read." };
  }
  const logPath = (io.env.TELLAGEN_GUARD_LOG ?? "").trim();
  if (logPath) {
    try {
      const command = (decision.command ?? "").replace(/[\t\r\n]+/g, " ").slice(0, 300);
      appendFileSync(logPath, `${decision.decision}\t${mode}\t${command}\n`, { mode: 0o600 });
    } catch {
      // A log is a convenience; the decision stands.
    }
  }
  io.stdout(
    `${JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: decision.decision,
        permissionDecisionReason: decision.reason.slice(0, 300),
      },
    })}\n`,
  );
  return 0;
}
