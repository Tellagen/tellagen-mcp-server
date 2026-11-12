import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

/**
 * The parts of the guide a model reads when it needs them. The server
 * instructions stay short and name these; the pickup answer names the ones
 * that apply to the run. Each resource is cut from SKILL.md by heading, so
 * the guide has one source.
 */
export interface GuideResource {
  name: string;
  uri: string;
  title: string;
  description: string;
  /** The `## ` headings of SKILL.md that make up the resource, in order. */
  headings: readonly string[];
  /** When the pickup answer names it: on every run, or only with matched runbooks. */
  when: "always" | "runbooks";
  /** The moment to read it, as the pickup answer says it. */
  readWhen: string;
}

export const SKILL_GUIDE_URI = "resource://tellagen/skill-guide";

export const GUIDE_RESOURCES: readonly GuideResource[] = [
  {
    name: "guide-findings",
    uri: "resource://tellagen/guide/findings",
    title: "Tellagen Finding Rules",
    description:
      "How to post a finding: the fields, finding types and roles, evidence refs with links or a command, screenshots, and the question form of a blocking gap.",
    headings: ["## Posting findings", "## Choosing finding types"],
    when: "always",
    readWhen: "before you post your first finding",
  },
  {
    name: "guide-completion",
    uri: "resource://tellagen/guide/completion",
    title: "Tellagen Completion Rules",
    description:
      "How to complete a run: the five things to do first, the result_summary with its headline, the causal chain, ruled out, coverage and unknowns, change refs for a regression, and the warnings.",
    headings: ["## Before you complete a run", "## Diagnosis structure", "## Regression and CI failures"],
    when: "always",
    readWhen: "before you complete the run",
  },
  {
    name: "guide-runbook-checks",
    uri: "resource://tellagen/guide/runbook-checks",
    title: "Tellagen Runbook Check Rules",
    description:
      "How to cite the frozen runbooks of a run: the guidance basis of a trace step, structured check attempts, source resolutions and fallbacks, gaps, and reuse hints.",
    headings: ["## Guidance lineage on trace steps", "## Structured v2 runbook checks"],
    when: "runbooks",
    readWhen: "before you run a check of a matched runbook",
  },
];

/** Guides the pickup answer does not name: they belong to other work. */
export const OTHER_GUIDE_RESOURCES: readonly GuideResource[] = [
  {
    name: "guide-sources",
    uri: "resource://tellagen/guide/sources",
    title: "Tellagen Guide to Other MCP Servers",
    description:
      "How to combine Tellagen with Grafana, GitHub, PagerDuty and error tracking servers, and how to prove that evidence is about the same resource.",
    headings: ["## Causal resource identity", "## Composing with other MCP servers"],
    when: "always",
    readWhen: "when you query another MCP server for evidence",
  },
  {
    name: "guide-postmortem",
    uri: "resource://tellagen/guide/postmortem",
    title: "Tellagen Postmortem Rules",
    description:
      "How to answer a postmortem revision request with a proposal, how the legacy import tools version a document, and how to submit runbook candidates from a postmortem.",
    headings: ["## Postmortem writeback"],
    when: "always",
    readWhen: "when the prompt carries a revision_request_id or an analysis_request_id",
  },
  {
    name: "guide-tool-check",
    uri: "resource://tellagen/guide/tool-check",
    title: "Tellagen MCP Tool Check",
    description: "How to answer a tool check session (a diag_ id) from Tellagen settings.",
    headings: ["## MCP diagnostic lifecycle"],
    when: "always",
    readWhen: "when the prompt carries a diagnostic_session_id",
  },
];

/** The text of one `## ` section of the guide, with its heading, up to the next `## `. */
export function guideSection(guide: string, heading: string): string {
  const marker = `\n${heading}\n`;
  const start = guide.indexOf(marker);
  if (start < 0) throw new Error(`the guide has no section ${heading}`);
  const rest = guide.slice(start + 1);
  const next = rest.indexOf("\n## ", heading.length);
  return (next < 0 ? rest : rest.slice(0, next)).trimEnd();
}

export function guideResourceText(guide: string, resource: GuideResource): string {
  return `${resource.headings.map((heading) => guideSection(guide, heading)).join("\n\n")}\n`;
}

/** Registers every guide part as a resource the model can read on its own. */
export function registerGuideResources(server: McpServer, guide: string): void {
  for (const resource of [...GUIDE_RESOURCES, ...OTHER_GUIDE_RESOURCES]) {
    const text = guideResourceText(guide, resource);
    server.registerResource(
      resource.name,
      resource.uri,
      { title: resource.title, description: resource.description, mimeType: "text/markdown" },
      async (uri) => ({ contents: [{ uri: uri.href, mimeType: "text/markdown", text }] }),
    );
  }
}
