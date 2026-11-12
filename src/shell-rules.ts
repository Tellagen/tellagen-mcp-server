/**
 * The one rule for a shell command in a listened run.
 *
 * A list of allowed prefixes can never be safe for a command with flags: a
 * wildcard tail lets through `-s https://evil.example` or a directory to
 * write to. So this is a parser, and it refuses by default at every level:
 *
 * 1. The command may hold only a short set of safe characters. No quote, no
 *    `$`, no `;`, `|`, `&`, `<`, `>`, parenthesis, brace, backslash, star, tilde,
 *    line break, or leading `VAR=value`: the text is split on blanks and
 *    nothing is left for a shell to read.
 * 2. The first word is `kubectl` or `gh` by name, with no path.
 * 3. The next words are a verb from a fixed list for that program.
 * 4. Each other word is either a flag from the fixed list of THAT verb, with a
 *    value that matches the pattern of that flag, or a positional word that
 *    matches the pattern of that verb. A flag that is not listed is refused.
 *
 * Never listed, for any verb: the server, the identity and the credentials
 * (`-s`, `--server`, `--kubeconfig`, `--context`, `--cluster`, `--user`,
 * `--token`, `--as`, `--as-group`, `--insecure-skip-tls-verify`, the
 * certificate flags, `--hostname`), anything that writes a file or a folder
 * (`--output-directory`, `--cache-dir`, `--log-file`), `--raw`, `-f`,
 * `--filename`, a watch or a follow that never ends, and `--web`.
 *
 * The client does not get a looser copy of this rule. A hook runs
 * `evaluateCommand` before every shell call and the shell call runs only on
 * an explicit pass (see listen-guard).
 */

export interface CommandVerdict {
  allowed: boolean;
  reason: string;
}

const refuse = (reason: string): CommandVerdict => ({ allowed: false, reason });
const ALLOW: CommandVerdict = { allowed: true, reason: "" };

/** Every word of an allowed command is made of these characters only. */
const SAFE_WORD = /^[A-Za-z0-9_.:/=,@+-]+$/;

/** A name, or `kind/name`. No leading slash, no `..`. */
const NAME = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;
const SLASH_NAME = /^[A-Za-z0-9][A-Za-z0-9._:-]*(\/[A-Za-z0-9][A-Za-z0-9._:-]*)?$/;
/** The first word of `get` and `describe` may be a list of kinds: pods,services. */
const KIND_AND_NAMES = /^[A-Za-z0-9][A-Za-z0-9._:,/-]*$/;
const INTEGER = /^[0-9]{1,6}$/;
const DURATION = /^[0-9]{1,5}[smh]$/;
const SELECTOR = /^[A-Za-z0-9_.:/=,+-]{1,200}$/;
const FIELD_SELECTOR = /^[A-Za-z0-9_.=,!-]{1,200}$/;
const JSON_PATH = /^\.[A-Za-z0-9._-]{1,100}$/;
const REPO = /^[A-Za-z0-9._-]{1,100}\/[A-Za-z0-9._-]{1,100}$/;
const WORD = /^[A-Za-z0-9._:/-]{1,100}$/;
const JSON_FIELDS = /^[A-Za-z0-9,]{1,300}$/;

type FlagValue = "bool" | RegExp | readonly string[];
type FlagTable = Record<string, FlagValue>;

interface VerbSpec {
  /** Flags this verb accepts, long and short forms as separate keys. */
  flags: FlagTable;
  /** Positional words: how many, and what each looks like. */
  positional: { min: number; max: number; pattern: RegExp };
}

/** Resource kinds that `kubectl get`, `describe` and `top` may name. Secrets and config maps are not here. */
export const KUBECTL_KINDS: readonly string[] = [
  "pods", "pod", "po",
  "deployments", "deployment", "deploy",
  "replicasets", "replicaset", "rs",
  "statefulsets", "statefulset", "sts",
  "daemonsets", "daemonset", "ds",
  "services", "service", "svc",
  "endpoints", "endpoint", "ep",
  "ingresses", "ingress", "ing",
  "nodes", "node", "no",
  "namespaces", "namespace", "ns",
  "events", "event", "ev",
  "jobs", "job", "cronjobs", "cronjob", "cj",
  "horizontalpodautoscalers", "hpa",
  "poddisruptionbudgets", "pdb",
  "persistentvolumeclaims", "pvc", "persistentvolumes", "pv",
  "networkpolicies", "netpol",
];
const KIND_SET = new Set(KUBECTL_KINDS);
/** `kubectl rollout history` works on these kinds only. */
const ROLLOUT_KINDS = new Set(["deployments", "deployment", "deploy", "statefulsets", "statefulset", "sts", "daemonsets", "daemonset", "ds"]);
const TOP_KINDS = new Set(["pods", "pod", "po", "nodes", "node", "no"]);

const NAMESPACE_FLAGS: FlagTable = { "-n": NAME, "--namespace": NAME, "-A": "bool", "--all-namespaces": "bool" };
const OUTPUT: readonly string[] = ["json", "yaml", "wide", "name"];

/** Per-verb flags of kubectl. A verb that is not here is refused. */
const KUBECTL: Record<string, VerbSpec> = {
  get: {
    flags: {
      ...NAMESPACE_FLAGS,
      "-o": OUTPUT, "--output": OUTPUT,
      "-l": SELECTOR, "--selector": SELECTOR,
      "--field-selector": FIELD_SELECTOR,
      "--show-labels": "bool",
      "--no-headers": "bool",
      "--sort-by": JSON_PATH,
    },
    // The kind list comes first and is checked apart; names follow.
    positional: { min: 1, max: 20, pattern: KIND_AND_NAMES },
  },
  describe: {
    flags: { ...NAMESPACE_FLAGS, "-l": SELECTOR, "--selector": SELECTOR },
    positional: { min: 1, max: 20, pattern: KIND_AND_NAMES },
  },
  logs: {
    flags: {
      "-n": NAME, "--namespace": NAME,
      "-c": NAME, "--container": NAME,
      "--tail": INTEGER,
      "--since": DURATION,
      "--previous": "bool", "-p": "bool",
      "--timestamps": "bool",
      "--limit-bytes": INTEGER,
      "-l": SELECTOR, "--selector": SELECTOR,
      "--all-containers": "bool",
      "--prefix": "bool",
      "--max-log-requests": INTEGER,
    },
    positional: { min: 0, max: 1, pattern: SLASH_NAME },
  },
  top: {
    flags: { ...NAMESPACE_FLAGS, "-l": SELECTOR, "--selector": SELECTOR, "--containers": "bool", "--no-headers": "bool", "--sort-by": ["cpu", "memory"] },
    positional: { min: 1, max: 2, pattern: KIND_AND_NAMES },
  },
  events: {
    flags: { ...NAMESPACE_FLAGS, "--for": SLASH_NAME, "--types": /^(Normal|Warning)(,(Normal|Warning))?$/, "--no-headers": "bool" },
    positional: { min: 0, max: 0, pattern: NAME },
  },
  version: { flags: { "--client": "bool", "-o": ["json", "yaml"], "--output": ["json", "yaml"] }, positional: { min: 0, max: 0, pattern: NAME } },
  "api-resources": { flags: { "-o": ["name", "wide"], "--output": ["name", "wide"], "--namespaced": "bool", "--no-headers": "bool" }, positional: { min: 0, max: 0, pattern: NAME } },
  "api-versions": { flags: {}, positional: { min: 0, max: 0, pattern: NAME } },
  // `cluster-info` takes no word after it: `cluster-info dump` writes files.
  "cluster-info": { flags: {}, positional: { min: 0, max: 0, pattern: NAME } },
};

/** `kubectl rollout history` only: `rollout status` waits until the rollout ends. */
const KUBECTL_ROLLOUT_HISTORY: VerbSpec = {
  flags: { "-n": NAME, "--namespace": NAME, "--revision": INTEGER },
  positional: { min: 1, max: 1, pattern: SLASH_NAME },
};

const GH_COMMON: FlagTable = { "-R": REPO, "--repo": REPO, "--json": JSON_FIELDS, "-L": INTEGER, "--limit": INTEGER };
const GH_STATE: readonly string[] = ["open", "closed", "merged", "all"];
const GH_LIST: FlagTable = {
  ...GH_COMMON,
  "-s": GH_STATE, "--state": GH_STATE,
  "-a": WORD, "--author": WORD,
  "-l": WORD, "--label": WORD,
  "-B": WORD, "--base": WORD,
  "-H": WORD, "--head": WORD,
};
/** A number, a branch or a tag. Never an address: `gh` takes the host from a full URL. */
const GH_TARGET = /^[A-Za-z0-9._/-]{1,200}$/;
const GH_ONE: VerbSpec = { flags: { ...GH_COMMON }, positional: { min: 0, max: 1, pattern: GH_TARGET } };

/** `gh` command pairs that read, with the flags of each. `gh api` is not here: it can send any method. */
const GH: Record<string, VerbSpec> = {
  "pr view": { ...GH_ONE, flags: { ...GH_COMMON, "--comments": "bool" } },
  "pr list": { flags: GH_LIST, positional: { min: 0, max: 0, pattern: WORD } },
  "pr diff": { flags: { "-R": REPO, "--repo": REPO, "--name-only": "bool", "--patch": "bool" }, positional: GH_ONE.positional },
  "pr checks": { flags: { "-R": REPO, "--repo": REPO, "--required": "bool", "--json": JSON_FIELDS }, positional: GH_ONE.positional },
  "pr status": { flags: { "-R": REPO, "--repo": REPO, "--json": JSON_FIELDS }, positional: { min: 0, max: 0, pattern: WORD } },
  "issue view": { ...GH_ONE, flags: { ...GH_COMMON, "--comments": "bool" } },
  "issue list": { flags: GH_LIST, positional: { min: 0, max: 0, pattern: WORD } },
  "issue status": { flags: { "-R": REPO, "--repo": REPO, "--json": JSON_FIELDS }, positional: { min: 0, max: 0, pattern: WORD } },
  "run view": { flags: { ...GH_COMMON, "--log": "bool", "--log-failed": "bool", "--job": INTEGER, "-j": INTEGER }, positional: GH_ONE.positional },
  "run list": { flags: { ...GH_COMMON, "--branch": WORD, "-b": WORD, "--workflow": WORD, "--status": WORD, "-s": WORD }, positional: { min: 0, max: 0, pattern: WORD } },
  "workflow view": { flags: { "-R": REPO, "--repo": REPO, "--ref": WORD, "-r": WORD, "--yaml": "bool", "-y": "bool" }, positional: GH_ONE.positional },
  "workflow list": { flags: { ...GH_COMMON, "--all": "bool", "-a": "bool" }, positional: { min: 0, max: 0, pattern: WORD } },
  "release view": { ...GH_ONE },
  "release list": { flags: { ...GH_COMMON }, positional: { min: 0, max: 0, pattern: WORD } },
  "repo view": { ...GH_ONE, positional: { min: 0, max: 1, pattern: REPO } },
  "repo list": { flags: { ...GH_COMMON, "--language": WORD }, positional: { min: 0, max: 1, pattern: WORD } },
  "search code": searchSpec({ "--filename": WORD, "--extension": WORD, "--language": WORD, "--owner": WORD, "--repo": REPO }),
  "search commits": searchSpec({ "--author": WORD, "--owner": WORD, "--repo": REPO }),
  "search issues": searchSpec({ "--state": ["open", "closed"], "--owner": WORD, "--repo": REPO, "--label": WORD }),
  "search prs": searchSpec({ "--state": ["open", "closed"], "--owner": WORD, "--repo": REPO, "--label": WORD, "--merged": "bool" }),
  "search repos": searchSpec({ "--owner": WORD, "--language": WORD }),
};

function searchSpec(flags: FlagTable): VerbSpec {
  return { flags: { "--limit": INTEGER, "-L": INTEGER, "--json": JSON_FIELDS, ...flags }, positional: { min: 1, max: 8, pattern: WORD } };
}

/** `gh` words that take no flag at all, because a flag can print the token. */
export const GH_BARE_COMMANDS: readonly string[] = ["auth status"];

export const GH_READ_COMMANDS: readonly string[] = Object.keys(GH);
export const KUBECTL_VERBS: readonly string[] = [...Object.keys(KUBECTL), "rollout history"];

/** Words that, anywhere in a command, name a credential. They are refused whatever the verb or flag. */
const CREDENTIAL_WORD = /secret|token|credential|kubeconfig|serviceaccount|sa\/|ssh-key|gpg-key|password|\bpki\b|csr\b/i;

function checkFlags(tokens: string[], spec: VerbSpec, label: string): { rest: string[]; values: Record<string, string>; verdict?: CommandVerdict } {
  const positional: string[] = [];
  const values: Record<string, string> = {};
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!;
    if (!token.startsWith("-")) {
      positional.push(token);
      continue;
    }
    let name = token;
    let value: string | undefined;
    const eq = token.indexOf("=");
    if (eq > 0) {
      name = token.slice(0, eq);
      value = token.slice(eq + 1);
    }
    const rule = Object.prototype.hasOwnProperty.call(spec.flags, name) ? spec.flags[name] : undefined;
    if (rule === undefined) return { rest: [], values, verdict: refuse(`${label} does not take the flag ${name.slice(0, 40)} in a listened run.`) };
    if (rule === "bool") {
      if (value !== undefined) return { rest: [], values, verdict: refuse(`${name} takes no value.`) };
      continue;
    }
    if (value === undefined) {
      value = tokens[++i];
      if (value === undefined || value.startsWith("-")) return { rest: [], values, verdict: refuse(`${name} needs a value.`) };
    }
    const ok = Array.isArray(rule) ? (rule as readonly string[]).includes(value) : (rule as RegExp).test(value);
    values[name] = value;
    if (!ok) return { rest: [], values, verdict: refuse(`The value of ${name} is not on the list.`) };
  }
  if (positional.length < spec.positional.min || positional.length > spec.positional.max) {
    return { rest: [], values, verdict: refuse(`${label} has the wrong number of arguments.`) };
  }
  if (positional.some((word) => !spec.positional.pattern.test(word))) {
    return { rest: [], values, verdict: refuse(`${label} has an argument that is not a plain name.`) };
  }
  return { rest: positional, values };
}

function kubectlVerdict(tokens: string[]): CommandVerdict {
  const verb = tokens[1] ?? "";
  if (verb.startsWith("-") || !verb) return refuse("Put flags such as -n after the verb: kubectl get pods -n prod.");
  if (verb === "rollout") {
    if (tokens[2] !== "history") return refuse("kubectl rollout may only read its history.");
    const history = checkFlags(tokens.slice(3), KUBECTL_ROLLOUT_HISTORY, "kubectl rollout history");
    if (history.verdict) return history.verdict;
    // The object of a rollout is a deployment, a stateful set or a daemon set, written kind/name.
    return resourceArguments("rollout history", history.rest, ROLLOUT_KINDS);
  }
  if (!Object.prototype.hasOwnProperty.call(KUBECTL, verb)) return refuse(`kubectl ${verb.slice(0, 30)} is not on the read-only list.`);
  const spec = KUBECTL[verb]!;
  const parsed = checkFlags(tokens.slice(2), spec, `kubectl ${verb}`);
  if (parsed.verdict) return parsed.verdict;
  if (verb === "get" || verb === "describe" || verb === "top") {
    return resourceArguments(verb, parsed.rest, verb === "top" ? TOP_KINDS : KIND_SET);
  }
  if (verb === "logs" && parsed.rest[0]?.includes("/")) return resourceArguments(verb, parsed.rest, KIND_SET);
  // `events --for kind/name`: the same kind check as every other resource argument.
  if (verb === "events" && parsed.values["--for"] !== undefined) {
    const target = parsed.values["--for"];
    if (!target.includes("/")) return refuse(KIND_REFUSAL(verb));
    return resourceArguments(verb, [target], KIND_SET);
  }
  return ALLOW;
}

const KIND_REFUSAL = (verb: string) =>
  `kubectl ${verb} may name only these kinds: pods, deployments, replica sets, stateful sets, daemon sets, jobs, cron jobs, services, endpoints, ingresses, nodes, namespaces, events, autoscalers, volume claims and the like. Secrets, config maps, service accounts, roles, custom resources and "all" are not on the list.`;

/**
 * EVERY resource argument is checked, not only the first. kubectl takes either
 * `KIND[,KIND] [NAME...]` or `KIND/NAME [KIND/NAME...]`, and prints each object
 * it finds. So: in the first form the first word is a list of bare kinds and
 * each later word is a bare name with no slash; in the second form each word is
 * `kind/name`, and each kind is checked. A kind must be written in lower case
 * and be on the list: a short name, a plural or singular that is not listed, a
 * `kind.version.group` form, or a custom resource is refused.
 */
function resourceArguments(verb: string, words: string[], allowed: ReadonlySet<string>): CommandVerdict {
  if (words.length === 0) return refuse(KIND_REFUSAL(verb));
  const kindOk = (kind: string) => kind === kind.toLowerCase() && allowed.has(kind);
  if (words[0]!.includes("/")) {
    for (const word of words) {
      const [kind, name, ...extra] = word.split("/");
      if (extra.length > 0 || word.includes(",") || !kindOk(kind!) || !name || !NAME.test(name)) return refuse(KIND_REFUSAL(verb));
    }
    return ALLOW;
  }
  for (const kind of words[0]!.split(",")) if (!kindOk(kind)) return refuse(KIND_REFUSAL(verb));
  for (const name of words.slice(1)) {
    if (!NAME.test(name)) return refuse(`kubectl ${verb} takes plain names after the kind. Name each object as kind/name in one form or the other, not both.`);
  }
  return ALLOW;
}

function ghVerdict(tokens: string[]): CommandVerdict {
  const pair = `${tokens[1] ?? ""} ${tokens[2] ?? ""}`;
  if (GH_BARE_COMMANDS.includes(pair)) {
    return tokens.length === 3 ? ALLOW : refuse(`gh ${pair} takes no flag: a flag can print the token.`);
  }
  if (!Object.prototype.hasOwnProperty.call(GH, pair)) return refuse(`gh ${pair.trim().slice(0, 40)} is not on the read-only list.`);
  return checkFlags(tokens.slice(3), GH[pair]!, `gh ${pair}`).verdict ?? ALLOW;
}

/**
 * Whether a shell command is on the read-only list. Default deny: anything
 * the grammar above does not name is refused.
 */
export function evaluateCommand(command: string): CommandVerdict {
  if (typeof command !== "string" || command.length === 0) return refuse("The command is empty.");
  if (command.length > 1000) return refuse("The command is too long.");
  const tokens = command.trim().split(/ +/);
  if (tokens.some((word) => !SAFE_WORD.test(word))) {
    return refuse("The command has a character that a listened run may not use: a quote, $, ;, |, &, <, >, a bracket, a star, a backslash or a line break.");
  }
  const program = tokens[0] ?? "";
  if (program !== "kubectl" && program !== "gh") {
    return refuse(`${program.replace(/^.*\//, "").slice(0, 40) || "That command"} is not on the read-only list. Only kubectl and gh, by name.`);
  }
  // A credential is refused whatever the verb or the flag says.
  if (program === "kubectl" && tokens.slice(1).some((word) => CREDENTIAL_WORD.test(word) && !/^(--tail|--since|--timestamps)/.test(word))) {
    return refuse("The command names a secret or a credential.");
  }
  if (program === "gh" && tokens.slice(1).some((word) => /token|secret|ssh-key|gpg-key|password/i.test(word))) {
    return refuse("The command names a secret or a credential.");
  }
  return program === "kubectl" ? kubectlVerdict(tokens) : ghVerdict(tokens);
}

/** What the hook says to the client for one event: an explicit pass, or a refusal with a reason. */
export function guardDecision(eventJson: string): { decision: "allow" | "deny"; reason: string; command?: string } {
  let event: unknown;
  try {
    event = JSON.parse(eventJson);
  } catch {
    return { decision: "deny", reason: "The hook event could not be read." };
  }
  const record = (typeof event === "object" && event !== null ? event : {}) as Record<string, unknown>;
  if (record.tool_name !== "Bash") return { decision: "deny", reason: "Only the shell tool is checked here, and it is the only tool this hook passes." };
  const input = (typeof record.tool_input === "object" && record.tool_input !== null ? record.tool_input : {}) as Record<string, unknown>;
  const command = input.command;
  if (typeof command !== "string") return { decision: "deny", reason: "The shell call has no command." };
  // A background run or a call outside the sandbox is not part of a read.
  if (input.run_in_background === true || input.dangerouslyDisableSandbox === true) {
    return { decision: "deny", reason: "A listened run may not start a background command or leave the sandbox.", command };
  }
  const verdict = evaluateCommand(command);
  return verdict.allowed ? { decision: "allow", reason: "On the read-only list.", command } : { decision: "deny", reason: verdict.reason, command };
}
