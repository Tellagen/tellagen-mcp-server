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

Ask your AI agent: *"Investigate incident #42 on Tellagen"*

## Tools

### Read tools

| Tool | Description |
|------|-------------|
| `tellagen_get_incident` | Get incident details (severity, status, services, timestamps) |
| `tellagen_list_incidents` | List all incidents, optionally filtered by status |
| `tellagen_get_incident_timeline` | Get the timeline of events for an incident |
| `tellagen_list_investigation_runs` | List investigation runs for an incident |
| `tellagen_list_findings` | List findings for an incident, optionally filtered by run |
| `tellagen_get_finding` | Get a single finding with full details |

### Write tools

| Tool | Description |
|------|-------------|
| `tellagen_start_investigation` | Start a new investigation run on an incident |
| `tellagen_post_finding` | Post a structured finding to an active investigation |
| `tellagen_complete_investigation` | Mark an investigation as completed or failed |
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

1. **Read** the incident from Tellagen
2. **Query** Grafana Loki for error logs, Prometheus for metrics
3. **Check** GitHub for recent deploys and code changes
4. **Post** findings back to Tellagen as they're discovered
5. **Complete** the investigation run

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
