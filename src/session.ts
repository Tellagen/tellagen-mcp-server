import { randomUUID } from "node:crypto";
import {
  CLIENT_HEADER_COMPUTER,
  CLIENT_HEADER_NAME,
  CLIENT_HEADER_SERVER_VERSION,
  CLIENT_HEADER_SESSION,
  CLIENT_HEADER_VERSION,
  type ClientIdentity,
  computerName,
  reportedClientName,
} from "./identity.js";
import { RunStateStore, type RunState, workspaceKey } from "./run-state.js";
import { cleanSourceBases, type SourceBase } from "./source-bases.js";
import { MCP_SERVER_VERSION } from "./version.js";

/** The run this MCP server process picked up. */
export interface ActiveRun {
  runId: string;
  incidentId?: number;
  pickedUpAt: string;
  serverCapabilities: string[];
  /** The Grafana and GitHub addresses of the pickup answer, when Tellagen sent them. */
  sourceBases?: SourceBase[];
}

/** A request on a finished run that this session took. `text` is the person's own words. */
export interface TakenRequest {
  /** The number Tellagen gave the request. */
  id: number;
  runId: string;
  kind: string;
  source?: string;
  sourceLabel?: string;
  text?: string;
}

/** Turns a toolset on in the running session. Set by the tool registry. */
export interface ToolsetSwitch {
  enable(toolset: string): { enabled: string[]; added: string[] };
  enabled(): string[];
}

/**
 * What one MCP server process knows about itself: who the client is, which
 * run it holds, and where that run is remembered on disk. One session belongs
 * to one Tellagen client object.
 */
export class Session {
  /** A random id of this process; it is not a secret and not a credential. */
  sessionId: string = randomUUID();
  readonly computer: string = computerName();
  state: RunStateStore;
  identity: ClientIdentity | undefined;
  toolsets: ToolsetSwitch | undefined;
  /**
   * Puts a yes or no question to the person through the client. True is a
   * yes, false a no, and undefined means the client cannot ask, so the model
   * must ask in plain text. Set by the server once the client is known.
   */
  ask: ((question: string) => Promise<boolean | undefined>) | undefined;
  /**
   * Lets the person pick one of a few options through the client. The value
   * of the option, null when they declined, undefined when the client cannot
   * ask.
   */
  choose:
    | ((question: string, options: ReadonlyArray<{ value: string; label: string }>) => Promise<string | null | undefined>)
    | undefined;
  /** Called when a pickup says that Tellagen wants a newer server. Set by the entry point. */
  updateSeen: ((info: { your_version: string; current_version: string }) => void) | undefined;
  private active: ActiveRun | undefined;
  /** The source addresses of the runs this process picked up or read, by run id. */
  private sourceBases = new Map<string, SourceBase[]>();
  /** Lines for the next tool answer (a missed heartbeat, a note from a recorder). */
  private pendingLines: string[] = [];
  private notice: { line: string; everyMs: number; shownAt: number } | undefined;
  private runEndListeners: Array<(runId: string) => void> = [];
  private runStartListeners: Array<(run: ActiveRun) => void> = [];

  constructor(apiUrl: string, private readonly stateDir: string | undefined) {
    this.state = new RunStateStore(stateDir, workspaceKey(apiUrl));
  }

  /** Points the remembered-run file at another workspace, after a sign-in. */
  setWorkspace(apiUrl: string): void {
    this.active = undefined;
    this.amendable.clear();
    this.requests.clear();
    this.sourceBases.clear();
    this.state = new RunStateStore(this.stateDir, workspaceKey(apiUrl));
  }

  /**
   * Speaks as the process that holds a run. A step hook is a separate process
   * and must send the session id of the server that picked the run up.
   */
  adoptSession(sessionId: string, clientId?: string): void {
    this.sessionId = sessionId;
    if (clientId) this.identity = { name: clientId, label: clientId, version: this.identity?.version ?? "" };
  }

  /** The headers that tell Tellagen which client sent a request. */
  identityHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      [CLIENT_HEADER_NAME]: reportedClientName(this.identity),
      [CLIENT_HEADER_SERVER_VERSION]: MCP_SERVER_VERSION,
      [CLIENT_HEADER_SESSION]: this.sessionId,
    };
    if (this.identity?.version) headers[CLIENT_HEADER_VERSION] = this.identity.version;
    if (this.computer) headers[CLIENT_HEADER_COMPUTER] = this.computer;
    return headers;
  }

  activeRun(): ActiveRun | undefined {
    return this.active;
  }

  /** Remembers a picked-up run in memory and in the state file. */
  setActiveRun(run: ActiveRun): void {
    this.active = run;
    const state: RunState = {
      version: 1,
      run_id: run.runId,
      picked_up_at: run.pickedUpAt,
      server_capabilities: run.serverCapabilities.slice(0, 100),
      session_id: this.sessionId,
      pid: process.pid,
    };
    if (run.incidentId !== undefined) state.incident_id = run.incidentId;
    if (run.sourceBases?.length) state.source_bases = run.sourceBases;
    this.keepSourceBases(run.runId, run.sourceBases ?? []);
    // The same run picked up again (after a restart): what a heartbeat or a step hook left for the model stays.
    const prior = this.state.read();
    if (prior?.run_id === run.runId) {
      if (prior.pending_notes?.length) state.pending_notes = prior.pending_notes;
      if (prior.recorded_steps?.length) state.recorded_steps = prior.recorded_steps;
    }
    if (this.identity?.label) state.client_name = this.identity.label;
    if (this.identity?.name) state.client_id = this.identity.name.slice(0, 64);
    if (this.identity?.version) state.client_version = this.identity.version;
    this.state.write(state);
    for (const listener of this.runStartListeners) listener(run);
  }

  private keepSourceBases(runId: string, bases: SourceBase[]): void {
    this.sourceBases.delete(runId);
    this.sourceBases.set(runId, bases);
    // A run is read once or twice; a long session must not collect them all.
    if (this.sourceBases.size > 20) this.sourceBases.delete(this.sourceBases.keys().next().value as string);
  }

  /**
   * The source addresses Tellagen sent for a run: from this process, else from
   * the state file when it names the run. Undefined when none is known.
   */
  sourceBasesFor(runId: string): SourceBase[] | undefined {
    const known = this.sourceBases.get(runId);
    if (known) return known;
    const stored = this.state.read();
    // The file is not trusted more than an answer: clean it again.
    return stored?.run_id === runId && stored.source_bases ? cleanSourceBases(stored.source_bases) : undefined;
  }

  /** Remembers the source addresses of a context read, in memory and in the state file. */
  rememberSourceBases(runId: string, bases: SourceBase[]): void {
    this.keepSourceBases(runId, bases);
    this.state.setSourceBases(runId, bases);
  }

  /** Runs that finished but still take additions, by run id. */
  private amendable = new Map<string, { until?: string; incidentId?: number }>();

  /**
   * Remembers a finished run that still takes additions, so a later call in
   * the same chat finds it. `until` is the time Tellagen gave, when it did.
   */
  rememberAmendable(runId: string, until?: string, incidentId?: number): void {
    this.amendable.delete(runId);
    this.amendable.set(runId, { ...(until ? { until } : {}), ...(incidentId !== undefined ? { incidentId } : {}) });
    if (this.amendable.size > 10) this.amendable.delete(this.amendable.keys().next().value as string);
  }

  forgetAmendable(runId: string): void {
    this.amendable.delete(runId);
  }

  /** The time Tellagen gave for a finished run, undefined when none was given or the run is not remembered. */
  amendableUntil(runId: string): string | undefined {
    return this.amendable.get(runId)?.until;
  }

  /**
   * The finished run that most recently took additions and has not run out,
   * for a call that gives no run id. Undefined when there is none.
   */
  latestAmendable(now = Date.now()): { runId: string; until?: string } | undefined {
    for (const [runId, info] of [...this.amendable.entries()].reverse()) {
      const end = info.until ? Date.parse(info.until) : NaN;
      if (Number.isFinite(end) && end <= now) {
        this.amendable.delete(runId);
        continue;
      }
      return { runId, ...(info.until ? { until: info.until } : {}) };
    }
    return undefined;
  }

  /** Requests on a finished run that this session took, by request id. */
  private requests = new Map<number, TakenRequest>();
  private finishListeners: Array<(runId: string, until: string | undefined) => void> = [];

  rememberRequest(request: TakenRequest): void {
    this.requests.delete(request.id);
    this.requests.set(request.id, request);
    if (this.requests.size > 20) this.requests.delete(this.requests.keys().next().value as number);
  }

  takenRequest(id: number): TakenRequest | undefined {
    return this.requests.get(id);
  }

  forgetRequest(id: number): void {
    this.requests.delete(id);
  }

  /** Called when a run was completed by this session and still takes additions. */
  onRunFinished(listener: (runId: string, until: string | undefined) => void): void {
    this.finishListeners.push(listener);
  }

  runFinished(runId: string, until: string | undefined): void {
    for (const listener of this.finishListeners) listener(runId, until);
  }

  /** Forgets a run that completed, failed, was cancelled or was taken over. */
  clearActiveRun(runId: string): void {
    if (this.active?.runId === runId) this.active = undefined;
    this.sourceBases.delete(runId);
    this.state.clear(runId);
    for (const listener of this.runEndListeners) listener(runId);
  }

  onRunStart(listener: (run: ActiveRun) => void): void {
    this.runStartListeners.push(listener);
  }

  onRunEnd(listener: (runId: string) => void): void {
    this.runEndListeners.push(listener);
  }

  private announcedSteps = new Set<string>();

  /** True the first time a recorded step is named to the model in this process. */
  announceRecordedStep(stepId: string): boolean {
    if (this.announcedSteps.has(stepId)) return false;
    if (this.announcedSteps.size > 500) this.announcedSteps.clear();
    this.announcedSteps.add(stepId);
    return true;
  }

  /** Queues one line for the next tool answer; the same line is queued once. */
  addPendingLine(line: string): void {
    if (!this.pendingLines.includes(line)) this.pendingLines.push(line);
  }

  /**
   * A line that goes with tool answers again and again, at most once in
   * `everyMs` (a key that is about to expire). Setting the same line twice
   * keeps one entry.
   */
  setNotice(line: string | undefined, everyMs = 30 * 60_000): void {
    if (line === undefined) {
      this.notice = undefined;
      return;
    }
    if (this.notice?.line !== line) this.notice = { line, everyMs, shownAt: 0 };
  }

  takePendingLines(now = Date.now()): string[] {
    const lines = this.pendingLines;
    this.pendingLines = [];
    if (this.notice && now - this.notice.shownAt >= this.notice.everyMs) {
      this.notice.shownAt = now;
      lines.push(this.notice.line);
    }
    return lines;
  }
}
