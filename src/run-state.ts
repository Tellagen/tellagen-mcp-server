import {
  chmodSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { z } from "zod";
import { tellagenHome } from "./home.js";
import { MAX_SOURCE_BASES, sourceBaseSchema, type SourceBase } from "./source-bases.js";

/**
 * The run this computer is working on, remembered across a client restart.
 *
 * The file holds no secret: no key, no token, no evidence. It is written with
 * owner-only permissions because a run id and a note are still private.
 */
const pendingNoteSchema = z.object({
  id: z.union([z.string(), z.number()]).optional(),
  author: z.string().max(200).optional(),
  at: z.string().max(64).optional(),
  text: z.string().max(4000),
});

const runStateSchema = z.object({
  version: z.literal(1),
  run_id: z.string().min(1).max(200),
  incident_id: z.number().int().positive().optional(),
  picked_up_at: z.string().max(64),
  server_capabilities: z.array(z.string().max(100)).max(100),
  /** The MCP server process that last picked the run up. */
  session_id: z.string().min(1).max(100),
  pid: z.number().int().positive(),
  client_name: z.string().max(100).optional(),
  client_version: z.string().max(64).optional(),
  /** The short client name Tellagen knows, such as "claude-code"; a hook sends it as its client. */
  client_id: z.string().max(64).optional(),
  /** The Grafana and GitHub addresses Tellagen sent for this run, so a source link needs no address of its own. */
  source_bases: z.array(sourceBaseSchema).max(MAX_SOURCE_BASES).optional(),
  /** Notes a recorder outside this process left for the model. */
  pending_notes: z.array(pendingNoteSchema).max(50).optional(),
  /** Steps a hook recorded that the model has not updated yet, oldest first. */
  recorded_steps: z
    .array(z.object({ step_id: z.string().min(1).max(200), title: z.string().max(200), at: z.string().max(64) }))
    .max(10)
    .optional(),
  /** Set by a recorder outside this process when Tellagen said the run is over. */
  stop: z.object({ reason: z.string().max(300), at: z.string().max(64) }).optional(),
});

export type RunState = z.infer<typeof runStateSchema>;
export type PendingNote = z.infer<typeof pendingNoteSchema>;

const MAX_STATE_BYTES = 256 * 1024;

/** The default folder of the state files: `~/.tellagen/state`. */
export function defaultStateDir(): string {
  return join(tellagenHome(), "state");
}

/** A file name for the workspace of an API address, with no path characters. */
export function workspaceKey(apiUrl: string): string {
  let host = apiUrl;
  try {
    host = new URL(apiUrl).host;
  } catch {
    // Not a URL: fall through and clean the raw text.
  }
  const key = host
    .toLowerCase()
    .replace(/[^a-z0-9.-]+/g, "-")
    .replace(/\.{2,}/g, ".")
    .replace(/^[.-]+|[.-]+$/g, "")
    .slice(0, 120);
  return key || "default";
}

/** Whether a process with this id is alive on this computer. */
export function processAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM: the process exists and belongs to someone else.
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Reads and writes one workspace's state file. With no folder it does
 * nothing, so a client built without one (a test, an embedder) never touches
 * the home folder. No method throws: a state file is a convenience, and a
 * disk error must not fail a tool call.
 */
export class RunStateStore {
  private readonly path: string | undefined;

  constructor(
    private readonly dir: string | undefined,
    workspace: string,
  ) {
    this.path = dir ? join(dir, `${workspace}.json`) : undefined;
  }

  /** The file, for a message to a person. Undefined when nothing is stored. */
  filePath(): string | undefined {
    return this.path;
  }

  read(): RunState | undefined {
    if (!this.path) return undefined;
    try {
      const stat = lstatSync(this.path);
      // A link or a huge file is not a state file this server wrote.
      if (!stat.isFile() || stat.size > MAX_STATE_BYTES) return undefined;
      const parsed = runStateSchema.safeParse(JSON.parse(readFileSync(this.path, "utf8")));
      return parsed.success ? parsed.data : undefined;
    } catch {
      return undefined;
    }
  }

  write(state: RunState): boolean {
    if (!this.path || !this.dir) return false;
    const temp = `${this.path}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
    try {
      mkdirSync(this.dir, { recursive: true, mode: 0o700 });
      // "wx" refuses an existing file or link at the temporary name.
      writeFileSync(temp, `${JSON.stringify(runStateSchema.parse(state), null, 2)}\n`, {
        mode: 0o600,
        flag: "wx",
      });
      
      chmodSync(temp, 0o600);
      renameSync(temp, this.path);
      return true;
    } catch {
      try {
        rmSync(temp, { force: true });
      } catch {
        // Nothing to clean.
      }
      return false;
    }
  }

  /** Removes the file. With a run id, only when the file names that run. */
  clear(runId?: string): void {
    if (!this.path) return;
    try {
      if (runId !== undefined) {
        const current = this.read();
        if (current && current.run_id !== runId) return;
      }
      rmSync(this.path, { force: true });
    } catch {
      // The file stays; the next pickup overwrites it.
    }
  }

  /**
   * Adds notes that a recorder (a step hook) got from Tellagen, so the model
   * sees them in the next answer of the server. A note is kept once by its id.
   */
  addPendingNotes(runId: string, notes: PendingNote[]): void {
    const current = this.read();
    if (!current || current.run_id !== runId || notes.length === 0) return;
    const known = new Set((current.pending_notes ?? []).map((note) => String(note.id ?? "")));
    const fresh = notes.filter((note) => note.id === undefined || !known.has(String(note.id)));
    if (fresh.length === 0) return;
    this.write({ ...current, pending_notes: [...(current.pending_notes ?? []), ...fresh].slice(-50) });
  }

  /** Remembers a step that a hook recorded, so the model can add its outcome to it. */
  addRecordedStep(runId: string, step: { step_id: string; title: string; at?: string }): void {
    const current = this.read();
    if (!current || current.run_id !== runId) return;
    const others = (current.recorded_steps ?? []).filter((item) => item.step_id !== step.step_id);
    const entry = { step_id: step.step_id, title: step.title.slice(0, 200), at: step.at ?? new Date().toISOString() };
    this.write({ ...current, recorded_steps: [...others, entry].slice(-10) });
  }

  /** The steps a hook recorded for this run that have no update from the model yet. */
  recordedSteps(runId: string): Array<{ step_id: string; title: string; at: string }> {
    const current = this.read();
    return current && current.run_id === runId ? (current.recorded_steps ?? []) : [];
  }

  removeRecordedStep(runId: string, stepId: string): void {
    const current = this.read();
    if (!current || current.run_id !== runId || !current.recorded_steps?.some((item) => item.step_id === stepId)) return;
    this.write({ ...current, recorded_steps: current.recorded_steps.filter((item) => item.step_id !== stepId) });
  }

  /** Keeps the source addresses of a run. An empty list removes them. */
  setSourceBases(runId: string, bases: SourceBase[]): void {
    const current = this.read();
    if (!current || current.run_id !== runId) return;
    // A read that changes nothing writes nothing: a recorder may have touched the file.
    if (JSON.stringify(current.source_bases ?? []) === JSON.stringify(bases)) return;
    const { source_bases: _old, ...rest } = current;
    this.write(bases.length > 0 ? { ...rest, source_bases: bases } : rest);
  }

  /** Records that Tellagen ended the run or gave it to another client. */
  setStop(runId: string, reason: string, at = new Date().toISOString()): void {
    const current = this.read();
    if (!current || current.run_id !== runId) return;
    this.write({ ...current, stop: { reason: reason.slice(0, 300), at } });
  }

  /** Takes the stop a recorder left for this run. The file stays until the server clears the run. */
  takeStop(runId: string): { reason: string; at: string } | undefined {
    const current = this.read();
    if (!current || current.run_id !== runId || !current.stop) return undefined;
    return current.stop;
  }

  /** Takes the notes a recorder left for this run and removes them from the file. */
  takePendingNotes(runId: string): PendingNote[] {
    const current = this.read();
    if (!current || current.run_id !== runId || !current.pending_notes?.length) return [];
    const { pending_notes: notes, ...rest } = current;
    this.write(rest);
    return notes;
  }
}
