#!/usr/bin/env node
import { MCP_SERVER_VERSION } from "./version.js";

/**
 * With no command this is the MCP server on standard input and output. The
 * commands below are for a person, or for a hook of a client. They load only
 * what they need, so a hook starts fast.
 */
const COMMANDS = new Set(["login", "logout", "status", "listen", "trace-hook", "listen-wrap", "listen-guard", "help", "--help", "-h", "--version", "-v"]);

async function serve(): Promise<void> {
  const [{ StdioServerTransport }, { readConfig }, { startTellagenServer }, { createRuntime }] = await Promise.all([
    import("@modelcontextprotocol/sdk/server/stdio.js"),
    import("./config.js"),
    import("./start.js"),
    import("./bootstrap.js"),
  ]);
  const config = readConfig();
  const { client, vault, index, credentials } = await createRuntime(process.env, { stateDir: config.stateDir });
  if (!credentials.apiKey || !credentials.apiUrl) {
    // The server still starts, so the client shows it as connected and the
    // first tool call explains the setup. No value is written here.
    process.stderr.write(
      "Tellagen MCP: no sign-in and no TELLAGEN_API_KEY or TELLAGEN_API_URL. The server runs, and tellagen_sign_in or the setup steps in each tool answer explain what to do.\n",
    );
  }
  for (const warning of config.warnings) {
    process.stderr.write(`Tellagen MCP: ${warning}\n`);
    // The model also reads it, with its next tool answer.
    client.session.addPendingLine(warning);
  }
  const transport = new StdioServerTransport();
  await startTellagenServer(client, transport, { toolsets: config.toolsets, signIn: { vault, index } });
}

async function main(): Promise<void> {
  const command = process.argv[2];
  if (command && COMMANDS.has(command)) {
    if (command === "--version" || command === "-v") {
      process.stdout.write(`${MCP_SERVER_VERSION}\n`);
      return;
    }
    if (command === "listen-guard") {
      // A guard that cannot finish passes nothing: exit 2 refuses the call.
      setTimeout(() => process.exit(2), 10_000).unref();
    }
    if (command === "trace-hook") {
      // A hook must never hold a tool call. If standard input never closes, leave anyway.
      setTimeout(() => process.exit(0), 2_500).unref();
    }
    const { runCli } = await import("./cli/main.js");
    process.exitCode = await runCli(command, process.argv.slice(3));
    return;
  }
  await serve();
}

main().catch((err) => {
  process.stderr.write(`Fatal: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
