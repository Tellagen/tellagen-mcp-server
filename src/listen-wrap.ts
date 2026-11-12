import { spawn } from "node:child_process";

/**
 * `listen-wrap`: runs one client command under a timer of its own. The
 * listener starts every client through it, so the time limit of a run holds
 * even when the listener is killed or its terminal closes: the wrapper is a
 * separate process. It passes standard input, output and the exit code
 * through. At the limit it sends SIGTERM, then SIGKILL after the grace time,
 * and exits with 124.
 */
export async function runWrapped(options: {
  limitSeconds: number;
  graceSeconds?: number;
  command: string;
  args: readonly string[];
}): Promise<number> {
  return new Promise<number>((resolve) => {
    const child = spawn(options.command, [...options.args], { stdio: ["inherit", "inherit", "inherit"], windowsHide: true });
    let timedOut = false;
    let killer: ReturnType<typeof setTimeout> | undefined;
    const limit = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      killer = setTimeout(() => child.kill("SIGKILL"), (options.graceSeconds ?? 15) * 1000);
    }, options.limitSeconds * 1000);
    const forward = (signal: NodeJS.Signals) => () => void child.kill(signal);
    const handlers: Array<[NodeJS.Signals, () => void]> = (["SIGTERM", "SIGINT", "SIGHUP"] as const).map((s) => [s, forward(s)]);
    for (const [signal, handler] of handlers) process.on(signal, handler);
    const done = (code: number) => {
      clearTimeout(limit);
      if (killer) clearTimeout(killer);
      for (const [signal, handler] of handlers) process.off(signal, handler);
      resolve(code);
    };
    child.on("error", () => done(127));
    child.on("close", (code, signal) => done(timedOut ? 124 : code ?? (signal ? 128 : 1)));
  });
}

/** Parses `--limit-seconds N [--grace-seconds N] -- command args...`. */
export function parseWrapArgs(args: readonly string[]): { limitSeconds: number; graceSeconds?: number; command: string; args: string[] } | undefined {
  const dash = args.indexOf("--");
  if (dash < 0 || dash === args.length - 1) return undefined;
  const flags = args.slice(0, dash);
  const value = (name: string) => {
    const index = flags.indexOf(name);
    const number = index >= 0 ? Number(flags[index + 1]) : NaN;
    return Number.isFinite(number) && number > 0 ? number : undefined;
  };
  const limitSeconds = value("--limit-seconds");
  if (!limitSeconds) return undefined;
  return { limitSeconds, graceSeconds: value("--grace-seconds"), command: args[dash + 1]!, args: args.slice(dash + 2) };
}
