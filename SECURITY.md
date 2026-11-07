# Security policy

## Report a vulnerability

Email hello@tellagen.com with the subject "Security report". Do not open a public issue for a vulnerability.

Tell us which version you use, what you found, and the steps to repeat it. We reply as soon as we can.

## Supported versions

We fix security problems in the latest release of `@tellagen/mcp-server`. Update to the latest version before you report.

## What the server stores

The server runs on your machine. It reads `TELLAGEN_API_KEY` from the environment and sends it only to the Tellagen API address that you set in `TELLAGEN_API_URL`. It does not store the credentials that your AI client uses for other tools.
