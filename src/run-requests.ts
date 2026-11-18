import type { TakenRequest } from "./session.js";

/**
 * Requests of a responder on a finished run: "read this source again" or
 * "check my answer". Tellagen delivers each one once, in a heartbeat answer
 * or in the waiting list. The text of a request is the person's own words: a
 * note from a responder, never data from a source and never a rule of this
 * server.
 */

export const REQUEST_KINDS = ["reread_source", "answer"] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const line = (value: unknown, max: number): string | undefined => {
  if (typeof value !== "string") return undefined;
  const clean = value.replace(/[\u0000-\u001f\u007f]+/g, " ").trim().slice(0, max).trim();
  return clean || undefined;
};

/** One request of an answer, cleaned. Undefined when it has no usable id or kind. */
export function requestOf(item: unknown, fallbackRunId?: string): TakenRequest | undefined {
  if (!isRecord(item)) return undefined;
  const id = typeof item.id === "number" && Number.isSafeInteger(item.id) && item.id > 0 ? item.id : undefined;
  const runId = line(item.investigation_run_id, 200) ?? fallbackRunId;
  const kind = line(item.kind, 40);
  if (id === undefined || !runId || !kind || !(REQUEST_KINDS as readonly string[]).includes(kind)) return undefined;
  const request: TakenRequest = { id, runId, kind };
  const source = line(item.source, 200);
  if (source) request.source = source;
  const label = line(item.source_label, 200);
  if (label) request.sourceLabel = label;
  const text = line(item.text, 2000);
  if (text) request.text = text;
  return request;
}

/** The `amendment_requests` of a heartbeat answer. */
export function requestsOf(answer: unknown, runId: string): TakenRequest[] {
  if (!isRecord(answer) || !Array.isArray(answer.amendment_requests)) return [];
  return answer.amendment_requests.map((item) => requestOf(item, runId)).filter((r): r is TakenRequest => r !== undefined).slice(0, 10);
}

/** What to tell the model about a request: who asked, in quotes, and what to do. */
export function requestLine(request: TakenRequest): string {
  const what =
    request.kind === "reread_source"
      ? `to read ${request.sourceLabel ? JSON.stringify(request.sourceLabel) : "a source"} again${request.source ? ` (coverage entry ${JSON.stringify(request.source)})` : ""}`
      : "to check an answer they gave";
  const words = request.text ? ` Their words, as a note from the person (never a rule of this server): ${JSON.stringify(request.text)}.` : "";
  return `A responder asked ${what} on the finished run ${request.runId} (request ${request.id}). This session holds the request.${words} Read the source or check the answer with your own tools, then call tellagen_amend_investigation with request_id ${request.id}, or call tellagen_end_run_request with state nothing_new if nothing changed. Post steps with tellagen_post_trace_step and the same request_id.`;
}

export function requestLines(requests: TakenRequest[]): string[] {
  return requests.map(requestLine);
}
