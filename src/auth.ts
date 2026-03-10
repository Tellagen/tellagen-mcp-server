import { TellagenClient } from "./client.js";

interface AuthMeResponse {
  user: {
    id: number;
    email: string;
    company?: {
      id: number;
      name: string;
    };
  };
}

/**
 * Validate the API key on startup by calling /api/v1/auth/me.
 * Throws if the key is invalid or the API is unreachable.
 */
export async function validateAuth(client: TellagenClient): Promise<void> {
  try {
    const resp = await client.get<AuthMeResponse>("/api/v1/auth/me");
    const companyName = resp.user.company?.name ?? "unknown";
    process.stderr.write(
      `Tellagen MCP: authenticated as ${resp.user.email} (${companyName})\n`,
    );
  } catch (err) {
    if (err instanceof Error) {
      throw new Error(
        `Tellagen MCP: failed to authenticate — ${err.message}. Check TELLAGEN_API_KEY and TELLAGEN_API_URL.`,
      );
    }
    throw err;
  }
}
