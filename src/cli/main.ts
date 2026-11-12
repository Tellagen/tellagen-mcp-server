import { MCP_SERVER_VERSION } from "../version.js";
import { loginCommand, logoutCommand, statusCommand } from "./auth.js";
import { type CliIo, realIo } from "./io.js";

const HELP = `Tellagen MCP server ${MCP_SERVER_VERSION}

With no command it runs as an MCP server on standard input and output.

Commands
  login        Sign in with your browser. The key goes to the system keychain.
  logout       Remove the stored key from this computer.
  status       Show the sign-in. With --line: one sentence for a client hook, or nothing.
  listen       Take diagnosis runs that wait in Tellagen and run them with your AI client, with no window.
  trace-hook   Record one tool call of a client hook as a step of the open run (reads the hook event on standard input).

Settings: TELLAGEN_API_KEY and TELLAGEN_API_URL win over a stored sign-in. TELLAGEN_HOME moves the folder ~/.tellagen.
`;

/** Runs a command and returns the exit code. */
export async function runCli(command: string, args: readonly string[], io: CliIo = realIo): Promise<number> {
  switch (command) {
    case "login":
      return loginCommand(args, io);
    case "logout":
      return logoutCommand(args, io);
    case "status":
      return statusCommand(args, io);
    case "listen": {
      const { listenCommand } = await import("./listen.js");
      return listenCommand(args, io);
    }
    case "listen-guard": {
      const { listenGuardCommand } = await import("./listen-guard.js");
      return listenGuardCommand(args, io);
    }
    case "listen-wrap": {
      // Internal: the listener starts every client through it.
      const { parseWrapArgs, runWrapped } = await import("../listen-wrap.js");
      const parsed = parseWrapArgs(args);
      if (!parsed) {
        io.stderr("listen-wrap is started by the listener.\n");
        return 2;
      }
      return runWrapped(parsed);
    }
    case "trace-hook": {
      const { traceHookCommand } = await import("./trace-hook.js");
      return traceHookCommand(args, io);
    }
    default:
      io.stdout(HELP);
      return 0;
  }
}
