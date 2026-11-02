export const exploreLink = {
  kind: "explore",
  label: "Query in Grafana Explore",
  url: "https://grafana.example.com/explore?left=%7B%22queries%22%3A%5B%5D%7D",
};

export const commitLink = {
  kind: "commit",
  label: "Commit abc1234 on GitHub",
  url: "https://github.com/acme/checkout/commit/abc1234",
};

export const compareFigure = {
  type: "compare",
  title: "Checkout 5xx rate",
  metric: "5xx rate",
  unit: "%",
  better: "lower",
  threshold: { value: 1, label: "SLO" },
  rows: [{ label: "checkout-api", before: 0.2, after: 8.1 }],
};

export const trendFigure = {
  type: "trend",
  title: "p99 latency",
  unit: "ms",
  series: [120, 125, 130, 900, 1400, 1380],
  start: "2026-06-18T09:00:00Z",
  step_seconds: 60,
  marks: [{ i: 3, label: "deploy 4412" }],
  source: {
    kind: "prometheus",
    datasource: "prom-uid-1",
    query: "histogram_quantile(0.99, sum(rate(x[5m])) by (le))",
    step: "60s",
  },
};

export const statsFigure = {
  type: "stats",
  items: [
    { label: "5xx rate", value: "8.1%", caption: "checkout-api, 5m", tone: "bad" },
    { label: "Deploys", value: "1", caption: "last 30m" },
  ],
};

/** A completed-run result summary that uses the whole diagnosis structure. */
export function structuredSummary() {
  return {
    conclusion: {
      tone: "danger",
      eyebrow: "Root cause found",
      sentence: "Deploy 4412 broke checkout upstream routing.",
      show_new_investigation_cta: false,
    },
    likely_cause_label: "Deploy 4412 changed checkout upstream routing",
    customer_impact: { status: "degraded", verified: true, label: "Checkout degraded" },
    confidence_percent: 86,
    signals_checked: { checked: 3, total: 4 },
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
            evidence_refs: [
              {
                source: "github",
                result_summary: "Deploy 4412 merged at 09:01",
                links: [commitLink],
                datasource: "github",
              },
            ],
            finding_ids: [11],
            links: [commitLink],
          },
          {
            id: "errors",
            claim: "5xx rose from 0.2% to 8.1% right after",
            relation_to_previous: "causes",
            verification: "confirmed",
            evidence_refs: [
              {
                source: "grafana-prometheus",
                query: "sum(rate(http_requests_total{code=~\"5..\"}[5m]))",
                result_summary: "5xx 8.1%",
                links: [exploreLink],
                command: "kubectl -n checkout get pods",
                datasource: "prom-uid-1",
              },
            ],
            finding_ids: [12, 13],
            figure: compareFigure,
          },
        ],
      },
    ],
    recommended_actions: [
      {
        title: "Roll back deploy 4412",
        category: "mitigation",
        priority: "high",
        evidence_refs: [
          { source: "github", result_summary: "diff", links: [commitLink] },
        ],
      },
    ],
    question_verification: {
      finding_id: 11,
      verdict: "resolved",
      summary: "Answered.",
      evidence_refs: [{ source: "github", result_summary: "x", command: "git log -1" }],
    },
    ruled_out: [
      {
        label: "Database saturation",
        explanation: "Connections stayed under 40% of the pool.",
        finding_ids: [14],
        links: [exploreLink],
        confidence_percent: 80,
      },
    ],
    coverage: [
      { source: "Grafana", state: "checked", summary: "Metrics read", step_ids: ["errors"], finding_ids: [12] },
      { source: "Kubernetes", state: "gap", summary: "No cluster access", finding_ids: [15] },
      { source: "PagerDuty", state: "not_configured" },
    ],
    unknowns: [{ label: "Why staging did not show it", why: "No staging metrics", finding_ids: [] }],
  };
}
