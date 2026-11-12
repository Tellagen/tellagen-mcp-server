import { homedir } from "node:os";
import { join } from "node:path";

/**
 * The folder where this server keeps what it must remember between runs:
 * the sign-in index, the remembered run, the listener's settings and logs.
 * `TELLAGEN_HOME` moves all of it, which is how a test avoids the real home
 * folder. It never holds a key, except the 0600 fallback file on a computer
 * with no keychain.
 */
export function tellagenHome(env: Record<string, string | undefined> = process.env): string {
  const fromEnv = (env.TELLAGEN_HOME ?? "").trim();
  return fromEnv || join(homedir(), ".tellagen");
}
