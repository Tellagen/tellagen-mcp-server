# Changelog

All notable changes to `@tellagen/mcp-server` are in this file. The newest version is first. Each heading is `## <version> - <date>`; the release workflow copies the section of the tagged version into the GitHub release.

## 0.10.0 - 2026-11-25

### Added

- A sparkline on a key figure (`stat_sparklines_v1`). A `stats` item in `tellagen_build_figure` takes `points`, the samples of the range query its value came from. The builder turns them into `spark`: the samples in time order, at most 60 values at an even step from the first to the last, and `window_seconds`, the time they span. Every value is a sample that was sent. Fewer than 4 usable samples give no sparkline. The sparkline is sent only when the pickup lists `stat_sparklines_v1`; otherwise the builder leaves it out and says so in `notes`, and the timeline tools and `tellagen_complete_investigation` leave it out with an `mcp_notice`.
- The plain status of a diagnosis (`plain_status_v1`). `result_summary.current_state` answers "Still happening?" with a state (`ongoing`, `stopped` or `unknown`) and one or two short sentences, and a `ruled_out` entry may say what it does not exclude in `still_possible`. The MCP advertises the capability at pickup. If the pickup lists it, the MCP sends both fields, on a completion and on an addition to a finished run. If the pickup does not list it, the MCP leaves both fields out and `mcp_notice` says so.
- The figure guide teaches four rules: a title is a name of what the figure shows, the step claim says the conclusion and the figure never repeats it, a stats caption is one short fact such as "SLO 1%", and a threshold is sent when there is one.
- The skill guide and the completion guide teach the plain writing rules: one fact in each sentence, a time as HH:MM UTC, no raw id in a sentence, a headline that matches the stored values, a blocking question that names its host, and a first action that names where.

### Fixed

- `tellagen_complete_investigation` now takes a `stats` step figure with a `title` and with five to eight items, as `tellagen_build_figure` returns it for a Tellagen that lists `figure_extras_v1`. The input check refused both.
- `tellagen_build_figure` skips a sample whose value is an empty string, in a trend and in a sparkline. It read such a sample as 0.

## 0.9.0 - 2026-11-22

### Added

- A verdict for every diagnosis (`diagnosis_verdict_v1`). `result_summary.alert_verdict` now fits a run of any incident, not only an alert. The new verdict `expected_behavior` (reasons `works_as_designed` and `third_party_behavior`) says nothing is broken, and `owner` (`ours` or `third_party`) says whose behavior or fix it is. The server decides whether a verdict that says nothing is broken is clear or held and lists what is missing; the guide and the completion warnings (`verdict_held`, `server_owned_field_ignored`) say what to add. The field is sent only when the pickup lists `diagnosis_verdict_v1` or `alert_verdict_v1`; `expected_behavior` and `owner` need `diagnosis_verdict_v1`. Without it the field is left out and `mcp_notice` says so.
- Fix options (`fix_options_v1`). `result_summary.fix_options` lists up to 5 ways to fix the problem as alternatives a person picks from. The new tool `tellagen_build_fix_option` checks one option and returns it in the right shape: the kind, where the change is, one target (a vendor, a team or a rollback), the files that were read, a diff of at most 6 changed lines, and a read-only way to check that it worked. It never takes a label, a web address or an action type, because Tellagen works out what each button does. It refuses a state that needs a reason and has none, a second recommended option, and a verify command that changes a system. Fix options are sent only when the pickup lists `fix_options_v1`. The new guide `resource://tellagen/guide/fixes` teaches the rules: read the file before you recommend a change to it, keep the change small, keep the tempting wrong option as not recommended, and never invent a rollback method.
- Code locations (`code_locations_v1`). When the pickup has `request.context.code_locations`, the server matches each repository to a local checkout by its git remote (the working directory, then the folders in `TELLAGEN_CODE_CHECKOUTS`), else to `gh` read-only, and adds `mcp_code_locations` to the pickup answer with how each one is read. It runs only `git remote` and `gh --version`, never sends a path or an address to Tellagen, and `TELLAGEN_CODE_CHECKOUTS=off` turns it off. The pickup reports the source `code` as found when this computer has a checkout. The guide says to read the code before asking a person, and to record the read in coverage with the source `code`, or a gap with a reason.
- The completion tool explains the new warnings: `verdict_held`, `server_owned_field_ignored`, `source_gap_as_question`, `coverage_checked_without_proof`, `code_not_read` and the ten fix option warnings.

### Changed

- `tellagen_update_incident` no longer offers the status, the severity or the severity mode, and never sends them, or the customer impact or the close fields. A person decides those in Tellagen. When Tellagen answers `incident_change_requires_person`, the answer says in plain words that it is a person's decision and not to try another way.
- The vendored contract bundle is raised to the version that holds the verdict, fix options and code locations guidance.

## 0.8.1 - 2026-11-20

### Changed

- Clearer descriptions for eight tools, after a review of all 54. Each one now says in plain words what the tool does, when to use it, what it returns and what it never does. `tellagen_post_trace_step` names `outcome`, `cause_key` and the optional `guidance`. `tellagen_post_runbook_check_attempt` explains the source resolution and the skipped attempt for a blocked source. `tellagen_get_investigation_coverage`, `tellagen_list_trace_steps`, `tellagen_list_runbooks`, `tellagen_list_investigation_runbook_waivers`, `tellagen_update_investigation_scope` and `tellagen_post_timeline_event` say what they return. No tool name, input or behavior changed.
- The Kubernetes safety check says "a session that `tellagen-mcp-server listen` did not start" instead of "a session that is not listened".

## 0.8.0 - 2026-11-20

### Added

- Each run log of the listener has lines with the time: when the listener started the client, when the client picked the run up (read from the state file of the workspace) and when the client ended. The log then shows how long the client took to start. The reason for a client that ended with an error never quotes these lines.

### Changed

- A session that the listener started never takes a run over. The listener starts the client with `TELLAGEN_UNATTENDED=1`, and the Tellagen MCP server of that client refuses `takeover` on `tellagen_pick_up_investigation` and `tellagen_resume`: when another client or session holds the run, the answer tells the model to stop and has no `next_input`. The rules of an unattended run also say "Never set takeover."

## 0.7.0 - 2026-11-19

### Added

- Requests on a finished run (`run_requests_v1`): the heartbeat goes on after `tellagen_complete_investigation` until `amend_until` and brings a responder's request (read a source again, check an answer) as a line, with its text quoted as the person's words. `tellagen_next_investigation` lists requests; new tools `tellagen_pick_up_run_request` and `tellagen_end_run_request`; `tellagen_amend_investigation` and `tellagen_post_trace_step` take `request_id`. The capability is sent at pickup and on the waiting list. The headless listener starts the person's client for such a request, under the same limits and read-only rules as a run.
- `tellagen_amend_investigation` adds findings, changed coverage and, when the answer changes, a new result to a finished run as a new version (`POST /api/v1/investigation-runs/{id}/amendments`). It is sent only when the pickup lists `run_amendments_v1`; otherwise the tool refuses with a clear message and sends nothing. It always sends an `Idempotency-Key` (a hash of the call), and a conflict (`run_amendment_conflict`) is sent again with the same key.
- The finished run is remembered after `tellagen_complete_investigation`, so the amend tool needs no run id in the same chat, and `tellagen_resume` says that the run takes additions instead of picking it up. When a write answers 409 `investigation_run_ended` with `details.amendable`, the answer starts with "The run is finished but takes additions until <time>. Use tellagen_amend_investigation."
- A coverage entry takes `reason` (`wrong_account`, `not_connected`, `auth_expired`, `error`, `no_source`), `retryable` and `detail`, sent only when the pickup lists `run_amendments_v1`; otherwise they are left out and `mcp_notice` says so.
- The guide and the server instructions say: a source you could not read goes in coverage with a reason, not in a gap finding; and a source that becomes readable in the same session is read and amended.

- `npx @tellagen/mcp-server kubernetes setup [--client claude-code|claude-desktop|codex|cursor] [--context NAME] [--service-account NAME [-n NAMESPACE] [--duration 8h]] [--yes] [--no-report]`: sets up a read-only Kubernetes server with one command. It writes `~/.config/tellagen/kubernetes-mcp.toml` (`toolsets = ["core"]`, `read_only = true`, `disable_destructive = true`, the Secret resource denied, and `kubeconfig` when you give a context or a service account), adds the `kubernetes-mcp-server` entry to your client (it asks first; `--yes` skips the question), runs the four `can-i` checks with the kubeconfig the server will use, and reports them to Tellagen so the tools table updates with no Recheck. With `--context` it writes a private copy of the kubeconfig that holds only that context. With `--service-account` it creates a token, writes a private kubeconfig for it (mode 600) and says how long the token lasts; run the command again to renew it. It prints no token and no path with a user name. Running it again changes nothing that is already set.
- The tool report sends `kubernetes_read_only_tools` (a boolean) when the client has a Kubernetes server: `true` when the server entry runs read-only (`read_only = true` in its `--config` TOML file, or a `--read-only` flag), `false` when it does not, and nothing when it cannot be known. The server reads only that one fact from the config files of the client, and only when the report says Kubernetes was found. The Recheck report of a diagnostic session (`tellagen_report_diagnostic_tools`) carries it on the kubernetes report in the same way. An older Tellagen that does not know the field gets the report without it.
- `doctor` recognises the Atlassian, Jira, Confluence and Notion servers (by name, command or address) as documentation, so `doctor --tool docs` finds them.

- The guide teaches the word limits of the result text (answer and headline 15, claim 20, evidence summary 60, action title 12 and summary 20, ruled out 30, coverage 20, unknowns 12, customer impact 15), the stock phrases to leave out, ids in `links` and never in a sentence, numbers with units, and "a figure shows the fact its step states". The completion tool reads the new warnings (`text_too_long`, `filler_phrase`, `raw_id_in_text`, `coverage_not_needed_without_reason`) with advice. When a dry run returns only advice about the text, the first call for a run shows it and completes nothing; the next call completes the run, changed or not.
- `result_summary.answer` and a `diff` or `checks` figure on a recommended action, sent only when the pickup lists `action_answer_v1`. A coverage entry in the state `not_needed` with its reason in `summary`, sent only when the pickup lists `coverage_not_needed_v1` (without it the entry is left out, never sent as `checked`). A compare row `limit` (the row then needs no `before`), in `tellagen_build_figure`, the result and the timeline blocks, sent only when the pickup lists `figure_limits_v1`. Without a capability the field is left out and `mcp_notice` says so.

- `result_summary.alert_verdict` on `tellagen_complete_investigation`: the verdict on the alert behind the incident (`real_problem`, `already_handled`, `false_alarm`, `not_sure`), its reason, onset, `would_change_mind` and a proof checklist. It is sent only when the pickup lists `alert_verdict_v1`; otherwise the field is left out and `mcp_notice` says so. The guide and the server instructions teach judging the alert first, the proof rules, and the four evidence rules (`cause_without_runtime_evidence`, `empty_result_link_dropped`, `step_names_fix_not_cause`, `false_alarm_without_rule`). The completion tool explains the `verdict_*` warnings.

### Changed

- For `docs`, the report tools and the pickup ask the model to put the name of the source it found in `detail` ("Confluence", "Notion", "repository folder"), with no address, path or user name.
- When storage and a filesystem alert must be tied together, the guide and the server instructions now say: map storage to device and mountpoint with the `node_filesystem_*` metrics and the documentation; if neither proves it, post a gap finding and return an inconclusive diagnosis.

### Removed

- The `local_host` source key. The report tools and the pickup no longer accept it, and the guide no longer asks for a host check.

### Fixed

- `listen` says why it could not prove the shell guard. When the guard saw no call, the refusal now shows the client's exit code and what it printed (on one line, cut to 300 characters, secrets masked), and a line that starts with "To fix it:". It names an expired or missing Claude Code sign-in (run `claude`, then `/login`), a refused `ANTHROPIC_API_KEY`, a usage limit, a model that is not available, a client that did not finish in 3 minutes, and a `disableAllHooks` or `allowManagedHooksOnly` setting that keeps the hook from running. Before, every such case said only that the client did not call the guard.

## 0.6.0 - 2026-11-15

### Added

- `tellagen_report_available_sources` (toolset `settings`): a client tells Tellagen which data sources it can reach (`grafana`, `kubernetes`, `github`, `docs`, `local_host`, each found or not found) with no `diag_` ID and no run, so the tools table in Settings updates for that client. It posts to `POST /api/v1/settings/agent/tool-report` and says so clearly when the Tellagen it talks to has no such route yet.
- The Kubernetes safety check. The client runs four `kubectl auth can-i` tests (create pods, delete pods, create `pods --subresource=exec`, get secrets) and reports them as checks with the ids `k8s_can_create_pods`, `k8s_can_delete_pods`, `k8s_can_exec` and `k8s_can_read_secrets` (`ok` when the answer is no, `failed` when it is yes). The protocol is in the guide and in the descriptions of `tellagen_report_available_sources` and `tellagen_report_diagnostic_tools`. It says what the identity could do, and a session that is not listened is never called read-only.
- The `doctor` command: `npx @tellagen/mcp-server doctor [--client claude-code|claude-desktop|codex|cursor] [--tool grafana|kubernetes|github|docs] [--fix] [--report]`. It reads the MCP config files of the clients on this computer, only when a person runs it, and never writes them. For each Grafana, Kubernetes, GitHub or documentation server it checks that the command can be started from the PATH that client uses (Claude Desktop and Cursor use a shorter PATH than a terminal), that the settings the tool needs are in the entry (names only) and, for Grafana, that `GRAFANA_URL` answers `/api/health` with no token. It prints one sentence for each problem. `--fix` prints a corrected entry and stops: only plain args (flags, package names) are printed, every other arg and every env value is hidden. `--report` posts names and statuses only (no path, value, argument or file text): each source goes with its `access_status` (`missing_tool`, `auth_missing` or `unreachable`) and one plain sentence. It cannot see a running session, so the model check is still the truth for a session.

- `tellagen_build_figure` builds a `log_lines` figure from the result of a Loki query. Send the streams (or a flat list of entries) with the query, datasource and range; the builder keeps at most 8 lines, the ones that show the event first, reads each level from a label, JSON, logfmt or a leading word, takes up to 6 fields from the line and its labels, counts `matched`, `scanned` and `lines_not_shown`, and removes colour codes and secrets from the text. `match` terms mark the lines that show the event, and `marks` mark a line of another tenant, company or request as `unrelated` with a note. A query with no result needs `scanned` and the range. It is built and sent only when Tellagen lists `log_lines_v1`; the timeline tools and the completion leave a `log_lines` figure out for an older Tellagen and say so. The figure guide and the skill teach it, and say that the text of an unrelated line is never the quote of a finding.
- The time window of a run. The server advertises `investigation_window_v1`, puts `request.context.window` at the top of the pickup answer as `mcp_window`, and uses the window as the default range of `tellagen_build_source_link` and of a `log_lines` figure (the answer says so). The guide teaches: search for the cause inside the window, use the baseline only for counts, and send `window_suggestion` `{from, to, reason}` with the result when the signal starts outside it.
- The server advertises `question_checks_v1`. `tellagen_post_finding` takes `checks` on a gap finding (one to three `{source, question}` yes or no checks); they are sent only when Tellagen lists `question_checks_v1`.

### Changed

- The vendored contract bundle moved to `2026-11-15.2`.

## 0.5.1 - 2026-11-13

### Added

- Tellagen now sends the Grafana and GitHub addresses of the workspace as `source_bases` in the pickup answer and in the context read of a run. The server remembers them with the run (also after a restart and with `tellagen_resume`), so a finding gets a Grafana Explore link with no `GRAFANA_URL` in the environment.
- `tellagen_probe_datasource` lists the addresses it knows for a Grafana datasource as `addresses[]`, each with its `source` (`pickup`, `GRAFANA_URL` or `datasource`), and marks the one it called with `used` and shows with `token_sent` whether the token went to it. The service account token is sent only to `GRAFANA_URL`; with only an address from Tellagen the probe calls `/api/health` with no token and says so. A `GRAFANA_URL` that is not an http or https address is reported as an error. An address from the pickup makes `GRAFANA_URL` optional in the check of required variables.

### Changed

- `tellagen_build_source_link` chooses the Grafana address in this order: the pickup `source_bases`, then `GRAFANA_URL`, then the `base_url` of the Tellagen datasource. `GRAFANA_URL` is now optional: it is used when Tellagen sends no Grafana address, or several and none is picked. With several Grafana addresses in the pickup, pass `connector` with the name of one; without it the next source decides. A GitHub link uses the GitHub address of the pickup when the repository belongs to it; `github_url` still wins.
- Only http and https addresses are used. Credentials, query and fragment are removed from an address, and a copyable command or a file path is never turned into a link.
- With a Tellagen that sends no `source_bases`, nothing changes: the order is `GRAFANA_URL`, then the datasource.
- The guide and the README describe the order and no longer ask for `GRAFANA_URL` as a setup step.
- In the registry file `server.json`, `TELLAGEN_API_KEY` and `TELLAGEN_API_URL` are no longer marked as required. Signing in with the browser is the normal way, and the key and the address are optional (they win over a sign-in when set).

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
