/** Structured error from the Tellagen API. */
export class TellagenAPIError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "TellagenAPIError";
  }
}

/** Format an API error into a user-friendly MCP tool error response. */
export function formatError(err: unknown): string {
  if (err instanceof TellagenAPIError) {
    return JSON.stringify({
      error: true,
      status: err.status,
      code: err.code,
      message: err.message,
    });
  }
  if (err instanceof Error) {
    return JSON.stringify({
      error: true,
      message: err.message,
    });
  }
  return JSON.stringify({ error: true, message: String(err) });
}
