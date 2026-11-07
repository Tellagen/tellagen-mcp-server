import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { TellagenClient } from "../client.js";
import { formatError } from "../errors.js";

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

type ProbeResult = {
  ok: boolean;
  datasource?: SafeDatasource;
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
): Promise<ProbeResult> {
  const safe = safeDatasource(datasource);
  const checks: ProbeCheck[] = [
    {
      name: "metadata_lookup",
      status: "ok",
      message: "Datasource metadata was found in Tellagen.",
    },
  ];
  const missingEnvVars = safe.required_env_vars.filter(
    (envVar) => process.env[envVar]?.trim() === undefined || process.env[envVar]?.trim() === "",
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

  if (datasource.type?.toLowerCase() !== "grafana") {
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

  const grafanaURL = grafanaURLForDatasource(safe);
  const tokenEnvVar = grafanaTokenEnvVar(safe.required_env_vars);
  const token = process.env[tokenEnvVar]?.trim();
  if (!grafanaURL || !token) {
    const missing = [
      ...(!grafanaURL ? ["GRAFANA_URL"] : []),
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
      checks,
      missing_env_vars: missing,
      recommended_action:
        "Set Grafana URL and service account token in the local MCP client environment.",
    };
  }

  checks.push(await probeGrafanaHealth(grafanaURL, token, timeoutMs));
  return {
    ok: checks.every((check) => check.status === "ok" || check.status === "skipped"),
    datasource: safe,
    checks,
    missing_env_vars: [],
  };
}

async function probeGrafanaHealth(
  grafanaURL: string,
  token: string,
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
        Authorization: `Bearer ${token}`,
      },
      signal: controller.signal,
    });
    if (response.ok) {
      return {
        name: "grafana_health",
        status: "ok",
        message: "Grafana /api/health responded successfully.",
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

function grafanaURLForDatasource(datasource: SafeDatasource): string | undefined {
  const envURL = process.env.GRAFANA_URL?.trim();
  return envURL || datasource.base_url;
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
