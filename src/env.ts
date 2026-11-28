/**
 * A client that does not expand "${VAR}" or "${VAR:-default}" in the env block
 * of an MCP server hands the text itself over as the value. The plugin's
 * .mcp.json passes "${TELLAGEN_API_URL:-}", so on such a client the server saw
 * an address that is not one, and every call failed on it. A value like that
 * counts as not set.
 */
const UNEXPANDED = /^\$\{[A-Za-z_][A-Za-z0-9_]*(?::?[-=?+][^}]*)?\}$/u;

export function isUnexpandedPlaceholder(value: string | undefined): boolean {
  return value !== undefined && UNEXPANDED.test(value.trim());
}

/**
 * Removes each TELLAGEN_ variable that holds an unexpanded placeholder and
 * returns the names it removed, sorted. Other variables are left alone.
 */
export function dropUnexpandedEnv(env: Record<string, string | undefined> = process.env): string[] {
  const dropped: string[] = [];
  for (const name of Object.keys(env)) {
    if (name.startsWith("TELLAGEN_") && isUnexpandedPlaceholder(env[name])) {
      delete env[name];
      dropped.push(name);
    }
  }
  return dropped.sort();
}

/** One line for standard error about the variables that were ignored, or "" when there are none. */
export function unexpandedEnvLine(dropped: readonly string[]): string {
  if (dropped.length === 0) return "";
  return `Tellagen MCP: ${dropped.join(", ")} ${dropped.length === 1 ? "holds" : "hold"} a placeholder that this client did not fill in, so ${dropped.length === 1 ? "it is" : "they are"} ignored.\n`;
}
