#!/usr/bin/env node
// Starts the built server with no key, as a client would, and checks that it
// connects, lists its tools and answers a tool call with the setup steps.
// Run `npm run build` first.
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const env = { ...process.env };
delete env.TELLAGEN_API_KEY;
delete env.TELLAGEN_API_URL;
delete env.TELLAGEN_TOOLSETS;

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [join(root, "dist", "index.js")],
  env,
  stderr: "ignore",
});
const client = new Client({ name: "smoke-test", version: "1.0.0" });

function fail(message) {
  process.stderr.write(`smoke test failed: ${message}\n`);
  process.exit(1);
}

try {
  await client.connect(transport);
  const tools = (await client.listTools()).tools;
  if (tools.length < 20) fail(`only ${tools.length} tools are listed`);
  if (!tools.some((tool) => tool.name === "tellagen_pick_up_investigation")) fail("the pickup tool is not listed");
  const result = await client.callTool({ name: "tellagen_list_incidents", arguments: {} });
  const text = result.content?.[0]?.text ?? "";
  if (!result.isError || !text.includes("tellagen_not_set_up")) fail("a tool call with no key did not answer with the setup steps");
  const words = (client.getInstructions() ?? "").trim().split(/\s+/).length;
  if (words > 600) fail(`the instructions have ${words} words`);
  process.stdout.write(`ok: ${tools.length} tools, ${words} instruction words, setup steps on a call with no key\n`);
} catch (err) {
  fail(err instanceof Error ? err.message : String(err));
} finally {
  await client.close().catch(() => undefined);
}

// The sign-in command of the built server, against a fake Tellagen on this
// computer. It checks that `login` waits for the approval and stores a key,
// that `status --line` is quiet or one line, and that `logout` clears it.
async function checkSignIn() {
  let polls = 0;
  const fake = createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      res.setHeader("content-type", "application/json");
      const origin = `http://127.0.0.1:${fake.address().port}`;
      if (req.url.endsWith("/device/start")) {
        res.end(JSON.stringify({ device_code: `tgdc_${"x".repeat(43)}`, user_code: "ABCD-1234", verification_uri: `${origin}/connect`, verification_uri_complete: `${origin}/connect?code=ABCD-1234`, expires_in: 600, interval: 1 }));
      } else if (req.url.endsWith("/device/token")) {
        polls += 1;
        res.end(JSON.stringify(polls < 2 ? { status: "authorization_pending", interval: 1 } : { status: "approved", api_key: "tgn_SmokeTestKey_0123456789abcdef", api_base_url: origin, key: { expires_at: "2099-01-01T00:00:00Z" }, workspace: { name: "Smoke" } }));
      } else {
        res.statusCode = 404;
        res.end("{}");
      }
    });
  });
  await new Promise((resolve) => fake.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${fake.address().port}`;
  const home = mkdtempSync(join(tmpdir(), "tellagen-smoke-"));
  // The key file in the temporary home, never the real keychain of whoever runs this.
  const cliEnv = { ...env, TELLAGEN_HOME: home, TELLAGEN_STATE_DIR: join(home, "state"), TELLAGEN_CREDENTIAL_STORE: "file" };
  const cli = (args) =>
    new Promise((resolve) => {
      const child = spawn(process.execPath, [join(root, "dist", "index.js"), ...args], { env: cliEnv, stdio: ["ignore", "pipe", "pipe"] });
      let out = "";
      child.stdout.on("data", (c) => (out += c));
      child.stderr.on("data", (c) => (out += c));
      child.on("close", (code) => resolve({ code, out }));
    });
  try {
    const login = await cli(["login", "--url", origin, "--no-browser"]);
    if (login.code !== 0 || !login.out.includes("ABCD-1234") || !login.out.includes("Signed in")) fail(`login did not finish: ${login.out.slice(0, 300)}`);
    if (login.out.includes("tgn_SmokeTestKey")) fail("login printed the key");
    const line = await cli(["status", "--line"]);
    if (line.code !== 0 || line.out.trim().split("\n").length > 1) fail("status --line is not quiet or one line");
    const out = await cli(["logout", "--all"]);
    if (out.code !== 0 || !out.out.includes("Signed out")) fail(`logout failed: ${out.out.slice(0, 300)}`);
    const after = await cli(["status", "--json"]);
    if (!after.out.includes('"signed_in": false')) fail("still signed in after logout");
  } finally {
    fake.close();
    rmSync(home, { recursive: true, force: true });
  }
  process.stdout.write("ok: login, status --line and logout against a fake Tellagen\n");
}
await checkSignIn();
