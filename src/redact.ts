/**
 * Masks tokens and passwords in a text before it leaves this computer. The
 * rules follow the ones Tellagen applies again when it receives a step, so a
 * secret that this list misses is still removed there; this list exists so
 * that a secret is never sent at all.
 *
 * It masks secrets only. Hosts, namespaces and queries stay, because they are
 * what a recorded step is for.
 */

const MASK = "[redacted]";

const PATTERNS: RegExp[] = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g,
  /\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}(?:\.[A-Za-z0-9_-]*)?/g,
  // user:password@ in a URL
  /(?<![A-Za-z0-9+.-])[a-zA-Z][a-zA-Z0-9+.-]*:\/\/[^\s/:@"']*:[^\s/@"']+@/g,
  /\bbearer\s+[A-Za-z0-9._~+/=-]{8,}/gi,
  /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|glpat-[A-Za-z0-9_-]{20,}|glsa_[A-Za-z0-9_]{20,}|glc_[A-Za-z0-9+/=_-]{20,}|npm_[A-Za-z0-9]{20,}|xox[abeprs]-[A-Za-z0-9-]{10,}|sk-[A-Za-z0-9_-]{20,}|[sr]k_live_[A-Za-z0-9]{10,}|tlg_[a-z]+_[A-Za-z0-9._-]{8,}|tgn_[A-Za-z0-9._-]{8,}|tllg_[A-Za-z0-9._-]{8,})/g,
  /\b(?:AKIA|ASIA|ABIA|ACCA)[0-9A-Z]{16}\b/g,
  /\bAIza[0-9A-Za-z_-]{35}/g,
  /\b(?:AccountKey|SharedAccessKey|SharedAccessSignature)=[^;\s"']+/gi,
  // An old Grafana API key (base64 of {"k":...}) in any header or value.
  /\beyJr[A-Za-z0-9+/=_-]{16,}/g,
  // A DSN or address with one secret part: https://<key>@host
  /(?<![A-Za-z0-9+.-])[a-zA-Z][a-zA-Z0-9+.-]*:\/\/[^\s/@"':]{8,}@/g,
];

// authorization: <rest of the line>, cookie: ...
const HEADER = /\b(authorization|proxy[-_]?authorization|cookie|set-cookie)(\\?["']?\s*[:=]\s*)([^\r\n]*)/gi;
// password: the rest of the line (a password can hold spaces)
const SECRET_PHRASE = /(?<![A-Za-z0-9_.-])([A-Za-z0-9_.-]*(?:password|passwd|passphrase|pwd|secret))([ \t]*:[ \t]*)((?:[^\s"':\\]|\\[^"\r\n])(?:[^\r\n"\\]|\\[^"\r\n])*)/gi;
// key=value, key: value, "key": "value" for a key that names a secret
const SECRET_KEY = "(?<![A-Za-z0-9_.-])[A-Za-z0-9_.-]*(?:password|passwd|passphrase|pwd|secret|token|api[-_]?key|apikey|access[-_]?key|private[-_]?key|credential|auth)[A-Za-z0-9_.-]*";
const FIELD = new RegExp(
  `(${SECRET_KEY})(\\\\?["']?\\s*[:=]\\s*)(\\\\"(?:[^"\\\\]|\\\\[^"])*\\\\"|"(?:[^"\\\\]|\\\\.)*"|'[^']*'|[^\\s,;&}\\])"']+)`,
  "gi",
);
// curl -u user:password, --user user:password
const USER_FLAG = /(\s(?:-u|--user)(?:\s+|=))(\S+)/g;
// --from-literal=name=value (kubectl create secret)
const LITERAL_FLAG = /(--from-literal(?:\s+|=))(\S+)/g;
// A command-line flag that names a secret: --token abc, --password=abc, -p abc is left alone.
const FLAG = /(?<![a-z0-9-])(--(?:[a-z0-9-]*(?:token|password|passwd|secret|api-key|apikey|auth-key|credential)[a-z0-9-]*))(\s+|=)(\S+)/gi;

/** A text with the tokens and passwords in it masked. */
export function redactSecrets(text: string): string {
  let out = text;
  for (const pattern of PATTERNS) out = out.replace(pattern, MASK);
  out = out.replace(HEADER, (_m, name: string, sep: string) => `${name}${sep}${MASK}`);
  out = out.replace(SECRET_PHRASE, (_m, name: string, sep: string) => `${name}${sep}${MASK}`);
  out = out.replace(FLAG, (_m, flag: string, sep: string) => `${flag}${sep}${MASK}`);
  out = out.replace(USER_FLAG, (_m, flag: string) => `${flag}${MASK}`);
  out = out.replace(LITERAL_FLAG, (_m, flag: string) => `${flag}${MASK}`);
  out = out.replace(FIELD, (_m, key: string, sep: string, value: string) => {
    // A value that an earlier rule already masked stays as it is: the pattern for a value stops at "]".
    if (value === MASK || value.startsWith("[redacted")) return `${key}${sep}${value}`;
    const quote = value.startsWith('"') ? '"' : value.startsWith("'") ? "'" : value.startsWith('\\"') ? '\\"' : "";
    return `${key}${sep}${quote}${MASK}${quote}`;
  });
  return out;
}

const SECRET_KEY_EXACT = /^(token|access_token|api_key|apikey|password|passwd|cookie|authorization|client_secret|refresh_token|private_key|webhook_secret|basic_auth|bearer_token|secret)$/i;

/** A JSON value with secrets masked: a secret key loses its value, every string is cleaned. */
export function redactValue(value: unknown, depth = 0): unknown {
  if (depth > 8) return "[too deep]";
  if (typeof value === "string") return redactSecrets(value);
  if (Array.isArray(value)) return value.slice(0, 50).map((item) => redactValue(item, depth + 1));
  if (typeof value === "object" && value !== null) {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>).slice(0, 50)) {
      out[key] = SECRET_KEY_EXACT.test(key.replace(/-/g, "_")) ? MASK : redactValue(item, depth + 1);
    }
    return out;
  }
  return value;
}

const SECRET_KEY_ANY = new RegExp(`^${SECRET_KEY.replace("(?<![A-Za-z0-9_.-])", "")}$`, "i");
// A name with one of these words as a part (split by - _ . or a space, or by camelCase) is a secret.
const STRONG_PARTS = new Set([
  "password", "passwd", "passphrase", "pwd", "token", "secret", "credential", "credentials", "authorization",
  "cookie", "dsn", "apikey", "privatekey", "accesskey", "signature",
]);
// ... and with one of these only as the last part: DB_PASS, user_session, but not pass_rate or session_count.
const LAST_PARTS = new Set(["pass", "session", "sessionid", "auth"]);
const PAIR_SEQUENCES = ["auth_code", "oauth_code", "api_key", "private_key", "access_key", "connection_string", "session_id", "secret_key"];

/**
 * Whether a field or variable name says that its value is a secret: token,
 * secret, password, passwd, pass, pwd, api key, auth, authorization, cookie,
 * set-cookie, session, private key, client secret, credential, dsn and
 * connection string, in any case and form (DB_PASSWORD, DB_PASS, X-Api-Key,
 * setCookie). This is the one key rule: the text rule and the field rule both
 * use it.
 */
export function isSecretKey(key: string): boolean {
  const trimmed = key.trim();
  if (trimmed === "") return false;
  if (SECRET_KEY_ANY.test(trimmed) || SECRET_KEY_ANY.test(trimmed.replace(/-/g, "_"))) return true;
  const snake = trimmed
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[-.\s]+/g, "_")
    .toLowerCase();
  const parts = snake.split("_").filter((part) => part !== "");
  if (parts.some((part) => STRONG_PARTS.has(part))) return true;
  if (parts.length > 0 && LAST_PARTS.has(parts[parts.length - 1]!)) return true;
  return PAIR_SEQUENCES.some((sequence) => `_${snake}_`.includes(`_${sequence}_`));
}

/** The value key of a name/value pair: value, val, env_value, secretValue. */
export function isPairValueKey(key: string): boolean {
  return /^(?:value|val|.*[_.-](?:value|val)|.*[a-z](?:Value|Val))$/i.test(key.trim());
}

/** The name key of a name/value pair: name, key, env_name, varName. */
export function isPairNameKey(key: string): boolean {
  return /^(?:name|key|.*[_.-](?:name|key)|.*[a-z](?:Name|Key))$/i.test(key.trim());
}

const MASKED = "[redacted]";

type Json = Record<string, unknown>;
const isObject = (value: unknown): value is Json => typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * Masks, in a parsed JSON value, every value key of an object whose name key
 * holds a secret word (anywhere in the same object, any order), every value
 * under a secret key, and the same inside strings that hold JSON. Returns
 * whether anything changed.
 */
function maskJson(value: unknown, depth = 0): { value: unknown; changed: boolean } {
  if (depth > 8) return { value, changed: false };
  if (Array.isArray(value)) {
    let changed = false;
    const out = value.map((item) => {
      const r = maskJson(item, depth + 1);
      changed ||= r.changed;
      return r.value;
    });
    return { value: out, changed };
  }
  if (typeof value === "string") {
    const t = value.trim();
    if (t.startsWith("{") && t.endsWith("}")) {
      try {
        const r = maskJson(JSON.parse(t), depth + 1);
        if (r.changed) return { value: JSON.stringify(r.value), changed: true };
      } catch {
        // not JSON: the text rules see it
      }
    }
    return { value, changed: false };
  }
  if (!isObject(value)) return { value, changed: false };
  const namesSecret = Object.entries(value).some(([k, v]) => isPairNameKey(k) && typeof v === "string" && isSecretKey(v));
  let changed = false;
  const out: Json = {};
  for (const [k, v] of Object.entries(value)) {
    if ((isSecretKey(k) || (namesSecret && isPairValueKey(k))) && v !== null && typeof v !== "object" && v !== MASKED) {
      out[k] = MASKED;
      changed = true;
      continue;
    }
    const r = maskJson(v, depth + 1);
    changed ||= r.changed;
    out[k] = r.value;
  }
  return { value: out, changed };
}

/**
 * Finds each balanced JSON object or array in a line (after a timestamp or a
 * level, several in one line, or the whole line), masks its pairs and puts the
 * masked JSON back in its place. A segment that is no JSON stays as it is.
 */
function maskEmbeddedJson(text: string): string {
  let result = "";
  let i = 0;
  let tries = 0;
  while (i < text.length && tries < 200) {
    const ch = text[i]!;
    if (ch !== "{" && ch !== "[") {
      // Jump to the next bracket: a long prefix costs one step, not one for each character.
      let next = text.length;
      for (const bracket of ["{", "["]) {
        const at = text.indexOf(bracket, i);
        if (at >= 0 && at < next) next = at;
      }
      result += text.slice(i, next);
      i = next;
      continue;
    }
    tries += 1;
    const end = balancedEnd(text, i);
    if (end > 0) {
      const segment = text.slice(i, end + 1);
      try {
        const r = maskJson(JSON.parse(segment));
        if (r.changed) {
          result += JSON.stringify(r.value);
          i = end + 1;
          continue;
        }
        result += segment;
        i = end + 1;
        continue;
      } catch {
        // not JSON: go on inside it, a smaller object may be
      }
    }
    result += ch;
    i += 1;
  }
  return result + text.slice(i);
}

/** The index of the bracket that closes the one at `start`, string-aware; -1 when none. */
function balancedEnd(text: string, start: number): number {
  let depth = 0;
  let inString = false;
  for (let i = start; i < text.length && i - start < 100_000; i++) {
    const c = text[i]!;
    if (inString) {
      if (c === "\\") i += 1;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') inString = true;
    else if (c === "{" || c === "[") depth += 1;
    else if (c === "}" || c === "]") {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

const LOGFMT_TOKEN = /(^|\s)([A-Za-z_][\w.-]*)=("(?:[^"\\]|\\.)*"|\S*)/g;

// key sep value, in any text: "key":"value", key=value, key: value, key%3Dvalue.
const GENERIC_PAIR =
  /(?<![A-Za-z0-9_.-])(["']?)([A-Za-z_][A-Za-z0-9_.-]*)\1(\s*(?:[:=]|%3[Dd])\s*)("(?:[^"\\]|\\.)*"|'[^']*'|\[redacted\]\s+[A-Za-z0-9+/._~-]{12,}={0,2}|\[redacted\]|(?:(?:Basic|Bearer|Digest|Token|Negotiate)\s+)?[^\s,;&}\])"']+)/gi;
// OAuth and signed-URL parameters that are secrets in a query.
const QUERY_SECRET = /([?&](?:code|sig|signature|x-amz-signature|x-amz-credential)(?:=|%3[Dd]))[^&\s"']+/gi;

/**
 * The one redaction step for text that leaves this computer in a log figure:
 * the line text, every field value and the query. Order: the value shapes of
 * redactSecrets (tokens, keys, URL userinfo, headers), then the one key rule
 * (isSecretKey) on every key/value in the text, then name/value pairs decided
 * on the whole line or JSON object, in any order and at any distance.
 */
export function redactLogText(text: string): string {
  let out = redactSecrets(text);
  out = out.replace(QUERY_SECRET, (_m, head: string) => `${head}${MASKED}`);
  out = out.replace(GENERIC_PAIR, (m, quote: string, key: string, sep: string, value: string) => {
    if (!isSecretKey(key) && value.length <= 2000 && /%(?:25)?3[Dd]/.test(value)) {
      // A URL-encoded pair inside a longer value: look at a decoded copy.
      try {
        const decoded = decodeURIComponent(value);
        if (redactLogText(decoded) !== decoded) {
          const q = value.startsWith('"') ? '"' : value.startsWith("'") ? "'" : "";
          return `${quote}${key}${quote}${sep}${q}${MASKED}${q}`;
        }
      } catch {
        // not valid URL encoding: the value stays
      }
    }
    if (!isSecretKey(key) || value === MASKED || value.slice(1) === `${MASKED}"` || value.slice(1) === `${MASKED}'`) return m;
    const q = value.startsWith('"') ? '"' : value.startsWith("'") ? "'" : "";
    return `${quote}${key}${quote}${sep}${q}${MASKED}${q}`;
  });
  out = maskEmbeddedJson(out);
  const pairs = [...out.matchAll(LOGFMT_TOKEN)];
  const namesSecret = pairs.some((m) => isPairNameKey(m[2]!) && isSecretKey(m[3]!.replace(/^"|"$/g, "")));
  if (namesSecret) {
    out = out.replace(LOGFMT_TOKEN, (m, lead: string, key: string, value: string) =>
      isPairValueKey(key) && !value.startsWith(MASKED) ? `${lead}${key}=${value.startsWith('"') ? `"${MASKED}"` : MASKED}` : m,
    );
  }
  return out;
}
