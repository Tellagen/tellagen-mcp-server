import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { TellagenClient } from "../client.js";
import { formatError } from "../errors.js";
import type { SignInManager } from "../signin.js";

import { SIGN_IN_TOOL } from "./catalog.js";

export { SIGN_IN_TOOL };

/**
 * The tool that signs the person in with the browser, so setup needs no key
 * and no workspace address. It works when nothing is set up, so it is not
 * behind the access check. The answer holds the code to show and never a key
 * or a device code.
 */
export function registerSignInTool(server: McpServer, client: TellagenClient, manager: SignInManager): void {
  server.registerTool(
    SIGN_IN_TOOL,
    {
      description:
        "Sign the person in to Tellagen with their browser, with no API key to copy. Shows a short code and opens the browser. Tell the person the code and the address, then call this tool again with wait_seconds 20 until it says signed_in. The key goes to the system keychain; it never appears in a tool answer. Call it when Tellagen says it is not set up, or when the sign-in expired. It takes no address: the server is the one the person set up.",
      inputSchema: {
        wait_seconds: z
          .number()
          .int()
          .min(0)
          .max(25)
          .optional()
          .describe("Wait up to this many seconds for the person to approve. Default 0: answer at once."),
        restart: z.boolean().optional().describe("Start a new sign-in even if one is open or the client is signed in."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async (args) => {
      try {
        const auth = client.auth();
        if (!args.restart && auth === "ok" && client.apiUrl()) {
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify({
                  status: "already_signed_in",
                  api_url: client.apiUrl(),
                  message: "This client is already signed in and Tellagen accepted its key. Call with restart true to sign in again.",
                }),
              },
            ],
          };
        }
        const view = await manager.begin({
          restart: args.restart,
          waitMs: (args.wait_seconds ?? 0) * 1000,
          // The address comes from the person's settings, never from this call.
        });
        return { content: [{ type: "text" as const, text: JSON.stringify(view) }], isError: view.status === "failed" };
      } catch (err) {
        return { content: [{ type: "text" as const, text: formatError(err) }], isError: true };
      }
    },
  );
}
