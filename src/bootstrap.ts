import { TellagenClient } from "./client.js";
import { type CredentialVault, openVault } from "./credentials.js";
import { SignInIndex } from "./signin-index.js";
import { expiryLine, resolveCredentials, type ResolvedCredentials } from "./signin.js";
import { defaultStateDir } from "./run-state.js";

export interface Runtime {
  client: TellagenClient;
  vault: CredentialVault;
  index: SignInIndex;
  credentials: ResolvedCredentials;
}

/**
 * Builds a client from the environment and the stored sign-in. The keychain
 * is read only when a sign-in is stored and the environment holds no key, so
 * a setup with environment variables never waits on it.
 */
export async function createRuntime(
  env: Record<string, string | undefined> = process.env,
  options: { vault?: CredentialVault; index?: SignInIndex; stateDir?: string } = {},
): Promise<Runtime> {
  const vault = options.vault ?? openVault();
  const index = options.index ?? new SignInIndex();
  const credentials = await resolveCredentials(env, vault, index);
  const client = new TellagenClient({
    apiUrl: credentials.apiUrl,
    apiKey: credentials.apiKey,
    stateDir: options.stateDir ?? ((env.TELLAGEN_STATE_DIR ?? "").trim() || defaultStateDir()),
  });
  if (credentials.problem) client.session.addPendingLine(credentials.problem);
  client.session.setNotice(expiryLine(credentials.entry));
  if (credentials.source === "sign-in" && credentials.account) {
    const account = credentials.account;
    client.session.updateSeen = (info) =>
      index.update(account, { update_available: { ...info, seen_at: new Date().toISOString() } });
  }
  return { client, vault, index, credentials };
}
