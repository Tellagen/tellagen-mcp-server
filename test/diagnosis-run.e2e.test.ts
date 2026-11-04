/**
 * A run replayed end to end against a fake Tellagen REST server:
 * pickup, build_source_link, trace step, post_finding x2, complete. The MCP
 * server is real and is called through an MCP client over an in-memory
 * transport, so the tool input schemas run exactly as they do for an agent
 * (a field without a schema entry would be stripped before the request).
 * The assertions are on the exact request bodies the fake server received.
 */
import { createServer as createHttpServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { TellagenClient } from "../src/client.js";
import { createServer } from "../src/server.js";
import {
  commitLink,
  compareFigure,
  exploreLink,
} from "./helpers/diagnosis-fixtures.js";

type Recorded = { method: string; path: string; auth?: string; body?: any };

type FakeBackend = {
  url: string;
  requests: Recorded[];
  close: () => Promise<void>;
};

const WARNINGS = [
  {
    code: "evidence_without_link",
    message: "Grafana evidence has no link",
    path: "causal_paths[0].steps[1].evidence_refs[1]",
  },
];

async function startBackend(options: { capable: boolean }): Promise<FakeBackend> {
  const requests: Recorded[] = [];
  let nextFindingId = 10;
  const context = {
    run: { id: "run-1", status: "running" },
    incident: { id: 42 },
    request: {
      context: {
        time_range: { from: "2026-06-18T08:40:00Z", to: "2026-06-18T10:20:00Z" },
      },
    },
    pickup: { investigation_run_id: "run-1", incident_id: 42 },
    ...(options.capable ? { server_capabilities: ["diagnosis_structure_v1"] } : {}),
  };
  const server: Server = createHttpServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      const path = req.url ?? "";
      requests.push({
        method: req.method ?? "",
        path,
        auth: req.headers.authorization,
        body: raw ? JSON.parse(raw) : undefined,
      });
      const send = (status: number, body: unknown) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(body));
      };
      const key = `${req.method} ${path}`;
      if (key === "POST /api/v1/investigations/run-1/pickup") return send(200, context);
      if (key === "GET /api/v1/investigations/run-1/context") return send(200, context);
      if (key === "GET /api/v1/datasources") {
        return send(200, {
          datasources: [
            {
              id: 1,
              name: "Grafana prod",
              type: "grafana",
              enabled: true,
              metadata: { base_url: "https://grafana.example.com" },
            },
          ],
        });
      }
      if (key === "POST /api/v1/investigation-runs/run-1/trace") {
        return send(200, { steps: [{ step_id: "errors-1" }] });
      }
      if (key === "POST /api/v1/incidents/42/findings") {
        return send(201, { finding: { id: nextFindingId++ } });
      }
      if (key === "PUT /api/v1/investigation-runs/run-1/causes/deploy-4412") {
        return send(200, { cause: { investigation_run_id: "run-1", key: "deploy-4412", ...JSON.parse(raw) } });
      }
      if (key === "PATCH /api/v1/investigations/run-1") {
        return send(
          200,
          options.capable
            ? { run: { id: "run-1", status: "completed" }, warnings: WARNINGS }
            : { run: { id: "run-1", status: "completed" } },
        );
      }
      return send(404, { code: "not_found", message: `no route ${key}` });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

async function connect(apiUrl: string) {
  const tellagen = new TellagenClient({ apiUrl, apiKey: "tllg_test" });
  const server = createServer(tellagen);
  const client = new Client({ name: "test-agent", version: "0.0.1" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  const call = async (name: string, args: Record<string, unknown>) => {
    const result = (await client.callTool({ name, arguments: args })) as {
      content: Array<{ type: string; text: string }>;
      isError?: boolean;
    };
    return {
      isError: result.isError === true,
      text: result.content[0].text,
      json: () => JSON.parse(result.content[0].text) as Record<string, any>,
    };
  };
  return { call, close: () => client.close() };
}

const guidance = { origin: "agent_judgment", refs: [], reason: "checking the error rate" };

/** The agent's whole run, with the finding ids it reads from the responses. */
async function replayRun(call: Awaited<ReturnType<typeof connect>>["call"]) {
  const pickup = await call("tellagen_pick_up_investigation", { investigation_run_id: "run-1" });
  expect(pickup.isError).toBe(false);

  const built = await call("tellagen_build_source_link", {
    kind: "explore",
    datasource: "prom-uid-1",
    query: "sum(rate(http_requests_total{code=~\"5..\"}[5m]))",
    investigation_run_id: "run-1",
  });
  expect(built.isError).toBe(false);
  const links = built.json().links as Array<{ kind: string; label: string; url: string }>;

  await call("tellagen_post_trace_step", {
    investigation_run_id: "run-1",
    step_id: "errors-1",
    step_index: 1,
    status: "done",
    tool_name: "grafana-prometheus",
    title: "Checked the checkout 5xx rate",
    result_summary: "5xx rose from 0.2% to 8.1%",
    guidance,
    outcome: "supports",
    cause_key: "deploy-4412",
  });

  const deployFinding = await call("tellagen_post_finding", {
    incident_id: 42,
    investigation_run_id: "run-1",
    finding_type: "evidence",
    role: "confirms",
    claim: "Deploy 4412 shipped at 09:02",
    evidence_summary: "Release 4412 merged and deployed at 09:02.",
    confidence: 0.9,
    confidence_reason: "deploy log and commit agree",
    evidence_refs: [
      {
        source: "github",
        result_summary: "Deploy 4412 merged at 09:01",
        links: [commitLink],
        datasource: "github",
      },
    ],
  });
  const cause = await call("tellagen_update_cause", {
    investigation_run_id: "run-1",
    cause_key: "deploy-4412",
    label: "Deploy 4412 changed checkout routing",
    state: "leading",
    rationale: "5xx started right after the deploy",
    evidence_for: 1,
    finding_ids: [10],
    sources: ["github"],
  });
  const errorFinding = await call("tellagen_post_finding", {
    incident_id: 42,
    investigation_run_id: "run-1",
    finding_type: "evidence",
    role: "confirms",
    claim: "5xx rose from 0.2% to 8.1% right after",
    evidence_summary: "checkout-api 5xx 8.1% against 0.2% before.",
    confidence: 0.85,
    confidence_reason: "two windows compared",
    evidence_refs: [
      {
        source: "grafana-prometheus",
        query: "sum(rate(http_requests_total{code=~\"5..\"}[5m]))",
        result_summary: "5xx 8.1%",
        links,
        command: "kubectl -n checkout get pods",
        datasource: "prom-uid-1",
      },
    ],
  });
  const deployId = deployFinding.json().finding.id as number;
  const errorId = errorFinding.json().finding.id as number;

  const complete = await call("tellagen_complete_investigation", {
    run_id: "run-1",
    status: "completed",
    result_summary: {
      conclusion: {
        tone: "danger",
        eyebrow: "Root cause found",
        sentence: "Deploy 4412 broke checkout routing.",
        show_new_investigation_cta: false,
      },
      likely_cause_label: "Deploy 4412 changed checkout routing",
      customer_impact: { status: "degraded", verified: true, label: "Checkout degraded" },
      confidence_percent: 86,
      signals_checked: { checked: 2, total: 3 },
      takeaways: [],
      assessment: { diagnosis_state: "confirmed" },
      causal_paths: [
        {
          id: "primary",
          kind: "primary",
          steps: [
            {
              id: "deploy",
              claim: "Deploy 4412 shipped at 09:02",
              verification: "confirmed",
              finding_ids: [deployId],
              links: [commitLink],
            },
            {
              id: "errors",
              claim: "5xx rose from 0.2% to 8.1% right after",
              relation_to_previous: "causes",
              verification: "confirmed",
              finding_ids: [errorId],
              figure: compareFigure,
              evidence_refs: [
                {
                  source: "grafana-prometheus",
                  result_summary: "5xx 8.1%",
                  links,
                  datasource: "prom-uid-1",
                },
              ],
            },
          ],
        },
      ],
      ruled_out: [
        {
          label: "Database saturation",
          explanation: "Connections stayed under 40% of the pool.",
          finding_ids: [errorId],
          confidence_percent: 80,
        },
      ],
      coverage: [
        { source: "Grafana", state: "checked", step_ids: ["errors"], finding_ids: [errorId] },
        { source: "Kubernetes", state: "gap", summary: "No cluster access" },
      ],
      unknowns: [{ label: "Why staging did not show it", why: "No staging metrics" }],
    },
  });
  return { links, deployId, errorId, complete, cause };
}

describe("a replayed run against a fake Tellagen REST server", () => {
  let backend: FakeBackend | undefined;
  afterEach(async () => {
    await backend?.close();
    backend = undefined;
    vi.unstubAllEnvs();
  });
  beforeEach(() => {
    vi.stubEnv("GRAFANA_URL", "");
    vi.stubEnv("TELLAGEN_MCP_CLIENT", "claude");
    vi.stubEnv("TELLAGEN_MCP_PROFILE_ID", "");
  });

  it("sends the exact structured bodies to a backend that advertises diagnosis_structure_v1", async () => {
    backend = await startBackend({ capable: true });
    const agent = await connect(backend.url);
    const { links, deployId, errorId, complete, cause } = await replayRun(agent.call);
    await agent.close();

    // The finding ids are the ones the backend returned.
    expect([deployId, errorId]).toEqual([10, 11]);
    expect(links).toHaveLength(1);
    expect(links[0].kind).toBe("explore");
    const pane = JSON.parse(decodeURIComponent(links[0].url.split("left=")[1]));
    expect(pane.range).toEqual({ from: "1781772000000", to: "1781778000000" });
    expect(links[0].url.startsWith("https://grafana.example.com/explore?left=")).toBe(true);

    expect(backend.requests.map((r) => `${r.method} ${r.path}`)).toEqual([
      "POST /api/v1/investigations/run-1/pickup",
      "GET /api/v1/datasources",
      "GET /api/v1/investigations/run-1/context",
      "POST /api/v1/investigation-runs/run-1/trace",
      "POST /api/v1/incidents/42/findings",
      "PUT /api/v1/investigation-runs/run-1/causes/deploy-4412",
      "POST /api/v1/incidents/42/findings",
      "PATCH /api/v1/investigations/run-1",
    ]);
    expect(new Set(backend.requests.map((r) => r.auth))).toEqual(new Set(["Bearer tllg_test"]));

    const [pickup, , , trace, finding1, causeReq, finding2, patch] = backend.requests;
    expect(causeReq.body).toEqual({
      label: "Deploy 4412 changed checkout routing",
      state: "leading",
      rationale: "5xx started right after the deploy",
      evidence_for: 1,
      finding_ids: [10],
      sources: ["github"],
    });
    expect(cause.isError).toBe(false);
    expect(cause.json().cause.key).toBe("deploy-4412");
    expect(pickup.body.protocol_capabilities).toEqual([
      "runbook_plan_v2",
      "trace_check_id_v2",
      "finding_roles_v2",
      "gap_findings_v2",
      "completion_coverage_v2",
      "diagnosis_structure_v1",
      "diagnosis_changes_v1",
      "run_images_v1",
    ]);
    expect(pickup.body.client.name).toBe("claude");

    expect(trace.body).toEqual({
      step_id: "errors-1",
      step_index: 1,
      status: "done",
      title: "Checked the checkout 5xx rate",
      guidance,
      tool_name: "grafana-prometheus",
      result_summary: "5xx rose from 0.2% to 8.1%",
      outcome: "supports",
      cause_key: "deploy-4412",
    });

    expect(finding1.body.evidence_refs).toEqual([
      {
        source: "github",
        result_summary: "Deploy 4412 merged at 09:01",
        links: [commitLink],
        datasource: "github",
      },
    ]);
    expect(finding2.body.evidence_refs).toEqual([
      {
        source: "grafana-prometheus",
        query: 'sum(rate(http_requests_total{code=~"5.."}[5m]))',
        result_summary: "5xx 8.1%",
        links,
        command: "kubectl -n checkout get pods",
        datasource: "prom-uid-1",
      },
    ]);
    expect(finding2.body).toMatchObject({ finding_type: "evidence", role: "confirms" });

    expect(patch.body.status).toBe("completed");
    const steps = patch.body.result_summary.causal_paths[0].steps;
    expect(steps[0]).toEqual({
      id: "deploy",
      claim: "Deploy 4412 shipped at 09:02",
      verification: "confirmed",
      finding_ids: [10],
      links: [commitLink],
    });
    expect(steps[1].finding_ids).toEqual([11]);
    expect(steps[1].figure).toEqual(compareFigure);
    expect(steps[1].evidence_refs[0]).toEqual({
      source: "grafana-prometheus",
      result_summary: "5xx 8.1%",
      links,
      datasource: "prom-uid-1",
    });
    expect(patch.body.result_summary.ruled_out).toEqual([
      {
        label: "Database saturation",
        explanation: "Connections stayed under 40% of the pool.",
        finding_ids: [11],
        confidence_percent: 80,
      },
    ]);
    expect(patch.body.result_summary.coverage).toEqual([
      { source: "Grafana", state: "checked", step_ids: ["errors"], finding_ids: [11] },
      { source: "Kubernetes", state: "gap", summary: "No cluster access" },
    ]);
    expect(patch.body.result_summary.unknowns).toEqual([
      { label: "Why staging did not show it", why: "No staging metrics" },
    ]);

    // The completion result keeps the backend warnings verbatim and adds a line.
    const out = complete.json();
    expect(complete.isError).toBe(false);
    expect(out.warnings).toEqual(WARNINGS);
    expect(out.warnings_summary).toContain("1 evidence_without_link");
    expect(out.mcp_notice).toBeUndefined();
  });

  it("an older backend without server_capabilities receives the old payload shape", async () => {
    backend = await startBackend({ capable: false });
    const agent = await connect(backend.url);
    const { complete, cause } = await replayRun(agent.call);
    await agent.close();

    expect(cause.isError).toBe(false);
    expect(cause.json().mcp_notice).toContain("does not support live causes");
    expect(backend.requests.some((r) => r.path.includes("/causes/"))).toBe(false);

    const trace = backend.requests.find((r) => r.path.endsWith("/trace"))!;
    expect(trace.body.outcome).toBeUndefined();
    expect(trace.body.cause_key).toBeUndefined();
    expect(trace.body.status).toBe("done");

    const findings = backend.requests.filter((r) => r.path.endsWith("/findings"));
    for (const finding of findings) {
      for (const ref of finding.body.evidence_refs) {
        expect(Object.keys(ref).sort()).not.toEqual(expect.arrayContaining(["links"]));
        expect(ref.links).toBeUndefined();
        expect(ref.command).toBeUndefined();
        expect(ref.datasource).toBeUndefined();
      }
    }
    expect(findings[1].body.evidence_refs[0]).toEqual({
      source: "grafana-prometheus",
      query: 'sum(rate(http_requests_total{code=~"5.."}[5m]))',
      result_summary: "5xx 8.1%",
    });

    const patch = backend.requests.find((r) => r.method === "PATCH")!;
    const summary = patch.body.result_summary;
    expect(summary.ruled_out).toBeUndefined();
    expect(summary.coverage).toBeUndefined();
    expect(summary.unknowns).toBeUndefined();
    const text = JSON.stringify(summary);
    expect(text).not.toContain("finding_ids");
    expect(text).not.toContain("figure");
    expect(text).not.toContain('"links"');
    // What older Tellagen understood is still there.
    expect(summary.causal_paths[0].steps.map((s: any) => s.id)).toEqual(["deploy", "errors"]);
    expect(summary.conclusion.tone).toBe("danger");
    expect(summary.assessment).toEqual({ diagnosis_state: "confirmed" });

    expect(complete.isError).toBe(false);
    const out = complete.json();
    expect(out.run.status).toBe("completed");
    expect(out.mcp_notice).toContain("diagnosis_structure_v1");
  });

  it("checks a figure before any request and says which field is wrong", async () => {
    backend = await startBackend({ capable: true });
    const agent = await connect(backend.url);
    const result = await agent.call("tellagen_complete_investigation", {
      run_id: "run-1",
      status: "completed",
      result_summary: {
        conclusion: { tone: "neutral", eyebrow: "x", sentence: "x", show_new_investigation_cta: false },
        likely_cause_label: "",
        customer_impact: { status: "unknown", verified: false, label: "" },
        confidence_percent: 10,
        signals_checked: { checked: 0, total: 0 },
        takeaways: [],
        causal_paths: [
          {
            id: "primary",
            kind: "primary",
            steps: [
              {
                id: "s1",
                claim: "x",
                verification: "unknown",
                figure: { type: "trend", series: [1], marks: [{ i: 3, label: "late" }] },
              },
            ],
          },
        ],
      },
    });
    await agent.close();
    expect(result.isError).toBe(true);
    expect(result.text).toContain("figure");
    expect(backend.requests).toHaveLength(0);
  });
});
