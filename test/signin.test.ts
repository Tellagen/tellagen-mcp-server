import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { TellagenClient } from "../src/client.js";
import { CredentialVault, MemoryStore } from "../src/credentials.js";
import { SignInIndex } from "../src/signin-index.js";
import {
  SignInManager,
  Secret,
  expiryLine,
  pollDeviceToken,
  registrableDomain,
  sameRegistrableDomain,
  resolveCredentials,
  safeUrl,
  signInBaseUrl,
  signOut,
  startDeviceSignIn,
  type FetchLike,
} from "../src/signin.js";
import { startTellagenServer } from "../src/start.js";
import { jsonResponse } from "./helpers/harness.js";

const DEVICE_CODE = "tgdc_ThisIsTheSecretDeviceCode0123456789abcdefg";
const KEY = "tgn_TheApiKeyOfThePerson_0123456789";
const ROOT = "https://api.tellagen.com";
const WORKSPACE_API = "https://acme.api.tellagen.com";

const started = {
  device_code: DEVICE_CODE,
  user_code: "WXRT-4821",
  verification_uri: "https://tellagen.com/connect",
  verification_uri_complete: "https://tellagen.com/connect?code=WXRT-4821",
  expires_in: 600,
  interval: 5,
};

function approved(extra: Record<string, unknown> = {}) {
  return {
    status: "approved",
    api_key: KEY,
    api_base_url: WORKSPACE_API,
    key: { id: 42, expires_at: new Date(Date.now() + 30 * 86_400_000).toISOString() },
    workspace: { name: "Acme", subdomain: "acme", url: "https://acme.tellagen.com" },
    ...extra,
  };
}

/** A Tellagen that answers the sign-in routes in the order given. */
function script(tokenAnswers: Array<Response | (() => Response)>) {
  const calls: Array<{ url: string; body: any; headers: Headers }> = [];
  const answers = [...tokenAnswers];
  const fetchFn: FetchLike = async (input, init) => {
    const url = String(input);
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ url, body, headers: new Headers(init?.headers) });
    if (url.endsWith("/api/v1/auth/device/start")) return jsonResponse(started);
    if (url.endsWith("/api/v1/auth/device/token")) {
      const next = answers.length > 1 ? answers.shift()! : answers[0]!;
      return typeof next === "function" ? next() : next.clone();
    }
    if (url.endsWith("/api/v1/auth/me")) return jsonResponse({ user: { email: "a@b.c" } });
    return jsonResponse({}, 404);
  };
  return { fetchFn, calls };
}

describe("the device flow functions", () => {
  it("starts with the client facts and keeps the device code secret", async () => {
    const { fetchFn, calls } = script([jsonResponse({ status: "authorization_pending", interval: 5 })]);
    const start = await startDeviceSignIn(ROOT, { name: "claude-code", version: "2.1.0" }, fetchFn);
    expect(calls[0]!.body).toMatchObject({ client_name: "claude-code", client_version: "2.1.0", server_version: expect.any(String) });
    expect(start.userCode).toBe("WXRT-4821");
    expect(JSON.stringify(start)).not.toContain(DEVICE_CODE);
    expect(String(start.deviceCode)).toBe("[secret]");
    expect(start.deviceCode.reveal()).toBe(DEVICE_CODE);
  });

  it("refuses a verification address that is not https", async () => {
    const fetchFn: FetchLike = async () => jsonResponse({ ...started, verification_uri: "javascript:alert(1)", verification_uri_complete: "http://evil.example/x" });
    await expect(startDeviceSignIn(ROOT, { name: "x", version: "" }, fetchFn)).rejects.toThrow(/did not start a sign-in/);
  });

  it("reads the end states of a poll", async () => {
    const poll = (response: Response) => pollDeviceToken(ROOT, new Secret(DEVICE_CODE), async () => response);
    await expect(poll(jsonResponse({ code: "expired", message: "x" }, 410))).rejects.toMatchObject({ code: "expired" });
    await expect(
      poll(jsonResponse({ code: "denied", message: "Not approved.", details: { reason: "responder_seat_required" } }, 403)),
    ).rejects.toMatchObject({ code: "denied", reason: "responder_seat_required" });
    await expect(poll(jsonResponse({ code: "invalid_device_code", message: "x" }, 400))).rejects.toMatchObject({ code: "invalid_device_code" });
    expect(await poll(jsonResponse({ status: "slow_down", interval: 10 }))).toEqual({ state: "pending", intervalSeconds: 10 });
  });

  it("does not trust an approved answer with an address that cannot hold a key", async () => {
    const poll = (body: unknown) => pollDeviceToken(ROOT, new Secret(DEVICE_CODE), async () => jsonResponse(body));
    await expect(poll(approved({ api_base_url: "http://attacker.example" }))).rejects.toThrow(/no usable key or workspace address/);
    await expect(poll(approved({ api_base_url: "https://user:pw@acme.example" }))).rejects.toThrow();
    expect(await pollDeviceToken("http://localhost:3000", new Secret(DEVICE_CODE), async () => jsonResponse(approved({ api_base_url: "http://localhost:8080" })))).toMatchObject({ state: "approved" });
  });

  it("refuses a verification page on another domain, before any code is shown or page opened", async () => {
    for (const page of ["https://evil.example/connect", "https://tellagen.com.evil.example/connect", "https://tellagen-com.example/connect"]) {
      const fetchFn: FetchLike = async () => jsonResponse({ ...started, verification_uri: page, verification_uri_complete: `${page}?code=WXRT-4821` });
      await expect(startDeviceSignIn(ROOT, { name: "x", version: "" }, fetchFn)).rejects.toThrow(/another domain/);
    }
    // The page may be on the web host of the same domain.
    const ok: FetchLike = async () => jsonResponse(started);
    expect((await startDeviceSignIn(ROOT, { name: "x", version: "" }, ok)).verificationUri).toBe("https://tellagen.com/connect");
  });

  it("refuses an api_base_url on another domain, so the key is neither stored nor sent there", async () => {
    const poll = (url: string) => pollDeviceToken(ROOT, new Secret(DEVICE_CODE), async () => jsonResponse(approved({ api_base_url: url })));
    await expect(poll("https://acme.api.evil.example")).rejects.toThrow(/another domain/);
    await expect(poll("https://tellagen.com.evil.example")).rejects.toThrow(/another domain/);
    await expect(poll(WORKSPACE_API)).resolves.toMatchObject({ state: "approved" });
  });

  it("for an address outside the Tellagen cloud, accepts the same host, a host below it, or the parent of a deep host, and no public suffix", () => {
    const same = (candidate: string, expected: string) => sameRegistrableDomain(new URL(candidate), new URL(expected));
    expect(same("https://tellagen.corp.example/connect", "https://api.tellagen.corp.example")).toBe(true);
    expect(same("https://api.tellagen.corp.example", "https://api.tellagen.corp.example")).toBe(true);
    expect(same("https://acme.api.tellagen.corp.example", "https://api.tellagen.corp.example")).toBe(true);
    expect(same("https://corp.example", "https://api.tellagen.corp.example")).toBe(false);
    // A deployment on a shared suffix does not trust the whole suffix.
    expect(same("https://evil.vercel.app", "https://x.vercel.app")).toBe(false);
    expect(same("https://b.co.th", "https://a.b.co.th")).toBe(true);
    expect(same("https://evil.co.th", "https://a.b.co.th")).toBe(false);
    expect(same("https://evil.example", "http://127.0.0.1:3000")).toBe(false);
    expect(same("http://127.0.0.1:8080", "http://127.0.0.1:3000")).toBe(true);
  });

  it("knows the registered domain, also under a two-level suffix", () => {
    expect(registrableDomain("acme.api.tellagen.com")).toBe("tellagen.com");
    expect(registrableDomain("api.example.co.uk")).toBe("example.co.uk");
    expect(registrableDomain("localhost")).toBe("localhost");
    expect(registrableDomain("127.0.0.1")).toBe("127.0.0.1");
  });

  it("knows which addresses may be used", () => {
    expect(safeUrl("https://a.example/x")?.origin).toBe("https://a.example");
    expect(safeUrl("http://127.0.0.1:3000")).toBeDefined();
    expect(safeUrl("http://a.example")).toBeUndefined();
    expect(signInBaseUrl({})).toBe(ROOT);
    expect(signInBaseUrl({ TELLAGEN_API_URL: WORKSPACE_API })).toBe(WORKSPACE_API);
    expect(signInBaseUrl({ TELLAGEN_SIGN_IN_URL: "https://api.example.com", TELLAGEN_API_URL: WORKSPACE_API })).toBe("https://api.example.com");
    expect(() => signInBaseUrl({ TELLAGEN_SIGN_IN_URL: "http://evil.example" })).toThrow();
  });
});

describe("the sign-in manager", () => {
  let dir: string;
  let vault: CredentialVault;
  let index: SignInIndex;
  let store: MemoryStore;
  let networkSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    // The key check after a sign-in must not reach a real network.
    networkSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async () => jsonResponse({ user: { email: "a@b.c" } }));
    dir = mkdtempSync(join(tmpdir(), "tellagen-signin-"));
    store = new MemoryStore("macos-keychain");
    vault = new CredentialVault(store, new MemoryStore("file"), false);
    index = new SignInIndex(dir);
  });
  afterEach(() => {
    networkSpy.mockRestore();
    rmSync(dir, { recursive: true, force: true });
  });

  const manager = (client: TellagenClient, fetchFn: FetchLike, env: Record<string, string | undefined> = {}) =>
    new SignInManager(client, { env, vault, index, fetch: fetchFn, sleep: async () => undefined, canOpenBrowser: () => false });

  it("approves: stores the key in the keychain, remembers the workspace, and the client works", async () => {
    const { fetchFn, calls } = script([jsonResponse({ status: "authorization_pending", interval: 5 }), jsonResponse(approved())]);
    const client = new TellagenClient({ apiUrl: "", apiKey: "" });
    const flow = manager(client, fetchFn);
    const waiting = await flow.begin({});
    expect(waiting.status).toBe("waiting");
    expect(waiting.user_code).toBe("WXRT-4821");
    expect(JSON.stringify(waiting)).not.toContain(DEVICE_CODE);
    const done = await flow.begin({ waitMs: 1000 });
    // The sleep of the test returns at once, so wait for the background poll.
    const final = done.status === "signed_in" ? done : await vi.waitFor(() => {
      const view = flow.current();
      if (view?.status !== "signed_in") throw new Error("not yet");
      return view;
    });
    expect(final.workspace).toBe("Acme");
    expect(final.storage).toBe("macOS Keychain");
    expect(JSON.stringify(final)).not.toContain(KEY);
    expect(await store.get("acme.api.tellagen.com")).toBe(KEY);
    expect(index.find()?.entry).toMatchObject({ api_url: WORKSPACE_API, workspace_name: "Acme", storage: "macos-keychain" });
    expect(JSON.stringify(index.read())).not.toContain(KEY);
    expect(client.apiUrl()).toBe(WORKSPACE_API);
    // The device code went only to the token route.
    expect(calls.filter((c) => JSON.stringify(c.body ?? {}).includes(DEVICE_CODE)).every((c) => c.url.endsWith("/device/token"))).toBe(true);
  });

  it("reports a denial with its reason and creates no key", async () => {
    const { fetchFn } = script([jsonResponse({ code: "denied", message: "A responder seat is needed.", details: { reason: "responder_seat_required" } }, 403)]);
    const client = new TellagenClient({ apiUrl: "", apiKey: "" });
    const flow = manager(client, fetchFn);
    await flow.begin({});
    const view = await vi.waitFor(() => {
      const current = flow.current();
      if (current?.status === "waiting") throw new Error("not yet");
      return current!;
    });
    expect(view.status).toBe("denied");
    expect(view.reason).toBe("responder_seat_required");
    expect(store.entries.size).toBe(0);
    expect(index.list()).toHaveLength(0);
  });

  it("reports an expired code and starts a new one on request", async () => {
    const { fetchFn } = script([jsonResponse({ code: "expired", message: "x" }, 410)]);
    const client = new TellagenClient({ apiUrl: "", apiKey: "" });
    const flow = manager(client, fetchFn);
    await flow.begin({});
    const view = await vi.waitFor(() => {
      const current = flow.current();
      if (current?.status === "waiting") throw new Error("not yet");
      return current!;
    });
    expect(view.status).toBe("expired");
    expect(view.message).toContain("tellagen_sign_in");
    const again = await flow.begin({});
    expect(again.status).toBe("waiting");
  });

  it("a second sign-in replaces the key of the same workspace and keeps another workspace", async () => {
    await vault.save("other.api.tellagen.com", "tgn_OtherWorkspaceKey_0123456789");
    index.save("other.api.tellagen.com", { api_url: "https://other.api.tellagen.com", signed_in_at: "2026-11-01T00:00:00Z", storage: "macos-keychain" });
    for (const key of [KEY, "tgn_TheSecondKey_0123456789abc"]) {
      const { fetchFn } = script([jsonResponse(approved({ api_key: key }))]);
      const client = new TellagenClient({ apiUrl: "", apiKey: "" });
      const flow = manager(client, fetchFn);
      await flow.begin({ restart: true });
      await vi.waitFor(() => {
        if (flow.current()?.status !== "signed_in") throw new Error("not yet");
      });
    }
    expect(await store.get("acme.api.tellagen.com")).toBe("tgn_TheSecondKey_0123456789abc");
    expect(await store.get("other.api.tellagen.com")).toBe("tgn_OtherWorkspaceKey_0123456789");
    expect(index.list().map((item) => item.account).sort()).toEqual(["acme.api.tellagen.com", "other.api.tellagen.com"]);
    expect(index.find()?.account).toBe("acme.api.tellagen.com");
  });

  it("ignores an address in the tool call and starts only at the configured server", async () => {
    const { fetchFn, calls } = script([jsonResponse({ status: "authorization_pending", interval: 5 })]);
    const client = new TellagenClient({ apiUrl: "", apiKey: "" });
    const flow = manager(client, fetchFn, { TELLAGEN_API_URL: WORKSPACE_API });
    await flow.begin({ ...( { api_url: "https://evil.example" } as object ) });
    expect(calls[0]!.url.startsWith(WORKSPACE_API)).toBe(true);
    flow.cancel();
  });

  it("does not let restart override TELLAGEN_API_KEY", async () => {
    const { fetchFn, calls } = script([jsonResponse(approved())]);
    const client = new TellagenClient({ apiUrl: WORKSPACE_API, apiKey: "tllg_from_env_0123456789" });
    const view = await manager(client, fetchFn, { TELLAGEN_API_KEY: "tllg_from_env_0123456789" }).begin({ restart: true });
    expect(view.status).toBe("failed");
    expect(calls).toHaveLength(0);
  });

  it("does nothing when TELLAGEN_API_KEY is set, because the variable wins", async () => {
    const { fetchFn, calls } = script([jsonResponse(approved())]);
    const client = new TellagenClient({ apiUrl: WORKSPACE_API, apiKey: "tllg_from_env_0123456789" });
    const view = await manager(client, fetchFn, { TELLAGEN_API_KEY: "tllg_from_env_0123456789" }).begin({});
    expect(view.status).toBe("failed");
    expect(view.message).toContain("TELLAGEN_API_KEY");
    expect(calls).toHaveLength(0);
  });

  it("says so when the key cannot be stored, and never shows the key", async () => {
    const broken = new CredentialVault(
      Object.assign(new MemoryStore("macos-keychain"), {
        set: async () => {
          throw new Error("The macOS Keychain did not keep the key.");
        },
      }),
      new MemoryStore("file"),
      false,
    );
    const { fetchFn } = script([jsonResponse(approved())]);
    const client = new TellagenClient({ apiUrl: "", apiKey: "" });
    const flow = new SignInManager(client, { env: {}, vault: broken, index, fetch: fetchFn, sleep: async () => undefined, canOpenBrowser: () => false });
    await flow.begin({});
    const view = await vi.waitFor(() => {
      const current = flow.current();
      if (current?.status === "waiting") throw new Error("not yet");
      return current!;
    });
    expect(view.status).toBe("failed");
    expect(view.message).toContain("did not keep the key");
    expect(JSON.stringify(view)).not.toContain(KEY);
    expect(client.auth()).toBe("missing");
  });

  it("opens the browser when it can, and not over SSH", async () => {
    const open = vi.fn(() => true);
    const { fetchFn } = script([jsonResponse({ status: "authorization_pending", interval: 5 })]);
    const client = new TellagenClient({ apiUrl: "", apiKey: "" });
    const withBrowser = new SignInManager(client, { env: {}, vault, index, fetch: fetchFn, sleep: () => new Promise(() => undefined), canOpenBrowser: () => true, openBrowser: open });
    const view = await withBrowser.begin({});
    expect(open).toHaveBeenCalledWith("https://tellagen.com/connect?code=WXRT-4821");
    expect(view.opened_browser).toBe(true);
    const noBrowser = new SignInManager(client, { env: {}, vault, index, fetch: fetchFn, sleep: () => new Promise(() => undefined), canOpenBrowser: () => false, openBrowser: open });
    open.mockClear();
    expect((await noBrowser.begin({})).opened_browser).toBe(false);
    expect(open).not.toHaveBeenCalled();
  });
});

describe("which key is used", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "tellagen-resolve-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  async function signedIn() {
    const store = new MemoryStore("macos-keychain");
    const vault = new CredentialVault(store, new MemoryStore("file"), false);
    const index = new SignInIndex(dir);
    await vault.save("acme.api.tellagen.com", KEY);
    index.save("acme.api.tellagen.com", { api_url: WORKSPACE_API, workspace_name: "Acme", signed_in_at: "2026-11-01T00:00:00Z", storage: "macos-keychain" });
    return { vault, index, store };
  }

  it("uses the stored sign-in when the environment has nothing", async () => {
    const { vault, index } = await signedIn();
    expect(await resolveCredentials({}, vault, index)).toMatchObject({ source: "sign-in", apiUrl: WORKSPACE_API, apiKey: KEY });
  });

  it("lets TELLAGEN_API_KEY and TELLAGEN_API_URL win", async () => {
    const { vault, index } = await signedIn();
    const result = await resolveCredentials({ TELLAGEN_API_KEY: "tllg_env_key_0123456789", TELLAGEN_API_URL: "https://env.api.tellagen.com" }, vault, index);
    expect(result).toMatchObject({ source: "environment", apiKey: "tllg_env_key_0123456789", apiUrl: "https://env.api.tellagen.com" });
  });

  it("uses the stored key of the address that TELLAGEN_API_URL names, and not another", async () => {
    const { vault, index } = await signedIn();
    expect((await resolveCredentials({ TELLAGEN_API_URL: WORKSPACE_API }, vault, index)).apiKey).toBe(KEY);
    const other = await resolveCredentials({ TELLAGEN_API_URL: "https://other.api.tellagen.com" }, vault, index);
    expect(other.apiKey).toBe("");
    expect(other.source).toBe("none");
  });

  it("says what is wrong when the key left the keychain", async () => {
    const { vault, index, store } = await signedIn();
    store.entries.clear();
    const result = await resolveCredentials({}, vault, index);
    expect(result.apiKey).toBe("");
    expect(result.problem).toContain("Sign in again");
  });

  it("signs out: the key and the index entry are gone, and the other workspace stays", async () => {
    const { vault, index, store } = await signedIn();
    await vault.save("other.api.tellagen.com", "tgn_OtherWorkspaceKey_0123456789");
    index.save("other.api.tellagen.com", { api_url: "https://other.api.tellagen.com", signed_in_at: "2026-11-01T00:00:00Z", storage: "macos-keychain" });
    const result = await signOut(vault, index, "acme.api.tellagen.com");
    expect(result.signedOut).toEqual(["acme.api.tellagen.com"]);
    expect(store.entries.has("acme.api.tellagen.com")).toBe(false);
    expect(index.list().map((item) => item.account)).toEqual(["other.api.tellagen.com"]);
    await signOut(vault, index);
    expect(store.entries.size).toBe(0);
    expect(index.list()).toHaveLength(0);
  });

  it("adds a line for a key that expires in under 7 days, and only then", () => {
    const entry = (days: number) => ({ api_url: WORKSPACE_API, signed_in_at: "x", storage: "file" as const, expires_at: new Date(Date.now() + days * 86_400_000).toISOString() });
    expect(expiryLine(entry(3))).toContain("expires in 3 days");
    expect(expiryLine(entry(30))).toBeUndefined();
    expect(expiryLine(entry(-1))).toContain("has expired");
    expect(expiryLine({ api_url: WORKSPACE_API, signed_in_at: "x", storage: "file" })).toBeUndefined();
  });
});

describe("the sign-in tool", () => {
  it("is listed with no key, shows the code, and the answer holds no key or device code", async () => {
    const { fetchFn } = script([jsonResponse({ status: "authorization_pending", interval: 5 }), jsonResponse(approved())]);
    const store = new MemoryStore("macos-keychain");
    const dir = mkdtempSync(join(tmpdir(), "tellagen-tool-"));
    try {
      const api = new TellagenClient({ apiUrl: "", apiKey: "" });
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      const mcp = new Client({ name: "claude-code", version: "2.1.0" }, { capabilities: {} });
      const spy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => fetchFn(String(input), init as RequestInit));
      const server = await startTellagenServer(api, serverTransport, {
        signIn: { vault: new CredentialVault(store, new MemoryStore("file"), false), index: new SignInIndex(dir), env: {}, fetch: fetchFn, sleep: async () => undefined, canOpenBrowser: () => false },
      });
      await mcp.connect(clientTransport);
      const tools = (await mcp.listTools()).tools;
      expect(tools.map((tool) => tool.name)).toContain("tellagen_sign_in");
      // The model cannot choose the server.
      expect(Object.keys(tools.find((tool) => tool.name === "tellagen_sign_in")!.inputSchema.properties ?? {})).toEqual(["wait_seconds", "restart"]);

      const first = (await mcp.callTool({ name: "tellagen_sign_in", arguments: {} })) as { content: Array<{ text: string }> };
      const waiting = JSON.parse(first.content[0]!.text);
      expect(waiting.status).toBe("waiting");
      expect(waiting.user_code).toBe("WXRT-4821");
      expect(first.content[0]!.text).not.toContain(DEVICE_CODE);

      await vi.waitFor(async () => {
        const next = (await mcp.callTool({ name: "tellagen_sign_in", arguments: {} })) as { content: Array<{ text: string }> };
        if (JSON.parse(next.content[0]!.text).status === "waiting") throw new Error("not yet");
      });
      const after = (await mcp.callTool({ name: "tellagen_sign_in", arguments: {} })) as { content: Array<{ text: string }> };
      expect(after.content[0]!.text).not.toContain(KEY);
      expect(after.content[0]!.text).not.toContain(DEVICE_CODE);
      expect(await store.get("acme.api.tellagen.com")).toBe(KEY);
      expect(api.apiUrl()).toBe(WORKSPACE_API);
      await mcp.close();
      await server.close();
      spy.mockRestore();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
