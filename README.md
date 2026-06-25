# @tellagen/mcp-server

MCP server for Tellagen — investigate incidents with AI agents.

Works with any MCP-compatible client: Claude Code, Cursor, VS Code Copilot, Windsurf.

## Quick start

### 1. Create an API key

In Tellagen, go to **Settings > API Keys** and create a key with both `incidents:read` and `incidents:write` scopes.

> **Important:** `incidents:write` does NOT imply `incidents:read`. You need both scopes for full investigation capabilities.

### 2. Add to your MCP client config

**Claude Code** (`~/.claude.json` or project `.mcp.json`):

```json
{
  "mcpServers": {
    "tellagen": {
      "command": "npx",
      "args": ["-y", "@tellagen/mcp-server"],
      "env": {
        "TELLAGEN_API_KEY": "tllg_...",
        "TELLAGEN_API_URL": "https://yourcompany.api.tellagen.com"
      }
    }
  }
}
```

**Cursor** (`.cursor/mcp.json`):

```json
{
  "mcpServers": {
    "tellagen": {
      "command": "npx",
      "args": ["-y", "@tellagen/mcp-server"],
      "env": {
        "TELLAGEN_API_KEY": "tllg_...",
        "TELLAGEN_API_URL": "https://yourcompany.api.tellagen.com"
      }
    }
  }
}
```

### 3. Investigate

From a Tellagen incident, click **Investigate with AI**, then copy the Codex or Claude command. The command includes an `investigation_run_id`; your local agent should call `tellagen_pick_up_investigation` with that ID before doing any evidence work.

If you are starting outside the Tellagen UI, ask your AI agent: *"Start a local Tellagen investigation for incident #42"*.

## Tools

### Read tools

| Tool | Description |
|------|-------------|
| `tellagen_get_incident` | Get incident details (severity, status, services, timestamps) |
| `tellagen_list_incidents` | List all incidents, optionally filtered by status |
| `tellagen_get_incident_timeline` | Get the timeline of events for an incident |
| `tellagen_list_investigation_runs` | List investigation runs for an incident |
| `tellagen_get_incident_context` | Get the full context bundle for an existing investigation run |
| `tellagen_list_runbooks` | List matched runbooks/skills for a run |
| `tellagen_list_findings` | List findings for an incident, optionally filtered by run |
| `tellagen_get_finding` | Get a single finding with full details |

### Write tools

| Tool | Description |
|------|-------------|
| `tellagen_start_investigation` | Start a local investigation run when no UI-created run ID was provided |
| `tellagen_pick_up_investigation` | Attach the local agent to a UI-created awaiting run |
| `tellagen_post_trace_step` | Post live investigation progress steps |
| `tellagen_post_finding` | Post a structured finding to an active investigation |
| `tellagen_complete_investigation` | Mark an investigation as completed or failed, with RCA summary support |
| `tellagen_update_finding` | Update a finding's status (dismiss or restore) |
| `tellagen_promote_finding` | Promote a finding to the incident timeline |

## Composing with other MCP servers

The Tellagen MCP server is designed to work alongside vendor MCP servers for observability and source control. Install whichever match your stack:

```json
{
  "mcpServers": {
    "tellagen": {
      "command": "npx",
      "args": ["-y", "@tellagen/mcp-server"],
      "env": {
        "TELLAGEN_API_KEY": "tllg_...",
        "TELLAGEN_API_URL": "https://yourcompany.api.tellagen.com"
      }
    },
    "grafana": {
      "command": "uvx",
      "args": ["mcp-grafana"],
      "env": {
        "GRAFANA_URL": "https://yourcompany.grafana.net",
        "GRAFANA_SERVICE_ACCOUNT_TOKEN": "glsa_..."
      }
    },
    "github": {
      "command": "npx",
      "args": ["@anthropic-ai/github-mcp-server"],
      "env": {
        "GITHUB_PERSONAL_ACCESS_TOKEN": "ghp_..."
      }
    }
  }
}
```

The agent uses Tellagen tools to manage the investigation lifecycle and vendor tools to gather evidence:

1. **Pick up** the Tellagen run if the UI command included `investigation_run_id`
2. **Read** the returned context bundle, including runbooks and investigation scope
3. **Post trace steps** before and after meaningful checks
4. **Query** Grafana Loki for error logs, Prometheus for metrics
5. **Check** GitHub for recent deploys and code changes
6. **Post** findings back to Tellagen as they're discovered
7. **Complete** the investigation run with a concise RCA summary

## Authentication

- API key is passed via `TELLAGEN_API_KEY` environment variable (never in args)
- The server validates the key on startup by calling `/api/v1/auth/me`
- All requests include `Authorization: Bearer tllg_...` header
- The MCP server acts as the API key's creating user

## Scopes

The API key needs both scopes:

| Scope | Required for |
|-------|-------------|
| `incidents:read` | Reading incidents, timelines, investigation runs, findings |
| `incidents:write` | Starting investigations, posting findings, promoting to timeline |

## Development

### Setup

```bash
npm install
npm run build
npm test
```

### Running the dev server locally

1. **Build the project** (or use watch mode):

   ```bash
   npm run build
   # or, to rebuild on every change:
   npm run dev
   ```

2. **Point your MCP client at the local build** instead of the published npm package.

   **Claude Code** — add to `~/.claude.json` (global) or `.mcp.json` (per-project):

   ```json
   {
     "mcpServers": {
       "tellagen": {
         "command": "node",
         "args": ["/absolute/path/to/tellagen-mcp-server/dist/index.js"],
         "env": {
           "TELLAGEN_API_KEY": "tllg_...",
           "TELLAGEN_API_URL": "https://yourcompany.api.tellagen.com"
         }
       }
     }
   }
   ```

   **Cursor** — add to `.cursor/mcp.json`:

   ```json
   {
     "mcpServers": {
       "tellagen": {
         "command": "node",
         "args": ["/absolute/path/to/tellagen-mcp-server/dist/index.js"],
         "env": {
           "TELLAGEN_API_KEY": "tllg_...",
           "TELLAGEN_API_URL": "https://yourcompany.api.tellagen.com"
         }
       }
     }
   }
   ```

   Replace `/absolute/path/to/tellagen-mcp-server` with the actual path to your clone.

3. **Restart the MCP client** so it picks up the new config. In Claude Code, run `/mcp` to verify the server is connected.

4. **Iterate:** if you're running `npm run dev`, every save recompiles. Restart the MCP connection (or restart your client) to pick up changes.

### Running tests

```bash
npm test                              # all tests
npx vitest run test/client.test.ts    # single file
npx vitest                            # watch mode
```

### Type-checking

```bash
npm run lint    # tsc --noEmit
```

## Environment variables

| Variable | Required | Description |
|----------|----------|-------------|
| `TELLAGEN_API_KEY` | Yes | API key (format: `tllg_...`) |
| `TELLAGEN_API_URL` | Yes | API base URL (e.g., `https://yourcompany.api.tellagen.com`) |
