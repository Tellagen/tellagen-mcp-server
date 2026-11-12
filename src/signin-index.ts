import { chmodSync, lstatSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { z } from "zod";
import { tellagenHome } from "./home.js";

/**
 * What this computer knows about its sign-ins, apart from the keys: which
 * workspace, until when, and where the key is kept. The file holds no key.
 * One sign-in is kept for each workspace address, and one of them is the
 * current one.
 */

const entrySchema = z.object({
  api_url: z.string().max(300),
  workspace_name: z.string().max(200).optional(),
  workspace_url: z.string().max(300).optional(),
  signed_in_at: z.string().max(40),
  /** When the key stops working; empty when Tellagen sent no date. */
  expires_at: z.string().max(40).optional(),
  storage: z.enum(["macos-keychain", "libsecret", "windows-vault", "file"]),
  /** Seen at a pickup: this server is older than the workspace wants. */
  update_available: z
    .object({ your_version: z.string().max(40), current_version: z.string().max(40), seen_at: z.string().max(40) })
    .optional(),
});

const indexSchema = z.object({
  version: z.literal(1),
  current: z.string().max(220).optional(),
  workspaces: z.record(z.string().max(220), entrySchema),
});

export type SignInEntry = z.infer<typeof entrySchema> & { account?: never };
export type SignInIndexData = z.infer<typeof indexSchema>;

const MAX_BYTES = 64 * 1024;
const MAX_WORKSPACES = 50;

export class SignInIndex {
  readonly #path: string | undefined;
  constructor(private readonly dir: string | undefined = tellagenHome()) {
    this.#path = dir ? join(dir, "signin.json") : undefined;
  }

  filePath(): string | undefined {
    return this.#path;
  }

  read(): SignInIndexData {
    const empty: SignInIndexData = { version: 1, workspaces: {} };
    if (!this.#path) return empty;
    try {
      const stat = lstatSync(this.#path);
      if (!stat.isFile() || stat.size > MAX_BYTES) return empty;
      const parsed = indexSchema.safeParse(JSON.parse(readFileSync(this.#path, "utf8")));
      return parsed.success ? parsed.data : empty;
    } catch {
      return empty;
    }
  }

  private write(data: SignInIndexData): boolean {
    if (!this.#path || !this.dir) return false;
    const temp = `${this.#path}.${randomBytes(6).toString("hex")}.tmp`;
    try {
      mkdirSync(this.dir, { recursive: true, mode: 0o700 });
      writeFileSync(temp, `${JSON.stringify(indexSchema.parse(data), null, 2)}\n`, { mode: 0o600, flag: "wx" });
      chmodSync(temp, 0o600);
      renameSync(temp, this.#path);
      return true;
    } catch {
      rmSync(temp, { force: true });
      return false;
    }
  }

  /** Records a sign-in and makes it the current one. */
  save(account: string, entry: SignInEntry): boolean {
    const data = this.read();
    if (!(account in data.workspaces) && Object.keys(data.workspaces).length >= MAX_WORKSPACES) return false;
    data.workspaces[account] = entry;
    data.current = account;
    return this.write(data);
  }

  update(account: string, change: Partial<SignInEntry>): void {
    const data = this.read();
    const entry = data.workspaces[account];
    if (!entry) return;
    data.workspaces[account] = { ...entry, ...change };
    this.write(data);
  }

  remove(account: string): void {
    const data = this.read();
    delete data.workspaces[account];
    if (data.current === account) data.current = Object.keys(data.workspaces)[0];
    if (Object.keys(data.workspaces).length === 0) {
      if (this.#path) rmSync(this.#path, { force: true });
      return;
    }
    this.write(data);
  }

  /** The entry of an account, or the current one when none is named. */
  find(account?: string): { account: string; entry: SignInEntry } | undefined {
    const data = this.read();
    const key = account ?? data.current;
    if (!key) return undefined;
    const entry = data.workspaces[key];
    return entry ? { account: key, entry } : undefined;
  }

  list(): Array<{ account: string; entry: SignInEntry; current: boolean }> {
    const data = this.read();
    return Object.entries(data.workspaces).map(([account, entry]) => ({ account, entry, current: account === data.current }));
  }
}
