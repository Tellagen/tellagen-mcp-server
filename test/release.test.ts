import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// @ts-expect-error a plain script with no type declarations
import { changelogSection, isReleased } from "../scripts/changelog-section.mjs";
import { MCP_SERVER_VERSION } from "../src/version.js";

const read = (file: string) => readFileSync(new URL(`../${file}`, import.meta.url), "utf8");
const changelog = read("CHANGELOG.md");

describe("the changelog", () => {
  it("has one entry for each version from 0.4.0 to the current version, newest first", () => {
    const versions = [...changelog.matchAll(/^## (\d+\.\d+\.\d+)/gm)].map((match) => match[1]);
    expect(versions[0]).toBe(MCP_SERVER_VERSION);
    expect(versions).toEqual(expect.arrayContaining(["0.4.0", "0.4.1", "0.4.2", "0.4.3"]));
    expect(new Set(versions).size).toBe(versions.length);
    const sorted = [...versions].sort((a, b) => {
      const [x, y] = [a, b].map((v) => v!.split(".").map(Number));
      return y![0]! - x![0]! || y![1]! - x![1]! || y![2]! - x![2]!;
    });
    expect(versions).toEqual(sorted);
  });

  it("gives the release workflow the section of a version, with or without the v", () => {
    const section = changelogSection(changelog, `v${MCP_SERVER_VERSION}`);
    expect(section).toBe(changelogSection(changelog, MCP_SERVER_VERSION));
    expect(section).toContain("### Added");
    expect(section).not.toContain("## 0.4.3");
    expect(section.startsWith("##")).toBe(true);
    expect(section.startsWith("## ")).toBe(false);
    expect(changelogSection(changelog, "0.4.0")).toContain("tellagen_build_figure");
  });

  it("returns nothing for a version with no section, a partial match or a bad version", () => {
    expect(changelogSection(changelog, "9.9.9")).toBeUndefined();
    expect(changelogSection(changelog, "0.4")).toBeUndefined();
    expect(changelogSection("## 0.4.30 - x\n\ntext\n", "0.4.3")).toBeUndefined();
    expect(changelogSection("## 1.0.0\n\n## 0.9.0\n\ntext\n", "1.0.0")).toBeUndefined();
    expect(changelogSection(changelog, "../../etc/passwd")).toBeUndefined();
  });

  it("names no internal ticket, person or private path", () => {
    for (const file of ["CHANGELOG.md", ".github/workflows/ci.yml", ".github/workflows/release.yml", "scripts/changelog-section.mjs", "scripts/smoke.mjs"]) {
      const text = read(file);
      expect(text, file).not.toMatch(/\bCORE-\d+/);
      expect(text, file).not.toMatch(/\/Users\/|\.claude\/worktrees|sprint/i);
    }
  });
});

describe("the workflows", () => {
  const ci = read(".github/workflows/ci.yml");
  const release = read(".github/workflows/release.yml");

  it("run install, typecheck, the tests and the build on pull requests and on master", () => {
    expect(ci).toMatch(/on:\n  pull_request:\n  push:\n    branches: \[master\]/);
    for (const step of ["npm ci", "npm run lint", "npm test", "npm run build"]) {
      expect(ci).toContain(`run: ${step}`);
    }
    expect(ci).toContain("permissions:\n  contents: read");
  });

  it("publish on a version tag only after the tests pass, with provenance, then create the release from the changelog", () => {
    expect(release).toMatch(/on:\n  push:\n    tags: \["v\*"\]/);
    const order = ["scripts/changelog-section.mjs", "npm ci", "npm run lint", "npm test", "npm run build", "npm publish --provenance", "gh release create"].map(
      (step) => release.indexOf(step),
    );
    expect(order.every((index) => index > 0)).toBe(true);
    expect(order).toEqual([...order].sort((a, b) => a - b));
    expect(release).toContain("id-token: write");
    expect(release).toContain("--notes-file");
    expect(release).toContain("does not match package.json version");
  });

  it("gives the right to publish only to the publish job, which runs after the tests and no install script", () => {
    const [testJob, publishJob] = release.split("\n  publish:\n");
    expect(publishJob).toContain("needs: test");
    expect(testJob).not.toContain("id-token: write");
    expect(testJob).not.toContain("contents: write");
    expect(testJob).not.toContain("secrets.");
    expect(publishJob).toContain("id-token: write");
    expect(publishJob).toContain("npm ci --ignore-scripts");
    expect(publishJob).not.toContain("npm test");
    // The token is exported only when the secret exists.
    expect(publishJob).toMatch(/if: env\.HAS_NPM_TOKEN == 'true'\n\s+env:\n\s+NODE_AUTH_TOKEN/);
    expect(publishJob.match(/NODE_AUTH_TOKEN/g)).toHaveLength(1);
  });

  it("refuses a tag that is not on master and a changelog heading with no date", () => {
    expect(release).toContain('git merge-base --is-ancestor "$GITHUB_SHA" origin/master');
    expect(release).toContain('changelog-section.mjs --release "$TAG"');
    expect(isReleased("## 0.5.0 - Unreleased\n\ntext\n", "0.5.0")).toBe(false);
    expect(isReleased("## 0.5.0\n\ntext\n", "0.5.0")).toBe(false);
    expect(isReleased("## 0.5.0 - 2026-12-01\n\ntext\n", "v0.5.0")).toBe(true);
    expect(isReleased(changelog, "0.4.3")).toBe(true);
    expect(isReleased(changelog, "9.9.9")).toBe(false);
  });

  /** The shell text of every `run:` step, single-line or block. */
  function runScripts(workflow: string): string[] {
    const lines = workflow.split("\n");
    const scripts: string[] = [];
    for (let i = 0; i < lines.length; i++) {
      const match = /^(\s*)(?:- )?run:\s*(.*)$/.exec(lines[i]!);
      if (!match) continue;
      if (match[2] !== "|") {
        scripts.push(match[2]!);
        continue;
      }
      const indent = match[1]!.length;
      const block: string[] = [];
      while (i + 1 < lines.length && (lines[i + 1]!.trim() === "" || lines[i + 1]!.search(/\S/) > indent)) {
        block.push(lines[++i]!);
      }
      scripts.push(block.join("\n"));
    }
    return scripts;
  }

  it("never put a secret or a value from the event into a script: they go through env", () => {
    for (const workflow of [ci, release]) {
      const scripts = runScripts(workflow);
      expect(scripts.length).toBeGreaterThan(4);
      for (const script of scripts) expect(script).not.toContain("${{");
      expect(workflow).toContain("persist-credentials: false");
    }
    expect(runScripts(release).some((script) => script.includes('"$TAG"'))).toBe(true);
  });
});
