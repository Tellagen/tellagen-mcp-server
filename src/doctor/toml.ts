/**
 * A reader for the small part of TOML that a Codex config uses: tables
 * (`[a.b]`, `[a."b.c"]`), strings, numbers, booleans, arrays (also over
 * several lines) and inline tables. It is not a full TOML parser. A line it
 * cannot read is skipped, so one odd entry never hides the rest.
 */
export type TomlValue = string | number | boolean | TomlValue[] | { [key: string]: TomlValue };
export type TomlTable = { [key: string]: TomlValue };

class Reader {
  pos = 0;
  constructor(readonly text: string) {}
  get done(): boolean {
    return this.pos >= this.text.length;
  }
  peek(): string {
    return this.text[this.pos] ?? "";
  }
  skipSpaces(): void {
    while (this.peek() === " " || this.peek() === "\t") this.pos++;
  }
  skipBlank(): void {
    for (;;) {
      const c = this.peek();
      if (c === " " || c === "\t" || c === "\n" || c === "\r") this.pos++;
      else if (c === "#") this.skipLine();
      else return;
    }
  }
  skipLine(): void {
    while (!this.done && this.peek() !== "\n") this.pos++;
  }
}

const ESCAPES: Record<string, string> = { n: "\n", t: "\t", r: "\r", '"': '"', "\\": "\\", b: "\b", f: "\f" };

function readString(r: Reader): string {
  const quote = r.peek();
  r.pos++;
  let out = "";
  while (!r.done && r.peek() !== quote) {
    if (r.peek() === "\n") throw new Error("unterminated string");
    if (quote === '"' && r.peek() === "\\") {
      r.pos++;
      const c = r.peek();
      if (c === "u") {
        out += String.fromCharCode(parseInt(r.text.slice(r.pos + 1, r.pos + 5), 16) || 63);
        r.pos += 5;
        continue;
      }
      out += ESCAPES[c] ?? c;
      r.pos++;
      continue;
    }
    out += r.peek();
    r.pos++;
  }
  if (r.done) throw new Error("unterminated string");
  r.pos++;
  return out;
}

function readKey(r: Reader): string {
  r.skipSpaces();
  if (r.peek() === '"' || r.peek() === "'") return readString(r);
  const start = r.pos;
  while (/[A-Za-z0-9_-]/.test(r.peek())) r.pos++;
  if (r.pos === start) throw new Error("bad key");
  return r.text.slice(start, r.pos);
}

function readKeyPath(r: Reader): string[] {
  const path = [readKey(r)];
  for (;;) {
    r.skipSpaces();
    if (r.peek() !== ".") return path;
    r.pos++;
    path.push(readKey(r));
  }
}

function readValue(r: Reader): TomlValue {
  r.skipSpaces();
  const c = r.peek();
  if (c === '"' || c === "'") return readString(r);
  if (c === "[") {
    r.pos++;
    const items: TomlValue[] = [];
    for (;;) {
      r.skipBlank();
      if (r.peek() === "]") {
        r.pos++;
        return items;
      }
      items.push(readValue(r));
      r.skipBlank();
      if (r.peek() === ",") r.pos++;
      else if (r.peek() !== "]") throw new Error("bad array");
    }
  }
  if (c === "{") {
    r.pos++;
    const table: TomlTable = {};
    for (;;) {
      r.skipBlank();
      if (r.peek() === "}") {
        r.pos++;
        return table;
      }
      const path = readKeyPath(r);
      r.skipSpaces();
      if (r.peek() !== "=") throw new Error("bad inline table");
      r.pos++;
      assign(table, path, readValue(r));
      r.skipBlank();
      if (r.peek() === ",") r.pos++;
      else if (r.peek() !== "}") throw new Error("bad inline table");
    }
  }
  const start = r.pos;
  while (!r.done && !/[\s,\]}#]/.test(r.peek())) r.pos++;
  const word = r.text.slice(start, r.pos);
  if (word === "true") return true;
  if (word === "false") return false;
  const n = Number(word.replace(/_/g, ""));
  if (word !== "" && Number.isFinite(n)) return n;
  throw new Error("bad value");
}

function descend(root: TomlTable, path: string[]): TomlTable {
  let table = root;
  for (const key of path) {
    if (key === "__proto__" || key === "constructor" || key === "prototype") throw new Error("bad key");
    const next = table[key];
    if (typeof next === "object" && next !== null && !Array.isArray(next)) table = next as TomlTable;
    else {
      const created: TomlTable = {};
      table[key] = created;
      table = created;
    }
  }
  return table;
}

function assign(table: TomlTable, path: string[], value: TomlValue): void {
  const parent = descend(table, path.slice(0, -1));
  const key = path[path.length - 1]!;
  if (key === "__proto__" || key === "constructor" || key === "prototype") return;
  parent[key] = value;
}

export function parseToml(text: string): TomlTable {
  const root: TomlTable = {};
  const r = new Reader(text);
  let current = root;
  while (!r.done) {
    r.skipBlank();
    if (r.done) break;
    try {
      if (r.peek() === "[") {
        r.pos++;
        const array = r.peek() === "[";
        if (array) r.pos++;
        const path = readKeyPath(r);
        r.skipSpaces();
        if (r.peek() !== "]") throw new Error("bad table header");
        r.pos++;
        if (array) {
          // Arrays of tables are not used for servers. Keep the entries apart so they never merge.
          r.pos++;
          current = {};
        } else {
          current = descend(root, path);
        }
      } else {
        const path = readKeyPath(r);
        r.skipSpaces();
        if (r.peek() !== "=") throw new Error("bad line");
        r.pos++;
        assign(current, path, readValue(r));
      }
    } catch {
      r.skipLine();
    }
  }
  return root;
}
