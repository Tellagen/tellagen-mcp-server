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
  /\b[a-zA-Z][a-zA-Z0-9+.-]*:\/\/[^\s/:@"']+:[^\s/@"']+@/g,
  /\bbearer\s+[A-Za-z0-9._~+/=-]{8,}/gi,
  /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|glpat-[A-Za-z0-9_-]{20,}|glsa_[A-Za-z0-9_]{20,}|glc_[A-Za-z0-9+/=_-]{20,}|npm_[A-Za-z0-9]{20,}|xox[abeprs]-[A-Za-z0-9-]{10,}|sk-[A-Za-z0-9_-]{20,}|[sr]k_live_[A-Za-z0-9]{10,}|tlg_[a-z]+_[A-Za-z0-9._-]{8,}|tgn_[A-Za-z0-9._-]{8,}|tllg_[A-Za-z0-9._-]{8,})/g,
  /\b(?:AKIA|ASIA|ABIA|ACCA)[0-9A-Z]{16}\b/g,
  /\bAIza[0-9A-Za-z_-]{35}/g,
  /\b(?:AccountKey|SharedAccessKey|SharedAccessSignature)=[^;\s"']+/gi,
  // An old Grafana API key (base64 of {"k":...}) in any header or value.
  /\beyJr[A-Za-z0-9+/=_-]{16,}/g,
  // A DSN or address with one secret part: https://<key>@host
  /\b[a-zA-Z][a-zA-Z0-9+.-]*:\/\/[^\s/@"':]{8,}@/g,
];

// authorization: <rest of the line>, cookie: ...
const HEADER = /\b(authorization|proxy[-_]?authorization|cookie|set-cookie)(\\?["']?\s*[:=]\s*)([^\r\n]*)/gi;
// password: the rest of the line (a password can hold spaces)
const SECRET_PHRASE = /\b([A-Za-z0-9_.-]*(?:password|passwd|passphrase|pwd|secret))([ \t]*:[ \t]*)((?:[^\s"':\\]|\\[^"\r\n])(?:[^\r\n"\\]|\\[^"\r\n])*)/gi;
// key=value, key: value, "key": "value" for a key that names a secret
const SECRET_KEY = "[A-Za-z0-9_.-]*(?:password|passwd|passphrase|pwd|secret|token|api[-_]?key|apikey|access[-_]?key|private[-_]?key|credential|auth)[A-Za-z0-9_.-]*";
const FIELD = new RegExp(
  `(${SECRET_KEY})(\\\\?["']?\\s*[:=]\\s*)(\\\\"(?:[^"\\\\]|\\\\[^"])*\\\\"|"(?:[^"\\\\]|\\\\.)*"|'[^']*'|[^\\s,;&}\\])"']+)`,
  "gi",
);
// curl -u user:password, --user user:password
const USER_FLAG = /(\s(?:-u|--user)(?:\s+|=))(\S+)/g;
// --from-literal=name=value (kubectl create secret)
const LITERAL_FLAG = /(--from-literal(?:\s+|=))(\S+)/g;
// A command-line flag that names a secret: --token abc, --password=abc, -p abc is left alone.
const FLAG = /(--(?:[a-z0-9-]*(?:token|password|passwd|secret|api-key|apikey|auth-key|credential)[a-z0-9-]*))(\s+|=)(\S+)/gi;

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
