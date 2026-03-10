# Tellagen MCP — AI Agent Skill Guide

You have access to the Tellagen MCP server. This guide teaches you how to use it — alone and combined with other MCP servers — to investigate and manage incidents.

## Core concept

Tellagen is an incident investigation platform. Your role is to act as an on-call AI investigator: read incidents, gather evidence from observability and source control systems, post structured findings, and promote key findings to the incident timeline so human responders see them in the war room.

## Tools available (12 total)

### Incidents
| Tool | Method | What it does |
|------|--------|-------------|
| `tellagen_get_incident` | GET | Read incident details — severity, status, services, timestamps, manager |
| `tellagen_list_incidents` | GET | List incidents, optionally filter by `active` / `resolved` / `all` |
| `tellagen_get_incident_timeline` | GET | Read the incident timeline — status changes, decisions, promoted findings |
| `tellagen_create_incident` | POST | Declare a new incident (all fields optional: service, severity, regions, gist, team_id, etc.) |

### Investigations
| Tool | Method | What it does |
|------|--------|-------------|
| `tellagen_start_investigation` | POST | Open an investigation run — returns a `run_id` you must use for all findings |
| `tellagen_list_investigation_runs` | GET | List runs for an incident (shows status, agent info, finding counts) |
| `tellagen_complete_investigation` | PATCH | Close a run as `completed` or `failed` (with `failure_reason`) |

### Findings
| Tool | Method | What it does |
|------|--------|-------------|
| `tellagen_post_finding` | POST | Post a structured finding to an active run |
| `tellagen_list_findings` | GET | List findings for an incident (optionally filter by run) |
| `tellagen_get_finding` | GET | Get full finding details including evidence refs |
| `tellagen_update_finding` | PATCH | Dismiss or restore a finding |
| `tellagen_promote_finding` | POST | Promote a finding to the incident timeline (creates a visible timeline event) |

## Investigation lifecycle

Every investigation follows this sequence. Do not skip steps.

```
1. tellagen_get_incident          → understand what happened
2. tellagen_start_investigation   → open a run, get run_id
3. [gather evidence]              → use Grafana, GitHub, codebase, PagerDuty, etc.
4. tellagen_post_finding          → post each finding as you discover it (do NOT batch)
5. tellagen_promote_finding       → promote key findings to the timeline
6. tellagen_complete_investigation → close the run
```

### Rules
- **Post findings incrementally.** Every meaningful observation, correlation, or hypothesis gets its own finding posted immediately. Do not wait until the end.
- **One run per investigation session.** Start one run, post all findings to it, then complete it.
- **Always complete the run.** Even if you hit errors, call `tellagen_complete_investigation` with `status: "failed"` and a `failure_reason`.

## Posting findings

Every finding requires:

| Field | Type | Description |
|-------|------|-------------|
| `incident_id` | number | Which incident |
| `investigation_run_id` | string | Your active run ID |
| `finding_type` | enum | `observation`, `correlation`, `hypothesis`, `evidence`, `recommendation`, `negative` |
| `claim` | string | One-sentence statement of the finding |
| `evidence_summary` | string | Detailed explanation with supporting data |
| `confidence` | number | 0.0–1.0 (0.9+ near-certain, 0.5–0.7 plausible, <0.5 speculative) |
| `confidence_reason` | string | Why you have this confidence level |

Optional:

| Field | Type | Description |
|-------|------|-------------|
| `evidence_refs` | array | Sources consulted (see below) |
| `screenshots` | array | Standalone screenshots for this finding |

### Evidence refs

Each evidence ref links to a specific data source you queried:

```json
{
  "source": "grafana-loki",
  "query": "{app=\"checkout\"} |= \"error\" | json",
  "result_summary": "Found 847 errors in last 30 minutes, 90% are 502 Bad Gateway from upstream payments service",
  "url": "https://grafana.example.com/explore?...",
  "screenshots": [
    {
      "url": "https://grafana.example.com/render/d-solo/abc/checkout?panelId=4&from=now-1h",
      "caption": "Grafana panel showing 5xx spike at 14:32 UTC"
    }
  ]
}
```

### Screenshots

Screenshots can be attached to individual evidence refs (source-specific) or at the top level of a finding (standalone). Each screenshot object:

```json
{
  "url": "https://...",
  "base64": "<base64-encoded image data>",
  "media_type": "image/png",
  "caption": "What this screenshot shows"
}
```

All fields are optional, but provide at least `url` or `base64`. Use `url` when linking to a render endpoint (e.g., Grafana panel render). Use `base64` when you have raw image data from a screenshot tool.

Screenshots are also supported on `tellagen_promote_finding` — attach them so they appear on the timeline event in the war room.

## Choosing finding types

| Type | When to use | Example |
|------|-------------|---------|
| `observation` | Raw data point worth noting | "Error rate is 5x normal at 2.3%" |
| `correlation` | Two things that appear related | "Error spike started 4 minutes after deploy abc123" |
| `hypothesis` | Proposed explanation (may be wrong) | "The payments service OOM is likely caused by the connection pool leak in PR #891" |
| `evidence` | Proof that supports or refutes a hypothesis | "Thread dump confirms 2,400 idle connections held by HikariCP pool" |
| `recommendation` | Suggested action for responders | "Roll back deploy abc123 to restore payments service" |
| `negative` | Something you ruled out | "Database latency is normal — not a contributing factor" |

Post early and often. A `hypothesis` with 0.4 confidence is still valuable — it tells responders what you're thinking and what to check.

## Composing with other MCP servers

Tellagen handles the investigation lifecycle. Other MCP servers provide the evidence. Here's how to combine them.

### With Grafana MCP (`mcp-grafana`)

Grafana MCP gives you tools to search dashboards, query Prometheus/Loki, and list alert rules.

**Investigation pattern:**

1. Read the incident from Tellagen — note the affected service and timestamps
2. Use Grafana tools to search for relevant dashboards (`search_dashboards`)
3. Query Prometheus for metrics: error rates, latency percentiles, saturation (`query_prometheus`)
4. Query Loki for error logs around the incident timeframe (`query_loki`)
5. If Grafana provides panel render URLs or you capture screenshots, attach them to your findings
6. Post each query result as a finding with evidence refs back to Tellagen

**Example flow:**
```
tellagen_get_incident(incident_id=42)
  → "checkout service, sev1, started 14:30 UTC"

search_dashboards(query="checkout")
  → finds dashboard uid "abc123"

query_prometheus(query='rate(http_requests_total{service="checkout",code=~"5.."}[5m])')
  → 5xx rate jumped from 0.002 to 0.15 at 14:32

query_loki(query='{app="checkout"} |= "error" | json', start="2025-03-09T14:25:00Z", end="2025-03-09T14:45:00Z")
  → 847 errors, 90% are "connection refused" from payments upstream

tellagen_post_finding(
  incident_id=42,
  investigation_run_id="run-xyz",
  finding_type="observation",
  claim="HTTP 5xx rate spiked 75x at 14:32 UTC",
  evidence_summary="checkout service 5xx rate went from 0.2% to 15%. 90% of errors are 502 Bad Gateway from upstream payments service.",
  confidence=0.95,
  confidence_reason="Direct metric observation from Prometheus, corroborated by Loki error logs",
  evidence_refs=[
    {
      source: "grafana-prometheus",
      query: "rate(http_requests_total{service='checkout',code=~'5..'}[5m])",
      result_summary: "5xx rate jumped from 0.002 to 0.15 at 14:32 UTC",
      url: "https://grafana.example.com/explore?...",
      screenshots: [{
        url: "https://grafana.example.com/render/d-solo/abc123/checkout?panelId=4&from=1709992500000&to=1709993700000&width=800&height=400",
        caption: "5xx rate panel showing the spike"
      }]
    },
    {
      source: "grafana-loki",
      query: "{app='checkout'} |= 'error' | json",
      result_summary: "847 errors in 20-minute window. 90% are 'connection refused' from payments upstream",
      url: "https://grafana.example.com/explore?..."
    }
  ]
)
```

### With GitHub MCP (`@modelcontextprotocol/server-github`)

GitHub MCP lets you search code, list commits, read PRs, and check deployments.

**Investigation pattern:**

1. From the incident, identify the service and approximate start time
2. Search recent commits/PRs for the affected service around that time
3. Look at deployment events or release tags
4. Read changed files if a suspicious deploy is found
5. Post correlation findings linking deploys to the incident
6. Check for related issues or prior incidents

**Example findings from GitHub evidence:**
```
tellagen_post_finding(
  finding_type="correlation",
  claim="Deploy abc123 landed 4 minutes before the 5xx spike",
  evidence_summary="PR #891 merged at 14:28 UTC, deployed at 14:28. Incident started at 14:32. The PR changes connection pool settings in payments-client.",
  confidence=0.7,
  confidence_reason="Strong temporal correlation, and the changed code touches the exact subsystem showing errors",
  evidence_refs=[{
    source: "github",
    query: "commits to main between 14:00-14:35 in checkout-service repo",
    result_summary: "1 deploy: commit abc123 from PR #891 'Tune HikariCP pool settings'",
    url: "https://github.com/org/checkout-service/pull/891"
  }]
)
```

### With PagerDuty MCP

**Investigation pattern:**

1. Check which alerts fired around the incident start time
2. Look at alert history for the affected service — is this a repeat?
3. Identify who was paged and when
4. Post findings about alert patterns

### With Sentry / error tracking MCP

**Investigation pattern:**

1. Search for new error groups that appeared around incident start
2. Get error details — stack traces, affected users, frequency
3. Link specific errors to your hypothesis about root cause

### Multi-source investigation template

For a typical sev1/sev2, query sources in this order:

1. **Tellagen** — read the incident, check if there's a prior investigation
2. **Grafana/Prometheus** — check key metrics (error rate, latency, saturation) for the affected service
3. **Grafana/Loki** — pull error logs around the incident window
4. **GitHub** — find recent deploys to the affected service
5. **PagerDuty** — check what alerts fired
6. **Codebase** — if a suspicious deploy is found, read the changed code

Post findings after each source, not at the end. Your first finding might just be "error rate is elevated" — that's fine. Build the picture incrementally.

## Promoting to timeline

Not every finding belongs on the timeline. Promote findings that:

- Confirm or identify the root cause
- Record a critical decision or action taken
- Represent a key milestone (e.g., "service recovered at 15:12 UTC")
- Provide high-confidence recommendations for responders

When promoting, attach screenshots so the timeline event is self-contained:

```
tellagen_promote_finding(
  finding_id=7,
  title="Root cause: connection pool exhaustion after deploy abc123",
  is_key=true,
  screenshots=[{
    url: "https://grafana.example.com/render/d-solo/abc123/checkout?panelId=4&from=...",
    caption: "5xx rate panel showing spike and recovery after rollback"
  }]
)
```

## Creating incidents

When you detect something wrong (e.g., while monitoring dashboards), you can declare an incident directly:

```
tellagen_create_incident(
  service="payments",
  severity="sev2",
  gist="5xx-spike",
  regions=["us-east-1"],
  create_slack_channel=true
)
```

Then immediately start investigating it.

## Common mistakes to avoid

- **Batching findings.** Post each finding as you discover it. Don't accumulate five findings and post them all at the end.
- **Forgetting to complete the run.** Always call `tellagen_complete_investigation`, even on failure.
- **Low-effort evidence refs.** Include the actual query you ran and a meaningful `result_summary`, not just "checked Grafana". Deep links in `url` let humans verify your work.
- **Promoting everything.** The timeline is for key events. A speculative hypothesis with 0.3 confidence doesn't belong there.
- **Skipping screenshots.** When you have access to Grafana render URLs or captured dashboard images, attach them. A panel screenshot showing the spike is worth more than a text description to a human responder in the war room.
- **Not using negative findings.** When you rule something out, post a `negative` finding. It prevents other investigators from re-checking the same thing.
