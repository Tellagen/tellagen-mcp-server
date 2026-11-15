/**
 * The time window of a run. When the client lists `investigation_window_v1`
 * at pickup, Tellagen puts `request.context.window` in the bundle: the span
 * in which to look for the cause, and a baseline before it that is only for
 * "is this number normal". The window is stored when the run is created, so it
 * does not change while the run works.
 *
 * This module reads the window from a pickup or context answer, remembers it
 * for the run, writes it at the top of the pickup answer, and gives the
 * default range of a link or a figure. A client sends `window_suggestion`
 * with its result when the real signal lies outside the window.
 */

export const INVESTIGATION_WINDOW_CAPABILITY = "investigation_window_v1";
export const QUESTION_CHECKS_CAPABILITY = "question_checks_v1";

/** The longest reason of a window suggestion, as Tellagen counts it. */
export const WINDOW_SUGGESTION_REASON_MAX = 200;
/** The longest span of a window or a suggestion. */
export const WINDOW_MAX_DAYS = 30;

export type RunWindow = {
  from: string;
  /** Left out: the incident is open, so the window runs until now. */
  to?: string;
  basis?: string;
  baseline_from?: string;
  first_signal_at?: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** An RFC 3339 time as an ISO string, or undefined. The Go zero time is no time. */
function instant(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const at = Date.parse(value);
  if (!Number.isFinite(at) || at < Date.UTC(2000, 0, 1)) return undefined;
  return new Date(at).toISOString();
}

/**
 * The window of a pickup or context answer. Tellagen puts it in
 * `request.context.window`; a bare `context.window` and a top-level `window`
 * are read too. A window with no usable start is no window.
 */
export function windowOf(data: unknown): RunWindow | undefined {
  if (!isRecord(data)) return undefined;
  const request = isRecord(data.request) ? data.request : undefined;
  const raw = [request?.context, data.context, data]
    .map((holder) => (isRecord(holder) ? holder.window : undefined))
    .find(isRecord);
  if (!raw) return undefined;
  const from = instant(raw.from);
  if (!from) return undefined;
  const window: RunWindow = { from };
  const to = instant(raw.to);
  if (to) window.to = to;
  if (typeof raw.basis === "string" && /^[a-z_]{1,40}$/.test(raw.basis)) window.basis = raw.basis;
  const baseline = instant(raw.baseline_from);
  if (baseline) window.baseline_from = baseline;
  const signal = instant(raw.first_signal_at);
  if (signal) window.first_signal_at = signal;
  return window;
}

const windows = new WeakMap<object, Map<string, RunWindow | null>>();

/**
 * Remembers the window of a run from a pickup or context answer. An answer
 * with no window (an older Tellagen, a run made before windows) is
 * remembered as "none", so a later call does not ask again.
 */
export function rememberRunWindow(owner: object, runId: string, response: unknown): void {
  if (!isRecord(response)) return;
  let map = windows.get(owner);
  if (!map) {
    map = new Map();
    windows.set(owner, map);
  }
  map.set(runId, windowOf(response) ?? null);
}

/** The window this process saw for the run; undefined when it saw none. */
export function knownRunWindow(owner: object, runId: string | undefined): RunWindow | undefined {
  if (runId === undefined) return undefined;
  return windows.get(owner)?.get(runId) ?? undefined;
}

/** True when the process has read an answer for the run, with or without a window. */
export function runWindowKnown(owner: object, runId: string): boolean {
  return windows.get(owner)?.has(runId) ?? false;
}

/** The end of the window as a time, `now` for an open one. */
export function windowEnd(window: RunWindow, now: Date = new Date()): string {
  return window.to ?? now.toISOString();
}

export const WINDOW_RULES = [
  "Search for the cause inside this window: every query that looks for what went wrong uses a range between from and to.",
  "Use the baseline only to learn whether a number is normal, for example the count of the same hour on earlier days. Never look for the cause in it.",
  "When the signal starts before from or after to, do not search outside the window. Send window_suggestion {from, to, reason} with the result (reason at most 200 characters) and say so in a finding.",
];

/**
 * The note that goes at the top of a pickup answer: the window in plain
 * words, and the three rules. The key is first in the object so a client that
 * shows only the start of the answer still shows it.
 */
export function windowNote(window: RunWindow): Record<string, unknown> {
  const end = window.to ?? "now (the incident is open, so the window runs until the run ends)";
  const note: Record<string, unknown> = {
    search_from: window.from,
    search_to: end,
    ...(window.basis ? { basis: window.basis } : {}),
    ...(window.baseline_from
      ? { baseline_from: window.baseline_from, baseline_to: window.from, baseline_use: "counts only: is this number normal" }
      : { baseline: "none" }),
    ...(window.first_signal_at ? { first_signal_at: window.first_signal_at } : {}),
    rules: WINDOW_RULES,
  };
  return note;
}

/** A pickup answer with the window note first. An answer with no window is returned as it is. */
export function withWindowNote(data: unknown): unknown {
  if (!isRecord(data)) return data;
  const window = windowOf(data);
  if (!window) return data;
  return { mcp_window: windowNote(window), ...data };
}

/** The window suggestion of a result, as the guide shows it. */
export function suggestionProblem(
  suggestion: { from: string; to?: string; reason: string },
  now: Date = new Date(),
): string | undefined {
  const from = Date.parse(suggestion.from);
  if (!Number.isFinite(from)) return "from is not a time";
  if (from > now.getTime() + 60_000) return "from is in the future";
  const to = suggestion.to === undefined ? now.getTime() : Date.parse(suggestion.to);
  if (!Number.isFinite(to)) return "to is not a time";
  if (from >= to) return "from must be before to";
  if (to - from > WINDOW_MAX_DAYS * 86_400_000) return `the span is more than ${WINDOW_MAX_DAYS} days`;
  return undefined;
}
