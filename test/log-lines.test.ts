import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { buildFigure, validateBlock } from "../src/figures.js";
import { redactLogText } from "../src/redact.js";
import { stepFigureSchema } from "../src/diagnosis-structure.js";
import {
  cleanLogText,
  levelOfEntry,
  levelWord,
  logTimeMs,
  parseLogfmt,
  readLogEntries,
  selectLogLines,
} from "../src/log-lines.js";

const here = dirname(fileURLToPath(import.meta.url));
// A Loki result in the shapes of a real diagnosis run, with made-up values.
const loki = JSON.parse(readFileSync(join(here, "fixtures", "log-lines", "loki-result.json"), "utf8")) as unknown;
const rejected = JSON.parse(
  readFileSync(join(here, "..", "contracts", "runbooks", "v2", "fixtures", "timeline-event-blocks-rejected.json"), "utf8"),
) as { cases: Array<{ name: string; blocks: Array<Record<string, unknown>>; field: string; message: string }> };

const EVENT_AT = "2026-11-14T00:41:00Z";
const base = {
  type: "log_lines",
  title: "Errors from the billing worker",
  query: '{app="billing-worker"} |= "failed"',
  datasource: "loki",
  from: "2026-11-14T00:11:00Z",
  to: "2026-11-14T01:26:00Z",
  event_at: EVENT_AT,
  scanned: 2313,
  streams: loki,
};

const build = (figure: Record<string, unknown>, extra: Record<string, unknown> = {}, placement: "step_figure" | "timeline_block" = "step_figure") =>
  buildFigure({ placement, figure: { ...base, ...figure }, ...extra }, { logLines: true });

describe("reading a query result", () => {
  it("reads the whole Loki response, the streams array and a flat list of entries", () => {
    const whole = readLogEntries({ streams: loki });
    const bare = readLogEntries({ streams: (loki as { data: { result: unknown } }).data.result });
    expect(whole.issues).toEqual([]);
    expect(whole.entries).toHaveLength(6);
    expect(bare.entries).toEqual(whole.entries);
    const flat = readLogEntries({
      entries: [{ timestamp: "2026-11-14T00:42:00Z", line: "level=warn msg=slow", labels: { app: "x" } }],
    });
    expect(flat.entries).toEqual([{ at: Date.parse("2026-11-14T00:42:00Z"), line: "level=warn msg=slow", labels: { app: "x" } }]);
  });

  it("names the place of a line it cannot read", () => {
    const result = readLogEntries({
      streams: [{ stream: {}, values: [["not a time", "x"], ["1794616920000000000", 5]] }],
      entries: [{ timestamp: "2026-11-14T00:42:00Z" }],
    });
    expect(result.entries).toEqual([]);
    expect(result.issues[0]).toContain("streams.0.values.0");
    expect(result.issues[1]).toContain("streams.0.values.1");
    expect(result.issues[2]).toContain("entries.0");
  });

  it("reads times in seconds, milliseconds, microseconds and nanoseconds", () => {
    const at = Date.parse("2026-11-14T00:42:00Z");
    expect(logTimeMs("1794616920")).toBe(at);
    expect(logTimeMs(1794616920000)).toBe(at);
    expect(logTimeMs("1794616920000000")).toBe(at);
    expect(logTimeMs("1794616920000000000")).toBe(at);
    expect(logTimeMs("2026-11-14T00:42:00Z")).toBe(at);
    expect(logTimeMs("tomorrow")).toBeUndefined();
    expect(logTimeMs("")).toBeUndefined();
  });
});

describe("the level of a line", () => {
  const entry = (line: string, labels: Record<string, string> = {}) => ({ at: 1, line, labels });
  it("reads a label, JSON, logfmt and a leading word, in that order", () => {
    expect(levelOfEntry(entry("anything", { detected_level: "warn" }))).toBe("warn");
    expect(levelOfEntry(entry('{"level":"error","msg":"x"}', { level: "info" }))).toBe("info");
    expect(levelOfEntry(entry('{"severity":"CRITICAL"}'))).toBe("error");
    expect(levelOfEntry(entry('{"log":{"level":"debug"}}'))).toBe("debug");
    expect(levelOfEntry(entry('{"level":40}'))).toBe("warn");
    expect(levelOfEntry(entry('ts=1 level=warning msg="slow"'))).toBe("warn");
    expect(levelOfEntry(entry("2026-11-14T00:40:00Z INFO scheduler tick"))).toBe("info");
    expect(levelOfEntry(entry("[ERROR] export failed"))).toBe("error");
    expect(levelOfEntry(entry("something happened"))).toBe("other");
    expect(levelOfEntry(entry("level=weird"))).toBe("other");
  });
  it("maps the common words", () => {
    expect(["fatal", "panic", "err", "crit"].map(levelWord)).toEqual(["error", "error", "error", "error"]);
    expect(["Warning", "notice", "TRACE", "unknown"].map(levelWord)).toEqual(["warn", "info", "debug", undefined]);
  });
  it("reads logfmt values with quotes", () => {
    expect(parseLogfmt('a=1 b="two words" c=')).toEqual({ a: "1", b: "two words", c: "" });
    expect(parseLogfmt("no pairs here")).toBeUndefined();
  });
});

describe("the text of a line", () => {
  it("removes colour codes, shows line breaks, masks secrets and cuts a long text", () => {
    const cleaned = cleanLogText("\u001b[31mERROR\u001b[0m failed\nat run.go:12 token=abc123def456ghi789");
    expect(cleaned.text).toBe("ERROR failed ⏎ at run.go:12 token=[redacted]");
    expect(cleaned.what).toEqual(["terminal colour codes removed", "secrets masked", "line breaks shown as ⏎"]);
    const long = cleanLogText("x".repeat(600));
    expect([...long.text]).toHaveLength(500);
    expect(long.text.endsWith("…")).toBe(true);
    expect(long.what).toEqual(["cut at 500 characters"]);
  });
  it("keeps a tab and the indentation", () => {
    expect(cleanLogText("  \tindented").text).toBe("  \tindented");
  });
});

describe("choosing the lines", () => {
  const entries = readLogEntries({ streams: loki }).entries;

  it("puts the lines that show the event first, then unrelated, then the rest by level", () => {
    const { lines, total } = selectLogLines(entries, {
      match: ["invoice_sync"],
      marks: [{ field: { key: "company_id", value: "578" }, relation: "unrelated", note: "Company 578, 11 hours before the event" }],
      eventAt: Date.parse(EVENT_AT),
    });
    expect(total).toBe(6);
    expect(lines.map((l) => l.relation)).toEqual([
      "matches_event",
      "matches_event",
      "matches_event",
      "unrelated",
      undefined,
      undefined,
    ]);
    expect(lines[3]).toMatchObject({ note: "Company 578, 11 hours before the event", level: "error" });
    // The rest: the error line (the export) before the info line.
    expect(lines[4]!.level).toBe("error");
    expect(lines[5]!.level).toBe("info");
  });

  it("keeps at most 8 lines and never the same line twice", () => {
    const many = Array.from({ length: 20 }, (_, i) => ({ at: 1_794_010_920_000 + i * 1000, line: `level=error n=${i}`, labels: {} }));
    const { lines, total } = selectLogLines([...many, ...many], {});
    expect(total).toBe(20);
    expect(lines).toHaveLength(8);
  });

  it("takes fields from the line first and the labels after, at most six, and leaves a long value out", () => {
    const first = selectLogLines(entries, { match: ["invoice_sync"] }).lines.find((l) => l.fields?.company_id === "412");
    expect(first!.fields).toMatchObject({ task: "invoice_sync", company_id: "412", error: "context deadline exceeded", app: "billing-worker" });
    expect(Object.keys(first!.fields!).length).toBeLessThanOrEqual(6);
    const long = selectLogLines([{ at: 1_794_010_920_000, line: JSON.stringify({ level: "info", note: "y".repeat(300), ok: "yes" }), labels: {} }], {});
    expect(long.lines[0]!.fields).toEqual({ ok: "yes" });
  });

  it("takes the fields the agent names, in order", () => {
    const { lines } = selectLogLines(entries, { match: ["invoice_sync"], fieldKeys: ["error", "task"] });
    expect(Object.keys(lines[0]!.fields!)).toEqual(["error", "task"]);
  });
});

describe("tellagen_build_figure for log_lines", () => {
  it("builds a figure that the step figure schema and the API rules accept", () => {
    const result = build({
      match: ["invoice_sync"],
      marks: [{ field: { key: "company_id", value: "578" }, relation: "unrelated", note: "Company 578, 11 hours before the event" }],
    });
    expect(result.ok, result.ok ? "" : result.issues.join("; ")).toBe(true);
    if (!result.ok) return;
    const block = result.block as { matched: number; scanned: number; lines: unknown[]; source: Record<string, string>; lines_not_shown?: number };
    expect(block.matched).toBe(6);
    expect(block.scanned).toBe(2313);
    expect(block.lines).toHaveLength(6);
    expect(block.lines_not_shown).toBeUndefined();
    expect(block.source).toEqual({
      query: '{app="billing-worker"} |= "failed"',
      datasource: "loki",
      kind: "logql",
      from: "2026-11-14T00:11:00Z",
      to: "2026-11-14T01:26:00Z",
    });
    expect(stepFigureSchema.safeParse(result.block).success).toBe(true);
    expect(validateBlock(result.block)).toEqual([]);
    expect(result.summary).toBe("log_lines: 6 lines matched of 2313 scanned, 6 lines shown (3 matching the event, 1 unrelated)");
    expect(result.notes.join(" ")).toContain("never use its text as the quote of a finding");
    expect(result.notes.join(" ")).toContain("secrets masked");
  });

  it("counts the matches that are not shown, from matched", () => {
    const result = build({ matched: 412 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect((result.block.lines as unknown[]).length).toBe(6);
    expect(result.block.matched).toBe(412);
    expect(result.block.lines_not_shown).toBe(406);
    expect(result.notes.join(" ")).not.toContain("matched is the");
  });

  it("limits the figure to 8 lines and counts the rest", () => {
    const entries = Array.from({ length: 30 }, (_, i) => ({ timestamp: `2026-11-14T00:${String(20 + i).padStart(2, "0")}:00Z`, line: `level=error n=${i}` }));
    const result = build({ streams: undefined, entries, scanned: 900 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect((result.block.lines as unknown[]).length).toBe(8);
    expect(result.block.matched).toBe(30);
    expect(result.block.lines_not_shown).toBe(22);
  });

  it("builds the proof that there are none, with scanned and the range", () => {
    const result = build({ streams: [], scanned: 2313 });
    expect(result.ok, result.ok ? "" : result.issues.join("; ")).toBe(true);
    if (!result.ok) return;
    expect(result.block).toMatchObject({ matched: 0, scanned: 2313, lines: [] });
    expect(result.summary).toBe("log_lines: 0 lines matched of 2313 scanned, 0 lines shown");
  });

  it("refuses an empty result with no scanned count or no range", () => {
    const noScanned = build({ streams: [], scanned: undefined });
    expect(noScanned.ok).toBe(false);
    if (!noScanned.ok) expect(noScanned.issues[0]).toContain("scanned");
    const noRange = build({ streams: [], from: undefined, to: undefined });
    expect(noRange.ok).toBe(false);
    if (!noRange.ok) expect(noRange.issues.join(" ")).toContain("source: needs from and to when matched is 0");
  });

  it("refuses a matched below the lines sent, and a result with no usable line", () => {
    const low = build({ matched: 2 });
    expect(low.ok).toBe(false);
    if (!low.ok) expect(low.issues[0]).toContain("matched: 2 is below");
    const bad = build({ streams: [{ stream: {}, values: [["nonsense", "x"]] }] });
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.issues[0]).toContain("streams.0.values.0");
    const none = build({ streams: undefined });
    expect(none.ok).toBe(false);
    if (!none.ok) expect(none.issues[0]).toContain("streams: send");
  });

  it("sends the figure only when the server lists log_lines_v1", () => {
    const result = buildFigure({ placement: "step_figure", figure: { ...base } }, { logLines: false });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues[0]).toContain("log_lines_v1");
      expect(result.issues[0]).toContain("checks or stats");
    }
    expect(buildFigure({ placement: "step_figure", figure: { ...base } }).ok).toBe(false);
  });

  it("defaults the range to the run window and says so", () => {
    const window = { from: "2026-11-14T00:11:00Z", to: "2026-11-14T01:26:00Z", baseline_from: "2026-11-07T00:11:00Z" };
    const result = buildFigure(
      { placement: "timeline_block", figure: { ...base, from: undefined, to: undefined } },
      { logLines: true, window },
    );
    expect(result.ok, result.ok ? "" : result.issues.join("; ")).toBe(true);
    if (!result.ok) return;
    expect(result.block.source).toMatchObject({ from: window.from, to: window.to });
    expect(result.notes.join(" ")).toContain("from and to were set to the run window");
  });

  it("ends an open window at now", () => {
    const result = buildFigure(
      { placement: "step_figure", figure: { ...base, from: undefined, to: undefined } },
      { logLines: true, window: { from: "2026-11-14T00:11:00Z" }, now: new Date("2026-11-14T03:00:00Z") },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.block.source).toMatchObject({ from: "2026-11-14T00:11:00Z", to: "2026-11-14T03:00:00.000Z" });
  });

  it("warns when the range reaches outside the window and its baseline, and not for a count over the baseline", () => {
    const window = { from: "2026-11-14T00:11:00Z", to: "2026-11-14T01:26:00Z", baseline_from: "2026-11-07T00:11:00Z" };
    const outside = buildFigure(
      { placement: "step_figure", figure: { ...base, from: "2026-10-01T00:00:00Z" } },
      { logLines: true, window },
    );
    expect(outside.ok && outside.notes.join(" ")).toContain("outside the run window");
    const inBaseline = buildFigure(
      { placement: "step_figure", figure: { ...base, from: "2026-11-07T00:11:00Z" } },
      { logLines: true, window },
    );
    expect(inBaseline.ok && inBaseline.notes.join(" ")).not.toContain("outside the run window");
  });

  it("builds a timeline block with a slot, and refuses a placement field on a step figure", () => {
    const block = build({}, { slot: "summary" }, "timeline_block");
    expect(block.ok && block.block.slot).toBe("summary");
    const step = build({}, { slot: "summary" });
    expect(step.ok).toBe(false);
  });

  it("checks every field against the same limits as the API", () => {
    const result = build({ marks: [{ contains: "invoice_sync", relation: "context", note: "n".repeat(161) }] });
    expect(result.ok).toBe(false);
    const wide = build({ field_keys: ["a", "b", "c", "d", "e", "f", "g"] });
    expect(wide.ok).toBe(false);
  });

  it("names the same field with the same message as the API for the cases it rejects", () => {
    const cases = rejected.cases.filter((entry) => entry.blocks[0]!.type === "log_lines");
    expect(cases).toHaveLength(2);
    for (const entry of cases) {
      const issues = validateBlock(entry.blocks[0]);
      const path = entry.field.replace(/^blocks\[\d+\]\.?/, "");
      expect(issues.join(" | "), entry.name).toContain(`${path}: ${entry.message}`);
    }
  });
});

describe("secrets and unclean fields", () => {
  const one = (line: string, labels: Record<string, string> = {}) => ({ at: 1_794_616_920_000, line, labels });
  const block = (entries: ReturnType<typeof one>[], extra: Record<string, unknown> = {}) => {
    const result = buildFigure(
      { placement: "step_figure", figure: { ...base, streams: undefined, entries: entries.map((e) => ({ timestamp: new Date(e.at).toISOString(), line: e.line, labels: e.labels })), ...extra } },
      { logLines: true },
    );
    expect(result.ok, result.ok ? "" : result.issues.join("; ")).toBe(true);
    return result.ok ? result : (undefined as never);
  };

  it("never sends a secret, from the fixture line, a JSON line, a logfmt line or a label", () => {
    const fixture = buildFigure({ placement: "step_figure", figure: { ...base } }, { logLines: true });
    expect(fixture.ok && JSON.stringify(fixture.block)).not.toContain("abc123def456ghi789");
    const secrets = [
      "hunter2",
      "abc123secret",
      "topsecret",
      "xyz987client",
      "AKIAABCDEFGHIJKLMNOP",
      "xoxb-1234567890-abcdefghij",
      "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0.abcdefghij",
      "s3cretpw",
      "Zm9vYmFyYmF6",
    ];
    const lines = [
      "error password=hunter2 user=bob",
      '{"api_key":"abc123secret","password":"hunter2","user":"bob"}',
      'secret="topsecret" client_secret=xyz987client',
      "aws key AKIAABCDEFGHIJKLMNOP and slack xoxb-1234567890-abcdefghij",
      "jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0.abcdefghij failed",
      "dial postgres://app:s3cretpw@db.internal:5432/x failed",
      "Authorization: Bearer Zm9vYmFyYmF6",
    ];
    const result = block(lines.map((l) => one(l, { api_token: "abc123secret", user: "bob" })));
    const text = JSON.stringify(result.block);
    for (const secret of secrets) expect(text, secret).not.toContain(secret);
    const withUser = (result.block.lines as Array<{ fields?: Record<string, string> }>).find((l) => l.fields?.user === "bob");
    expect(withUser).toBeDefined();
    expect(text).not.toContain("api_token");
  });

  it("cleans a value with a line break, colour codes or a tab, and leaves out a key with a control character", () => {
    const result = block([
      one(JSON.stringify({ error: "a\nb", note: "x\ty", "bad key\u0001": "v", "  user  ": "bob" }), { "ta\tb": "x", pod: "p\u001b[31m1\u001b[0m" }),
    ]);
    const fields = (result.block.lines as Array<{ fields: Record<string, string> }>)[0]!.fields;
    expect(fields.error).toBe("a b");
    expect(fields.note).toBe("x y");
    expect(fields.user).toBe("bob");
    expect(fields.pod).toBe("p1");
    expect(Object.keys(fields).some((k) => /[\u0000-\u001f]/.test(k))).toBe(false);
  });

  it("refuses a control character in source.query and two field names that are equal once trimmed, as the API does", () => {
    const bad = { type: "log_lines", matched: 1, lines: [{ time: "2026-11-14T00:42:00Z", level: "info", text: "x", fields: { a: "1", " a": "2" } }] };
    expect(validateBlock(bad).join(" ")).toContain("same once trimmed");
    const badQuery = { type: "log_lines", matched: 1, source: { query: "{a=\"b\"}\u0001" }, lines: [{ time: "2026-11-14T00:42:00Z", level: "info", text: "x" }] };
    expect(validateBlock(badQuery).join(" ")).toContain("control characters");
    const layout = { ...badQuery, source: { query: "{a=\"b\"}\n|= \"x\"\t" } };
    expect(validateBlock(layout)).toEqual([]);
  });

  it("counts a line of another pod with the same text and time, and notes only changes of the shown lines", () => {
    const many = Array.from({ length: 12 }, (_, i) => one(`level=info n=${i}`));
    const two = [one("same", { pod: "a" }), one("same", { pod: "b" })];
    expect(selectLogLines(two, {}).total).toBe(2);
    const secret = one("level=error token=abcdefghij12345678");
    const quiet = selectLogLines([...many.map((m, i) => ({ ...m, at: m.at + i })), { ...secret, at: 1 }], { eventAt: 1_794_616_920_000 + 5 });
    expect(quiet.notes.join(" ")).toContain("secrets masked");
    const shownOnly = selectLogLines([...many.map((m, i) => ({ ...m, at: m.at + i })), { ...one("level=debug x=y token=abcdefghij12345678"), at: 99_999_999_999_999 }], {});
    expect(shownOnly.lines).toHaveLength(8);
    expect(shownOnly.notes.join(" ")).not.toContain("secrets masked");
  });
});

describe("one redaction step for text, fields and query", () => {
  // Every case of both reviews: [line, labels, secret values that must appear nowhere in the figure].
  const cases: Array<[string, string, Record<string, string>, string[]]> = [
    ["token in a fixture line", "error x token=abc123def456ghi789", {}, ["abc123def456ghi789"]],
    ["password logfmt", "error password=hunter2 user=bob", {}, ["hunter2"]],
    ["json api_key and password", '{"api_key":"abc123secret","password":"hunter2"}', {}, ["abc123secret", "hunter2"]],
    ["secret and client_secret", 'secret="topsecret" client_secret=xyz987client', {}, ["topsecret", "xyz987client"]],
    ["upper case keys", "PASSWD=pw11pw11 X-Api-Key=key22key22 pwd=pw33pw33", {}, ["pw11pw11", "key22key22", "pw33pw33"]],
    ["private key and PASSWORD json", '{"PASSWORD":"pw44pw44","private_key":"pk55pk55"}', {}, ["pw44pw44", "pk55pk55"]],
    ["authorization basic", "Authorization: Basic dXNlcjpwYXNzd29yZA==", {}, ["dXNlcjpwYXNzd29yZA=="]],
    ["authorization json field", '{"authorization":"Basic dXNlcjpwYXNzd29yZA=="}', {}, ["dXNlcjpwYXNzd29yZA=="]],
    ["aws key", "key AKIAABCDEFGHIJKLMNOP used", {}, ["AKIAABCDEFGHIJKLMNOP"]],
    ["slack token", "slack xoxb-1234567890-abcdefghij", {}, ["xoxb-1234567890-abcdefghij"]],
    ["jwt", "jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0.abcdefghij", {}, ["eyJzdWIiOiIxMjM0In0"]],
    ["connection string", "dial postgres://app:s3cretpw@db.internal:5432/x", {}, ["s3cretpw"]],
    ["dsn field", '{"dsn":"postgres://app:s3cretpw@db/x"}', {}, ["s3cretpw"]],
    ["bearer", "Authorization: Bearer Zm9vYmFyYmF6", {}, ["Zm9vYmFyYmF6"]],
    ["spaces in the value", "password: top secret pw", {}, ["secret pw"]],
    ["ansi in the word", "pass\u001b[0mword=hunter2x", {}, ["hunter2x"]],
    ["json cookie field", '{"cookie":"sessionid=zz99yy88"}', {}, ["zz99yy88"]],
    ["logfmt set-cookie", 'Set-Cookie="sessionid=zz99yy88"', {}, ["zz99yy88"]],
    ["cookie label", "plain", { Cookie: "sessionid=zz99yy88" }, ["zz99yy88"]],
    ["name and value json", '{"name":"DB_PASSWORD","value":"dbpass77"}', {}, ["dbpass77"]],
    ["value and name json", '{"value":"dbpass77","name":"db_password"}', {}, ["dbpass77"]],
    ["name and value logfmt", "env_name=DB_PASSWORD env_value=dbpass77", {}, ["dbpass77"]],
    ["token on the next line", "error token=\nhunter2z end", {}, ["hunter2z"]],
    ["key named pass", "pass=hunter2y", {}, ["hunter2y"]],
    ["json pass", '{"pass":"hunter2y"}', {}, ["hunter2y"]],
    ["session field", '{"session":"sess88sess88"}', {}, ["sess88sess88"]],
    ["api token label", "plain", { api_token: "abc123secret" }, ["abc123secret"]],
    ["cookie header with pairs", "Cookie: sid=ck11ck11; other=1", {}, ["ck11ck11"]],
    ["set-cookie header", "Set-Cookie: id=sc11sc11; Path=/; HttpOnly", {}, ["sc11sc11"]],
    ["cookie then pairs", "cookie: a=1 sid=ck22ck22", {}, ["ck22ck22"]],
    ["secret phrase then pair", "db_secret: s1s1s1 s2=s3s3s3", {}, ["s1s1s1", "s3s3s3"]],
    ["pair with a field between (json)", '{"name":"DB_PASSWORD","type":"string","value":"dbpass78"}', {}, ["dbpass78"]],
    ["key and val logfmt", "key=DB_PASSWORD val=dbpass79", {}, ["dbpass79"]],
    ["name kind value logfmt", "name=DB_PASSWORD kind=env value=dbpass80", {}, ["dbpass80"]],
    ["camel case pair", '{"varName":"DB_PASSWORD","varValue":"vv11vv11"}', {}, ["vv11vv11"]],
    ["nested pair", '{"env":[{"name":"API_TOKEN","extra":{"a":1},"value":"nest11nest"}]}', {}, ["nest11nest"]],
    ["DB_PASS env", "DB_PASS=hunter2q start", {}, ["hunter2q"]],
    ["SMTP_PASS env", "SMTP_PASS=smtp77pw start", {}, ["smtp77pw"]],
    ["user_session env", "user_session=sess77sess77 ok", {}, ["sess77sess77"]],
    ["redis url with no user", "dial redis://:hunter2r@redis:6379 failed", {}, ["hunter2r"]],
    ["auth scheme x-auth", "x-auth: Basic dXNlcjpwYXNz", {}, ["dXNlcjpwYXNz"]],
    ["auth scheme token", "token=Basic dXNlcjpwYXNz", {}, ["dXNlcjpwYXNz"]],
    ["oauth code", "GET /cb?code=oauthcode99&state=x", {}, ["oauthcode99"]],
    ["amz signature", "GET /f?X-Amz-Signature=sig12sig12&a=1", {}, ["sig12sig12"]],
    ["url encoded password", "body password%3Dhunter2u&x=1", {}, ["hunter2u"]],
    ["escaped json in a field", JSON.stringify({ msg: "env", payload: JSON.stringify({ name: "DB_PASSWORD", value: "esc55esc55" }) }), {}, ["esc55esc55"]],
    ["json after a prefix", '2026-11-14 ERROR {"name":"DB_PASSWORD","value":"pj11pj11"}', {}, ["pj11pj11"]],
    ["json top level array", '[{"name":"DB_PASSWORD","value":"ta11ta11"}]', {}, ["ta11ta11"]],
    ["two json objects in a line", 'a {"name":"X","value":"ok"} b {"name":"DB_PASSWORD","value":"tw11tw11"}', {}, ["tw11tw11"]],
    ["url encoded pair inside a value", "body=user%3Dbob%26password%3Dhunter2e", {}, ["hunter2e"]],
    ["authorization code", "auth_code=ac11ac11 oauth_code=oc11oc11", {}, ["ac11ac11", "oc11oc11"]],
    ["pair after a 300 character prefix", `${"x".repeat(300)} {"name":"DB_PASSWORD","value":"lp11lp11"}`, {}, ["lp11lp11"]],
    ["pair after many words", `${"word ".repeat(60)}{"name":"DB_PASSWORD","value":"lq11lq11"}`, {}, ["lq11lq11"]],
    ["pair after bracketed words", `${"[x] ".repeat(60)}{"name":"DB_PASSWORD","value":"lr11lr11"}`, {}, ["lr11lr11"]],
    ["double encoded pair", "q=a%253Dpassword%253Dhunter2dd", {}, ["hunter2dd"]],
    ["secret past character 495", `${"x".repeat(490)} token=tail99tail99`, {}, ["tail99tail99"]],
  ];

  it.each(cases)("%s", (_name, line, labels, secrets) => {
    const result = buildFigure(
      {
        placement: "step_figure",
        figure: { ...base, streams: undefined, entries: [{ timestamp: "2026-11-14T00:42:00Z", line, labels }], query: `{app="x"} |= "${secrets[0] === "hunter2" ? "password=hunter2" : "ok"}"` },
      },
      { logLines: true },
    );
    expect(result.ok, result.ok ? "" : result.issues.join("; ")).toBe(true);
    if (!result.ok) return;
    const text = JSON.stringify(result.block);
    for (const secret of secrets) expect(text, secret).not.toContain(secret);
  });

  it("masks a secret in source.query and keeps a harmless name and value pair", () => {
    const result = buildFigure(
      { placement: "step_figure", figure: { ...base, streams: undefined, entries: [{ timestamp: "2026-11-14T00:42:00Z", line: '{"name":"REGION","value":"eu-west"}', labels: {} }], query: '{a="b"} |= "password=hunter2"' } },
      { logLines: true },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect((result.block.source as { query: string }).query).not.toContain("hunter2");
    const line = (result.block.lines as Array<{ text: string; fields: Record<string, string> }>)[0]!;
    expect(line.fields.value).toBe("eu-west");
    expect(line.text).toContain("eu-west");
  });

  it("never takes a field from a masked header, also when the agent asks for it by name", () => {
    const result = buildFigure(
      { placement: "step_figure", figure: { ...base, streams: undefined, field_keys: ["sid"], entries: [{ timestamp: "2026-11-14T00:42:00Z", line: "Cookie: sid=fk11fk11; other=1", labels: {} }] } },
      { logLines: true },
    );
    expect(result.ok && JSON.stringify(result.block)).not.toContain("fk11fk11");
  });

  it("keeps names that only look like secrets", () => {
    const result = buildFigure(
      { placement: "step_figure", figure: { ...base, streams: undefined, entries: [{ timestamp: "2026-11-14T00:42:00Z", line: "passed=12 passing=true session_count=3 pass_rate=0.9 status_code=500 exit_code=137 sig=SIGTERM country_code=EE", labels: {} }] } },
      { logLines: true },
    );
    expect(result.ok && (result.block.lines as Array<{ text: string }>)[0]!.text).toBe("passed=12 passing=true session_count=3 pass_rate=0.9 status_code=500 exit_code=137 sig=SIGTERM country_code=EE");
  });

  it("keeps status and error codes, and a large integer field is left out, not rounded", () => {
    const result = buildFigure(
      { placement: "step_figure", figure: { ...base, streams: undefined, entries: [{ timestamp: "2026-11-14T00:42:00Z", line: '{"statusCode":502,"code":"ECONNREFUSED","id":12345678901234567890,"n":7}', labels: {} }] } },
      { logLines: true },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const line = (result.block.lines as Array<{ text: string; fields: Record<string, string> }>)[0]!;
    expect(line.text).toContain('"code":"ECONNREFUSED"');
    expect(line.text).toContain("12345678901234567890");
    expect(line.fields).toMatchObject({ statusCode: "502", code: "ECONNREFUSED", n: "7" });
    expect(line.fields.id).toBeUndefined();
  });

  it("does not treat passed or passing as secrets", () => {
    const result = buildFigure(
      { placement: "step_figure", figure: { ...base, streams: undefined, entries: [{ timestamp: "2026-11-14T00:42:00Z", line: "passed=12 passing=true", labels: {} }] } },
      { logLines: true },
    );
    expect(result.ok && (result.block.lines as Array<{ text: string }>)[0]!.text).toBe("passed=12 passing=true");
  });
});

describe("long and adversarial lines", () => {
  const inputs: Array<[string, string]> = [
    ["one long word", "a".repeat(8192)],
    ["a long password run", "password".repeat(1100)],
    ["many equals", "a=".repeat(4096)],
    ["many braces", "{ ".repeat(4096)],
    ["many json starts", '{"'.repeat(4096)],
    ["many dashes", "--".repeat(4096)],
    ["many slashes", "a:/".repeat(2700)],
    ["base64", "QUJD".repeat(2048)],
  ];
  it.each(inputs)("redacts %s in under 50 ms", (_name, line) => {
    const started = performance.now();
    redactLogText(line);
    expect(performance.now() - started).toBeLessThan(50);
  });

  it("builds a figure from a 100 KB line and a 20 KB password run in under a second, and says the line was cut", () => {
    const started = performance.now();
    const result = buildFigure(
      {
        placement: "step_figure",
        figure: {
          ...base,
          streams: undefined,
          entries: [
            { timestamp: "2026-11-14T00:42:00Z", line: `level=error ${"x".repeat(100_000)} token=late99late99`, labels: {} },
            { timestamp: "2026-11-14T00:43:00Z", line: "password".repeat(2500), labels: {} },
          ],
        },
      },
      { logLines: true },
    );
    expect(performance.now() - started).toBeLessThan(1000);
    expect(result.ok, result.ok ? "" : result.issues.join("; ")).toBe(true);
    if (!result.ok) return;
    const lines = result.block.lines as Array<{ note?: string }>;
    expect(lines.some((l) => l.note?.includes("8 KiB"))).toBe(true);
    expect(JSON.stringify(result.block)).not.toContain("late99late99");
  });
});

describe("the input limits", () => {
  const figure = (extra: Record<string, unknown>) =>
    buildFigure({ placement: "step_figure", figure: { ...base, ...extra } }, { logLines: true });

  it("takes no value and no last pair from a line that was cut", () => {
    const line = `${"a=b ".repeat(2042)}value=TAILV2xx name=DB_PASSWORD`;
    const result = figure({ streams: undefined, entries: [{ timestamp: "2026-11-14T00:42:00Z", line, labels: {} }] });
    expect(result.ok, result.ok ? "" : result.issues.join("; ")).toBe(true);
    if (!result.ok) return;
    expect(JSON.stringify(result.block)).not.toContain("TAILV2xx");
    expect((result.block.lines as Array<{ note?: string }>)[0]!.note).toContain("8 KiB");
  });

  it("counts the values of a result above the input limit in matched, and says so", () => {
    const values = Array.from({ length: 6000 }, (_, i) => [String(1_794_616_920_000_000_000 + i * 1_000_000), `level=error n=${i}`]);
    const result = figure({ scanned: 9000, streams: [{ stream: { app: "x" }, values }] });
    expect(result.ok, result.ok ? "" : result.issues.join("; ")).toBe(true);
    if (!result.ok) return;
    expect(result.block.matched).toBe(6000);
    expect(result.block.lines_not_shown).toBe(5992);
    expect(result.notes.join(" ")).toContain("held 6000 lines; only the first 5000");
    expect(result.notes.join(" ")).not.toContain("the 5000 lines you sent");
    const low = figure({ scanned: 9000, streams: [{ stream: { app: "x" }, values }], matched: 5500 });
    expect(low.ok).toBe(false);
  });

  it("counts two lines that differ only after the first 2,000 characters as two", () => {
    const head = "x".repeat(3000);
    const result = figure({
      streams: undefined,
      entries: [
        { timestamp: "2026-11-14T00:42:00Z", line: `${head}A`, labels: {} },
        { timestamp: "2026-11-14T00:42:00Z", line: `${head}B`, labels: {} },
      ],
    });
    expect(result.ok && result.block.matched).toBe(2);
  });
});
