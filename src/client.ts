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
      try {
        const errBody = (await res.json()) as {
          error?: string;
          message?: string;
        };
        code = errBody.error ?? code;
        message = errBody.message ?? message;
      } catch {
        // Response was not JSON — use status text.
        message = res.statusText || message;
      }
      throw new TellagenAPIError(res.status, code, message);
    }

    return (await res.json()) as T;
  }

  async get<T>(path: string): Promise<T> {
    return this.request<T>("GET", path);
  }

  async post<T>(path: string, body: unknown): Promise<T> {
    return this.request<T>("POST", path, body);
  }

  async patch<T>(path: string, body: unknown): Promise<T> {
    return this.request<T>("PATCH", path, body);
  }
}
