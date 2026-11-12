import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { activeRunId } from "../active-run.js";
import { TellagenClient } from "../client.js";
import { formatError } from "../errors.js";
import {
  buildGithubLink,
  buildGrafanaExploreLink,
  buildGrafanaPanelLink,
  classifySource,
  cleanCommand,
  kubectlCommandFromK8sUrl,
  linkLabel,
  looksLikeKubectl,
  sanitizeSourceUrl,
} from "../source-links.js";

export const SOURCE_LINK_KINDS = [
  "explore",
  "panel",
  "diff",
  "commit",
  "pr",
  "logs",
  "trace",
  "ci_run",
  "release",
] as const;

const GITHUB_KINDS: ReadonlySet<string> = new Set(["diff", "commit", "pr", "ci_run", "release"]);

type SourceLinkKind = (typeof SOURCE_LINK_KINDS)[number];

type BuiltLink = { kind: SourceLinkKind; label: string; url: string };

type SourceLinkResult = {
  links: BuiltLink[];
  command?: string;
  guidance?: string;
};

type Datasource = {
  name?: string;
  type?: string;
  enabled?: boolean;
  metadata?: unknown;
  config?: unknown;
};

class SourceLinkError extends Error {}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function fail(message: string): never {
  throw new SourceLinkError(message);
}

/**
 * The Grafana address: GRAFANA_URL in the MCP client environment wins (the
 * same override tellagen_probe_datasource honours), otherwise the Grafana
 * connector's base_url from the Tellagen datasources. Only the Tellagen API is
 * called, and credentials in the address are stripped.
 */
async function grafanaBaseUrl(
  client: TellagenClient,
  connector?: string,
): Promise<string> {
  const envUrl = process.env.GRAFANA_URL?.trim();
  if (envUrl) {
    const safe = sanitizeSourceUrl(envUrl);
    if (!safe || safe.example) {
      fail("GRAFANA_URL must be an http or https address.");
    }
    return safe.url;
  }

  const data = await client.get<{ datasources?: Datasource[] }>(
    "/api/v1/datasources",
  );
  const all = Array.isArray(data.datasources) ? data.datasources : [];
  const grafana = all.filter(
    (candidate) =>
      candidate.enabled !== false && candidate.type?.toLowerCase() === "grafana",
  );
  const wanted = connector?.trim();
  const named = wanted
    ? grafana.filter((candidate) => candidate.name === wanted)
    : grafana;
  if (named.length === 0) {
    const have = all
      .map((candidate) => candidate.name)
      .filter((name): name is string => Boolean(name));
    fail(
      wanted
        ? `No enabled Grafana datasource named "${wanted}" in Tellagen.${have.length ? ` Available: ${have.join(", ")}.` : ""} Set GRAFANA_URL in the MCP client environment to use your own Grafana address. If you cannot, send a read-only command and the datasource on the evidence ref instead of a link.`
        : `No enabled Grafana datasource in Tellagen.${have.length ? ` Available: ${have.join(", ")}.` : ""} Configure one in Tellagen or set GRAFANA_URL in the MCP client environment. If you cannot, send a read-only command and the datasource on the evidence ref instead of a link.`,
    );
  }
  if (named.length > 1) {
    fail(
      `Several Grafana datasources are configured (${named.map((candidate) => candidate.name).join(", ")}). Pass connector with one of these names.`,
    );
  }
  const config = isRecord(named[0].metadata)
    ? named[0].metadata
    : isRecord(named[0].config)
      ? named[0].config
      : {};
  const raw = typeof config.base_url === "string" ? config.base_url : "";
  const safe = sanitizeSourceUrl(raw);
  if (!safe || safe.example) {
    fail(
      "The Grafana datasource has no usable base_url (Tellagen shows connector settings to settings managers only). Set GRAFANA_URL in the MCP client environment.",
    );
  }
  return safe.url;
}

/** The incident window from the run's context, when it is a real range. */
async function incidentWindow(
  client: TellagenClient,
  runId: string,
): Promise<{ from?: string; to?: string }> {
  const data = await client.get<{
    request?: { context?: { time_range?: { from?: unknown; to?: unknown } } };
  }>(`/api/v1/investigations/${encodeURIComponent(runId)}/context`);
  const range = data.request?.context?.time_range;
  const usable = (value: unknown): string | undefined => {
    if (typeof value !== "string") return undefined;
    const at = Date.parse(value);
    // The Go zero time means "no window".
    return Number.isFinite(at) && at > Date.UTC(2000, 0, 1) ? value : undefined;
  };
  return { from: usable(range?.from), to: usable(range?.to) };
}

const K8S_GUIDANCE =
  "Kubernetes has no browser link. Put the kubectl command that reproduces the check in the evidence ref `command` (read-only, no credentials).";
const NO_LINK_GUIDANCE =
  "This source has no browser link. Put what you ran in the evidence ref `command` and keep the summary and query.";

export const sourceLinkInputSchema = {
  kind: z
    .enum(SOURCE_LINK_KINDS)
    .describe(
      "explore = Grafana Explore for a Prometheus query; logs = Grafana Explore for a Loki query; trace = Grafana Explore for a Tempo trace id; panel = a Grafana dashboard panel; diff = GitHub compare; commit = GitHub commit; pr = GitHub pull request; ci_run = a GitHub Actions run or job; release = a GitHub release. ci_run and release links need diagnosis_changes_v1 on the run.",
    ),
  source: z
    .string()
    .optional()
    .describe(
      'The evidence source name you use in the ref (for example "kubernetes-logs"). Kubernetes and other sources without a browser URL return a command or guidance instead of a link.',
    ),
  datasource: z
    .string()
    .optional()
    .describe(
      "Grafana data source uid (or name) the query ran against; Explore opens that data source",
    ),
  query: z
    .string()
    .optional()
    .describe(
      "The PromQL / LogQL query for explore and logs, or the trace id for trace",
    ),
  from: z
    .string()
    .optional()
    .describe(
      "Range start: an ISO instant, epoch milliseconds or a relative time like now-6h. Defaults to the incident window when investigation_run_id is given, otherwise now-1h",
    ),
  to: z.string().optional().describe("Range end, same formats as from"),
  investigation_run_id: z
    .string()
    .min(1)
    .optional()
    .describe(
      "Run whose incident window is the default time range (read from its context). Defaults to the run this session picked up",
    ),
  dashboard_uid: z.string().optional().describe("Grafana dashboard uid (panel)"),
  panel_id: z.number().int().min(0).optional().describe("Grafana panel id (panel)"),
  org_id: z
    .number()
    .int()
    .positive()
    .optional()
    .describe("Grafana org id; left out of the link when not given"),
  connector: z
    .string()
    .optional()
    .describe(
      "Name of the Tellagen Grafana datasource when several are configured",
    ),
  repo: z.string().optional().describe("GitHub repository as owner/name"),
  sha: z.string().optional().describe("Commit sha (commit)"),
  base: z.string().optional().describe("Base ref or sha (diff)"),
  head: z.string().optional().describe("Head ref or sha (diff)"),
  pr_number: z.number().int().positive().optional().describe("Pull request number (pr)"),
  run_id: z.number().int().positive().optional().describe("GitHub Actions run id, as in /actions/runs/<id> (ci_run)"),
  job_id: z
    .number()
    .int()
    .positive()
    .optional()
    .describe("GitHub Actions job id, to open the failing job of the run (ci_run)"),
  tag: z.string().optional().describe("Release tag (release)"),
  github_url: z
    .string()
    .optional()
    .describe("GitHub Enterprise base address; defaults to https://github.com"),
  k8s_url: z
    .string()
    .optional()
    .describe(
      "A k8s://context/<ctx>/namespace/<ns>/<kind>/<name> reference to turn into a kubectl command (source: kubernetes)",
    ),
};

export type SourceLinkInput = {
  [K in keyof typeof sourceLinkInputSchema]?: z.infer<
    (typeof sourceLinkInputSchema)[K]
  >;
} & { kind: SourceLinkKind };

/** Builds the links (or command guidance) for one reference. Exported for tests. */
export async function buildSourceLinks(
  client: TellagenClient,
  input: SourceLinkInput,
): Promise<SourceLinkResult> {
  const family = input.source ? classifySource(input.source).family : undefined;

  if (family === "kubernetes" || input.k8s_url) {
    const fromUrl = input.k8s_url ? kubectlCommandFromK8sUrl(input.k8s_url) : null;
    const fromQuery = looksLikeKubectl(input.query) ? cleanCommand(input.query) : null;
    const command = fromUrl ?? fromQuery;
    return command
      ? { links: [], command, guidance: K8S_GUIDANCE }
      : { links: [], guidance: K8S_GUIDANCE };
  }
  if (
    family === "codebase" ||
    family === "database" ||
    family === "docs" ||
    family === "tellagen" ||
    (family === "other" && !GITHUB_KINDS.has(input.kind))
  ) {
    return { links: [], guidance: NO_LINK_GUIDANCE };
  }

  const kind = input.kind;
  if (
    kind === "diff" ||
    kind === "commit" ||
    kind === "pr" ||
    kind === "ci_run" ||
    kind === "release"
  ) {
    if (!input.repo) fail("repo (owner/name) is required for GitHub links.");
    const url = buildGithubLink(kind, {
      repo: input.repo,
      sha: input.sha,
      base: input.base,
      head: input.head,
      prNumber: input.pr_number,
      runId: input.run_id,
      jobId: input.job_id,
      tag: input.tag,
      githubUrl: input.github_url,
    });
    if (!url) {
      fail(
        kind === "commit"
          ? "Could not build a commit link: repo must be owner/name and sha 7 to 40 hex characters."
          : kind === "pr"
            ? "Could not build a pull request link: repo must be owner/name and pr_number a positive integer."
            : kind === "ci_run"
              ? "Could not build a CI run link: repo must be owner/name, run_id a positive integer and job_id (if given) a positive integer."
              : kind === "release"
                ? "Could not build a release link: repo must be owner/name and tag a plain tag name."
                : "Could not build a compare link: repo must be owner/name, base and head plain refs, and github_url (if given) an http(s) address.",
      );
    }
    const repo = input.repo.trim();
    const label =
      kind === "commit"
        ? `Commit ${input.sha!.trim().slice(0, 7)} on GitHub`
        : kind === "pr"
          ? `Pull request #${input.pr_number} on GitHub`
          : kind === "ci_run"
            ? input.job_id !== undefined
              ? `Job ${input.job_id} of run ${input.run_id} on GitHub`
              : `CI run ${input.run_id} on GitHub`
            : kind === "release"
              ? `Release ${input.tag!.trim()} on GitHub`
              : `Compare ${input.base!.trim()}...${input.head!.trim()}`;
    return { links: [{ kind, label: linkLabel(label || repo), url }] };
  }

  // Grafana kinds. The address comes first so a missing Grafana is reported
  // before any other lookup.
  if (kind === "panel" && !input.dashboard_uid) {
    fail("dashboard_uid is required for a panel link.");
  }
  if (kind !== "panel") {
    if (!input.query?.trim()) {
      fail(
        kind === "trace"
          ? "query (the trace id) is required for a trace link."
          : "query is required for an Explore link.",
      );
    }
    if (kind === "trace" && !input.datasource?.trim()) {
      fail("datasource (the Tempo data source uid) is required for a trace link.");
    }
    if (family === "tempo" && kind !== "trace") {
      return { links: [], guidance: NO_LINK_GUIDANCE };
    }
  }
  const base = await grafanaBaseUrl(client, input.connector);
  let from = input.from;
  let to = input.to;
  const windowRunId = activeRunId(client, input.investigation_run_id);
  if ((!from || !to) && windowRunId) {
    const window = await incidentWindow(client, windowRunId);
    from = from || window.from;
    to = to || window.to;
  }
  const orgId = input.org_id ?? null;

  if (kind === "panel") {
    const url = buildGrafanaPanelLink({
      baseUrl: base,
      dashboardUid: input.dashboard_uid!,
      panelId: input.panel_id,
      from,
      to,
      orgId,
    });
    if (!url) {
      fail("dashboard_uid may contain only letters, digits, - and _ (up to 64).");
    }
    return {
      links: [
        {
          kind: "panel",
          label: linkLabel(
            input.panel_id !== undefined
              ? `Panel ${input.panel_id} in Grafana`
              : "Dashboard in Grafana",
          ),
          url,
        },
      ],
    };
  }

  // explore, logs, trace
  const query = input.query!.trim();
  const url = buildGrafanaExploreLink({
    baseUrl: base,
    datasource: input.datasource,
    query,
    from,
    to,
    orgId,
    queryShape: kind === "trace" ? "traceql" : "expr",
  });
  if (!url) fail("Could not build an Explore link from this input.");
  const label =
    kind === "trace"
      ? "Trace in Grafana Explore"
      : kind === "logs"
        ? "Logs in Grafana Explore"
        : "Query in Grafana Explore";
  return { links: [{ kind, label: linkLabel(label), url }] };
}

export function registerSourceLinkTools(
  server: McpServer,
  client: TellagenClient,
): void {
  server.registerTool(
    "tellagen_build_source_link",
    {
      description:
        "Build the clickable link (or copyable command) for an evidence source, to put in evidence_refs[].links[]. Grafana Explore, panel and trace links come from the Grafana address (GRAFANA_URL in the MCP environment, else the Tellagen Grafana datasource); GitHub compare, commit, pull request, Actions run (ci_run) and release links come from repo. Kubernetes and other sources without a browser URL return a command or guidance instead. Calls only the Tellagen API, puts no credentials in a URL, and returns {links:[{kind,label,url}]} that you copy into the ref unchanged.",
      inputSchema: sourceLinkInputSchema,
    },
    async (input) => {
      try {
        const result = await buildSourceLinks(client, input as SourceLinkInput);
        return {
          content: [{ type: "text" as const, text: JSON.stringify(result) }],
        };
      } catch (err) {
        if (err instanceof SourceLinkError) {
          return {
            content: [{ type: "text" as const, text: err.message }],
            isError: true,
          };
        }
        return {
          content: [{ type: "text" as const, text: formatError(err) }],
          isError: true,
        };
      }
    },
  );
}
