# CLAUDE.md

Guidance for an agent that changes this repository: the Tellagen MCP server, published to npm as `@tellagen/mcp-server`. `README.md` has the tools, the environment variables and the release steps; this file holds what is easy to get wrong.

## Commands

- `npm ci`, then `npm run lint` (typecheck), `npm test` (vitest) and `npm run build`. CI runs the same four on Node 20 and 22, then `npm run smoke`, which starts the built server with no key.
- Run one file: `npx vitest run test/<name>.test.ts`.

## Things that move together

- **The guide.** `SKILL.md` is the one source of the guide. `src/guide-resources.ts` cuts it into the `resource://tellagen/guide/...` resources by its `## ` headings, and `src/server.ts` holds the short instructions that name them. Rename, add or remove a `## ` heading and change `guide-resources.ts` in the same commit; `test/agent-guide.test.ts` and `test/instructions.test.ts` check the result. Keep the instructions short: detail belongs in a guide part that the model reads when it reaches the step.
- **The version.** `package.json`, `package-lock.json`, `server.json` and `src/version.ts` hold the same version, and `CHANGELOG.md` starts with its section (`## <version> - Unreleased` until the release date is known). Tests keep them equal.
- **The contracts.** `contracts/runbooks` is a copy of the Tellagen contract bundle. Never edit it by hand: `npm run contracts:update -- <contracts folder of a Tellagen checkout>` copies and checks it.
- **The plugin.** `Tellagen/tellagen-plugin` pins this package in `.mcp.json` and in every command of `hooks/hooks.json`, and `Tellagen/tellagen-marketplace` holds a copy of the plugin. A new minor version here needs the pin raised in the plugin, then the copy refreshed.

## Rules

- Standard output belongs to the MCP protocol and to a hook's answer. Write notes for a person to standard error.
- A missing key or address is never fatal: the server starts and each tool explains the setup. Keep that true for every new setting.
- This repository is public. Name no internal ticket, person or private path in any file.
- Do not commit, push, tag or publish unless you are asked to. A tag `v<version>` on `master` publishes to npm.
