import { existsSync, lstatSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { buildAllowedTools, type ToolOptions } from "./listen-rules.js";

/**
 * The permission rules in the person's own Claude Code settings add to the
 * list the listener passes. A person who allows `Bash(*)` or `Read` for
 * their daily work would give an unattended run the same access. So before a
 * run is started, every allow rule the client will read is checked against
 * the listener's own list, and the listener refuses to start when one is not
 * on it.
 */

export interface SettingsProblem {
  rule: string;
  file: string;
}

function settingsFiles(cwd: string, home: string, env: Record<string, string | undefined>): string[] {
  // The client reads the settings of the working folder and of every folder above it.
  const folders: string[] = [];
  for (let folder = cwd, last = ""; folder !== last; last = folder, folder = dirname(folder)) folders.push(folder);
  const configDir = (env.CLAUDE_CONFIG_DIR ?? "").trim();
  const userDirs = new Set([join(home, ".claude"), ...(configDir ? [configDir] : [])]);
  return [
    ...[...userDirs].flatMap((dir) => [join(dir, "settings.json"), join(dir, "settings.local.json")]),
    ...folders.flatMap((folder) => [join(folder, ".claude", "settings.json"), join(folder, ".claude", "settings.local.json")]),
    "/Library/Application Support/ClaudeCode/managed-settings.json",
    "/etc/claude-code/managed-settings.json",
  ];
}

/** The allow rules of the client's settings files that are not on the listener's list. */
export function inspectClientSettings(
  cwd: string,
  options: ToolOptions = {},
  home: string = homedir(),
  env: Record<string, string | undefined> = process.env,
): { problems: SettingsProblem[]; unreadable: string[] } {
  const ours = new Set(buildAllowedTools(options));
  const problems: SettingsProblem[] = [];
  const unreadable: string[] = [];
  for (const file of [...new Set(settingsFiles(cwd, home, env))]) {
    if (!existsSync(file)) continue;
    let data: unknown;
    try {
      const stat = lstatSync(file);
      if (!stat.isFile() || stat.size > 1024 * 1024) throw new Error("not a settings file");
      data = JSON.parse(readFileSync(file, "utf8"));
    } catch {
      // A file this process cannot read is a file it cannot vouch for.
      unreadable.push(file);
      continue;
    }
    const permissions = (data as { permissions?: { allow?: unknown } } | null)?.permissions;
    const allow = permissions?.allow;
    if (!Array.isArray(allow)) continue;
    for (const rule of allow) {
      if (typeof rule === "string" && !ours.has(rule.trim())) problems.push({ rule: rule.trim().slice(0, 120), file });
    }
  }
  return { problems, unreadable };
}
