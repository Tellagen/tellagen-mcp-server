import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

type ContractManifest = {
  contract_version: string;
  bundle_sha256: string;
  files: Array<{ path: string; sha256: string; bytes: number }>;
};

type ContractProvenance = {
  upstream_commit: string;
  upstream_worktree_dirty?: boolean;
  contract_version: string;
  bundle_sha256: string;
  bundle_path: string;
};

const repositoryRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const bundleRoot = join(repositoryRoot, "contracts", "runbooks");

function sha256(data: Buffer | string): string {
  return createHash("sha256").update(data).digest("hex");
}

describe("vendored Tellagen runbook contracts", () => {
  it("matches every upstream manifest digest and records provenance", () => {
    const manifest = JSON.parse(
      readFileSync(join(bundleRoot, "manifest.json"), "utf8"),
    ) as ContractManifest;
    const provenance = JSON.parse(
      readFileSync(
        join(repositoryRoot, "contracts", "tellagen-runbook-contracts.json"),
        "utf8",
      ),
    ) as ContractProvenance;

    expect(provenance.upstream_commit).toMatch(/^[a-f0-9]{40}$/);
    expect(provenance.upstream_worktree_dirty).toBe(true);
    expect(provenance.bundle_path).toBe("contracts/runbooks");
    expect(provenance.contract_version).toBe(manifest.contract_version);
    expect(provenance.bundle_sha256).toBe(manifest.bundle_sha256);

    const bundleInput = [...manifest.files]
      .sort((left, right) => left.path.localeCompare(right.path))
      .map((entry) => {
        const data = readFileSync(join(bundleRoot, entry.path));
        expect(data.byteLength, entry.path).toBe(entry.bytes);
        expect(sha256(data), entry.path).toBe(entry.sha256);
        return `${entry.path}\0${entry.sha256}\n`;
      })
      .join("");
    expect(sha256(bundleInput)).toBe(manifest.bundle_sha256);
  });

  it("keeps the structured check fixture compatible with MCP check identities", () => {
    const plan = JSON.parse(
      readFileSync(
        join(bundleRoot, "v2", "fixtures", "grafana-error-rate-plan.json"),
        "utf8",
      ),
    ) as {
      entry_check_ids: string[];
      source_requirements: Array<{ id: string; source_key: string }>;
      checks: Array<{ id: string; source_requirement_id: string }>;
      completion: { required_check_ids: string[] };
    };

    expect(plan.entry_check_ids.length).toBeGreaterThan(0);
    for (const check of plan.checks) {
      expect(
        plan.source_requirements.some(
          (requirement) => requirement.id === check.source_requirement_id,
        ),
      ).toBe(true);
    }
    for (const checkID of plan.completion.required_check_ids) {
      expect(plan.checks.some((check) => check.id === checkID)).toBe(true);
    }
  });

  it("vendors the filesystem-pressure topology gate from the authoritative bundle", () => {
    const manifest = JSON.parse(
      readFileSync(join(bundleRoot, "manifest.json"), "utf8"),
    ) as ContractManifest;
    expect(manifest.contract_version).toBe("2026-11-03.1");
    expect(
      manifest.files.some(
        (entry) => entry.path === "v2/fixtures/filesystem-pressure.json",
      ),
    ).toBe(true);

    const definition = JSON.parse(
      readFileSync(
        join(bundleRoot, "v2", "fixtures", "filesystem-pressure.json"),
        "utf8",
      ),
    ) as {
      match: { symptoms: string[] };
      checks: Array<{
        id: string;
        falsifies_when: string;
        on_error: { action: string };
        evidence_contract: { required_fields: string[] };
      }>;
      completion: { required_check_ids: string[]; allow_inconclusive: boolean };
    };
    expect(definition.match.symptoms).toContain("disk_pressure");
    const topology = definition.checks.find(
      (check) => check.id === "map-runtime-filesystems",
    );
    expect(topology?.evidence_contract.required_fields).toEqual(
      expect.arrayContaining(["resource_identity", "join_basis"]),
    );
    expect(topology?.falsifies_when).not.toContain("cannot establish");
    expect(topology?.on_error.action).toBe("record_gap");
    expect(definition.completion.allow_inconclusive).toBe(true);
    expect(definition.completion.required_check_ids).toContain(
      "map-runtime-filesystems",
    );
  });
});
