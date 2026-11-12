import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { loginCommand, logoutCommand, statusCommand } from "../src/cli/auth.js";
import type { CliIo } from "../src/cli/io.js";
import { CredentialVault, MemoryStore } from "../src/credentials.js";
import { RunStateStore, workspaceKey } from "../src/run-state.js";
import { SignInIndex } from "../src/signin-index.js";
import type { FetchLike } from "../src/signin.js";
import { MCP_SERVER_VERSION } from "../src/version.js";
import { jsonResponse } from "./helpers/harness.js";

const DEVICE_CODE = "tgdc_SecretDeviceCodeForTheCliTest0123456789";
const KEY = "tgn_TheKeyOfTheCliTest_0123456789";
const API = "https://acme.api.tellagen.com";

function makeIo(env: Record<string, string | undefined> = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const io: CliIo = { env, stdout: (t) => void out.push(t), stderr: (t) => void err.push(t), readStdin: async () => "" };
  return { io, out, err, text: () => out.join("") + err.join("") };
}

describe("login, logout and status", () => {
  let dir: string;
  let store: MemoryStore;
  let vault: CredentialVault;
  let index: SignInIndex;
  let networkSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "tellagen-cli-"));
    store = new MemoryStore("macos-keychain");
    vault = new CredentialVault(store, new MemoryStore("file"), false);
    index = new SignInIndex(dir);
    networkSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async () => jsonResponse({ user: { email: "a@b.c" } }));
  });
  afterEach(() => {
    networkSpy.mockRestore();
    rmSync(dir, { recursive: true, force: true });
  });

  const fetchFor = (token: Response): FetchLike => async (input) => {
    const url = String(input);
    if (url.endsWith("/device/start")) {
      return jsonResponse({
        device_code: DEVICE_CODE,
        user_code: "WXRT-4821",
        verification_uri: "https://tellagen.com/connect",
        verification_uri_complete: "https://tellagen.com/connect?code=WXRT-4821",
        expires_in: 600,
        interval: 1,
      });
    }
    return token.clone();
  };
  const approvedResponse = () =>
    jsonResponse({
      status: "approved",
      api_key: KEY,
      api_base_url: API,
      key: { expires_at: "2027-02-10T09:00:00Z" },
      workspace: { name: "Acme", url: "https://acme.tellagen.com" },
    });

  it("login shows the code, stores the key and prints no key and no device code", async () => {
    const run = makeIo({});
    const code = await loginCommand(["--no-browser"], run.io, {
      vault,
      index,
      fetch: fetchFor(approvedResponse()),
      sleep: async () => undefined,
      canOpenBrowser: () => false,
    });
    expect(code).toBe(0);
    expect(run.text()).toContain("WXRT-4821");
    expect(run.text()).toContain("https://tellagen.com/connect");
    expect(run.text()).toContain("Signed in to Acme");
    expect(run.text()).toContain("2027-02-10");
    expect(run.text()).not.toContain(KEY);
    expect(run.text()).not.toContain(DEVICE_CODE);
    expect(await store.get("acme.api.tellagen.com")).toBe(KEY);
  });

  it("login exits with 1 and a reason when the person denies", async () => {
    const run = makeIo({});
    const code = await loginCommand(["--no-browser"], run.io, {
      vault,
      index,
      fetch: fetchFor(jsonResponse({ code: "denied", message: "The sign-in was cancelled.", details: { reason: "cancelled" } }, 403)),
      sleep: async () => undefined,
      canOpenBrowser: () => false,
    });
    expect(code).toBe(1);
    expect(run.err.join("")).toContain("cancelled");
    expect(store.entries.size).toBe(0);
  });

  it("login exits with 1 when the code expires", async () => {
    const run = makeIo({});
    const code = await loginCommand([], run.io, {
      vault,
      index,
      fetch: fetchFor(jsonResponse({ code: "expired", message: "x" }, 410)),
      sleep: async () => undefined,
      canOpenBrowser: () => false,
    });
    expect(code).toBe(1);
    expect(run.err.join("")).toContain("expired");
  });

  it("login refuses a client name it does not know and an unknown flag", async () => {
    expect(await loginCommand(["--client", "vim"], makeIo().io, { vault, index })).toBe(2);
    expect(await loginCommand(["--bogus"], makeIo().io, { vault, index })).toBe(2);
  });

  it("logout clears the key and the index, and says that the key stays valid in Tellagen", async () => {
    await vault.save("acme.api.tellagen.com", KEY);
    index.save("acme.api.tellagen.com", { api_url: API, signed_in_at: "2026-11-01T00:00:00Z", storage: "macos-keychain" });
    const run = makeIo({});
    expect(await logoutCommand([], run.io, { vault, index })).toBe(0);
    expect(store.entries.size).toBe(0);
    expect(index.list()).toHaveLength(0);
    expect(run.text()).toContain("Signed out: acme.api.tellagen.com");
    expect(run.text()).toContain("keeps it valid");
    expect(run.text()).not.toContain(KEY);
  });

  it("logout with nothing stored says so, and warns about a key in the environment", async () => {
    const run = makeIo({ TELLAGEN_API_KEY: "tllg_env_key_0123456789" });
    expect(await logoutCommand([], run.io, { vault, index })).toBe(0);
    expect(run.text()).toContain("No sign-in is stored");
    expect(run.text()).toContain("TELLAGEN_API_KEY is set");
    expect(run.text()).not.toContain("tllg_env_key");
  });

  it("status --line is silent when all is well and one sentence when something needs a person", async () => {
    await vault.save("acme.api.tellagen.com", KEY);
    const later = new Date(Date.now() + 60 * 86_400_000).toISOString();
    index.save("acme.api.tellagen.com", { api_url: API, workspace_name: "Acme", signed_in_at: "x", storage: "macos-keychain", expires_at: later });
    const quiet = makeIo({ TELLAGEN_STATE_DIR: join(dir, "state") });
    expect(await statusCommand(["--line"], quiet.io, { vault, index })).toBe(0);
    expect(quiet.text()).toBe("");

    index.update("acme.api.tellagen.com", { expires_at: new Date(Date.now() + 2 * 86_400_000).toISOString() });
    const soon = makeIo({ TELLAGEN_STATE_DIR: join(dir, "state") });
    await statusCommand(["--line"], soon.io, { vault, index });
    expect(soon.out.join("").trim().split("\n")).toHaveLength(1);
    expect(soon.text()).toContain("expires in");

    index.update("acme.api.tellagen.com", { expires_at: later, update_available: { your_version: MCP_SERVER_VERSION, current_version: "9.9.9", seen_at: "x" } });
    const old = makeIo({ TELLAGEN_STATE_DIR: join(dir, "state") });
    await statusCommand(["--line"], old.io, { vault, index });
    expect(old.text()).toContain("older than 9.9.9");

    new RunStateStore(join(dir, "state"), workspaceKey(API)).write({
      version: 1,
      run_id: "run-77",
      picked_up_at: "x",
      server_capabilities: [],
      session_id: "s",
      pid: process.pid,
    });
    const open = makeIo({ TELLAGEN_STATE_DIR: join(dir, "state") });
    await statusCommand(["--line"], open.io, { vault, index });
    expect(open.out.join("").trim().split("\n")).toHaveLength(1);
    expect(open.text()).toContain("Call tellagen_resume");
    expect(open.text()).not.toContain(KEY);
  });

  it("status --line tells the model to ask for a sign-in when nothing is set up", async () => {
    const run = makeIo({ TELLAGEN_STATE_DIR: join(dir, "state") });
    await statusCommand(["--line"], run.io, { vault, index });
    expect(run.text()).toContain("/tellagen:connect");
  });

  it("status prints the facts and no key", async () => {
    await vault.save("acme.api.tellagen.com", KEY);
    index.save("acme.api.tellagen.com", { api_url: API, workspace_name: "Acme", signed_in_at: "x", storage: "macos-keychain", expires_at: "2027-02-10T09:00:00Z" });
    const run = makeIo({ TELLAGEN_STATE_DIR: join(dir, "state") });
    await statusCommand([], run.io, { vault, index });
    expect(run.text()).toContain("Signed in to Acme");
    expect(run.text()).toContain("macOS Keychain");
    expect(run.text()).not.toContain(KEY);
    const json = makeIo({ TELLAGEN_STATE_DIR: join(dir, "state") });
    await statusCommand(["--json"], json.io, { vault, index });
    expect(JSON.parse(json.out.join("")).signed_in).toBe(true);
    expect(json.text()).not.toContain(KEY);
  });
});
