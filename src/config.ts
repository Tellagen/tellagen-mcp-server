import { defaultStateDir } from "./run-state.js";
import { DEFAULT_TOOLSETS, parseToolsets, type ToolsetSelection } from "./tools/catalog.js";

export interface ServerConfig {
  apiKey: string;
  apiUrl: string;
  toolsets: ToolsetSelection;
  stateDir: string;
  /** A setting that was wrong and was replaced by its default, in plain words. */
  warnings: string[];
}

/**
 * Reads the settings from the environment and the command line. A missing
 * key or address is not an error here: the server still starts and each tool
 * explains the setup. `--toolsets` wins over TELLAGEN_TOOLSETS. An unknown
 * toolset does not stop the server: the default sets are used and a warning
 * says so.
 */
export function readConfig(
  env: Record<string, string | undefined> = process.env,
  argv: readonly string[] = process.argv.slice(2),
): ServerConfig {
  let toolsets = env.TELLAGEN_TOOLSETS;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--toolsets") {
      toolsets = argv[i + 1] ?? "";
      i++;
    } else if (arg.startsWith("--toolsets=")) {
      toolsets = arg.slice("--toolsets=".length);
    }
  }
  const warnings: string[] = [];
  let selection: ToolsetSelection = DEFAULT_TOOLSETS;
  try {
    selection = parseToolsets(toolsets);
  } catch (err) {
    warnings.push(
      `${err instanceof Error ? err.message : "The toolset setting is not valid."} The default toolsets (${DEFAULT_TOOLSETS.join(", ")}) are on.`,
    );
  }
  return {
    apiKey: (env.TELLAGEN_API_KEY ?? "").trim(),
    apiUrl: (env.TELLAGEN_API_URL ?? "").trim(),
    toolsets: selection,
    stateDir: (env.TELLAGEN_STATE_DIR ?? "").trim() || defaultStateDir(),
    warnings,
  };
}
