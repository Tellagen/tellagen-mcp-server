/**
 * Source link building for evidence refs (CORE-776).
 *
 * The pure functions here are ports of the web resolver in
 * web/lib/investigation/sourceLinks.ts and web/lib/grafana/deeplink.ts. The
 * shared vectors (test/fixtures/sourceLinkVectors.json) pin the same input to
 * the same output string on both sides. Keep Grafana's `left` Explore
 * parameter: Grafana main still migrates it and `panes` breaks older
 * versions (CORE-761).
 *
 * Nothing here touches the network or reads credentials.
 */

export type SourceFamily =
  | "prometheus"
  | "loki"
  | "tempo"
  | "grafana"
  | "github"
  | "kubernetes"
  | "codebase"
  | "database"
  | "docs"
  | "tellagen"
  | "other";

export type SourceClass = {
  family: SourceFamily;
  key: string;
  label: string;
  viaGrafana: boolean;
};

export const MAX_URL_LENGTH = 2048;
export const MAX_LINK_LABEL_LENGTH = 60;
export const MAX_COMMAND_LENGTH = 1000;

function normalizeSourceName(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, "-")
    .replace(/^(?:query|get|search|list|run|mcp)-/, "");
}

function titleCase(value: string): string {
  return value
    .split("-")
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function datasourceFamily(rest: string): SourceFamily | null {
  if (
    /^(?:prometheus|prom|promql|mimir|thanos|victoriametrics|metrics)(?:$|-)/.test(
      rest,
    )
  ) {
    return "prometheus";
  }
  if (/^(?:loki|logql|logs?)(?:$|-)/.test(rest)) return "loki";
  if (/^(?:tempo|jaeger|zipkin|traces?)(?:$|-)/.test(rest)) return "tempo";
  if (
    /^(?:postgres|postgresql|mysql|mariadb|mssql|sql|sqlite|mongo|mongodb|redis|clickhouse|elasticsearch|opensearch|bigquery|snowflake)(?:$|-)/.test(
      rest,
    )
  ) {
    return "database";
  }
  return null;
}

const FAMILY_LABELS: Record<SourceFamily, string> = {
  prometheus: "Prometheus",
  loki: "Loki",
  tempo: "Tempo",
  grafana: "Grafana",
  github: "GitHub",
  kubernetes: "Kubernetes",
  codebase: "Codebase",
  database: "Database",
  docs: "Docs",
  tellagen: "Tellagen",
  other: "Source",
};

/**
 * Names the kind of a free-text source by its prefix (`grafana`,
 * `grafana-prometheus`, `Prometheus`, `loki`, `kubernetes-logs`, `codebase`,
 * `postgres`, the tool-style `query_loki_logs`). Never compares exactly.
 */
export function classifySource(source: string | null | undefined): SourceClass {
  const name = normalizeSourceName(source ?? "");
  if (!name) {
    return {
      family: "other",
      key: "unknown",
      label: "Source",
      viaGrafana: false,
    };
  }
  if (/^(?:kubernetes|kube|k8s|kubectl)(?:$|-)/.test(name)) {
    return {
      family: "kubernetes",
      key: "kubernetes",
      label: "Kubernetes",
      viaGrafana: false,
    };
  }
  if (/^(?:github|gh)(?:$|-)/.test(name) || name === "git") {
    return { family: "github", key: "github", label: "GitHub", viaGrafana: false };
  }
  if (/^grafana(?:$|-)/.test(name)) {
    const rest = name.slice("grafana".length).replace(/^-/, "");
    const family = datasourceFamily(rest) ?? "grafana";
    const label =
      family === "grafana" || family === "database"
        ? "Grafana"
        : `Grafana · ${FAMILY_LABELS[family]}`;
    return { family, key: "grafana", label, viaGrafana: true };
  }
  const direct = datasourceFamily(name);
  if (direct && direct !== "database") {
    return {
      family: direct,
      key: direct,
      label: FAMILY_LABELS[direct],
      viaGrafana: false,
    };
  }
  if (direct === "database") {
    const token = name.split("-")[0];
    return {
      family: "database",
      key: token,
      label: titleCase(token),
      viaGrafana: false,
    };
  }
  if (
    /^(?:codebase|code|repo|repository|file|files|filesystem|source-code)(?:$|-)/.test(
      name,
    )
  ) {
    return { family: "codebase", key: "codebase", label: "Codebase", viaGrafana: false };
  }
  if (/^(?:docs?|confluence|runbook|notion|wiki)(?:$|-)/.test(name)) {
    return { family: "docs", key: "docs", label: "Docs", viaGrafana: false };
  }
  if (/^tellagen(?:$|-)/.test(name)) {
    return { family: "tellagen", key: "tellagen", label: "Tellagen", viaGrafana: false };
  }
  const token = name.split("-")[0] || "unknown";
  return {
    family: "other",
    key: token,
    label: titleCase(token) || "Source",
    viaGrafana: false,
  };
}

export type SafeSourceUrl = {
  /** Credentials stripped; `http` or `https` only. */
  url: string;
  host: string;
  hostname: string;
  /** A `.invalid` host (the demo's): shown, never opened. */
  example: boolean;
};

function normalizeHostname(hostname: string): string {
  return hostname.toLowerCase().replace(/\.+$/, "");
}

/**
 * The address a browser may open, or null: http and https only, credentials
 * removed. `javascript:`, `data:`, `file:` and everything else is dropped.
 */
export function sanitizeSourceUrl(
  raw: string | null | undefined,
): SafeSourceUrl | null {
  const text = (raw ?? "").trim();
  if (!text || text.length > MAX_URL_LENGTH) return null;
  let parsed: URL;
  try {
    parsed = new URL(text);
  } catch {
    return null;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
  const hostname = normalizeHostname(parsed.hostname);
  if (!hostname) return null;
  parsed.username = "";
  parsed.password = "";
  return {
    url: parsed.toString(),
    host: parsed.host,
    hostname,
    example: hostname === "invalid" || hostname.endsWith(".invalid"),
  };
}

const K8S_KINDS = new Set([
  "deployments",
  "pods",
  "events",
  "statefulsets",
  "daemonsets",
  "replicasets",
  "services",
  "jobs",
  "nodes",
]);

const K8S_TOKEN = /^[A-Za-z0-9][A-Za-z0-9._@-]*$/;

/**
 * A kubectl command for a `k8s://context/<ctx>/namespace/<ns>/<kind>/<name>`
 * reference, only when the kind is one the agents read and every part is a
 * plain token (nothing that could change the command's meaning).
 */
export function kubectlCommandFromK8sUrl(raw: string): string | null {
  const text = raw.trim();
  if (!/^k8s:\/\//i.test(text)) return null;
  const parts = text
    .slice("k8s://".length)
    .split(/[?#]/)[0]
    .split("/")
    .filter(Boolean);
  if (parts[0] !== "context" || parts.length < 4) return null;
  let context: string;
  try {
    context = decodeURIComponent(parts[1]);
  } catch {
    return null;
  }
  if (!K8S_TOKEN.test(context)) return null;
  let index = 2;
  let namespace: string | null = null;
  if (parts[index] === "namespace") {
    namespace = parts[index + 1] ?? null;
    if (!namespace || !K8S_TOKEN.test(namespace)) return null;
    index += 2;
  }
  const kind = parts[index];
  if (!kind || !K8S_KINDS.has(kind)) return null;
  const nameRaw = parts[index + 1];
  const name = nameRaw ? nameRaw.split(":")[0] : null;
  if (name && (name === "proxy" || !K8S_TOKEN.test(name))) return null;
  const segments = ["kubectl", "--context", context];
  if (namespace) segments.push("-n", namespace);
  segments.push("get", kind);
  if (name) segments.push(name);
  return segments.join(" ");
}

/** A Grafana time (an ISO instant, epoch milliseconds, or `now-1h`) as Explore reads it. */
export function exploreTime(value: string | undefined, fallback: string): string {
  const text = value?.trim();
  if (!text) return fallback;
  if (/^now/.test(text) || /^\d+$/.test(text)) return text;
  const at = Date.parse(text);
  return Number.isFinite(at) ? String(at) : fallback;
}

function isOpenableHttpUrl(parsed: URL): boolean {
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;
  return !(
    parsed.hostname === "invalid" || parsed.hostname.endsWith(".invalid")
  );
}

export type GrafanaExploreInput = {
  baseUrl: string;
  /** The Grafana data source's name or uid. */
  datasource?: string;
  query: string;
  from?: string;
  to?: string;
  /**
   * Omitted keeps `orgId=1`; a value uses it; `null` leaves `orgId` out so
   * Grafana opens the viewer's current org.
   */
  orgId?: string | number | null;
  /**
   * How the query is written into the pane. `expr` is right for Prometheus and
   * Loki (the default and the only shape the shared vectors pin); `traceql`
   * is Tempo's trace id / TraceQL query.
   */
  queryShape?: "expr" | "traceql";
};

/**
 * Same string as the web `buildGrafanaExploreLink` for the shared vectors:
 * `<base>/explore?orgId=1&left=<json>`.
 */
export function buildGrafanaExploreLink(input: GrafanaExploreInput): string | null {
  const query = input.query.trim();
  if (!query) return null;
  let base: URL;
  try {
    base = new URL(input.baseUrl.trim());
  } catch {
    return null;
  }
  if (!isOpenableHttpUrl(base)) return null;

  const queryEntry =
    input.queryShape === "traceql"
      ? { refId: "A", queryType: "traceql", query }
      : { refId: "A", expr: query };
  const pane: Record<string, unknown> = {
    queries: [queryEntry],
    range: {
      from: exploreTime(input.from, "now-1h"),
      to: exploreTime(input.to, "now"),
    },
  };
  const datasource = input.datasource?.trim();
  if (datasource) pane.datasource = datasource;

  const path = base.pathname.replace(/\/+$/, "");
  const org = input.orgId === undefined ? "1" : input.orgId;
  const orgParam =
    org === null || `${org}`.trim() === ""
      ? ""
      : `orgId=${encodeURIComponent(`${org}`.trim())}&`;
  return `${base.origin}${path}/explore?${orgParam}left=${encodeURIComponent(JSON.stringify(pane))}`;
}

/** A Grafana dashboard (and optionally one panel) at a time range. */
export function buildGrafanaPanelLink(input: {
  baseUrl: string;
  dashboardUid: string;
  panelId?: number;
  from?: string;
  to?: string;
  orgId?: string | number | null;
}): string | null {
  const uid = input.dashboardUid.trim();
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(uid)) return null;
  let base: URL;
  try {
    base = new URL(input.baseUrl.trim());
  } catch {
    return null;
  }
  if (!isOpenableHttpUrl(base)) return null;
  const path = base.pathname.replace(/\/+$/, "");
  const params: string[] = [];
  if (input.orgId !== undefined && input.orgId !== null && `${input.orgId}`.trim() !== "") {
    params.push(`orgId=${encodeURIComponent(`${input.orgId}`.trim())}`);
  }
  if (input.panelId !== undefined) params.push(`viewPanel=${input.panelId}`);
  params.push(`from=${encodeURIComponent(exploreTime(input.from, "now-1h"))}`);
  params.push(`to=${encodeURIComponent(exploreTime(input.to, "now"))}`);
  return `${base.origin}${path}/d/${encodeURIComponent(uid)}?${params.join("&")}`;
}

const GITHUB_REPO = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}\/[A-Za-z0-9._-]{1,100}$/;
const GITHUB_REF = /^[A-Za-z0-9._\/@~^+-]{1,200}$/;
const GITHUB_SHA = /^[0-9a-fA-F]{7,40}$/;

function githubBase(githubUrl?: string): string | null {
  const text = githubUrl?.trim();
  if (!text) return "https://github.com";
  const safe = sanitizeSourceUrl(text);
  if (!safe || safe.example) return null;
  const parsed = new URL(safe.url);
  return `${parsed.origin}${parsed.pathname.replace(/\/+$/, "")}`;
}

function encodeRef(ref: string): string {
  return ref.split("/").map(encodeURIComponent).join("/");
}

/** GitHub compare, commit and pull request URLs from `owner/name`. */
export function buildGithubLink(
  kind: "diff" | "commit" | "pr",
  input: {
    repo: string;
    sha?: string;
    base?: string;
    head?: string;
    prNumber?: number;
    githubUrl?: string;
  },
): string | null {
  const repo = input.repo.trim();
  if (!GITHUB_REPO.test(repo) || repo.includes("..")) return null;
  const base = githubBase(input.githubUrl);
  if (!base) return null;
  if (kind === "commit") {
    const sha = input.sha?.trim() ?? "";
    return GITHUB_SHA.test(sha) ? `${base}/${repo}/commit/${sha.toLowerCase()}` : null;
  }
  if (kind === "pr") {
    const n = input.prNumber;
    return n !== undefined && Number.isInteger(n) && n > 0
      ? `${base}/${repo}/pull/${n}`
      : null;
  }
  const from = input.base?.trim() ?? "";
  const to = input.head?.trim() ?? "";
  if (!GITHUB_REF.test(from) || !GITHUB_REF.test(to)) return null;
  if (from.includes("..") || to.includes("..")) return null;
  return `${base}/${repo}/compare/${encodeRef(from)}...${encodeRef(to)}`;
}

/** A single line of at most 60 characters for a link label. */
export function linkLabel(text: string): string {
  const clean = text.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
  return clean.length > MAX_LINK_LABEL_LENGTH
    ? `${clean.slice(0, MAX_LINK_LABEL_LENGTH - 1)}…`
    : clean;
}

/** A command to copy: control characters out, bounded, never an address. */
export function cleanCommand(value: string | null | undefined): string | null {
  const text = (value ?? "")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")
    .trim();
  if (!text || text.length > MAX_COMMAND_LENGTH) return null;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) return null;
  return text;
}

export function looksLikeKubectl(text: string | null | undefined): boolean {
  return /^\s*(?:kubectl|oc)\s+\S/i.test(text ?? "");
}
