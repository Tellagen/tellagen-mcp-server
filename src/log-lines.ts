/**
 * Builds the lines of a `log_lines` figure from the result of a Loki query.
 *
 * The figure shows the log lines that prove a claim, or the proof that there
 * are none: how many lines matched out of how many were scanned, in what
 * range, and at most 8 of the matches, each with a time, a level, the text as
 * logged and a relation to the event. This module only reshapes what a tool
 * returned. It never writes a line, a count or a time of its own, and a line
 * it cannot read is reported by name, not guessed.
 *
 * Two result shapes are read:
 *   - the Loki HTTP API: streams of `{stream: {labels}, values: [[ns, line]]}`;
 *   - a flat list of entries `{timestamp, line, labels}`, as the Grafana MCP
 *     server and most log tools return.
 */
import { createHash } from "node:crypto";
import { isPairNameKey, isPairValueKey, isSecretKey, redactLogText } from "./redact.js";

export const MAX_LOG_LINES = 8;
export const MAX_LOG_TEXT = 500;
export const MAX_LOG_NOTE = 160;
export const MAX_LOG_FIELDS = 6;
export const MAX_LOG_FIELD_KEY = 40;
export const MAX_LOG_FIELD_VALUE = 200;
export const MAX_LOG_COUNT = 1_000_000_000;
/** The most of one raw line that is read. The rest is dropped and never sent. */
export const MAX_LOG_INPUT_LINE = 8192;
/** The most of one label value that is read. */
export const MAX_LOG_INPUT_LABEL = 1000;
/** The most entries of a result that are read. */
export const MAX_LOG_INPUT_ENTRIES = 5000;

export type LogLevel = "error" | "warn" | "info" | "debug" | "other";
export type LogRelation = "matches_event" | "context" | "unrelated";

export type LogLine = {
  time: string;
  level: LogLevel;
  text: string;
  fields?: Record<string, string>;
  relation?: LogRelation;
  note?: string;
};

/** One line of a query result, before it is shaped. */
export type LogEntry = {
  at: number;
  line: string;
  labels: Record<string, string>;
  /** The line was longer than MAX_LOG_INPUT_LINE and its end was dropped. */
  cut?: boolean;
};

/** A rule of the agent: a line that holds this text or this field is marked. */
export type LogMark = {
  contains?: string;
  field?: { key: string; value: string };
  relation: LogRelation;
  note?: string;
};

export type LogLinesSelection = {
  lines: LogLine[];
  total: number;
  notes: string[];
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/* ------------------------------------------------------------------ */
/* Times                                                              */
/* ------------------------------------------------------------------ */

/**
 * A time as milliseconds since the epoch. Loki sends nanoseconds as a digit
 * string; other tools send an RFC 3339 time or a number of seconds,
 * milliseconds, microseconds or nanoseconds. Undefined when it is none of
 * these.
 */
export function logTimeMs(value: unknown): number | undefined {
  if (typeof value === "number") {
    if (!Number.isFinite(value) || value <= 0) return undefined;
    return unitMs(Math.trunc(value).toString());
  }
  if (typeof value !== "string") return undefined;
  const text = value.trim();
  if (/^\d{9,20}$/.test(text)) return unitMs(text);
  const at = Date.parse(text);
  return Number.isFinite(at) && at > Date.UTC(2000, 0, 1) ? at : undefined;
}

function unitMs(digits: string): number | undefined {
  // Digits count: 10 seconds, 13 milliseconds, 16 microseconds, 19 nanoseconds.
  const n = digits.length;
  let ms: number;
  if (n <= 11) ms = Number(digits) * 1000;
  else if (n <= 14) ms = Number(digits);
  else if (n <= 17) ms = Number(digits) / 1000;
  else ms = Number(digits.slice(0, digits.length - 6));
  return Number.isFinite(ms) && ms > Date.UTC(2000, 0, 1) ? Math.trunc(ms) : undefined;
}

/* ------------------------------------------------------------------ */
/* Reading a result                                                   */
/* ------------------------------------------------------------------ */

function labelsOf(value: unknown): Record<string, string> {
  if (!isRecord(value)) return {};
  const out: Record<string, string> = {};
  for (const [key, item] of Object.entries(value)) {
    if (typeof item === "string") out[key] = item;
    else if (typeof item === "number" || typeof item === "boolean") out[key] = String(item);
  }
  return out;
}

/**
 * The entries of a query result. `streams` holds Loki streams (or the whole
 * Loki response), `entries` a flat list. Problems name the place in the input.
 */
export function readLogEntries(input: { streams?: unknown; entries?: unknown }): {
  entries: LogEntry[];
  issues: string[];
  /** Valid values beyond MAX_LOG_INPUT_ENTRIES that were counted but not kept. */
  overflow: number;
} {
  let overflow = 0;
  const entries: LogEntry[] = [];
  const issues: string[] = [];
  const push = (at: number, line: string, labels: Record<string, string>) => {
    if (entries.length >= MAX_LOG_INPUT_ENTRIES) {
      overflow += 1;
      return;
    }
    const cut = line.length > MAX_LOG_INPUT_LINE;
    const capped = Object.fromEntries(
      Object.entries(labels).map(([k, v]) => [k.slice(0, 200), v.slice(0, MAX_LOG_INPUT_LABEL)]),
    );
    entries.push({ at, line: cut ? line.slice(0, MAX_LOG_INPUT_LINE) : line, labels: capped, ...(cut ? { cut: true } : {}) });
  };

  let streams = input.streams;
  if (isRecord(streams)) {
    // The whole body of a Loki response: {status, data: {resultType, result: [...]}}.
    const data = isRecord(streams.data) ? streams.data : streams;
    streams = data.result;
  }
  if (streams !== undefined) {
    if (!Array.isArray(streams)) {
      issues.push("streams: send the streams array of the Loki result (each {stream, values: [[time, line]]}).");
    } else {
      streams.forEach((stream, s) => {
        if (!isRecord(stream) || !Array.isArray(stream.values)) {
          issues.push(`streams.${s}: send {stream: {labels}, values: [[time, line]]}.`);
          return;
        }
        const labels = labelsOf(stream.stream ?? stream.labels ?? stream.metric);
        stream.values.forEach((pair, v) => {
          if (!Array.isArray(pair) || typeof pair[1] !== "string") {
            issues.push(`streams.${s}.values.${v}: send [time, line] with the line as a string.`);
            return;
          }
          const at = logTimeMs(pair[0]);
          if (at === undefined) {
            issues.push(
              `streams.${s}.values.${v}: the time "${String(pair[0]).slice(0, 40)}" is not a time. Send the nanosecond string or an RFC 3339 time as the query returned it.`,
            );
            return;
          }
          push(at, pair[1], labels);
        });
      });
    }
  }

  if (input.entries !== undefined) {
    if (!Array.isArray(input.entries)) {
      issues.push("entries: send the list of log entries, each {timestamp, line, labels}.");
    } else {
      input.entries.forEach((entry, i) => {
        if (!isRecord(entry)) {
          issues.push(`entries.${i}: send {timestamp, line, labels}.`);
          return;
        }
        const text = [entry.line, entry.text, entry.message, entry.body, entry.log].find((x) => typeof x === "string");
        if (typeof text !== "string") {
          issues.push(`entries.${i}: send the line as a string in line.`);
          return;
        }
        const when = entry.timestamp ?? entry.time ?? entry.ts ?? entry.t ?? entry.Timestamp;
        const at = logTimeMs(when);
        if (at === undefined) {
          issues.push(
            `entries.${i}: the time "${String(when).slice(0, 40)}" is not a time. Send the timestamp as the query returned it.`,
          );
          return;
        }
        push(at, text, labelsOf(entry.labels ?? entry.stream ?? entry.fields));
      });
    }
  }
  return { entries, issues, overflow };
}

// ANSI colour and cursor sequences, which a terminal log may carry.
// eslint-disable-next-line no-control-regex
const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]/g;
/* ------------------------------------------------------------------ */
/* Level                                                              */
/* ------------------------------------------------------------------ */

const LEVEL_KEYS = [
  "level",
  "lvl",
  "severity",
  "loglevel",
  "log_level",
  "levelname",
  "detected_level",
  "severity_text",
];
const TIME_KEYS = new Set(["time", "ts", "timestamp", "t", "@timestamp", "datetime", "date"]);
const MESSAGE_KEYS = new Set(["msg", "message", "log", "body", "text"]);

/** A level word as one of the five levels; undefined when it is not a level word. */
export function levelWord(word: unknown): LogLevel | undefined {
  if (typeof word === "number") {
    // Syslog severity 0 to 7, and the pino levels 10 to 60.
    if (word >= 0 && word <= 3) return "error";
    if (word === 4) return "warn";
    if (word === 5 || word === 6) return "info";
    if (word === 7) return "debug";
    if (word >= 10 && word <= 60) return word >= 50 ? "error" : word === 40 ? "warn" : word === 30 ? "info" : "debug";
    return undefined;
  }
  if (typeof word !== "string") return undefined;
  const w = word.trim().toLowerCase();
  if (["error", "err", "fatal", "critical", "crit", "panic", "alert", "emerg", "emergency", "severe"].includes(w)) return "error";
  if (["warn", "warning"].includes(w)) return "warn";
  if (["info", "information", "notice"].includes(w)) return "info";
  if (["debug", "trace", "verbose", "dbg"].includes(w)) return "debug";
  if (/^\d+$/.test(w)) return levelWord(Number(w));
  return undefined;
}

const LEADING_LEVEL =
  /^[\s[(<]*(?:\d{4}[-/]\d{2}[-/]\d{2}[T ][\d:.,]+(?:Z|[+-]\d{2}:?\d{2})?[\s\])>:|-]*)?[[(<]?(ERROR|ERR|WARN(?:ING)?|INFO|DEBUG|TRACE|FATAL|CRITICAL|PANIC)\b/i;
const LOGFMT_LEVEL = /(?:^|\s)(?:level|lvl|severity|loglevel)=("?)([A-Za-z0-9]+)\1(?=\s|$)/;

/** The JSON object a line holds, or undefined. */
export function parseJsonLine(line: string): Record<string, unknown> | undefined {
  const text = line.trim();
  if (!text.startsWith("{") || !text.endsWith("}")) return undefined;
  try {
    const value = JSON.parse(text) as unknown;
    return isRecord(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

/** The key=value pairs of a logfmt line. Quoted values lose their quotes. */
export function parseLogfmt(line: string): Record<string, string> | undefined {
  if (!/(?:^|\s)[A-Za-z_][\w.-]*=/.test(line)) return undefined;
  const out: Record<string, string> = {};
  const pattern = /(?:^|\s)([A-Za-z_][\w.-]*)=(?:"((?:[^"\\]|\\.)*)"|(\S*))/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(line)) !== null) {
    const key = match[1];
    if (!(key in out)) out[key] = match[2] !== undefined ? match[2].replace(/\\(.)/g, "$1") : (match[3] ?? "");
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * The level of a line. A level label of the stream wins, then a level in the
 * JSON or logfmt of the line, then a level word at the start of the text.
 * Anything else is `other`.
 */
export function levelOfEntry(entry: LogEntry): LogLevel {
  for (const key of LEVEL_KEYS) {
    const found = levelWord(entry.labels[key]);
    if (found) return found;
  }
  // Colour codes in front of a level word must not hide it.
  const text = entry.line.replace(ANSI, "");
  const json = parseJsonLine(text);
  if (json) {
    for (const key of LEVEL_KEYS) {
      const found = levelWord(json[key]);
      if (found) return found;
    }
    const nested = isRecord(json.log) ? levelWord(json.log.level) : undefined;
    if (nested) return nested;
  } else {
    const logfmt = LOGFMT_LEVEL.exec(text);
    if (logfmt) {
      const found = levelWord(logfmt[2]);
      if (found) return found;
    }
  }
  const lead = LEADING_LEVEL.exec(text);
  if (lead) {
    const found = levelWord(lead[1]);
    if (found) return found;
  }
  return "other";
}

/* ------------------------------------------------------------------ */
/* Text and fields                                                    */
/* ------------------------------------------------------------------ */

// Control characters the Tellagen API refuses in log text (tabs are allowed).
// eslint-disable-next-line no-control-regex
const TEXT_CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u2028\u2029\u200e\u200f\u202a-\u202e\u2066-\u2069]/g;

const TEXT_CONTROL_ONE = new RegExp(TEXT_CONTROL.source);

/**
 * The text of a line for the figure: ANSI sequences out, line breaks turned
 * into a visible mark, secrets masked and other control characters out. A text
 * over 500 characters is cut with an ellipsis. `what` names each change.
 */
export function cleanLogText(line: string, options: { masked?: boolean } = {}): { text: string; what: string[] } {
  const what: string[] = [];
  // The input is cut first, so the redaction cost is bounded by the input limit and not by the line.
  const input = line.length > MAX_LOG_INPUT_LINE ? line.slice(0, MAX_LOG_INPUT_LINE) : line;
  let text = input.replace(ANSI, "");
  if (text !== input) what.push("terminal colour codes removed");
  // Redaction runs once, on the raw line, so a value on the next line is still found.
  if (options.masked !== true) {
    const masked = redactLogText(text);
    if (masked !== text) what.push("secrets masked");
    text = masked;
  } else if (text.includes("[redacted]")) {
    what.push("secrets masked");
  }
  const flat = text.replace(/\r?\n|\r/g, " \u23ce ");
  if (flat !== text) what.push("line breaks shown as \u23ce");
  text = flat;
  const clean = text.replace(TEXT_CONTROL, " ");
  if (clean !== text) what.push("control characters removed");
  text = clean.trimEnd();
  const chars = [...text];
  if (chars.length > MAX_LOG_TEXT) {
    text = chars.slice(0, MAX_LOG_TEXT - 1).join("") + "\u2026";
    what.push(`cut at ${MAX_LOG_TEXT} characters`);
  }
  return { text, what };
}

const NOISY_LABELS =
  /^(?:__.*|filename|detected_level|level|lvl|severity|loglevel|log_level|levelname|severity_text|service_name|job)$/;

function scalar(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  // A whole number the parser cannot hold exactly would differ from the line: leave it out.
  if (typeof value === "number") return Number.isInteger(value) && !Number.isSafeInteger(value) ? undefined : String(value);
  if (typeof value === "boolean") return String(value);
  return undefined;
}

/** All the fields a line offers, in order: those of its JSON or logfmt first, then its stream labels. */
function candidateFields(raw: LogEntry, masked = false): Array<[string, string]> {
  // Fields come only from what is left after redaction: a key that sits inside a
  // masked header or phrase is gone from the line, so it can never become a field.
  const entry: LogEntry = masked
    ? raw
    : {
        ...raw,
        line: redactLogText(raw.line.slice(0, MAX_LOG_INPUT_LINE).replace(ANSI, "")),
        labels: Object.fromEntries(Object.entries(raw.labels).map(([k, v]) => [k, redactLogText(v)])),
      };
  const out: Array<[string, string]> = [];
  const own = (key: string) => {
    const k = key.toLowerCase();
    return !(TIME_KEYS.has(k) || MESSAGE_KEYS.has(k) || LEVEL_KEYS.includes(k));
  };
  const parsed = parseJsonLine(entry.line);
  if (parsed) {
    for (const [key, value] of Object.entries(parsed)) {
      if (!own(key)) continue;
      const text = scalar(value);
      if (text !== undefined) out.push([key, text]);
    }
  } else {
    const logfmt = parseLogfmt(entry.line);
    if (logfmt) {
      for (const [key, value] of Object.entries(logfmt)) {
        if (own(key)) out.push([key, value]);
      }
    }
  }
  if (entry.cut) {
    // The end of the line was dropped: its last pair may be cut, and a value whose name was cut off
    // looks harmless. Take no pair value and not the last pair.
    const kept = out.slice(0, -1).filter(([key]) => !isPairValueKey(key));
    out.length = 0;
    out.push(...kept);
  }
  for (const [key, value] of Object.entries(entry.labels)) {
    if (!NOISY_LABELS.test(key)) out.push([key, value]);
  }
  // A secret logged as a name and a value: the name says it, so the paired value is not shown.
  if (out.some(([key, value]) => isPairNameKey(key) && isSecretKey(value))) {
    return out.filter(([key]) => !isPairValueKey(key));
  }
  return out;
}

/**
 * The fields of one line. With `wanted` it takes those keys, in that order.
 * Without it, the fields of the line itself first and then the stream labels,
 * at most six. A value over 200 characters is left out, never cut.
 */
export function fieldsOfEntry(entry: LogEntry, wanted?: string[], masked = false): Record<string, string> | undefined {
  const all = candidateFields(entry, masked);
  const seen = new Set<string>();
  const picked: Array<[string, string]> = [];
  // A field the API would refuse is left out or cleaned, never the reason the figure fails.
  const shape = ([rawKey, rawValue]: [string, string]): [string, string] | undefined => {
    const key = rawKey.trim();
    if (key === "" || [...key].length > MAX_LOG_FIELD_KEY || TEXT_CONTROL_ONE.test(key) || /[\t\r\n]/.test(key)) return undefined;
    // A field named token, password, secret or the like never leaves this computer.
    if (isSecretKey(key)) return undefined;
    const cleaned = rawValue.replace(ANSI, "");
    // The field rule is never weaker than the text rule: a pair the text rule would mask is not a field.
    if (redactLogText(`${key}=${cleaned}`) !== `${key}=${redactLogText(cleaned)}`) return undefined;
    const value = redactLogText(cleaned.replace(/\r?\n|\r|\t/g, " ").replace(TEXT_CONTROL, " ")).trim();
    if (value === "" || value.includes("[redacted") || [...value].length > MAX_LOG_FIELD_VALUE) return undefined;
    return [key, value];
  };
  const candidates =
    wanted && wanted.length > 0
      ? wanted.flatMap((key) => {
          const hit = all.find(([k]) => k === key);
          return hit ? [hit] : [];
        })
      : all;
  for (const pair of candidates) {
    if (picked.length >= MAX_LOG_FIELDS) break;
    const shaped = shape(pair);
    if (!shaped || seen.has(shaped[0])) continue;
    seen.add(shaped[0]);
    picked.push(shaped);
  }
  if (picked.length === 0) return undefined;
  return Object.fromEntries(picked);
}

/* ------------------------------------------------------------------ */
/* Choosing the lines                                                 */
/* ------------------------------------------------------------------ */

const LEVEL_RANK: Record<LogLevel, number> = { error: 0, warn: 1, other: 2, info: 3, debug: 4 };

type Shaped = {
  what: string[];
  entry: LogEntry;
  line: LogLine;
  tier: number;
};

function markOf(entry: LogEntry, marks: LogMark[]): LogMark | undefined {
  const lower = entry.line.toLowerCase();
  return marks.find((mark) => {
    if (mark.contains === undefined && mark.field === undefined) return false;
    if (mark.contains !== undefined && !lower.includes(mark.contains.toLowerCase())) return false;
    if (mark.field !== undefined) {
      const parsed = parseJsonLine(entry.line);
      const logfmt = parsed ? undefined : parseLogfmt(entry.line);
      const fromLine = parsed ? scalar(parsed[mark.field.key]) : logfmt?.[mark.field.key];
      const value = fromLine ?? entry.labels[mark.field.key];
      if (value !== mark.field.value) return false;
    }
    return true;
  });
}

/**
 * Chooses at most 8 lines and shapes each one. The order is: lines that show
 * the event (those that hold a `match` term or are marked matches_event), then
 * lines marked unrelated (a line that looks like proof and is not must stay
 * visible), then lines marked context, then the rest by level, errors first.
 * Inside a group the lines closest to `eventAt` come first when it is given,
 * else the earliest; the chosen lines are then shown in time order inside
 * their group. The same line at the same time is never shown twice.
 */
export function selectLogLines(
  entries: LogEntry[],
  options: { match?: string[]; marks?: LogMark[]; fieldKeys?: string[]; eventAt?: number; limit?: number },
): LogLinesSelection {
  const limit = Math.min(options.limit ?? MAX_LOG_LINES, MAX_LOG_LINES);
  const terms = (options.match ?? []).map((t) => t.toLowerCase()).filter((t) => t !== "");
  const marks = options.marks ?? [];
  const notes: string[] = [];
  const changes = new Set<string>();

  const seenLines = new Set<string>();
  // Rank on the raw entries (cheap, local), then clean and redact only the lines that are shown.
  const ranked: Array<{ entry: LogEntry; level: LogLevel; mark: LogMark | undefined; relation: LogRelation | undefined; tier: number }> = [];
  for (const entry of entries) {
    const identity = `${entry.at}\u0000${createHash("sha1").update(entry.line).digest("hex")}\u0000${JSON.stringify(entry.labels)}`;
    if (seenLines.has(identity)) continue;
    seenLines.add(identity);
    if (entry.line.replace(ANSI, "").trim() === "") continue;
    const level = levelOfEntry(entry);
    const mark = markOf(entry, marks);
    const termHit = terms.some((term) => entry.line.toLowerCase().includes(term));
    let relation: LogRelation | undefined = mark?.relation;
    if (relation === undefined && termHit) relation = "matches_event";
    const tier =
      relation === "matches_event" ? 0 : relation === "unrelated" ? 1 : relation === "context" ? 2 : 3 + LEVEL_RANK[level];
    ranked.push({ entry, level, mark, relation, tier });
  }
  const distanceOf = (r: { entry: LogEntry }) =>
    options.eventAt === undefined ? r.entry.at : Math.abs(r.entry.at - options.eventAt);
  ranked.sort((a, b) => a.tier - b.tier || distanceOf(a) - distanceOf(b) || a.entry.at - b.entry.at);
  const shaped: Shaped[] = [];
  for (const r of ranked.slice(0, limit)) {
    // One redaction of the capped line serves the text and the fields.
    const maskedLine = redactLogText(r.entry.line.replace(ANSI, ""));
    const cleaned = cleanLogText(maskedLine, { masked: true });
    if (r.entry.line.replace(ANSI, "") !== r.entry.line) cleaned.what.unshift("terminal colour codes removed");
    const line: LogLine = { time: new Date(r.entry.at).toISOString(), level: r.level, text: cleaned.text };
    const masked: LogEntry = {
      ...r.entry,
      line: maskedLine,
      labels: Object.fromEntries(Object.entries(r.entry.labels).map(([k, v]) => [k, redactLogText(v)])),
    };
    const fields = fieldsOfEntry(masked, options.fieldKeys, true);
    if (fields) line.fields = fields;
    if (r.relation) line.relation = r.relation;
    if (r.mark?.note) line.note = r.mark.note.trim();
    else if (r.entry.cut) line.note = "The line was longer than 8 KiB; the rest was not read or sent.";
    shaped.push({ entry: r.entry, line, tier: r.tier, what: cleaned.what });
  }

  const chosen = shaped;
  chosen.sort((a, b) => a.tier - b.tier || a.entry.at - b.entry.at);
  for (const item of chosen) for (const change of item.what) changes.add(change);
  if (changes.size > 0) notes.push(`Log text was cleaned: ${[...changes].join("; ")}.`);
  return { lines: chosen.map((s) => s.line), total: ranked.length, notes };
}

/** A figure's relation counts, for the one-line summary. */
export function relationCounts(lines: LogLine[]): {
  matches_event: number;
  context: number;
  unrelated: number;
  unmarked: number;
} {
  const counts = { matches_event: 0, context: 0, unrelated: 0, unmarked: 0 };
  for (const line of lines) {
    if (line.relation) counts[line.relation] += 1;
    else counts.unmarked += 1;
  }
  return counts;
}
