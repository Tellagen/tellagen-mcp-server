import { z } from "zod";
import type { TellagenClient } from "./client.js";
import { sanitizeSourceUrl } from "./source-links.js";

/**
 * The browser addresses of the integrations of a workspace.
 *
 * A pickup answer and the context read of a run carry them as `source_bases`:
 * the enabled Grafana and GitHub addresses, so a source link needs no address
 * in the client environment. A Tellagen that predates the field sends none,
 * and the client then works as it did before.
 */
export const SOURCE_BASE_KINDS = ["grafana", "github"] as const;
export type SourceBaseKind = (typeof SOURCE_BASE_KINDS)[number];

export const MAX_SOURCE_BASES = 10;
const MAX_REPOSITORIES = 100;

/** The schema of a base as it is kept in the state file. */
export const sourceBaseSchema = z.object({
  kind: z.enum(SOURCE_BASE_KINDS),
  name: z.string().min(1).max(200),
  base_url: z.string().min(1).max(2048),
  network: z.string().max(32).optional(),
  repositories: z.array(z.string().max(200)).max(MAX_REPOSITORIES).optional(),
});

export type SourceBase = z.infer<typeof sourceBaseSchema>;

/** Where an address came from. */
export type AddressSource = "pickup" | "GRAFANA_URL" | "datasource";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Keeps the usable bases of a `source_bases` value. A kind this client does not
 * know, an address that is not http or https, a reserved example address and
 * an entry with no name are dropped; credentials, query and fragment are
 * removed from the address. Anything that is not a list gives an empty list.
 */
export function cleanSourceBases(raw: unknown): SourceBase[] {
  if (!Array.isArray(raw)) return [];
  const out: SourceBase[] = [];
  for (const item of raw) {
    if (!isRecord(item)) continue;
    const kind = item.kind;
    if (kind !== "grafana" && kind !== "github") continue;
    const name = typeof item.name === "string" ? item.name.trim().slice(0, 200) : "";
    if (!name || typeof item.base_url !== "string") continue;
    const safe = sanitizeSourceUrl(item.base_url);
    if (!safe || safe.example) continue;
    let base_url: string;
    try {
      const parsed = new URL(safe.url);
      base_url = `${parsed.origin}${parsed.pathname.replace(/\/+$/, "")}`;
    } catch {
      continue;
    }
    const entry: SourceBase = { kind, name, base_url };
    if (typeof item.network === "string" && item.network) entry.network = item.network.slice(0, 32);
    if (kind === "github" && Array.isArray(item.repositories)) {
      const repositories = item.repositories
        .filter((repo): repo is string => typeof repo === "string" && repo.length > 0 && repo.length <= 200)
        .slice(0, MAX_REPOSITORIES);
      if (repositories.length > 0) entry.repositories = repositories;
    }
    out.push(entry);
    if (out.length >= MAX_SOURCE_BASES) break;
  }
  return out;
}

/** The bases of a pickup answer or a context read, from the top level of the response. */
export function sourceBasesOf(response: unknown): SourceBase[] {
  return isRecord(response) ? cleanSourceBases(response.source_bases) : [];
}

/**
 * The bases this process knows for a run: the ones of its own pickup or
 * context read, else the ones in the state file when it names the run. With no
 * run, or a run this computer never picked up, the answer is an empty list.
 */
export function knownSourceBases(client: TellagenClient, runId?: string): SourceBase[] {
  if (!runId) return [];
  return client.session.sourceBasesFor(runId) ?? [];
}

/** Remembers the bases of a pickup answer or a context read for a run. */
export function rememberSourceBases(client: TellagenClient, runId: string, response: unknown): void {
  if (!isRecord(response)) return;
  client.session.rememberSourceBases(runId, sourceBasesOf(response));
}

export type GrafanaBaseChoice =
  | { base: SourceBase; ambiguous?: undefined }
  | { base?: undefined; ambiguous: string[] }
  | { base?: undefined; ambiguous?: undefined };

/**
 * The Grafana base to use. With a connector name, the base of that name. With
 * none, the only Grafana base; several of them are ambiguous and the caller
 * decides (an explicit address, or asking for a connector).
 */
export function chooseGrafanaBase(bases: readonly SourceBase[], connector?: string): GrafanaBaseChoice {
  const grafana = bases.filter((base) => base.kind === "grafana");
  const wanted = connector?.trim();
  if (wanted) {
    const named = grafana.filter((base) => base.name === wanted);
    return named.length === 1 ? { base: named[0] } : {};
  }
  if (grafana.length === 1) return { base: grafana[0] };
  if (grafana.length > 1) return { ambiguous: grafana.map((base) => base.name) };
  return {};
}

/**
 * The GitHub address for a repository: the base that lists the repository, else
 * the only GitHub base that lists none. With several candidates there is no
 * choice, and the link goes to github.com as before.
 */
export function chooseGithubBase(bases: readonly SourceBase[], repo: string): SourceBase | undefined {
  const github = bases.filter((base) => base.kind === "github");
  const wanted = repo.trim().toLowerCase();
  const listing = github.filter((base) => base.repositories?.some((item) => item.toLowerCase() === wanted));
  if (listing.length === 1) return listing[0];
  if (listing.length > 1) return undefined;
  const open = github.filter((base) => !base.repositories?.length);
  return open.length === 1 && github.length === 1 ? open[0] : undefined;
}
