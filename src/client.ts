import { TellagenAPIError } from "./errors.js";

export interface ClientConfig {
  apiUrl: string;
  apiKey: string;
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
      throw new TellagenAPIError(res.status, code, message, payload);
    }

    return (await res.json()) as T;
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
