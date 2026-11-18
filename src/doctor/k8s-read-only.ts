import { isAbsolute, join } from "node:path";
import { toolOfEntry } from "./checks.js";
import { DOCTOR_CLIENTS, scanClient, type DoctorClient, type DoctorFs, type ServerEntry } from "./config-files.js";
import { parseToml } from "./toml.js";

/** Replaces a leading `~` and the `$HOME` forms that a config line may use. */
function expandHome(path: string, fs: DoctorFs): string {
  return path
    .replace(/^~(?=$|[\\/])/, fs.home)
    .replace(/^\$\{?HOME\}?(?=$|[\\/])/, fs.home)
    .replace(/^%USERPROFILE%(?=$|[\\/])/i, fs.home);
}

function flagValue(args: readonly string[], name: string): string | true | undefined {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === name) {
      const next = args[i + 1];
      return next !== undefined && !next.startsWith("-") ? next : true;
    }
    if (arg.startsWith(`${name}=`)) return arg.slice(name.length + 1);
  }
  return undefined;
}

function truthy(value: string | true): boolean | undefined {
  if (value === true) return true;
  const v = value.trim().toLowerCase();
  if (v === "true" || v === "1" || v === "yes") return true;
  if (v === "false" || v === "0" || v === "no") return false;
  return undefined;
}

/**
 * Whether one Kubernetes server entry runs read-only: the `read_only` setting
 * of its `--config` TOML file, or a `--read-only` flag. `true` when it does,
 * `false` when the entry clearly does not, `undefined` when it cannot be
 * known (a config file that cannot be read, or an entry that is a remote
 * address). Only this one fact is read; no path, value or file text leaves.
 */
export function kubernetesEntryReadOnly(entry: ServerEntry, fs: DoctorFs): boolean | undefined {
  if (entry.url && !entry.command) return undefined;
  const flag = flagValue(entry.args, "--read-only");
  if (flag !== undefined) return truthy(flag);
  const config = flagValue(entry.args, "--config");
  if (typeof config === "string") {
    const expanded = expandHome(config, fs);
    const path = isAbsolute(expanded) ? expanded : join(fs.cwd, expanded);
    const text = fs.readText(path);
    if (text === undefined) return undefined;
    try {
      const root = parseToml(text);
      const value = root.read_only;
      return value === true;
    } catch {
      return undefined;
    }
  }
  return false;
}

/**
 * The read-only flag of the Kubernetes server of a client, read from its
 * config files. With several Kubernetes servers it is true only when every
 * one is read-only. `undefined` when the client has no Kubernetes server in a
 * file the doctor reads, or the answer cannot be known.
 */
export function kubernetesReadOnlyOfClient(client: string | undefined, fs: DoctorFs): boolean | undefined {
  const clients: readonly DoctorClient[] = (DOCTOR_CLIENTS as readonly string[]).includes(client ?? "")
    ? [client as DoctorClient]
    : DOCTOR_CLIENTS;
  const answers: boolean[] = [];
  for (const name of clients) {
    for (const entry of scanClient(name, fs).entries) {
      if (toolOfEntry(entry) !== "kubernetes") continue;
      const answer = kubernetesEntryReadOnly(entry, fs);
      if (answer !== undefined) answers.push(answer);
    }
  }
  if (answers.length === 0) return undefined;
  return answers.every(Boolean);
}
