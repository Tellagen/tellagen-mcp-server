import { existsSync, lstatSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { tellagenHome } from "./home.js";
import { checkExtraTool } from "./listen-rules.js";

/**
 * The settings of the listener: `~/.tellagen/listen.json`. The file is
 * optional; every setting has a default. An unknown key is an error, so a
 * mistyped setting is never silently ignored, and no setting can switch off
 * the read-only rules.
 */

export const MAX_RUNS_LIMIT = 3;
export const DEFAULT_TIMEOUT_MINUTES = 45;

const serverName = z.string().regex(/^[A-Za-z0-9_-]{1,60}$/, "an MCP server name has letters, digits, - and _ only");

const configSchema = z
  .object({
    /** The client that runs a diagnosis. */
    client: z.enum(["claude", "codex"]).default("claude"),
    /** The folder the client starts in. Default: the folder where `listen` was started. */
    working_folder: z.string().min(1).max(500).optional(),
    /** The most runs at one time. */
    max_runs: z.number().int().min(1).max(MAX_RUNS_LIMIT).default(1),
    /** The time one run may take before it is stopped. */
    run_time_limit_minutes: z.number().int().min(5).max(240).default(DEFAULT_TIMEOUT_MINUTES),
    /** Names of the MCP servers of Grafana and GitHub, when they are not the usual ones. */
    mcp_servers: z
      .object({
        grafana: z.array(serverName).max(5).optional(),
        github: z.array(serverName).max(5).optional(),
      })
      .strict()
      .default({}),
    /** Extra read tools, each `mcp__<server>__<tool>`. A tool that changes something is refused. */
    extra_allowed_tools: z.array(z.string().max(200)).max(100).default([]),
    /** A file of MCP server settings for the client, when the servers are not set up for the user. */
    mcp_config_file: z.string().min(1).max(500).optional(),
    /** The model the client uses; the client's own default when left out. */
    model: z.string().regex(/^[A-Za-z0-9._:/-]{1,80}$/).optional(),
  })
  .strict();

export type ListenConfig = z.infer<typeof configSchema>;

export class ListenConfigError extends Error {}

export function listenConfigPath(home = tellagenHome()): string {
  return join(home, "listen.json");
}

/** Reads the settings. A missing file gives the defaults. A wrong file is an error that says what to fix. */
export function readListenConfig(home = tellagenHome()): ListenConfig {
  const path = listenConfigPath(home);
  let raw: unknown = {};
  if (existsSync(path)) {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.size > 64 * 1024) throw new ListenConfigError(`${path} is not a settings file.`);
    try {
      raw = JSON.parse(readFileSync(path, "utf8"));
    } catch {
      throw new ListenConfigError(`${path} is not valid JSON.`);
    }
  }
  const parsed = configSchema.safeParse(raw);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    throw new ListenConfigError(`${path}: ${first?.path.join(".") || "settings"}: ${first?.message ?? "not valid"}.`);
  }
  for (const tool of parsed.data.extra_allowed_tools) {
    const problem = checkExtraTool(tool);
    if (problem) throw new ListenConfigError(`${path}: extra_allowed_tools: ${problem}`);
  }
  const folder = parsed.data.working_folder;
  if (folder) {
    try {
      if (!statSync(folder).isDirectory()) throw new Error();
    } catch {
      throw new ListenConfigError(`${path}: working_folder: ${folder.slice(0, 120)} is not a folder.`);
    }
  }
  return parsed.data;
}
