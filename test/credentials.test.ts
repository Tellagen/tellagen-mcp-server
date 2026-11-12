import { mkdtempSync, rmSync, statSync, chmodSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  CredentialVault,
  KEYCHAIN_SERVICE,
  KeyFileStore,
  MacKeychainStore,
  MemoryStore,
  SecretToolStore,
  accountFor,
  openVault,
  type CommandResult,
  type RunCommand,
} from "../src/credentials.js";

const KEY = "tgn_AbCdEf0123456789_secretvalue";
const ACCOUNT = "acme.api.tellagen.com";

interface Call {
  command: string;
  args: readonly string[];
  input?: string;
  env?: Record<string, string>;
}

const ok = (stdout = ""): CommandResult => ({ code: 0, stdout, stderr: "", missing: false, timedOut: false });
const failed = (stderr = "error"): CommandResult => ({ code: 1, stdout: "", stderr, missing: false, timedOut: false });
const absent: CommandResult = { code: null, stdout: "", stderr: "", missing: true, timedOut: false };

/** A pretend `security` command with a keychain in memory. */
function fakeSecurity(calls: Call[], options: { drop?: boolean } = {}): RunCommand {
  const items = new Map<string, string>();
  return async (command, args, opts) => {
    calls.push({ command, args, input: opts?.input, env: opts?.env });
    if (args[0] === "-i") {
      const match = /-a "([^"]+)" .* -w "([^"]+)"/.exec(opts?.input ?? "");
      if (match && !options.drop) items.set(match[1]!, match[2]!);
      // The real command can exit 0 after an error.
      return ok();
    }
    const account = args[args.indexOf("-a") + 1]!;
    if (args[0] === "find-generic-password") return items.has(account) ? ok(`${items.get(account)}\n`) : { ...failed("not found"), code: 44 };
    if (args[0] === "delete-generic-password") {
      items.delete(account);
      return ok();
    }
    return failed();
  };
}

describe("the macOS keychain store", () => {
  it("passes the key on standard input, never in the arguments, and reads it back", async () => {
    const calls: Call[] = [];
    const store = new MacKeychainStore(fakeSecurity(calls));
    await store.set(ACCOUNT, KEY);
    expect(await store.get(ACCOUNT)).toBe(KEY);
    const write = calls.find((call) => call.args[0] === "-i")!;
    expect(write.input).toContain(KEY);
    for (const call of calls) expect(call.args.join(" ")).not.toContain(KEY);
    expect(write.input).toContain(`-s "${KEYCHAIN_SERVICE}"`);
    await store.delete(ACCOUNT);
    expect(await store.get(ACCOUNT)).toBeUndefined();
  });

  it("fails when the keychain did not keep the key, without the key in the message", async () => {
    const store = new MacKeychainStore(fakeSecurity([], { drop: true }));
    const err = await store.set(ACCOUNT, KEY).catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toContain("did not keep the key");
    expect((err as Error).message).not.toContain(KEY);
  });

  it("refuses a key or an account that could break the command", async () => {
    const calls: Call[] = [];
    const store = new MacKeychainStore(fakeSecurity(calls));
    await expect(store.set(ACCOUNT, 'tgn_abc" ; delete-generic-password -s x')).rejects.toThrow(/cannot be stored/);
    await expect(store.set('bad"account', KEY)).rejects.toThrow(/cannot be stored/);
    expect(calls).toHaveLength(0);
  });
});

describe("the Secret Service store", () => {
  it("passes the key on standard input", async () => {
    const calls: Call[] = [];
    const items = new Map<string, string>();
    const run: RunCommand = async (command, args, opts) => {
      calls.push({ command, args, input: opts?.input });
      const account = args[args.indexOf("account") + 1]!;
      if (args[0] === "store") {
        items.set(account, (opts?.input ?? "").trim());
        return ok();
      }
      if (args[0] === "lookup") return items.has(account) ? ok(items.get(account)) : failed("");
      items.delete(account);
      return ok();
    };
    const store = new SecretToolStore(run);
    await store.set(ACCOUNT, KEY);
    expect(await store.get(ACCOUNT)).toBe(KEY);
    expect(calls.find((c) => c.args[0] === "store")!.input).toBe(KEY);
    for (const call of calls) expect(call.args.join(" ")).not.toContain(KEY);
  });
});

describe("the key file and the vault", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "tellagen-cred-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("writes a key file readable by the owner only", async () => {
    const store = new KeyFileStore(join(dir, "credentials"));
    await store.set(ACCOUNT, KEY);
    const path = store.path(ACCOUNT);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(statSync(join(dir, "credentials")).mode & 0o777).toBe(0o700);
    expect(await store.get(ACCOUNT)).toBe(KEY);
    await store.delete(ACCOUNT);
    expect(await store.get(ACCOUNT)).toBeUndefined();
  });

  it("refuses to read a key file that other users can read", async () => {
    const store = new KeyFileStore(join(dir, "credentials"));
    await store.set(ACCOUNT, KEY);
    chmodSync(store.path(ACCOUNT), 0o644);
    await expect(store.get(ACCOUNT)).rejects.toThrow(/chmod 600/);
  });

  it("uses the keychain and writes no file", async () => {
    const file = new KeyFileStore(join(dir, "credentials"));
    const vault = new CredentialVault(new MemoryStore("macos-keychain"), file, false);
    const saved = await vault.save(ACCOUNT, KEY);
    expect(saved).toEqual({ kind: "macos-keychain" });
    expect(readdirSync(dir)).toEqual([]);
    expect(await vault.load(ACCOUNT, "macos-keychain")).toBe(KEY);
  });

  it("falls back to the file on a computer with no keychain, and says so", async () => {
    const broken = new SecretToolStore(async () => absent);
    const file = new KeyFileStore(join(dir, "credentials"));
    const vault = new CredentialVault(broken, file, true);
    const saved = await vault.save(ACCOUNT, KEY);
    expect(saved.kind).toBe("file");
    expect(saved.fileNotice).toContain("no usable keychain");
    expect(saved.fileNotice).toContain(".key");
    expect(saved.fileNotice).not.toContain(KEY);
    expect(await vault.load(ACCOUNT, "file")).toBe(KEY);
  });

  it("does not move the key to a file when macOS refuses it", async () => {
    const refusing: MemoryStore = new MemoryStore("macos-keychain");
    refusing.set = async () => {
      throw new Error("The macOS Keychain did not keep the key.");
    };
    const vault = new CredentialVault(refusing, new KeyFileStore(join(dir, "credentials")), false);
    await expect(vault.save(ACCOUNT, KEY)).rejects.toThrow(/Nothing was written to a file/);
    expect(readdirSync(dir)).toEqual([]);
  });

  it("removes the key from every place", async () => {
    const keychain = new MemoryStore("libsecret");
    const file = new KeyFileStore(join(dir, "credentials"));
    await keychain.set(ACCOUNT, KEY);
    await file.set(ACCOUNT, KEY);
    const vault = new CredentialVault(keychain, file, true);
    await vault.remove(ACCOUNT);
    expect(await keychain.get(ACCOUNT)).toBeUndefined();
    expect(await file.get(ACCOUNT)).toBeUndefined();
  });

  it("never touches the keychain when TELLAGEN_CREDENTIAL_STORE is file", async () => {
    const calls: Call[] = [];
    const vault = openVault("darwin", fakeSecurity(calls), new KeyFileStore(join(dir, "credentials")), { TELLAGEN_CREDENTIAL_STORE: "file" });
    const saved = await vault.save(ACCOUNT, KEY);
    expect(saved.kind).toBe("file");
    expect(calls).toHaveLength(0);
  });

  it("names an account from the host of the API address", () => {
    expect(accountFor("https://Acme.api.tellagen.com/path")).toBe("acme.api.tellagen.com");
    expect(() => accountFor("not a url")).toThrow();
  });
});
