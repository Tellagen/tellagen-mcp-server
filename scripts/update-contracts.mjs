#!/usr/bin/env node
// Raises the pin of the vendored Tellagen contract bundle.
//
//   node scripts/update-contracts.mjs <folder of the bundle> [--commit <hash>]
//
// The folder is the contracts folder of a Tellagen checkout, the one that holds
// manifest.json and v2/. The script checks every file against the manifest of
// the bundle, copies the bundle to contracts/runbooks, and records where it came
// from in contracts/tellagen-runbook-contracts.json. Run the tests afterwards.
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const source = args.find((arg) => !arg.startsWith("--"));
const commitIndex = args.indexOf("--commit");
let commit = commitIndex >= 0 ? args[commitIndex + 1] : undefined;

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}
const sha256 = (data) => createHash("sha256").update(data).digest("hex");

if (!source) fail("Usage: node scripts/update-contracts.mjs <folder of the contract bundle> [--commit <hash>]");
const folder = resolve(source);
const manifestPath = join(folder, "manifest.json");
if (!existsSync(manifestPath)) fail(`${folder} has no manifest.json. Give the contracts folder of a Tellagen checkout.`);
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));

// Every file must match the manifest, and the bundle digest must match too.
const lines = [...manifest.files]
  .sort((a, b) => a.path.localeCompare(b.path))
  .map((entry) => {
    const data = readFileSync(join(folder, entry.path));
    if (data.byteLength !== entry.bytes) fail(`${entry.path}: ${data.byteLength} bytes, the manifest says ${entry.bytes}.`);
    if (sha256(data) !== entry.sha256) fail(`${entry.path}: the digest differs from the manifest. The bundle in that folder is not the one it names.`);
    return `${entry.path}\0${entry.sha256}\n`;
  })
  .join("");
if (sha256(lines) !== manifest.bundle_sha256) fail("The bundle digest differs from the manifest.");

if (!commit) {
  try {
    commit = execFileSync("git", ["-C", folder, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  } catch {
    fail("Could not read the commit of that checkout. Pass --commit <hash>.");
  }
}
if (!/^[a-f0-9]{40}$/.test(commit)) fail("The commit must be a 40-character hash.");
let dirty = false;
try {
  dirty = execFileSync("git", ["-C", folder, "status", "--porcelain", "--", "."], { encoding: "utf8" }).trim().length > 0;
} catch {
  // Not a checkout: the commit was given by hand.
}
if (dirty) fail("That folder has changes that are not committed. Commit them first, so the pin names a real commit.");

const target = join(root, "contracts", "runbooks");
rmSync(target, { recursive: true, force: true });
mkdirSync(target, { recursive: true });
cpSync(folder, target, { recursive: true });
writeFileSync(
  join(root, "contracts", "tellagen-runbook-contracts.json"),
  `${JSON.stringify(
    {
      upstream_repository: "https://github.com/tellagen/tellagen",
      upstream_commit: commit,
      upstream_worktree_dirty: false,
      contract_version: manifest.contract_version,
      bundle_sha256: manifest.bundle_sha256,
      bundle_path: "contracts/runbooks",
    },
    null,
    2,
  )}\n`,
);
process.stdout.write(`Pinned contract bundle ${manifest.contract_version} (${commit.slice(0, 10)}). Now run: npm test\n`);
