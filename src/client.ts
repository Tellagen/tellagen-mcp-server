import { TellagenAPIError, TellagenSetupError } from "./errors.js";
import { Session } from "./session.js";

export interface ClientConfig {
  /** The API address. Empty when the person has not set it yet. */
  apiUrl: string;
  /** The API key. Empty when the person has not set it yet. */
  apiKey: string;
  /**
   * The folder of the remembered-run file. Left out, nothing is written to
   * disk; the command-line entry point passes `~/.tellagen/state`.
   */
  stateDir?: string;
}

/**
 * Timeouts and retries of every Tellagen call. One object, so a test can
 * shorten the delays without a setting that a person could see.
 */
export const httpDefaults = {
  /** How long one attempt may take. */
  timeoutMs: 30_000,
  /** How long an attempt that sends screenshots may take. */
  uploadTimeoutMs: 120_000,
  /** How long one call may take with all its repeats and waits. */
  totalMs: 60_000,
  /** The same for a call that sends screenshots. */
  uploadTotalMs: 150_000,
  /** Repeats after the first attempt. */
  retries: 3,
  /** The first delay; each repeat doubles it. */
  baseDelayMs: 500,
  /** The longest delay, also for a Retry-After header. */
  maxDelayMs: 30_000,
  /** How long a refused key is trusted to be still refused. */
  authRecheckMs: 15_000,
};

export interface RequestOptions {
  /** One attempt's limit in milliseconds. Defaults to 30 seconds. */
  timeoutMs?: number;
  /**
   * Whether a repeat cannot create a second record. GET and PUT are; a POST
   * or PATCH is only when the caller says so (a trace step by step_id, a
   * heartbeat) or sends an idempotency key.
   */
  safeToRepeat?: boolean;
  /** Sent as the Idempotency-Key header; makes the call safe to repeat. */
  idempotencyKey?: string;
  /** Extra request headers. */
  headers?: Record<string, string>;
}

const RETRY_STATUSES = new Set([429, 502, 503, 504]);

export type AuthStatus = "missing" | "unknown" | "ok" | "rejected";

const KEY_STEPS = [
  "Easiest: call tellagen_sign_in and tell the person the code and the address it returns. They approve in the browser. There is no key to copy.",
  "Or in Tellagen, open Settings > API Keys and create a key with the incidents:read and incidents:write scopes.",
  "Put the key in TELLAGEN_API_KEY and the API address (for example https://yourcompany.api.tellagen.com) in TELLAGEN_API_URL, in the env block of this MCP server in your client's configuration.",
  "Restart the client, or reconnect this MCP server.",
] as const;

/** The setup error for a missing key or address. It names no value. */
export function missingSetupError(missing: readonly string[]): TellagenSetupError {
  return new TellagenSetupError(
    "tellagen_not_set_up",
    `Tellagen is not set up in this client: ${missing.join(" and ")} ${missing.length === 1 ? "is" : "are"} not set. Tell the person the steps in setup_steps. No Tellagen tool works until they are done.`,
    KEY_STEPS,
  );
}

/**
 * Rewrites an answer that means "a person must fix the access" into a clear
 * message with the fix. Other errors pass unchanged.
 */
function accessError(err: TellagenAPIError): TellagenAPIError | undefined {
  const payload = { ...(err.payload ?? {}) };
  if (err.status === 401) {
    const expired = /expired/i.test(err.code);
    const message = expired
      ? "Tellagen refused the API key because it has expired (HTTP 401)."
      : "Tellagen refused the API key (HTTP 401). The key is wrong, was revoked or has expired.";
    return new TellagenAPIError(401, expired ? err.code : err.code === "unknown" ? "api_key_refused" : err.code, `${message} Tell the person the steps in setup_steps.`, {
      ...payload,
      setup_steps: [
        "If the person signed in with the browser, call tellagen_sign_in with restart true.",
        "Otherwise in Tellagen, open Settings > API Keys and create a new key with the incidents:read and incidents:write scopes.",
        "Replace the value of TELLAGEN_API_KEY in the env block of this MCP server, and check that TELLAGEN_API_URL is the API address of the same workspace.",
        "Restart the client, or reconnect this MCP server.",
      ],
    });
  }
  if (err.status === 403 && err.code === "seat_access_suspended") {
    return new TellagenAPIError(403, err.code, `${err.message} The API key belongs to a person whose seat in this workspace is paused, so Tellagen refuses its calls. Tell the person the steps in setup_steps.`, {
      ...payload,
      setup_steps: [
        "Ask a workspace admin to restore the seat in Tellagen, under Settings > Members, or to change the plan.",
        "Then call the tool again. The key itself does not need to change.",
      ],
    });
  }
  if (err.status === 403 && err.code === "company_disabled") {
    return new TellagenAPIError(403, err.code, `${err.message} Tellagen refuses every call of this workspace until it is active again. Tell the person the steps in setup_steps.`, {
      ...payload,
      setup_steps: ["Ask the workspace owner to contact Tellagen support.", "Then call the tool again."],
    });
  }
  return undefined;
}

function retryAfterMs(res: Response): number | undefined {
  const value = res.headers.get("retry-after");
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const date = Date.parse(value);
  if (Number.isFinite(date)) return Math.max(0, date - Date.now());
  return undefined;
}

const sleep = (ms: number) =>
  ms <= 0 ? Promise.resolve() : new Promise<void>((resolve) => setTimeout(resolve, ms));

export interface BinaryFetchOptions {
  /** The most bytes read; a larger response is refused. */
  maxBytes: number;
  /** The Accept header. Defaults to any type. */
  accept?: string;
}

export interface BinaryResponse {
  bytes: Uint8Array;
  /** The media type without parameters, lower case; empty when not sent. */
  contentType: string;
  etag?: string;
  contentDisposition?: string;
}

/** The API error of a response that is not ok, from its JSON body when it has one. */
async function apiError(res: Response): Promise<TellagenAPIError> {
  let code = "unknown";
  let message = `HTTP ${res.status}`;
  let payload: Record<string, unknown> | undefined;
  try {
    const candidate = (await res.json()) as unknown;
    if (candidate && typeof candidate === "object" && !Array.isArray(candidate)) {
      payload = candidate as Record<string, unknown>;
      // Two shapes exist: {code, message} and {error: {code, message, field}}.
      const nested =
        payload.error && typeof payload.error === "object" && !Array.isArray(payload.error)
          ? (payload.error as Record<string, unknown>)
          : undefined;
      if (typeof payload.code === "string") {
        code = payload.code;
      } else if (typeof nested?.code === "string") {
        code = nested.code;
      } else if (typeof payload.error === "string") {
        code = payload.error;
      }
      if (typeof payload.message === "string") {
        message = payload.message;
      } else if (typeof nested?.message === "string") {
        message = nested.message;
      }
      if (nested) {
        // Keep the detail and free the `error` key for the tool result flag.
        const { error: _error, ...rest } = payload;
        payload = { ...rest, error_detail: nested };
      }
    }
  } catch {
    // Response was not JSON — use status text.
    message = res.statusText || message;
  }
  return new TellagenAPIError(res.status, code, message, payload);
}

/** Thin HTTP wrapper for the Tellagen public API. */
export class TellagenClient {
  private baseUrl: string;
  #apiKey: string;
  /** What this process knows about its client and its run. */
  readonly session: Session;
  private authStatus: AuthStatus;
  private authProblem: TellagenAPIError | undefined;
  private authCheckedAt = 0;

  constructor(config: ClientConfig) {
    this.baseUrl = (config.apiUrl ?? "").trim().replace(/\/+$/, "");
    this.#apiKey = (config.apiKey ?? "").trim();
    this.session = new Session(this.baseUrl, config.stateDir);
    this.authStatus = this.#apiKey && this.baseUrl ? "unknown" : "missing";
  }

  /**
   * Replaces the key and the address, after a sign-in or a sign-out. The
   * remembered-run file follows the address. The new key has not been tried
   * yet, so the answer about the old one is dropped.
   */
  setCredentials(config: { apiUrl: string; apiKey: string }): void {
    this.baseUrl = (config.apiUrl ?? "").trim().replace(/\/+$/, "");
    this.#apiKey = (config.apiKey ?? "").trim();
    this.session.setWorkspace(this.baseUrl);
    this.authStatus = this.#apiKey && this.baseUrl ? "unknown" : "missing";
    this.authProblem = undefined;
    this.authCheckedAt = 0;
  }

  /** The API address in use; it holds no secret. */
  apiUrl(): string {
    return this.baseUrl;
  }

  /** Whether Tellagen accepted the key: not set, not asked yet, yes or no. */
  auth(): AuthStatus {
    return this.authStatus;
  }

  private missingSetup(): TellagenSetupError | undefined {
    const missing: string[] = [];
    if (!this.#apiKey) missing.push("TELLAGEN_API_KEY");
    if (!this.baseUrl) missing.push("TELLAGEN_API_URL");
    return missing.length > 0 ? missingSetupError(missing) : undefined;
  }

  /**
   * Asks Tellagen once whether it accepts the key. It never throws: a
   * network error leaves the answer open, and the tools report it later.
   */
  async checkAuth(): Promise<AuthStatus> {
    if (this.authStatus === "missing") return this.authStatus;
    this.authCheckedAt = Date.now();
    try {
      const me = await this.request<{ user?: unknown }>("GET", "/api/v1/auth/me", undefined, {
        safeToRepeat: false,
        timeoutMs: 10_000,
      });
      // This route answers 200 with no user for a key Tellagen does not
      // accept, so the status alone says nothing.
      if (me && typeof me === "object" && me.user && typeof me.user === "object") {
        this.authStatus = "ok";
        this.authProblem = undefined;
      } else {
        this.noteAccess(new TellagenAPIError(401, "api_key_refused", "The API key was not accepted"));
      }
    } catch {
      // request() already recorded a refusal; anything else stays open.
    }
    return this.authStatus;
  }

  /**
   * The reason no tool can work right now, or nothing. A refused key is asked
   * about again after a short while, so a restored seat needs no restart.
   */
  async accessProblem(): Promise<Error | undefined> {
    const missing = this.missingSetup();
    if (missing) return missing;
    if (this.authStatus !== "rejected") return undefined;
    if (Date.now() - this.authCheckedAt >= httpDefaults.authRecheckMs) {
      await this.checkAuth();
    }
    return this.authStatus === "rejected" ? this.authProblem : undefined;
  }

  private headers(extra?: Record<string, string>): Record<string, string> {
    return {
      Authorization: `Bearer ${this.#apiKey}`,
      "Content-Type": "application/json",
      ...this.session.identityHeaders(),
      ...extra,
    };
  }

  /**
   * One fetch with a time limit, repeated on a network error, a timeout and
   * on 429, 502, 503 and 504 when the call is safe to repeat. The response
   * is returned with its timer still running; the caller ends it with done().
   */
  private async send(
    url: string,
    init: RequestInit,
    options: { timeoutMs: number; safeToRepeat: boolean },
  ): Promise<{ res: Response; done: () => void }> {
    let attempts = options.safeToRepeat ? httpDefaults.retries + 1 : 1;
    // One deadline for all attempts and waits: a client gives up on a tool
    // call long before four full attempts end.
    const total = Math.max(
      options.timeoutMs,
      options.timeoutMs > httpDefaults.timeoutMs ? httpDefaults.uploadTotalMs : httpDefaults.totalMs,
    );
    const deadline = Date.now() + total;
    for (let attempt = 1; ; attempt++) {
      const controller = new AbortController();
      let timedOut = false;
      const limit = Math.max(1, Math.min(options.timeoutMs, deadline - Date.now()));
      const timer = setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, limit);
      const done = () => clearTimeout(timer);
      let delay = Math.min(httpDefaults.baseDelayMs * 2 ** (attempt - 1), httpDefaults.maxDelayMs);
      try {
        const res = await fetch(url, { ...init, signal: controller.signal });
        if (!RETRY_STATUSES.has(res.status) || attempt >= attempts) return { res, done };
        const wait = retryAfterMs(res);
        if (wait !== undefined) delay = Math.min(Math.max(wait, delay), httpDefaults.maxDelayMs);
        // No time is left for another attempt: this answer is the result.
        if (Date.now() + delay >= deadline) return { res, done };
        await res.body?.cancel().catch(() => undefined);
        done();
      } catch (err) {
        done();
        if (Date.now() + delay >= deadline) attempts = attempt;
        if (attempt >= attempts) {
          if (timedOut) {
            throw new TellagenAPIError(
              0,
              "timeout",
              `Tellagen did not answer within ${Math.round(limit / 1000)} seconds.${options.safeToRepeat ? "" : " The call was not repeated, because a repeat could create a second record. Read the current state before you send it again."}`,
            );
          }
          throw err;
        }
      }
      await sleep(delay);
    }
  }

  /** Records a refusal of the key or the seat and returns the clear error. */
  private noteAccess(err: TellagenAPIError): TellagenAPIError {
    const clear = accessError(err);
    if (!clear) return err;
    this.authStatus = "rejected";
    this.authProblem = clear;
    this.authCheckedAt = Date.now();
    return clear;
  }

  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
    options: RequestOptions = {},
  ): Promise<T> {
    const missing = this.missingSetup();
    if (missing) throw missing;
    const url = `${this.baseUrl}${path}`;
    const init: RequestInit = {
      method,
      headers: this.headers({
        ...(options.headers ?? {}),
        ...(options.idempotencyKey ? { "Idempotency-Key": options.idempotencyKey } : {}),
      }),
    };
    if (body !== undefined) {
      init.body = JSON.stringify(body);
    }
    const safeToRepeat =
      options.safeToRepeat ?? (method === "GET" || method === "PUT" || Boolean(options.idempotencyKey));

    const { res, done } = await this.send(url, init, {
      timeoutMs: options.timeoutMs ?? httpDefaults.timeoutMs,
      safeToRepeat,
    });
    try {
      if (!res.ok) {
        throw this.noteAccess(await apiError(res));
      }
      // The auth route proves nothing by its status; checkAuth reads its body.
      if (this.authStatus !== "ok" && path !== "/api/v1/auth/me") {
        this.authStatus = "ok";
        this.authProblem = undefined;
      }
      return (await res.json()) as T;
    } catch (err) {
      // The time limit can also end the read of the answer.
      if (err instanceof Error && err.name === "AbortError") {
        throw new TellagenAPIError(
          0,
          "timeout",
          "Tellagen started to answer but did not finish within the time limit. Read the current state before you send the call again.",
        );
      }
      throw err;
    } finally {
      done();
    }
  }

  /**
   * GET the bytes at an API path with the API key, for images and other
   * files. A response larger than maxBytes is refused before it is read in
   * full, and an error status is reported like any other API error.
   */
  async getBinary(path: string, options: BinaryFetchOptions): Promise<BinaryResponse> {
    const missing = this.missingSetup();
    if (missing) throw missing;
    const { res, done } = await this.send(
      `${this.baseUrl}${path}`,
      {
        method: "GET",
        headers: {
          Authorization: `Bearer ${this.#apiKey}`,
          Accept: options.accept ?? "*/*",
          ...this.session.identityHeaders(),
        },
      },
      { timeoutMs: httpDefaults.uploadTimeoutMs, safeToRepeat: true },
    );
    try {
      return await this.readBinary(res, options);
    } finally {
      done();
    }
  }

  private async readBinary(res: Response, options: BinaryFetchOptions): Promise<BinaryResponse> {
    if (!res.ok) {
      throw this.noteAccess(await apiError(res));
    }
    const tooLarge = (size: number) =>
      new TellagenAPIError(
        413,
        "response_too_large",
        `The response is ${size} bytes; at most ${options.maxBytes} are read`,
      );
    const declared = Number(res.headers.get("content-length") ?? "");
    if (Number.isFinite(declared) && declared > options.maxBytes) {
      await res.body?.cancel().catch(() => undefined);
      throw tooLarge(declared);
    }
    const chunks: Uint8Array[] = [];
    let size = 0;
    if (res.body) {
      const reader = res.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > options.maxBytes) {
          await reader.cancel().catch(() => undefined);
          throw tooLarge(size);
        }
        chunks.push(value);
      }
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return {
      bytes,
      contentType: (res.headers.get("content-type") ?? "").split(";")[0]!.trim().toLowerCase(),
      etag: res.headers.get("etag") ?? undefined,
      contentDisposition: res.headers.get("content-disposition") ?? undefined,
    };
  }

  async get<T>(path: string, options?: RequestOptions): Promise<T> {
    return this.request<T>("GET", path, undefined, options);
  }

  async post<T>(path: string, body: unknown, options?: RequestOptions): Promise<T> {
    return this.request<T>("POST", path, body, options);
  }

  async put<T>(path: string, body: unknown, options?: RequestOptions): Promise<T> {
    return this.request<T>("PUT", path, body, options);
  }

  async patch<T>(path: string, body: unknown, options?: RequestOptions): Promise<T> {
    return this.request<T>("PATCH", path, body, options);
  }
}
