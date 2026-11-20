/**
 * A client that the listener started runs unattended: nobody can answer a
 * question. The listener sets this variable for the client it starts, and the
 * Tellagen MCP server that the client starts inherits it. An unattended session
 * never takes a run over from another client or session: the other one is most
 * likely a person who opened the run by hand.
 */
export const UNATTENDED_ENV = "TELLAGEN_UNATTENDED";

/** True when this process runs under the listener. */
export function isUnattended(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[UNATTENDED_ENV] === "1";
}
