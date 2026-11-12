import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { TellagenClient } from "../client.js";
import { activeRunId } from "../active-run.js";
import { formatError } from "../errors.js";
import {
  type AddressSource,
  chooseGrafanaBase,
  knownSourceBases,
  type SourceBase,
} from "../source-bases.js";

type CheckStatus = "ok" | "warning" | "error" | "skipped";

type Datasource = {
  id?: number;
  name?: string;
  type?: string;
  custody_mode?: string;
  enabled?: boolean;
  config?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
  status?: unknown;
};

type DatasourcesResponse = {
  datasources?: Datasource[];
};

type ProbeCheck = {
  name: string;
  status: CheckStatus;
  message: string;
  http_status?: number;
};

type SafeDatasource = {
  id?: number;
  name?: string;
  type?: string;
  custody_mode?: string;
  enabled?: boolean;
  base_url?: string;
  mcp_server?: string;
  datasource_names: string[];
  required_env_vars: string[];
};

/**
 * One address of a Grafana datasource and where it came from. `used` marks the
 * one the probe calls. `token_sent` is true only for GRAFANA_URL, the address
 * the person paired with the local token.
 */
type ProbeAddress = {
  source: AddressSource;
  url: string;
  used: boolean;
  token_sent: boolean;
};

type ProbeResult = {
  ok: boolean;
  datasource?: SafeDatasource;
  /** For Grafana: every address that is known, in the order links use them (pickup, GRAFANA_URL, datasource). */
  addresses?: ProbeAddress[];
  available_datasources?: SafeDatasource[];
  checks: ProbeCheck[];
  missing_env_vars: string[];
  recommended_action?: string;
};

const DEFAULT_GRAFANA_ENV_VARS = [
  "GRAFANA_URL",
  "GRAFANA_SERVICE_ACCOUNT_TOKEN",
];

export function registerDatasourceTools(
  server: McpServer,
  client: TellagenClient,
): void {
  server.registerTool(
    "tellagen_probe_datasource",
    {
      description:
        "Check the local setup of a datasource that Tellagen lists, before you query it. For Grafana it checks the required environment variables and calls the /api/health endpoint. Returns ok, the checks that ran, the names of missing environment variables and a recommended action. It is read-only and never returns credentials.",
      inputSchema: {
        datasource_id: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("Datasource ID from Tellagen"),
        name: z.string().min(1).optional().describe("Datasource name"),
        timeout_ms: z
          .number()
          .int()
          .min(500)
          .max(10000)
          .optional()
          .describe("Grafana health probe timeout in milliseconds"),
      },
    },
    async ({ datasource_id, name, timeout_ms }) => {
      try {
        const data = await client.get<DatasourcesResponse>("/api/v1/datasources");
        const datasources = Array.isArray(data.datasources)
          ? data.datasources
          : [];
        const selected = selectDatasource(datasources, datasource_id, name);

        if (!selected.datasource) {
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify(selected.result),
              },
            ],
          };
        }

        const result = await probeDatasource(
          selected.datasource,
          timeout_ms ?? 3000,
          knownSourceBases(client, activeRunId(client)),
        );
        return {
          content: [{ type: "text" as const, text: JSON.stringify(result) }],
        };
      } catch (err) {
        return {
          content: [{ type: "text" as const, text: formatError(err) }],
          isError: true,
        };
      }
    },
  );
}

function selectDatasource(
  datasources: Datasource[],
  datasourceID?: number,
  name?: string,
): { datasource?: Datasource; result?: ProbeResult } {
  const checks: ProbeCheck[] = [];
  const safeDatasources = datasources.map(safeDatasource);

  if (datasourceID !== undefined) {
    const datasource = datasources.find((candidate) => candidate.id === datasourceID);
    if (datasource) return { datasource };
    return {
      result: {
        ok: false,
        checks: [
          {
            name: "metadata_lookup",
            status: "error",
            message: `No datasource found with ID ${datasourceID}.`,
          },
        ],
        missing_env_vars: [],
        available_datasources: safeDatasources,
        recommended_action:
          "Run tellagen_probe_datasource with a datasource_id or name from available_datasources.",
      },
    };
  }

  const trimmedName = name?.trim();
  if (trimmedName) {
    const datasource = datasources.find(
      (candidate) => candidate.name === trimmedName,
    );
    if (datasource) return { datasource };
    return {
      result: {
        ok: false,
        checks: [
          {
            name: "metadata_lookup",
            status: "error",
            message: `No datasource found named ${trimmedName}.`,
          },
        ],
        missing_env_vars: [],
        available_datasources: safeDatasources,
        recommended_action:
          "Run tellagen_probe_datasource with a datasource_id or name from available_datasources.",
      },
    };
  }

  const enabledDatasources = datasources.filter(
    (datasource) => datasource.enabled !== false,
  );
  const grafanaDatasources = enabledDatasources.filter(
    (datasource) => datasource.type?.toLowerCase() === "grafana",
  );
  if (grafanaDatasources.length === 1) return { datasource: grafanaDatasources[0] };
  if (enabledDatasources.length === 1) return { datasource: enabledDatasources[0] };

  checks.push({
    name: "metadata_selection",
    status: "error",
    message:
      "Multiple datasources are available. Provide datasource_id or name to choose one.",
  });
  return {
    result: {
      ok: false,
      checks,
      missing_env_vars: [],
      available_datasources: safeDatasources,
      recommended_action:
        "Run tellagen_probe_datasource again with datasource_id or name.",
    },
  };
}

async function probeDatasource(
  datasource: Datasource,
  timeoutMs: number,
  pickupBases: readonly SourceBase[] = [],
): Promise<ProbeResult> {
  const safe = safeDatasource(datasource);
  const isGrafana = datasource.type?.toLowerCase() === "grafana";
  const addresses = isGrafana ? grafanaAddresses(safe, pickupBases) : [];
  const pickupUrl = addresses.find((address) => address.source === "pickup")?.url;
  const checks: ProbeCheck[] = [
    {
      name: "metadata_lookup",
      status: "ok",
      message: "Datasource metadata was found in Tellagen.",
    },
  ];
  const missingEnvVars = safe.required_env_vars.filter(
    (envVar) =>
      // An address Tellagen sent with the pickup makes GRAFANA_URL optional.
      !(envVar === "GRAFANA_URL" && pickupUrl) &&
      (process.env[envVar]?.trim() === undefined || process.env[envVar]?.trim() === ""),
  );

  if (missingEnvVars.length > 0) {
    checks.push({
      name: "required_env",
      status: "error",
      message: `Missing local environment variables: ${missingEnvVars.join(", ")}.`,
    });
    return {
      ok: false,
      datasource: safe,
      ...(addresses.length > 0 ? { addresses } : {}),
      checks,
      missing_env_vars: missingEnvVars,
      recommended_action:
        "Add the missing variables to your MCP client env or shell before starting tellagen-mcp-server.",
    };
  }

  checks.push({
    name: "required_env",
    status: "ok",
    message: "All required local environment variables are present.",
  });

  if (!isGrafana) {
    checks.push({
      name: "provider_probe",
      status: "skipped",
      message: `No provider-specific probe is implemented for datasource type ${datasource.type ?? "unknown"}.`,
    });
    return {
      ok: true,
      datasource: safe,
      checks,
      missing_env_vars: [],
    };
  }

  const tokenEnvVar = grafanaTokenEnvVar(safe.required_env_vars);
  const token = process.env[tokenEnvVar]?.trim();

  // GRAFANA_URL is the only address that gets the local token. A value that is
  // not an http or https address is a setup error, not something to skip.
  const envUrl = process.env.GRAFANA_URL?.trim();
  if (envUrl && !addresses.some((address) => address.source === "GRAFANA_URL")) {
    checks.push({
      name: "grafana_url",
      status: "error",
      message: "GRAFANA_URL is not an http or https address, so nothing was called.",
    });
    return {
      ok: false,
      datasource: safe,
      ...(addresses.length > 0 ? { addresses } : {}),
      checks,
      missing_env_vars: [],
      recommended_action: "Set GRAFANA_URL to an http or https address, or remove it.",
    };
  }

  const target = addresses.find((address) => address.used);
  if (!target || !token) {
    const missing = [
      ...(!target ? ["GRAFANA_URL"] : []),
      ...(!token ? [tokenEnvVar] : []),
    ];
    checks.push({
      name: "grafana_config",
      status: "error",
      message: `Grafana probe needs ${missing.join(" and ")}.`,
    });
    return {
      ok: false,
      datasource: safe,
      ...(addresses.length > 0 ? { addresses } : {}),
      checks,
      missing_env_vars: missing,
      recommended_action:
        "Set Grafana URL and service account token in the local MCP client environment.",
    };
  }

  // The token goes only to GRAFANA_URL. An address that Tellagen sent (the
  // pickup or the datasource) is called without it: /api/health needs no sign-in.
  checks.push(await probeGrafanaHealth(target.url, target.token_sent ? token : undefined, timeoutMs));
  return {
    ok: checks.every((check) => check.status === "ok" || check.status === "skipped"),
    datasource: safe,
    ...(addresses.length > 0 ? { addresses } : {}),
    checks,
    missing_env_vars: [],
    ...(target.token_sent
      ? {}
      : { recommended_action: "Set GRAFANA_URL to check the service account token against your own Grafana." }),
  };
}

async function probeGrafanaHealth(
  grafanaURL: string,
  token: string | undefined,
  timeoutMs: number,
): Promise<ProbeCheck> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const controller = new AbortController();
  try {
    timeout = setTimeout(() => controller.abort(), timeoutMs);
    const response = await fetch(grafanaHealthURL(grafanaURL), {
      method: "GET",
      headers: {
        Accept: "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      signal: controller.signal,
    });
    if (response.ok) {
      return {
        name: "grafana_health",
        status: "ok",
        message: token
          ? "Grafana /api/health responded successfully."
          : "Grafana /api/health responded successfully at the address Tellagen sent. No token was sent to it, so the token was not checked.",
        http_status: response.status,
      };
    }
    return {
      name: "grafana_health",
      status: "error",
      message: `Grafana /api/health returned HTTP ${response.status}.`,
      http_status: response.status,
    };
  } catch (err) {
    const aborted =
      err instanceof Error && err.name.toLowerCase() === "aborterror";
    return {
      name: "grafana_health",
      status: "error",
      message: aborted
        ? `Grafana /api/health timed out after ${timeoutMs}ms.`
        : "Grafana /api/health failed before receiving a response. Check the URL, network path, and TLS configuration.",
    };
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

function safeDatasource(datasource: Datasource): SafeDatasource {
  const config = datasourceConfig(datasource);
  const requiredEnvVars = requiredEnvVarsForDatasource(datasource, config);
  return {
    id: datasource.id,
    name: datasource.name,
    type: datasource.type,
    custody_mode: datasource.custody_mode,
    enabled: datasource.enabled,
    base_url: safeURL(stringField(config, "base_url")),
    mcp_server: stringField(config, "mcp_server"),
    datasource_names: stringArrayField(config, "datasource_names"),
    required_env_vars: requiredEnvVars,
  };
}

function datasourceConfig(datasource: Datasource): Record<string, unknown> {
  if (isRecord(datasource.metadata)) return datasource.metadata;
  if (isRecord(datasource.config)) return datasource.config;
  return {};
}

function requiredEnvVarsForDatasource(
  datasource: Datasource,
  config: Record<string, unknown>,
): string[] {
  const configured = stringArrayField(config, "required_env_vars");
  if (configured.length > 0) return configured;
  if (datasource.type?.toLowerCase() === "grafana") {
    return DEFAULT_GRAFANA_ENV_VARS;
  }
  return [];
}

/**
 * The addresses of a Grafana datasource and where each came from, listed in the
 * order links use them: the pickup `source_bases`, GRAFANA_URL, then the
 * datasource `base_url`. The probe calls GRAFANA_URL when it is valid, else the
 * first address Tellagen sent. Only GRAFANA_URL gets the local token.
 */
function grafanaAddresses(
  datasource: SafeDatasource,
  pickupBases: readonly SourceBase[],
): ProbeAddress[] {
  const found: Array<{ source: AddressSource; url: string | undefined }> = [
    { source: "pickup", url: safeURL(pickupBaseFor(datasource, pickupBases)?.base_url) },
    { source: "GRAFANA_URL", url: safeURL(process.env.GRAFANA_URL?.trim()) },
    { source: "datasource", url: datasource.base_url },
  ];
  const known = found.filter(
    (item): item is { source: AddressSource; url: string } => Boolean(item.url) && /^https?:\/\//i.test(item.url!),
  );
  const usedSource = known.some((item) => item.source === "GRAFANA_URL") ? "GRAFANA_URL" : known[0]?.source;
  return known.map((item) => ({
    ...item,
    used: item.source === usedSource,
    token_sent: item.source === "GRAFANA_URL" && item.source === usedSource,
  }));
}

/** The pickup base of this datasource: the one with its name, else the only Grafana base. */
function pickupBaseFor(datasource: SafeDatasource, bases: readonly SourceBase[]): SourceBase | undefined {
  const named = datasource.name ? chooseGrafanaBase(bases, datasource.name).base : undefined;
  return named ?? chooseGrafanaBase(bases).base;
}

function grafanaTokenEnvVar(requiredEnvVars: string[]): string {
  return (
    requiredEnvVars.find((envVar) =>
      /(^|_)(TOKEN|API_KEY|PASSWORD|SECRET)(_|$)/i.test(envVar),
    ) ?? "GRAFANA_SERVICE_ACCOUNT_TOKEN"
  );
}

function grafanaHealthURL(baseURL: string): string {
  const url = new URL(baseURL);
  url.username = "";
  url.password = "";
  const pathPrefix = url.pathname === "/" ? "" : url.pathname.replace(/\/+$/, "");
  url.pathname = `${pathPrefix}/api/health`;
  url.search = "";
  url.hash = "";
  return url.toString();
}

function stringField(
  record: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = record[key];
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed || undefined;
}

function stringArrayField(record: Record<string, unknown>, key: string): string[] {
  const value = record[key];
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter(Boolean);
}

function safeURL(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  try {
    const url = new URL(raw);
    url.username = "";
    url.password = "";
    for (const key of [...url.searchParams.keys()]) {
      if (isSensitiveKey(key)) url.searchParams.delete(key);
    }
    if (url.pathname === "/" && url.search === "") {
      return `${url.protocol}//${url.host}`;
    }
    return url.toString().replace(/\/$/, "");
  } catch {
    return undefined;
  }
}

function isSensitiveKey(key: string): boolean {
  return /(token|key|secret|password|authorization|auth)/i.test(key);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
