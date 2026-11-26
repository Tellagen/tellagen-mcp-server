import { describe, expect, it } from "vitest";

import { readConfig } from "../src/config.js";
import { dropUnexpandedEnv, isUnexpandedPlaceholder, unexpandedEnvLine } from "../src/env.js";

describe("an env value the client did not expand", () => {
  it("recognises a placeholder and nothing else", () => {
    for (const value of ["${TELLAGEN_API_URL:-}", "${TELLAGEN_API_URL}", " ${TELLAGEN_API_KEY:-} ", "${X:-https://a.example}", "${X-default}", "${user_config_api_url}"]) {
      expect(isUnexpandedPlaceholder(value), value).toBe(true);
    }
    for (const value of [undefined, "", "https://acme.api.tellagen.com", "tk_live_abc", "$TELLAGEN_API_URL", "https://${HOST}/api", "${A}${B}", "{TELLAGEN_API_URL}"]) {
      expect(isUnexpandedPlaceholder(value), String(value)).toBe(false);
    }
  });

  it("removes only TELLAGEN_ variables that hold a placeholder, and names them", () => {
    const env: Record<string, string | undefined> = {
      TELLAGEN_API_URL: "${TELLAGEN_API_URL:-}",
      TELLAGEN_API_KEY: "${TELLAGEN_API_KEY:-}",
      TELLAGEN_TOOLSETS: "diagnosis",
      OTHER: "${OTHER:-}",
      PATH: "/usr/bin",
    };
    expect(dropUnexpandedEnv(env)).toEqual(["TELLAGEN_API_KEY", "TELLAGEN_API_URL"]);
    expect(env).toEqual({ TELLAGEN_TOOLSETS: "diagnosis", OTHER: "${OTHER:-}", PATH: "/usr/bin" });
    expect(dropUnexpandedEnv(env)).toEqual([]);
  });

  it("leaves the server with no address, so it starts and offers the sign-in", () => {
    const env: Record<string, string | undefined> = {
      TELLAGEN_API_URL: "${TELLAGEN_API_URL:-}",
      TELLAGEN_API_KEY: "${TELLAGEN_API_KEY:-}",
    };
    dropUnexpandedEnv(env);
    const config = readConfig(env, []);
    expect(config.apiUrl).toBe("");
    expect(config.apiKey).toBe("");
  });

  it("says on one line what was ignored, and nothing when all is well", () => {
    expect(unexpandedEnvLine([])).toBe("");
    expect(unexpandedEnvLine(["TELLAGEN_API_URL"])).toBe(
      "Tellagen MCP: TELLAGEN_API_URL holds a placeholder that this client did not fill in, so it is ignored.\n",
    );
    expect(unexpandedEnvLine(["TELLAGEN_API_KEY", "TELLAGEN_API_URL"])).toBe(
      "Tellagen MCP: TELLAGEN_API_KEY, TELLAGEN_API_URL hold a placeholder that this client did not fill in, so they are ignored.\n",
    );
  });
});
