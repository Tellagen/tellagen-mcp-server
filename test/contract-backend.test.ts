import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { INVESTIGATION_PROTOCOL_CAPABILITIES } from "../src/version.js";
import {
  CLIENT_HEADER_COMPUTER,
  CLIENT_HEADER_NAME,
  CLIENT_HEADER_SERVER_VERSION,
  CLIENT_HEADER_SESSION,
  CLIENT_HEADER_VERSION,
} from "../src/identity.js";

/**
 * The server and Tellagen share one protocol and live in two repositories.
 * The server's own tests run against a fake Tellagen, so a change on the
 * Tellagen side could break real clients with every test green. Two things
 * keep that from happening:
 *
 * 1. `contracts/mcp-protocol.json` says what this server sends and relies on.
 *    Tests keep it equal to the source.
 * 2. The contract bundle that Tellagen publishes (vendored in contracts/runbooks,
 *    raised with `npm run contracts:update`) carries `v2/client-protocol.json`:
 *    the routes, request fields, response fields, headers, capabilities and
 *    error codes of the diagnosis path. `compareProtocols` checks 1 against it
 *    and names the route and the field that differ.
 */

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const ours = JSON.parse(readFileSync(join(root, "contracts", "mcp-protocol.json"), "utf8")) as McpProtocol;
const bundle = join(root, "contracts", "runbooks");
const backendProtocolPath = join(bundle, "v2", "client-protocol.json");

interface RouteUse {
  method: string;
  path: string;
  query?: string[];
  request_fields: string[];
  response_fields: string[];
  error_codes: string[];
}
interface McpProtocol {
  protocol_capabilities_sent: string[];
  server_capabilities_used: string[];
  client_headers_sent: string[];
  routes: RouteUse[];
}
interface BackendProtocol {
  server_capabilities: string[];
  protocol_capabilities: string[];
  client_headers: string[];
  error_codes: string[];
  routes: Array<{ method: string; path: string; query?: string[]; request_fields: string[]; response_fields: string[] }>;
}

/** What differs between what the server relies on and what Tellagen publishes, one sentence each. */
export function compareProtocols(mcp: McpProtocol, backend: BackendProtocol): string[] {
  const problems: string[] = [];
  for (const name of mcp.protocol_capabilities_sent) {
    if (!backend.protocol_capabilities.includes(name)) problems.push(`The server advertises the capability "${name}" at pickup, but Tellagen does not know it.`);
  }
  for (const name of mcp.server_capabilities_used) {
    if (!backend.server_capabilities.includes(name)) problems.push(`The server relies on the server capability "${name}", but Tellagen does not list it.`);
  }
  for (const name of mcp.client_headers_sent) {
    if (!backend.client_headers.some((h) => h.toLowerCase() === name.toLowerCase())) problems.push(`The server sends the header ${name}, but Tellagen does not read it.`);
  }
  for (const route of mcp.routes) {
    const label = `${route.method} ${route.path}`;
    const theirs = backend.routes.find((r) => r.method === route.method && r.path === route.path);
    if (!theirs) {
      problems.push(`${label}: the server calls this route, but Tellagen has no such route.`);
      continue;
    }
    for (const field of route.request_fields) {
      if (!theirs.request_fields.includes(field)) problems.push(`${label}: the server sends the request field "${field}", but Tellagen's contract has no such field.`);
    }
    for (const param of route.query ?? []) {
      if (!(theirs.query ?? []).includes(param)) problems.push(`${label}: the server sends the query parameter "${param}", but Tellagen's contract has no such parameter.`);
    }
    for (const field of route.response_fields) {
      if (!theirs.response_fields.includes(field)) problems.push(`${label}: the server reads the response field "${field}", but Tellagen's contract does not return it.`);
    }
    for (const code of route.error_codes) {
      if (!backend.error_codes.includes(code)) problems.push(`${label}: the server handles the error code "${code}", but Tellagen's contract does not list it.`);
    }
  }
  return problems;
}

const sourceFiles = (dir: string): string[] =>
  readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? sourceFiles(path) : path.endsWith(".ts") ? [path] : [];
  });
const source = sourceFiles(join(root, "src")).map((path) => readFileSync(path, "utf8")).join("\n");

describe("contracts/mcp-protocol.json says what the source does", () => {
  it("lists the capabilities the server advertises, exactly", () => {
    expect([...ours.protocol_capabilities_sent].sort()).toEqual([...INVESTIGATION_PROTOCOL_CAPABILITIES].sort());
  });

  it("lists the headers the server sends, exactly", () => {
    const headers = [CLIENT_HEADER_NAME, CLIENT_HEADER_VERSION, CLIENT_HEADER_COMPUTER, CLIENT_HEADER_SERVER_VERSION, CLIENT_HEADER_SESSION];
    expect([...ours.client_headers_sent].sort()).toEqual([...headers].sort());
  });

  it("names a server capability only where the source reads it", () => {
    for (const name of ours.server_capabilities_used) expect(source, name).toContain(`"${name}"`);
  });

  it("lists every route of the diagnosis path that the source calls, and no other", () => {
    const literals = new Set<string>();
    for (const match of source.matchAll(/[`"}](\/api\/v1\/(?:auth\/device|auth\/me|investigations|investigation-runs|incidents\/\$\{[^}]+\}\/(?:findings|investigations\b))[^`"]*)[`"]/g)) {
      literals.add(
        match[1]!
          .replace(/\$\{query\}/g, "")
          .replace(/\$\{[^}]+\}/g, "{id}")
          .replace(/\?.*$/, "")
          .replace(/\/causes\/\{id\}$/, "/causes/{key}"),
      );
    }
    const listed = new Set(ours.routes.map((route) => route.path));
    // Routes of the incident tools that are not the diagnosis path stay out of the file.
    const diagnosis = [...literals].filter((path) => !/\/investigations\/(workspace|scope)$|\/runbook-waivers$|\/coverage$|\/investigations\/\{id\}$|\/investigation-attachments/.test(path));
    for (const path of diagnosis) expect(listed.has(path), `${path} is called in the source but not listed in contracts/mcp-protocol.json`).toBe(true);
    for (const path of listed) {
      if (path === "/api/v1/incidents/{id}/findings" || path === "/api/v1/investigation-runs/{id}/causes/{key}") continue;
      expect(literals.has(path), `${path} is listed in contracts/mcp-protocol.json but the source no longer calls it`).toBe(true);
    }
  });

  it("names a request field only where the source uses it", () => {
    for (const route of ours.routes) {
      for (const field of [...route.request_fields, ...(route.query ?? [])]) {
        expect(source, `${route.method} ${route.path}: ${field}`).toContain(field.split(".").at(-1)!);
      }
    }
  });
});

describe("the server against the protocol file in the pinned bundle", () => {
  const manifest = JSON.parse(readFileSync(join(bundle, "manifest.json"), "utf8")) as { contract_version: string };
  // The bundle that added the protocol file. A pin at or after it must hold the file.
  const FIRST_VERSION_WITH_PROTOCOL_FILE = "2026-11-12.1";

  it("requires the protocol file from the first bundle version that has it", () => {
    if (manifest.contract_version >= FIRST_VERSION_WITH_PROTOCOL_FILE) {
      expect(existsSync(backendProtocolPath), `The pinned bundle ${manifest.contract_version} must hold v2/client-protocol.json`).toBe(true);
    }
  });

  it.skipIf(!existsSync(backendProtocolPath))("finds no difference between the server and Tellagen", () => {
    const backend = JSON.parse(readFileSync(backendProtocolPath, "utf8")) as BackendProtocol;
    expect(compareProtocols(ours, backend)).toEqual([]);
  });
});

describe("a deliberate break turns the check red with the name of the field", () => {
  const backend = (): BackendProtocol => ({
    server_capabilities: ours.server_capabilities_used,
    protocol_capabilities: ours.protocol_capabilities_sent,
    client_headers: ours.client_headers_sent,
    error_codes: ours.routes.flatMap((route) => route.error_codes),
    routes: ours.routes.map((route) => ({ method: route.method, path: route.path, query: route.query, request_fields: route.request_fields, response_fields: route.response_fields })),
  });

  it("agrees with a backend that has everything", () => {
    expect(compareProtocols(ours, backend())).toEqual([]);
  });

  it("names the field when Tellagen renames a pickup field", () => {
    const broken = backend();
    const pickup = broken.routes.find((route) => route.path === "/api/v1/investigations/{id}/pickup")!;
    pickup.request_fields = pickup.request_fields.map((field) => (field === "model" ? "model_name" : field));
    const problems = compareProtocols(ours, broken);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("POST /api/v1/investigations/{id}/pickup");
    expect(problems[0]).toContain('"model"');
  });

  it("names the response field, the route, the capability, the header and the error code", () => {
    const broken = backend();
    broken.routes.find((route) => route.path === "/api/v1/investigation-runs/{id}/trace")!.response_fields = ["steps"];
    broken.routes = broken.routes.filter((route) => route.path !== "/api/v1/investigation-runs/{id}/heartbeat");
    broken.server_capabilities = broken.server_capabilities.filter((name) => name !== "recorded_steps_v1");
    broken.client_headers = broken.client_headers.filter((name) => name !== "X-Tellagen-Client-Session");
    broken.error_codes = broken.error_codes.filter((name) => name !== "run_taken_over");
    const text = compareProtocols(ours, broken).join("\n");
    expect(text).toContain('"responder_notes"');
    expect(text).toContain("POST /api/v1/investigation-runs/{id}/heartbeat: the server calls this route");
    expect(text).toContain('"recorded_steps_v1"');
    expect(text).toContain("X-Tellagen-Client-Session");
    expect(text).toContain('"run_taken_over"');
  });
});
