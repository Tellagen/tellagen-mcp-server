/** What a command needs from its surroundings, so a test can run it without a terminal. */
export interface CliIo {
  env: Record<string, string | undefined>;
  stdout(text: string): void;
  stderr(text: string): void;
  /** All of standard input; "" when it is a terminal. */
  readStdin(maxBytes: number): Promise<string>;
}

export const realIo: CliIo = {
  env: process.env,
  stdout: (text) => void process.stdout.write(text),
  stderr: (text) => void process.stderr.write(text),
  readStdin: async (maxBytes) => {
    if (process.stdin.isTTY) return "";
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of process.stdin) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
      size += buffer.length;
      // More than the limit is not read; the caller sees a cut event and drops it.
      if (size > maxBytes) {
        chunks.push(buffer.subarray(0, Math.max(0, buffer.length - (size - maxBytes))));
        break;
      }
      chunks.push(buffer);
    }
    return Buffer.concat(chunks).toString("utf8");
  },
};

/** Splits `--name value`, `--name=value` and flags. Anything else is a positional. */
export function parseArgs(
  args: readonly string[],
  valued: readonly string[],
  flags: readonly string[],
): { values: Record<string, string>; flags: Set<string>; positional: string[]; unknown: string[] } {
  const values: Record<string, string> = {};
  const seen = new Set<string>();
  const positional: string[] = [];
  const unknown: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (!arg.startsWith("--")) {
      positional.push(arg);
      continue;
    }
    const eq = arg.indexOf("=");
    const name = eq === -1 ? arg.slice(2) : arg.slice(2, eq);
    if (valued.includes(name)) {
      const value = eq === -1 ? args[++i] : arg.slice(eq + 1);
      if (value === undefined) unknown.push(arg);
      else values[name] = value;
    } else if (flags.includes(name) && eq === -1) {
      seen.add(name);
    } else {
      unknown.push(arg);
    }
  }
  return { values, flags: seen, positional, unknown };
}
