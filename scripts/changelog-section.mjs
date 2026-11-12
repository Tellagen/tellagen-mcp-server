#!/usr/bin/env node
// Prints the section of CHANGELOG.md for one version, without its heading.
// The release workflow uses it for the text of the GitHub release.
//
//   node scripts/changelog-section.mjs 0.5.0
//   node scripts/changelog-section.mjs v0.5.0
//   node scripts/changelog-section.mjs --release v0.5.0   (also refuses a heading with no date)
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/** The text under `## <version>` up to the next `## ` heading, or undefined. */
export function changelogSection(changelog, version) {
  const wanted = String(version).replace(/^v/, "");
  if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(wanted)) return undefined;
  const lines = changelog.split("\n");
  const isHeading = (line) => line.startsWith("## ");
  const start = lines.findIndex(
    (line) => isHeading(line) && line.slice(3).trim().split(/\s+/)[0] === wanted,
  );
  if (start < 0) return undefined;
  const rest = lines.slice(start + 1);
  const end = rest.findIndex(isHeading);
  const text = (end < 0 ? rest : rest.slice(0, end)).join("\n").trim();
  return text.length > 0 ? text : undefined;
}

/** The heading line of a version, or undefined. */
export function changelogHeading(changelog, version) {
  const wanted = String(version).replace(/^v/, "");
  return changelog
    .split("\n")
    .find((line) => line.startsWith("## ") && line.slice(3).trim().split(/\s+/)[0] === wanted);
}

/** Whether the heading of a version carries a date (YYYY-MM-DD) and not "Unreleased". */
export function isReleased(changelog, version) {
  const heading = changelogHeading(changelog, version);
  return heading !== undefined && /\b\d{4}-\d{2}-\d{2}\b/.test(heading) && !/unreleased/i.test(heading);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  const release = args.includes("--release");
  const version = args.find((arg) => !arg.startsWith("--"));
  if (!version) {
    process.stderr.write("Usage: changelog-section.mjs [--release] <version>\n");
    process.exit(2);
  }
  const root = join(dirname(fileURLToPath(import.meta.url)), "..");
  const changelog = readFileSync(join(root, "CHANGELOG.md"), "utf8");
  const section = changelogSection(changelog, version);
  if (!section) {
    process.stderr.write(`CHANGELOG.md has no section for ${version}. Add one before you tag.\n`);
    process.exit(1);
  }
  if (release && !isReleased(changelog, version)) {
    process.stderr.write(`The CHANGELOG.md heading of ${version} has no date. Replace "Unreleased" with the release date before you tag.\n`);
    process.exit(1);
  }
  process.stdout.write(`${section}\n`);
}
