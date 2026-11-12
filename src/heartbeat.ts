import type { TellagenClient } from "./client.js";
import { TellagenAPIError } from "./errors.js";
import { pendingNotesOf, runEventLines } from "./run-events.js";

export const HEARTBEAT_CAPABILITY = "client_heartbeat_v1";
export const HEARTBEAT_INTERVAL_MS = 30_000;
const FAILURES_BEFORE_NOTICE = 3;
export const HEARTBEAT_MISSED_LINE = "Tellagen has not heard from this client for 90 seconds.";

/**
 * Tells Tellagen every 30 seconds that this client still holds its run, so
 * the web can show "Client connected". It runs only while a run is active and
 * the server lists client_heartbeat_v1. A failed heartbeat never fails a tool
 * call: after three in a row the next tool answer carries one line.
 */
export class Heartbeat {
  private timer: ReturnType<typeof setInterval> | undefined;
  private runId: string | undefined;
  private failures = 0;
  private sending = false;

  constructor(
    private readonly client: TellagenClient,
    private readonly intervalMs = HEARTBEAT_INTERVAL_MS,
  ) {
    client.session.onRunStart((run) => {
      this.stop();
      if (run.serverCapabilities.includes(HEARTBEAT_CAPABILITY)) this.start(run.runId);
    });
    client.session.onRunEnd((runId) => {
      if (runId === this.runId) this.stop();
    });
  }

  running(): boolean {
    return this.timer !== undefined;
  }

  private start(runId: string): void {
    this.runId = runId;
    this.failures = 0;
    this.timer = setInterval(() => void this.beat(), this.intervalMs);
    // The timer must not keep the process alive after the client closed.
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.runId = undefined;
    this.failures = 0;
  }

  /** Sends one heartbeat. It never throws. */
  async beat(): Promise<void> {
    const runId = this.runId;
    if (!runId || this.sending) return;
    this.sending = true;
    const session = this.client.session;
    try {
      const answer = await this.client.post<unknown>(
        `/api/v1/investigation-runs/${encodeURIComponent(runId)}/heartbeat`,
        // The computer name goes in its header, like on every call.
        { session_id: session.sessionId },
        // The next beat is the retry.
        { safeToRepeat: false, timeoutMs: 10_000 },
      );
      this.failures = 0;
      // A note can arrive with a heartbeat. It goes to the state file, so a restart of the client
      // before the next tool answer does not lose it. Without a state file it waits in memory.
      const record = (typeof answer === "object" && answer !== null ? answer : {}) as Record<string, unknown>;
      const notes = pendingNotesOf(record);
      let rest: unknown = answer;
      if (notes.length > 0 && session.state.filePath()) {
        session.state.addPendingNotes(runId, notes);
        const { responder_notes: _kept, ...others } = record;
        rest = others;
      }
      // A cancel request, or a run that ended, comes as a line.
      for (const line of runEventLines(this.client, rest)) session.addPendingLine(line);
    } catch (err) {
      if (err instanceof TellagenAPIError && (err.code === "run_taken_over" || err.code === "investigation_run_ended")) {
        const lines = runEventLines(this.client, { ...(err.payload ?? {}), error: true, code: err.code, message: err.message, run_id: runId });
        for (const line of lines) session.addPendingLine(line);
        return;
      }
      this.failures += 1;
      if (this.failures === FAILURES_BEFORE_NOTICE) session.addPendingLine(HEARTBEAT_MISSED_LINE);
    } finally {
      this.sending = false;
    }
  }
}
