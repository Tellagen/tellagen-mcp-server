import { TellagenAPIError } from "./errors.js";

export interface ClientConfig {
  apiUrl: string;
  apiKey: string;
}

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
      if (typeof payload.code === "string") {
        code = payload.code;
      } else if (typeof payload.error === "string") {
        code = payload.error;
      }
      if (typeof payload.message === "string") {
        message = payload.message;
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
  private readonly baseUrl: string;
  private readonly apiKey: string;

  constructor(config: ClientConfig) {
    this.baseUrl = config.apiUrl.replace(/\/+$/, "");
    this.apiKey = config.apiKey;
  }

  private headers(extra?: Record<string, string>): Record<string, string> {
    return {
      Authorization: `Bearer ${this.apiKey}`,
      "Content-Type": "application/json",
      ...extra,
    };
  }

  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    const init: RequestInit = {
      method,
      headers: this.headers(),
    };
    if (body !== undefined) {
      init.body = JSON.stringify(body);
    }

    const res = await fetch(url, init);

    if (!res.ok) {
      throw await apiError(res);
    }

    return (await res.json()) as T;
  }

  /**
   * GET the bytes at an API path with the API key, for images and other
   * files. A response larger than maxBytes is refused before it is read in
   * full, and an error status is reported like any other API error.
   */
  async getBinary(path: string, options: BinaryFetchOptions): Promise<BinaryResponse> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        Accept: options.accept ?? "*/*",
      },
    });
    if (!res.ok) {
      throw await apiError(res);
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

  async get<T>(path: string): Promise<T> {
    return this.request<T>("GET", path);
  }

  async post<T>(path: string, body: unknown): Promise<T> {
    return this.request<T>("POST", path, body);
  }

  async put<T>(path: string, body: unknown): Promise<T> {
    return this.request<T>("PUT", path, body);
  }

  async patch<T>(path: string, body: unknown): Promise<T> {
    return this.request<T>("PATCH", path, body);
  }
}
