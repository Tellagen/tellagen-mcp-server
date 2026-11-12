import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmodSync, lstatSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tellagenHome } from "./home.js";

/**
 * Where the API key of a sign-in is kept.
 *
 * The key goes to the system keychain: the macOS Keychain, the Secret
 * Service (libsecret) on Linux, the Windows credential vault. Where a
 * computer has none, the key goes to a file that only its owner can read, and
 * the person is told so. The key is never written to the state folder, to a
 * log or to a message.
 *
 * Each keychain is reached through the command that ships with the system,
 * so this package needs no native module. The key reaches that command on
 * its standard input or in its environment, never in its arguments, because
 * the arguments of a running command can be read by other users.
 */

export const KEYCHAIN_SERVICE = "tellagen-mcp-server";

export type StoreKind = "macos-keychain" | "libsecret" | "windows-vault" | "file";

export interface CredentialStore {
  readonly kind: StoreKind;
  get(account: string): Promise<string | undefined>;
  /** Stores the key and reads it back. It throws a plain error without the key. */
  set(account: string, secret: string): Promise<void>;
  delete(account: string): Promise<void>;
}

export interface CommandResult {
  code: number | null;
  stdout: string;
  stderr: string;
  /** The command is not installed. */
  missing: boolean;
  timedOut: boolean;
}

export type RunCommand = (
  command: string,
  args: readonly string[],
  options?: { input?: string; env?: Record<string, string>; timeoutMs?: number; cwd?: string },
) => Promise<CommandResult>;

/** Runs a system command. It never throws and never prints. */
export const runCommand: RunCommand = (command, args, options = {}) =>
  new Promise((resolve) => {
    let settled = false;
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const finish = (result: Partial<CommandResult>) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code: null, stdout, stderr, missing: false, timedOut, ...result });
    };
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(command, [...args], {
        stdio: ["pipe", "pipe", "pipe"],
        env: { ...process.env, ...(options.env ?? {}) },
        cwd: options.cwd,
        windowsHide: true,
      });
    } catch {
      resolve({ code: null, stdout: "", stderr: "", missing: true, timedOut: false });
      return;
    }
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, options.timeoutMs ?? 5_000);
    child.stdout?.on("data", (chunk: Buffer) => {
      if (stdout.length < 100_000) stdout += chunk.toString("utf8");
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      if (stderr.length < 100_000) stderr += chunk.toString("utf8");
    });
    child.on("error", (err: NodeJS.ErrnoException) => finish({ missing: err.code === "ENOENT" }));
    child.on("close", (code) => finish({ code }));
    child.stdin?.on("error", () => undefined);
    child.stdin?.end(options.input ?? "");
  });

const ACCOUNT_PATTERN = /^[a-z0-9][a-z0-9.:\-\[\]]{0,200}$/;
const SECRET_PATTERN = /^[A-Za-z0-9._~+/=\-]{8,512}$/;

/** The account name of a workspace: the host of its API address. */
export function accountFor(apiUrl: string): string {
  let host: string;
  try {
    host = new URL(apiUrl).host.toLowerCase();
  } catch {
    throw new Error("The API address is not a valid URL.");
  }
  if (!ACCOUNT_PATTERN.test(host)) throw new Error("The API address has a host name that cannot be stored.");
  return host;
}

function checkedSecret(secret: string): string {
  if (!SECRET_PATTERN.test(secret)) {
    throw new Error("The key has a form that cannot be stored. It was not stored.");
  }
  return secret;
}

function checkedAccount(account: string): string {
  if (!ACCOUNT_PATTERN.test(account)) throw new Error("That account name cannot be stored.");
  return account;
}

async function verify(store: CredentialStore, account: string, secret: string): Promise<void> {
  const back = await store.get(account);
  if (back !== secret) {
    throw new Error(`The ${describeStore(store.kind)} did not keep the key.`);
  }
}

export function describeStore(kind: StoreKind): string {
  switch (kind) {
    case "macos-keychain":
      return "macOS Keychain";
    case "libsecret":
      return "system keyring (Secret Service)";
    case "windows-vault":
      return "Windows Credential Manager";
    case "file":
      return "key file";
  }
}

/** The macOS Keychain, through the `security` command. */
export class MacKeychainStore implements CredentialStore {
  readonly kind = "macos-keychain" as const;
  constructor(private readonly run: RunCommand = runCommand) {}

  async get(account: string): Promise<string | undefined> {
    const result = await this.run("security", [
      "find-generic-password",
      "-s",
      KEYCHAIN_SERVICE,
      "-a",
      checkedAccount(account),
      "-w",
    ]);
    if (result.code !== 0) return undefined;
    const value = result.stdout.replace(/\r?\n$/, "");
    return value || undefined;
  }

  async set(account: string, secret: string): Promise<void> {
    checkedAccount(account);
    checkedSecret(secret);
    // `security -i` reads its commands from standard input, so the key is not
    // an argument of a process that other users can list.
    const result = await this.run(
      "security",
      ["-i"],
      {
        input: `add-generic-password -U -s "${KEYCHAIN_SERVICE}" -a "${account}" -l "Tellagen API key" -w "${secret}"\n`,
      },
    );
    if (result.missing) throw new Error("The macOS `security` command was not found.");
    // The interactive mode can exit with 0 after an error, so read it back.
    await verify(this, account, secret);
  }

  async delete(account: string): Promise<void> {
    await this.run("security", ["delete-generic-password", "-s", KEYCHAIN_SERVICE, "-a", checkedAccount(account)]);
  }
}

/** The Secret Service of a Linux desktop, through `secret-tool`. */
export class SecretToolStore implements CredentialStore {
  readonly kind = "libsecret" as const;
  constructor(private readonly run: RunCommand = runCommand) {}

  async get(account: string): Promise<string | undefined> {
    const result = await this.run("secret-tool", ["lookup", "service", KEYCHAIN_SERVICE, "account", checkedAccount(account)]);
    if (result.code !== 0) return undefined;
    return result.stdout.replace(/\r?\n$/, "") || undefined;
  }

  async set(account: string, secret: string): Promise<void> {
    checkedAccount(account);
    checkedSecret(secret);
    const result = await this.run(
      "secret-tool",
      ["store", "--label", "Tellagen API key", "service", KEYCHAIN_SERVICE, "account", account],
      { input: secret },
    );
    if (result.missing) throw new Error("The `secret-tool` command was not found.");
    await verify(this, account, secret);
  }

  async delete(account: string): Promise<void> {
    await this.run("secret-tool", ["clear", "service", KEYCHAIN_SERVICE, "account", checkedAccount(account)]);
  }

  /** Whether the Secret Service answers on this computer (it does not over SSH with no session bus). */
  async available(): Promise<boolean> {
    const result = await this.run("secret-tool", ["lookup", "service", KEYCHAIN_SERVICE, "account", "tellagen-probe"], {
      timeoutMs: 3_000,
    });
    if (result.missing || result.timedOut) return false;
    // Exit 1 with no message is "not found", which is the good answer.
    return result.code === 0 || (result.code === 1 && result.stderr.trim() === "");
  }
}

const VAULT_HEAD =
  "[void][Windows.Security.Credentials.PasswordVault,Windows.Security.Credentials,ContentType=WindowsRuntime];" +
  "$v = New-Object Windows.Security.Credentials.PasswordVault;";

/** Windows Credential Manager, through the PasswordVault of Windows PowerShell. */
export class WindowsVaultStore implements CredentialStore {
  readonly kind = "windows-vault" as const;
  constructor(private readonly run: RunCommand = runCommand) {}

  private script(body: string, account: string, secret?: string) {
    // The account and key travel in the environment of the child, not in its
    // command line.
    return this.run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", "-"], {
      input: `${VAULT_HEAD}${body}\n`,
      env: { TELLAGEN_ACCOUNT: account, ...(secret !== undefined ? { TELLAGEN_SECRET: secret } : {}) },
      timeoutMs: 15_000,
    });
  }

  async get(account: string): Promise<string | undefined> {
    const result = await this.script(
      `try { $c = $v.Retrieve('${KEYCHAIN_SERVICE}', $env:TELLAGEN_ACCOUNT); $c.RetrievePassword(); [Console]::Out.Write($c.Password) } catch { exit 3 }`,
      checkedAccount(account),
    );
    return result.code === 0 && result.stdout ? result.stdout : undefined;
  }

  async set(account: string, secret: string): Promise<void> {
    checkedAccount(account);
    checkedSecret(secret);
    const result = await this.script(
      `$v.Add((New-Object Windows.Security.Credentials.PasswordCredential('${KEYCHAIN_SERVICE}', $env:TELLAGEN_ACCOUNT, $env:TELLAGEN_SECRET)))`,
      account,
      secret,
    );
    if (result.missing) throw new Error("Windows PowerShell was not found.");
    await verify(this, account, secret);
  }

  async delete(account: string): Promise<void> {
    await this.script(
      `try { $v.Remove($v.Retrieve('${KEYCHAIN_SERVICE}', $env:TELLAGEN_ACCOUNT)) } catch { }`,
      checkedAccount(account),
    );
  }
}

/** The last resort: a file that only the owner can read. */
export class KeyFileStore implements CredentialStore {
  readonly kind = "file" as const;
  readonly #dir: string;
  constructor(dir: string = join(tellagenHome(), "credentials")) {
    this.#dir = dir;
  }

  path(account: string): string {
    return join(this.#dir, `${checkedAccount(account).replace(/[^a-z0-9.\-]+/g, "_")}.key`);
  }

  async get(account: string): Promise<string | undefined> {
    const path = this.path(account);
    try {
      const stat = lstatSync(path);
      if (!stat.isFile() || stat.size > 4096) return undefined;
      if (process.platform !== "win32" && (stat.mode & 0o077) !== 0) {
        throw new Error(
          `The key file ${path} can be read by other users. Run: chmod 600 "${path}" (or sign in again to rewrite it).`,
        );
      }
      const value = readFileSync(path, "utf8").trim();
      return SECRET_PATTERN.test(value) ? value : undefined;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw err;
    }
  }

  async set(account: string, secret: string): Promise<void> {
    checkedSecret(secret);
    const path = this.path(account);
    mkdirSync(this.#dir, { recursive: true, mode: 0o700 });
    const temp = `${path}.${randomBytes(6).toString("hex")}.tmp`;
    try {
      writeFileSync(temp, `${secret}\n`, { mode: 0o600, flag: "wx" });
      chmodSync(temp, 0o600);
      renameSync(temp, path);
    } catch (err) {
      rmSync(temp, { force: true });
      throw err;
    }
  }

  async delete(account: string): Promise<void> {
    rmSync(this.path(account), { force: true });
  }
}

/** A store in memory, for a test or an embedder. */
export class MemoryStore implements CredentialStore {
  readonly entries = new Map<string, string>();
  constructor(readonly kind: StoreKind = "macos-keychain") {}
  async get(account: string) {
    return this.entries.get(account);
  }
  async set(account: string, secret: string) {
    checkedSecret(secret);
    this.entries.set(account, secret);
  }
  async delete(account: string) {
    this.entries.delete(account);
  }
}

export interface SavedCredential {
  kind: StoreKind;
  /** Set when the key went to a file because the keychain could not be used. */
  fileNotice?: string;
}

/**
 * The keychain of this computer, with the file as the answer where there is
 * no keychain. macOS always has one, so a failure there is reported and the
 * key is not moved to a file.
 */
export class CredentialVault {
  constructor(
    private readonly primary: CredentialStore | undefined,
    private readonly file: CredentialStore,
    private readonly fileFallback: boolean,
  ) {}

  async save(account: string, secret: string): Promise<SavedCredential> {
    if (this.primary) {
      try {
        await this.primary.set(account, secret);
        // A key left in the file from an earlier sign-in is removed.
        await this.file.delete(account).catch(() => undefined);
        return { kind: this.primary.kind };
      } catch (err) {
        if (!this.fileFallback) {
          throw new Error(
            `${err instanceof Error ? err.message : "The keychain failed."} The key was not stored. Nothing was written to a file.`,
          );
        }
      }
    }
    await this.file.set(account, secret);
    const path = this.file instanceof KeyFileStore ? this.file.path(account) : "a key file";
    return {
      kind: "file",
      fileNotice: `This computer has no usable keychain, so the key is stored in ${path}. ${process.platform === "win32" ? "It sits in your user profile folder, and Windows does not enforce a file mode, so keep that folder private." : "Only your user can read that file (mode 600)."} Use TELLAGEN_API_KEY instead if you prefer.`,
    };
  }

  /** The key of an account, looking where the sign-in said it was stored. */
  async load(account: string, kind?: StoreKind): Promise<string | undefined> {
    const stores = [this.primary, this.file].filter((store): store is CredentialStore => store !== undefined);
    stores.sort((a, b) => Number(b.kind === kind) - Number(a.kind === kind));
    for (const store of stores) {
      if (kind && store.kind !== kind) continue;
      const value = await store.get(account);
      if (value) return value;
    }
    return undefined;
  }

  /** Removes the key from every place it could be. */
  async remove(account: string): Promise<void> {
    for (const store of [this.primary, this.file]) {
      if (!store) continue;
      try {
        await store.delete(account);
      } catch {
        // Nothing more to remove there.
      }
    }
  }

  primaryKind(): StoreKind | undefined {
    return this.primary?.kind;
  }
}

/**
 * The vault for this computer. On Linux the Secret Service may be missing or
 * unreachable (an SSH session has no session bus). The first save then
 * fails and the key goes to the owner-only file, with a notice. Reading never
 * waits on a probe.
 */
export function openVault(
  platform: NodeJS.Platform = process.platform,
  run: RunCommand = runCommand,
  file: CredentialStore = new KeyFileStore(),
  env: Record<string, string | undefined> = process.env,
): CredentialVault {
  // For a test run or a CI job: never touch the system keychain.
  if ((env.TELLAGEN_CREDENTIAL_STORE ?? "").trim().toLowerCase() === "file") return new CredentialVault(undefined, file, true);
  if (platform === "darwin") return new CredentialVault(new MacKeychainStore(run), file, false);
  if (platform === "linux") return new CredentialVault(new SecretToolStore(run), file, true);
  if (platform === "win32") return new CredentialVault(new WindowsVaultStore(run), file, true);
  return new CredentialVault(undefined, file, true);
}
