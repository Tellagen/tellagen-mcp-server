/** Structured error from the Tellagen API. */
export class TellagenAPIError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly payload?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "TellagenAPIError";
  }
}

/**
 * The server cannot talk to Tellagen until a person changes the setup: no
 * key, a key Tellagen refuses, or a paused seat. The message holds the steps
 * and never a secret value.
 */
export class TellagenSetupError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly steps: readonly string[],
  ) {
    super(message);
    this.name = "TellagenSetupError";
  }
}

/** A run tool was called with no run id and this session holds no run. */
export class NoActiveRunError extends Error {
  readonly code = "no_active_run";
  constructor(message: string) {
    super(message);
    this.name = "NoActiveRunError";
  }
}

function fieldPath(value: unknown): string {
  return typeof value === "string" ? value.replace(/[\u0000-\u001f\u007f]+/g, " ").trim().slice(0, 160) : "";
}

/**
 * A line that tells the model how to correct a request that Tellagen refused
 * because of a field: the wrong type of a value, or a field the route does
 * not know. The paths come from Tellagen and say no value back.
 */
export function fieldErrorHint(err: TellagenAPIError): string | undefined {
  const payload = err.payload ?? {};
  const field = fieldPath(payload.field);
  if (err.code === "invalid_field_type" && field) {
    return `Correct the field "${field}" as the message says, keep the other fields, and send the request again.`;
  }
  if (err.code === "unknown_field") {
    const details = payload.details as { fields?: unknown } | undefined;
    const listed = Array.isArray(details?.fields) ? details!.fields.map(fieldPath).filter(Boolean).slice(0, 20) : [];
    const paths = listed.length > 0 ? listed : field ? [field] : [];
    if (paths.length > 0) {
      return `Tellagen does not know these fields: ${paths.map((path) => `"${path}"`).join(", ")}. Remove them or use the name the tool describes, and send the request again. Do not send a field that the tool does not list.`;
    }
  }
  return undefined;
}

/** Format an API error into a user-friendly MCP tool error response. */
export function formatError(err: unknown): string {
  if (err instanceof TellagenAPIError) {
    const hint = fieldErrorHint(err);
    return JSON.stringify({
      ...(err.payload ?? {}),
      error: true,
      status: err.status,
      code: err.code,
      message: err.message,
      ...(hint ? { hint } : {}),
    });
  }
  if (err instanceof TellagenSetupError) {
    return JSON.stringify({
      error: true,
      code: err.code,
      message: err.message,
      setup_steps: err.steps,
    });
  }
  if (err instanceof NoActiveRunError) {
    return JSON.stringify({ error: true, code: err.code, message: err.message });
  }
  if (err instanceof Error) {
    return JSON.stringify({
      error: true,
      message: err.message,
    });
  }
  return JSON.stringify({ error: true, message: String(err) });
}
