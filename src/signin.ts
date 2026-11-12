import { spawn } from "node:child_process";
import type { TellagenClient } from "./client.js";
import { type CredentialVault, accountFor, describeStore } from "./credentials.js";
import { computerName, type ClientIdentity } from "./identity.js";
import { SignInIndex, type SignInEntry } from "./signin-index.js";
import { MCP_SERVER_VERSION } from "./version.js";

/**
 * Browser sign-in for a client (the device-code flow).
 *
 * 1. Start: Tellagen answers with a short code to show and a secret device
 *    code that only this process keeps.
 * 2. The person opens the address, signs in and approves the code.
 * 3. Poll: Tellagen creates a personal key when this client collects it, and
 *    shows it once. It goes to the keychain at once.
 *
 * The device code and the key never leave this file's variables except
 * to Tellagen and to the keychain. They are not logged, not returned from a
 * tool and not part of an error message.
 */

export const DEFAULT_SIGN_IN_URL = "https://api.tellagen.com";
const REQUEST_TIMEOUT_MS = 15_000;
const MAX_POLL_FAILURES = 5;
export const EXPIRY_WARNING_DAYS = 7;

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export class SignInError extends Error {
  constructor(
    readonly code: "expired" | "denied" | "invalid_device_code" | "rate_limited" | "busy" | "network" | "bad_answer" | "storage",
    message: string,
    /** For `denied`: the reason Tellagen gave, such as responder_seat_required. */
    readonly reason?: string,
  ) {
    super(message);
    this.name = "SignInError";
  }
}

/** A secret that prints as a placeholder, so a log line or JSON dump cannot leak it. */
export class Secret {
  readonly #value: string;
  constructor(value: string) {
    this.#value = value;
  }
  reveal(): string {
    return this.#value;
  }
  toString(): string {
    return "[secret]";
  }
  toJSON(): string {
    return "[secret]";
  }
  [Symbol.for("nodejs.util.inspect.custom")](): string {
    return "[secret]";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A URL that may receive a key or be opened: https, or http on this computer. */
export function safeUrl(value: unknown): URL | undefined {
  if (typeof value !== "string" || value.length > 500) return undefined;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return undefined;
  }
  if (url.username || url.password) return undefined;
  const loopback = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]" || url.hostname.endsWith(".localhost");
  if (url.protocol === "https:" || (url.protocol === "http:" && loopback)) return url;
  return undefined;
}

/**
 * The address that starts a sign-in: TELLAGEN_SIGN_IN_URL, else the API
 * address already chosen, else the Tellagen cloud. Every API host accepts the
 * start route, so a workspace address works too.
 */
/** Second-level public suffixes that need three labels for a registrable domain. */
const TWO_LEVEL_SUFFIXES = new Set([
  "co.uk", "org.uk", "ac.uk", "gov.uk", "com.au", "net.au", "org.au", "co.nz", "co.jp", "com.br",
  "co.in", "co.za", "com.sg", "com.hk", "com.mx", "com.tr", "co.kr",
]);

/** The domain a host is registered under, such as `tellagen.com` for `acme.api.tellagen.com`. */
export function registrableDomain(host: string): string {
  const name = host.toLowerCase().replace(/\.$/, "");
  // An address, a bracketed IPv6 address or a single label stands for itself.
  if (/^[\d.]+$/.test(name) || name.startsWith("[") || !name.includes(".")) return name;
  const labels = name.split(".");
  const tail2 = labels.slice(-2).join(".");
  return TWO_LEVEL_SUFFIXES.has(tail2) && labels.length >= 3 ? labels.slice(-3).join(".") : tail2;
}

/**
 * Whether an address from Tellagen's answer is on the same registered domain
 * as the address the sign-in started at. A page to open and a host to send a
 * key to must both pass: otherwise a server that was told to start a sign-in
 * could send the person, and the key, anywhere.
 */
export function sameRegistrableDomain(candidate: URL, expected: URL): boolean {
  const want = expected.hostname.toLowerCase();
  const got = candidate.hostname.toLowerCase();
  // The Tellagen cloud: the registered domain is known.
  if (registrableDomain(want) === "tellagen.com") return registrableDomain(got) === "tellagen.com";
  // Any other address (a self-hosted Tellagen): the same host, a host below it, or the parent of its
  // first label when that parent has three labels or more. The suffix table is short, so a wider
  // rule could let a whole public suffix such as vercel.app pass.
  if (got === want || got.endsWith(`.${want}`)) return true;
  const labels = want.split(".");
  if (labels.length >= 4 && !/^[\d.]+$/.test(want)) {
    const parent = labels.slice(1).join(".");
    return got === parent || got.endsWith(`.${parent}`);
  }
  return false;
}

export function signInBaseUrl(env: Record<string, string | undefined>, override?: string): string {
  for (const candidate of [override, env.TELLAGEN_SIGN_IN_URL, env.TELLAGEN_API_URL]) {
    const value = (candidate ?? "").trim();
    if (value) {
      const url = safeUrl(value);
      if (!url) throw new SignInError("bad_answer", "The sign-in address must be an https address.");
      return url.origin;
    }
  }
  return DEFAULT_SIGN_IN_URL;
}

export interface DeviceStart {
  deviceCode: Secret;
  userCode: string;
  verificationUri: string;
  verificationUriComplete: string;
  expiresInSeconds: number;
  intervalSeconds: number;
}

async function postJson(
  fetchFn: FetchLike,
  url: string,
  body: unknown,
): Promise<{ status: number; json: Record<string, unknown>; retryAfter?: number }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetchFn(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    let json: Record<string, unknown> = {};
    try {
      const parsed = (await res.json()) as unknown;
      if (isRecord(parsed)) json = parsed;
    } catch {
      // Not JSON: the status carries the meaning.
    }
    const retry = Number(res.headers.get("retry-after"));
    return { status: res.status, json, retryAfter: Number.isFinite(retry) && retry > 0 ? retry : undefined };
  } catch {
    throw new SignInError("network", "Tellagen could not be reached. Check the network and the sign-in address, then try again.");
  } finally {
    clearTimeout(timer);
  }
}

function cleanText(value: unknown, max: number): string {
  return typeof value === "string" ? value.replace(/[\u0000-\u001f\u007f]+/g, " ").trim().slice(0, max) : "";
}

export interface ClientFacts {
  name: string;
  version: string;
}

/** Step 1. Asks Tellagen for a code, naming this client and computer. */
export async function startDeviceSignIn(
  baseUrl: string,
  client: ClientFacts,
  fetchFn: FetchLike = fetch,
): Promise<DeviceStart> {
  const { status, json, retryAfter } = await postJson(fetchFn, `${baseUrl}/api/v1/auth/device/start`, {
    client_name: client.name,
    client_version: client.version,
    server_version: MCP_SERVER_VERSION,
    computer_name: computerName(),
  });
  if (status === 429) {
    throw new SignInError("rate_limited", `Too many sign-in attempts from this address. Try again in ${Math.ceil((retryAfter ?? 60) / 60)} minute(s).`);
  }
  if (status === 503) {
    throw new SignInError("busy", "Tellagen is busy with other sign-ins. Try again in a minute.");
  }
  const deviceCode = cleanText(json.device_code, 200);
  const userCode = cleanText(json.user_code, 40);
  const verificationUri = safeUrl(json.verification_uri);
  const complete = safeUrl(json.verification_uri_complete) ?? verificationUri;
  const expectedHost = new URL(baseUrl);
  for (const page of [verificationUri, complete]) {
    if (page && !sameRegistrableDomain(page, expectedHost)) {
      throw new SignInError(
        "bad_answer",
        `The server at ${expectedHost.hostname} sent a sign-in page on another domain (${page.hostname.slice(0, 80)}). Nothing was opened and no code is shown. Check the address you signed in at: the --url flag, TELLAGEN_SIGN_IN_URL or TELLAGEN_API_URL.`,
      );
    }
  }
  if (status !== 200 || !deviceCode || !userCode || !verificationUri || !complete) {
    throw new SignInError("bad_answer", `Tellagen did not start a sign-in (HTTP ${status}). Check that the sign-in address is a Tellagen API address.`);
  }
  const expires = Number(json.expires_in);
  const interval = Number(json.interval);
  return {
    deviceCode: new Secret(deviceCode),
    userCode,
    verificationUri: verificationUri.toString(),
    verificationUriComplete: complete.toString(),
    expiresInSeconds: Number.isFinite(expires) && expires > 0 ? Math.min(expires, 1800) : 600,
    intervalSeconds: Number.isFinite(interval) && interval > 0 ? Math.min(interval, 30) : 5,
  };
}

export interface ApprovedSignIn {
  apiKey: Secret;
  apiUrl: string;
  keyExpiresAt?: string;
  workspaceName?: string;
  workspaceUrl?: string;
}

export type PollResult =
  | { state: "pending"; intervalSeconds: number }
  | { state: "approved"; signIn: ApprovedSignIn };

/** Step 3. One poll. A pending answer carries the interval to wait. */
export async function pollDeviceToken(baseUrl: string, deviceCode: Secret, fetchFn: FetchLike = fetch): Promise<PollResult> {
  const { status, json } = await postJson(fetchFn, `${baseUrl}/api/v1/auth/device/token`, {
    device_code: deviceCode.reveal(),
  });
  const code = cleanText(json.code ?? (isRecord(json.error) ? json.error.code : undefined), 60);
  const details = isRecord(json.details) ? json.details : {};
  if (status === 410 || code === "expired") {
    throw new SignInError("expired", "The code expired before it was approved. Start the sign-in again.");
  }
  if (status === 403 || code === "denied") {
    const reason = cleanText(details.reason, 60);
    throw new SignInError("denied", cleanText(json.message, 300) || "The sign-in was not approved.", reason || undefined);
  }
  if (status === 400 || code === "invalid_device_code") {
    throw new SignInError("invalid_device_code", "Tellagen does not know this code any more. Start the sign-in again.");
  }
  if (status === 429) {
    return { state: "pending", intervalSeconds: 10 };
  }
  if (status !== 200) {
    throw new SignInError("bad_answer", `Tellagen answered the sign-in poll with HTTP ${status}.`);
  }
  const answer = cleanText(json.status, 40);
  const interval = Number(json.interval);
  if (answer === "authorization_pending" || answer === "slow_down") {
    return { state: "pending", intervalSeconds: Number.isFinite(interval) && interval > 0 ? Math.min(interval, 30) : 5 };
  }
  if (answer !== "approved") {
    throw new SignInError("bad_answer", "Tellagen answered the sign-in poll in a form this server does not know.");
  }
  const key = typeof json.api_key === "string" ? json.api_key.trim() : "";
  const apiUrl = safeUrl(json.api_base_url);
  if (apiUrl && !sameRegistrableDomain(apiUrl, new URL(baseUrl))) {
    throw new SignInError(
      "bad_answer",
      `The server at ${new URL(baseUrl).hostname} named a workspace on another domain (${apiUrl.hostname.slice(0, 80)}). The key was not stored and not used. Check the address you signed in at: the --url flag, TELLAGEN_SIGN_IN_URL or TELLAGEN_API_URL.`,
    );
  }
  if (!key || !apiUrl) {
    throw new SignInError("bad_answer", "Tellagen approved the sign-in but sent no usable key or workspace address.");
  }
  const workspace = isRecord(json.workspace) ? json.workspace : {};
  const keyInfo = isRecord(json.key) ? json.key : {};
  return {
    state: "approved",
    signIn: {
      apiKey: new Secret(key),
      apiUrl: apiUrl.origin,
      keyExpiresAt: cleanText(keyInfo.expires_at, 40) || undefined,
      workspaceName: cleanText(workspace.name, 200) || undefined,
      workspaceUrl: (() => { const w = safeUrl(workspace.url); return w && sameRegistrableDomain(w, new URL(baseUrl)) ? w.origin : undefined; })(),
    },
  };
}

/** Whether this process can show a browser to the person. */
export function canOpenBrowser(env: Record<string, string | undefined> = process.env, platform = process.platform): boolean {
  if (env.SSH_CONNECTION || env.SSH_CLIENT || env.SSH_TTY) return false;
  if (env.CI) return false;
  if (platform === "linux" && !env.DISPLAY && !env.WAYLAND_DISPLAY) return false;
  return true;
}

/** Opens an address in the browser. It never throws and shows nothing. */
export function openInBrowser(address: string, platform = process.platform): boolean {
  const url = safeUrl(address);
  if (!url) return false;
  try {
    const [command, args] =
      platform === "darwin"
        ? ["open", [url.toString()]]
        : platform === "win32"
          ? ["rundll32", ["url.dll,FileProtocolHandler", url.toString()]]
          : ["xdg-open", [url.toString()]];
    const child = spawn(command!, args as string[], { stdio: "ignore", detached: true, windowsHide: true });
    child.on("error", () => undefined);
    child.unref();
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Which key to use

export interface ResolvedCredentials {
  apiUrl: string;
  apiKey: string;
  source: "environment" | "sign-in" | "none";
  /** The sign-in this came from, when it came from one. */
  account?: string;
  entry?: SignInEntry;
  /** Why a stored key could not be read; a plain sentence. */
  problem?: string;
}

/**
 * TELLAGEN_API_KEY and TELLAGEN_API_URL win over a stored sign-in. If only
 * the address is set, the stored sign-in for that address is used. If
 * neither is set, the current sign-in is used.
 */
export async function resolveCredentials(
  env: Record<string, string | undefined>,
  vault: CredentialVault | undefined,
  index: SignInIndex,
): Promise<ResolvedCredentials> {
  const envKey = (env.TELLAGEN_API_KEY ?? "").trim();
  const envUrl = (env.TELLAGEN_API_URL ?? "").trim();
  if (envKey) return { apiUrl: envUrl, apiKey: envKey, source: "environment" };
  let account: string | undefined;
  if (envUrl) {
    try {
      account = accountFor(envUrl);
    } catch {
      return { apiUrl: envUrl, apiKey: "", source: "none" };
    }
  }
  const found = index.find(account);
  if (!found || !vault) return { apiUrl: envUrl, apiKey: "", source: "none" };
  try {
    const key = await vault.load(found.account, found.entry.storage);
    if (!key) {
      return {
        apiUrl: envUrl || found.entry.api_url,
        apiKey: "",
        source: "none",
        problem: `The key of the sign-in for ${found.account} is not in the ${describeStore(found.entry.storage)} any more. Sign in again.`,
      };
    }
    return { apiUrl: envUrl || found.entry.api_url, apiKey: key, source: "sign-in", account: found.account, entry: found.entry };
  } catch (err) {
    return {
      apiUrl: envUrl || found.entry.api_url,
      apiKey: "",
      source: "none",
      problem: err instanceof Error ? err.message : "The stored key could not be read.",
    };
  }
}

/** The days until a date, rounded up; negative when it is past. */
export function daysUntil(iso: string | undefined, now = Date.now()): number | undefined {
  if (!iso) return undefined;
  const at = Date.parse(iso);
  if (!Number.isFinite(at)) return undefined;
  return Math.ceil((at - now) / 86_400_000);
}

/** The line for a key that is about to expire or has expired, or nothing. */
export function expiryLine(entry: SignInEntry | undefined, now = Date.now()): string | undefined {
  const days = daysUntil(entry?.expires_at, now);
  if (days === undefined) return undefined;
  if (days <= 0) {
    return "The Tellagen sign-in on this computer has expired. Ask the person to sign in again (tellagen_sign_in).";
  }
  if (days < EXPIRY_WARNING_DAYS) {
    return `The Tellagen sign-in on this computer expires in ${days} day${days === 1 ? "" : "s"}. Ask the person to sign in again (tellagen_sign_in) soon.`;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// The sign-in that one server process runs

export interface SignInOptions {
  env?: Record<string, string | undefined>;
  vault: CredentialVault | undefined;
  index: SignInIndex;
  fetch?: FetchLike;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  openBrowser?: (address: string) => boolean;
  canOpenBrowser?: () => boolean;
}

export type FlowStatus = "waiting" | "signed_in" | "denied" | "expired" | "failed";

export interface FlowView {
  status: FlowStatus;
  user_code?: string;
  verification_uri?: string;
  verification_uri_complete?: string;
  expires_in_seconds?: number;
  opened_browser?: boolean;
  workspace?: string;
  api_url?: string;
  key_expires_at?: string;
  storage?: string;
  storage_notice?: string;
  reason?: string;
  message: string;
}

interface Flow {
  baseUrl: string;
  start: DeviceStart;
  startedAt: number;
  openedBrowser: boolean;
  status: FlowStatus;
  message: string;
  reason?: string;
  result?: {
    workspace?: string;
    apiUrl: string;
    keyExpiresAt?: string;
    storage: string;
    notice?: string;
  };
  done: Promise<void>;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms).unref?.());

/**
 * Runs one sign-in at a time for a client. `begin` returns at once with the
 * code to show; the polling goes on in the background and stores the key when
 * the person approves. A later call asks how it went.
 */
export class SignInManager {
  private flow: Flow | undefined;
  private cancelled = false;

  constructor(
    private readonly client: TellagenClient,
    private readonly options: SignInOptions,
  ) {}

  private env() {
    return this.options.env ?? process.env;
  }

  /** Stops the polling. The server calls it when the client disconnects. */
  cancel(): void {
    this.cancelled = true;
  }

  /** The state of the sign-in without starting one. */
  current(): FlowView | undefined {
    return this.flow ? this.view(this.flow) : undefined;
  }

  private view(flow: Flow): FlowView {
    const out: FlowView = { status: flow.status, message: flow.message };
    if (flow.status === "waiting") {
      out.user_code = flow.start.userCode;
      out.verification_uri = flow.start.verificationUri;
      out.verification_uri_complete = flow.start.verificationUriComplete;
      const left = flow.start.expiresInSeconds - Math.floor(((this.options.now?.() ?? Date.now()) - flow.startedAt) / 1000);
      out.expires_in_seconds = Math.max(0, left);
      out.opened_browser = flow.openedBrowser;
    }
    if (flow.reason) out.reason = flow.reason;
    if (flow.result) {
      out.workspace = flow.result.workspace;
      out.api_url = flow.result.apiUrl;
      out.key_expires_at = flow.result.keyExpiresAt;
      out.storage = flow.result.storage;
      if (flow.result.notice) out.storage_notice = flow.result.notice;
    }
    return out;
  }

  /**
   * Starts a sign-in, or reports the one that runs. With `waitMs` it waits
   * that long for the person to approve before it answers.
   */
  async begin(args: { restart?: boolean; waitMs?: number; baseUrl?: string; openBrowser?: boolean }): Promise<FlowView> {
    const env = this.env();
    if ((env.TELLAGEN_API_KEY ?? "").trim()) {
      return {
        status: "failed",
        message:
          "TELLAGEN_API_KEY is set in the environment of this MCP server. It wins over a sign-in, so a sign-in would change nothing. Remove TELLAGEN_API_KEY from the MCP server settings to sign in with the browser.",
      };
    }
    if (!this.flow || this.flow.status !== "waiting" || args.restart) {
      if (this.flow?.status === "signed_in" && !args.restart) {
        // The last flow worked; report it.
        return this.view(this.flow);
      }
      this.flow = await this.start(args);
    }
    const flow = this.flow;
    if (args.waitMs && flow.status === "waiting") {
      await Promise.race([flow.done, (this.options.sleep ?? defaultSleep)(args.waitMs)]);
    }
    return this.view(flow);
  }

  private async start(args: { baseUrl?: string; openBrowser?: boolean }): Promise<Flow> {
    const fetchFn = this.options.fetch ?? fetch;
    const baseUrl = signInBaseUrl(this.env(), args.baseUrl);
    const identity: ClientIdentity | undefined = this.client.session.identity;
    const facts: ClientFacts = { name: identity?.name ?? "mcp-client", version: identity?.version ?? "" };
    const start = await startDeviceSignIn(baseUrl, facts, fetchFn);
    const allowBrowser = args.openBrowser !== false && (this.options.canOpenBrowser ?? (() => canOpenBrowser(this.env())))();
    const opened = allowBrowser ? (this.options.openBrowser ?? openInBrowser)(start.verificationUriComplete) : false;
    const flow: Flow = {
      baseUrl,
      start,
      startedAt: this.options.now?.() ?? Date.now(),
      openedBrowser: opened,
      status: "waiting",
      message: opened
        ? "A browser window was opened. Tell the person to check that the code on the page matches the code below, then approve."
        : "Tell the person to open the address below in a browser, check that the code on the page matches the code below, then approve.",
      done: Promise.resolve(),
    };
    this.cancelled = false;
    flow.done = this.poll(flow, fetchFn).catch(() => undefined);
    return flow;
  }

  private async poll(flow: Flow, fetchFn: FetchLike): Promise<void> {
    const sleep = this.options.sleep ?? defaultSleep;
    const now = this.options.now ?? Date.now;
    let interval = flow.start.intervalSeconds;
    let failures = 0;
    const deadline = flow.startedAt + (flow.start.expiresInSeconds + 15) * 1000;
    try {
      while (!this.cancelled && now() < deadline) {
        await sleep(interval * 1000);
        if (this.cancelled) return;
        let result: PollResult;
        try {
          result = await pollDeviceToken(flow.baseUrl, flow.start.deviceCode, fetchFn);
          failures = 0;
        } catch (err) {
          if (err instanceof SignInError && err.code === "network" && ++failures < MAX_POLL_FAILURES) continue;
          throw err;
        }
        if (result.state === "pending") {
          interval = result.intervalSeconds;
          continue;
        }
        await this.finish(flow, result.signIn);
        return;
      }
      if (!this.cancelled) {
        flow.status = "expired";
        flow.message = "The code expired before it was approved. Call tellagen_sign_in again to get a new one.";
      }
    } catch (err) {
      if (err instanceof SignInError) {
        flow.status = err.code === "expired" ? "expired" : err.code === "denied" ? "denied" : "failed";
        flow.reason = err.reason;
        flow.message =
          err.code === "denied"
            ? `${err.message} The key was not created.`
            : `${err.message}${err.code === "expired" || err.code === "invalid_device_code" ? " Call tellagen_sign_in again for a new code." : ""}`;
      } else {
        flow.status = "failed";
        flow.message = "The sign-in failed. Call tellagen_sign_in again.";
      }
    }
  }

  private async finish(flow: Flow, approved: ApprovedSignIn): Promise<void> {
    const vault = this.options.vault;
    if (!vault) throw new SignInError("storage", "No key storage is available in this process.");
    const account = accountFor(approved.apiUrl);
    let saved;
    try {
      saved = await vault.save(account, approved.apiKey.reveal());
    } catch (err) {
      throw new SignInError(
        "storage",
        `${err instanceof Error ? err.message : "The key could not be stored."} Sign in again, or set TELLAGEN_API_KEY.`,
      );
    }
    const at = new Date((this.options.now?.() ?? Date.now())).toISOString();
    this.options.index.save(account, {
      api_url: approved.apiUrl,
      workspace_name: approved.workspaceName,
      workspace_url: approved.workspaceUrl,
      signed_in_at: at,
      expires_at: approved.keyExpiresAt,
      storage: saved.kind,
    });
    this.client.setCredentials({ apiUrl: approved.apiUrl, apiKey: approved.apiKey.reveal() });
    this.client.session.setNotice(expiryLine({ expires_at: approved.keyExpiresAt } as SignInEntry, this.options.now?.() ?? Date.now()));
    void this.client.checkAuth();
    flow.status = "signed_in";
    flow.message = `Signed in${approved.workspaceName ? ` to ${approved.workspaceName}` : ""}. The key is stored in the ${describeStore(saved.kind)}. The Tellagen tools work now.`;
    flow.result = {
      workspace: approved.workspaceName,
      apiUrl: approved.apiUrl,
      keyExpiresAt: approved.keyExpiresAt,
      storage: describeStore(saved.kind),
      notice: saved.fileNotice,
    };
  }
}

/**
 * Signs out: the key leaves the keychain and the index, and the client keeps
 * nothing. Tellagen's API does not let a key revoke itself, so the key stays
 * valid on the server until a person revokes it in Tellagen. The answer says
 * so.
 */
export async function signOut(
  vault: CredentialVault | undefined,
  index: SignInIndex,
  account?: string,
): Promise<{ signedOut: string[]; remaining: string[] }> {
  const targets = account ? [account] : index.list().map((item) => item.account);
  for (const name of targets) {
    await vault?.remove(name);
    index.remove(name);
  }
  return { signedOut: targets, remaining: index.list().map((item) => item.account) };
}

export const KEY_NOT_REVOKED_NOTE =
  "The key was removed from this computer. Tellagen keeps it valid until it expires or a person revokes it: in Tellagen, open Settings > Local diagnosis, find the client under Connected clients, and use Sign out there. That revokes the key.";
