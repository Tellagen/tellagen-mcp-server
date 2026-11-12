# Changelog

All notable changes to `@tellagen/mcp-server` are in this file. The newest version is first. Each heading is `## <version> - <date>`; the release workflow copies the section of the tagged version into the GitHub release.

## 0.5.0 - 2026-11-12

### Added

- The server starts with no `TELLAGEN_API_KEY` or `TELLAGEN_API_URL` and lists its tools. Each tool call then answers with the setup steps. With a key, the server asks Tellagen once at the start whether the key works. A wrong, revoked or expired key and a paused seat give a clear message with the fix on every tool call.
- The client name and version come from the MCP handshake and go to Tellagen at pickup and as request headers on every call, with the server version, the computer name and a session ID. `tellagen_pick_up_investigation` takes `model` (the model's own name) and `available_sources` (the data sources the client can reach).
- The server remembers the active run in `~/.tellagen/state/<workspace>.json` (owner-only, no secret). The run ID is optional on the run tools. `tellagen_resume` continues a run after a restart of the client and lists what is already posted. A second session on the same computer asks before it joins a run.
- Toolsets: `diagnosis`, `incidents`, `timeline`, `postmortem` and `settings`. `diagnosis,incidents` is the default; choose with `--toolsets` or `TELLAGEN_TOOLSETS`, or `all`. `tellagen_enable_toolset` turns a set on in a running session. Tools are listed in a fixed order, and every tool has read-only, destructive and idempotent annotations.
- `tellagen_next_investigation` finds the run that waits for a client, and the `diagnose` prompt starts a diagnosis with no run ID. With several waiting runs the person chooses.
- A heartbeat every 30 seconds while a run is active, when Tellagen lists `client_heartbeat_v1`. If another client holds a run, the pickup answers with a question for the person, and `takeover: true` is sent only after a yes.
- Notes from a responder come first in the tool result. When a run was cancelled, has ended or was taken over, the tool result says so and the remembered run is removed.
- Every attempt of a Tellagen call has a time limit of 30 seconds (120 seconds for a finding with screenshots), and a call with its repeats ends after 60 seconds (150 seconds). Calls that are safe to repeat are repeated up to 3 times on a network error and on HTTP 429, 502, 503 and 504, and respect `Retry-After`. A finding carries an `Idempotency-Key`. Base64 screenshots are measured before they are sent.
- Guide resources: findings, completion, runbook checks, other MCP servers, postmortem and tool check. The pickup answer names the ones that apply to the run.
- Continuous integration on pull requests and on `master`, and a release workflow for a `v*` tag.
- Sign in with the browser: the tool `tellagen_sign_in` and the commands `npx @tellagen/mcp-server login`, `logout` and `status`. The server shows a short code, opens the browser and stores the key in the system keychain (macOS Keychain, Secret Service on Linux, Windows Credential Manager). Where a computer has no keychain, the key goes to a file that only the owner can read, and the person is told so. `TELLAGEN_API_KEY` and `TELLAGEN_API_URL` still work and win over a stored sign-in. `logout` removes the key from the computer only; to sign the client out on the server, use Sign out under Connected clients in Settings > Local diagnosis in Tellagen. A key that expires in under 7 days adds one line to tool answers. No tool answer, log line or error holds the key or the device code.
- `npx @tellagen/mcp-server listen` takes the diagnosis runs that wait in Tellagen for this person and runs each with the person's own Claude Code, with no window. It supports Claude Code only (Codex cannot be held to a read-only tool list). It runs one run at a time by default, starts only runs that the person asked for, and uses only read tools: the Tellagen diagnosis tools, the read tools of Grafana and GitHub, and one parser for read-only `kubectl` and `gh` commands: default deny at every level, a fixed list of verbs and of flags for each verb, no shell syntax, no credential resource in any spelling. The client runs that same parser in a hook before every shell call, with no allow rule for the shell, so a broken hook means no shell call; the listener proves at its start, once for each client version, that the client calls the hook and obeys its refusal (a canary command that must not run). Where it cannot run the canary (Windows) it does not start the client. When a client cannot be started the listener tells Tellagen with a coded reason. It refuses to start when the person's own Claude Code settings allow more. It never uses a mode that skips permission prompts, and each run has a time limit that holds even if the listener is killed. `listen --status` shows the current run and the last five, and each run writes a log file. Settings are in `~/.tellagen/listen.json`.
- `npx @tellagen/mcp-server trace-hook` records a tool call of a client hook (Grafana and GitHub reads, `kubectl` and `gh` commands) as a step of the open run. It sends the tool, the query or command with tokens and passwords masked, the duration, the size of the result and the first 300 characters of it, never the whole result. It never blocks the tool call: it stops after two seconds and always exits with 0. The server names the recorded step in its next tool answer, and `tellagen_post_trace_step` takes that `step_id` (or `recorded:latest`) to add the outcome and the cause.
- `tellagen_complete_investigation` asks Tellagen for a dry run first, when Tellagen can answer one. If something is missing, the answer is `completed: false` with every repair at once (the field, what is missing and one example), and nothing changes. A trace step needs no guidance: Tellagen records the model's own judgment, with the step title as the reason. The server advertises `guidance_default_v1` and `strict_fields_v1`: Tellagen then names the field of a wrong type and refuses a field it does not know, and the server shows the field paths to the model. Set `TELLAGEN_STRICT_FIELDS=0` to turn strict fields off.
- A lead from a past incident: the server advertises `cause_lead_v1`. When Tellagen sends `suspected_cause_hints`, the server cleans their texts, marks them as untrusted data and adds the rules: test the lead with one check first, never post its cause as a finding or a proposed root cause without evidence from this incident.
- The server advertises `responder_notes_v1` at pickup, so Tellagen can tell a responder that this client shows their note to the model. Notes reach the model on every answer that carries them: a trace step, a check attempt, a cause, a finding and the heartbeat.
- `contracts/mcp-protocol.json` lists what the server sends and relies on, and a test compares it with the contract bundle. `npm run contracts:update` raises the pinned bundle.

### Changed

- The server instructions are short (under 600 words, down from about 1,500). The detail moved to the guide resources.
- By default the server lists 32 tools instead of 46. Set `TELLAGEN_TOOLSETS=all` to list every tool.
- `tellagen_sign_in` is always listed, so a default session lists 32 tools and `all` lists 50.
- An unknown toolset name does not stop the server: the default sets are used and the first tool answer says so.
- The vendored contract bundle moved to `2026-11-12.4`.

### Deprecated

- `TELLAGEN_MCP_CLIENT`. It is read for one more release, only when a client sends no name in the handshake, and for a Tellagen workspace that accepts only `codex` or `claude`.

## 0.4.3 - 2026-11-07

### Added

- A diff figure sends every changed line with its replacement. It uses unchanged lines and line numbers only when Tellagen lists `diff_lines_v1`.
- A stats figure takes a title and up to eight items, and a run history takes a count of runs not shown, when Tellagen lists `figure_extras_v1`.
- Guidance and local notices ask for a headline of 15 words or fewer and for a blocking question that is written as a question.
- Registry metadata: the registry name, repository, home page, issue tracker, keywords, `LICENSE` and `SECURITY.md`.

### Changed

- Every tool name and description was reviewed, and the README lists the tools in groups.
- The vendored contract bundle moved to `2026-11-07.2`.

## 0.4.2 - 2026-11-07

### Fixed

- A finding accepts the fact key of a trace step that has no other identifier, with a notice.
- The guide puts the Grafana address condition before the source link rule, names every `mitigation_state` value, and says what to do with coverage advice in legacy mode.

## 0.4.1 - 2026-11-05

### Fixed

- `tellagen_post_timeline_event` offers only the fields that Tellagen accepts from an API key, and `body` is required.
- The guide and the server instructions give a five-step check before completion, so agents post figures, causes and a timeline event. Tool errors say what to send instead.

## 0.4.0 - 2026-11-05

### Added

- The diagnosis structure: causal paths, ruled out, coverage and unknowns in the result, `outcome` and `cause_key` on trace steps, live causes with `tellagen_update_cause`, and source links with `tellagen_build_source_link`.
- `tellagen_build_figure` with the figure types stats, compare, trend, table, checks, changes, range overlap, histogram, run history and diff.
- Change refs for a regression or a CI failure, and the `ci_run`, `deployment` and `release` link kinds.
- `tellagen_get_context_attachment` reads one run screenshot per call. `tellagen_start_investigation` accepts `corrects_run_id` and `question_finding_id`.
