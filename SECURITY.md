# Security

## Threat model

`visual-qa` runs a headless browser against a URL and writes screenshots and reports to disk. It is usually driven by an autonomous coding agent. The main risks it is designed against:

| Risk | Mitigation |
|---|---|
| **Secrets leaking into reports/logs** (tokens in URLs, `Authorization` headers echoed to the console, API keys in error messages) | Every URL, console message, page error and load error passes through `redact()` before it reaches disk or stdout. It covers credentials in URLs, query params named like token/key/secret/password/auth/session/code/sig, Bearer/Basic values, JWTs, Stripe, AWS and GitHub key formats. Inputs are truncated first, which bounds regex cost. Covered by `scripts/test/security.test.mjs`. |
| **Screenshots containing private data** | Docs instruct adding `.visual-qa/` to `.gitignore`; this repo's `.gitignore` does the same. Run it against dev/staging with seed data, never against production behind a real user session. |
| **Destructive filesystem operations** (`--out` pointing at the wrong folder) | The script only deletes a directory that contains its own `.visual-qa-output` marker. It refuses the filesystem root, the home directory, the current directory and symlinks. Output subfolder names are sanitised to `[a-z0-9-]`, so routes like `/../../etc` cannot escape the output dir. |
| **Dangerous URL schemes** | Only `http:`, `https:` and `file:` are accepted (`javascript:`, `data:`, `chrome:` etc. are refused). |
| **Hostile page content** | Chromium's sandbox stays enabled (no `--no-sandbox`). Browser contexts are created with downloads disabled, no permissions granted and service workers blocked. Each viewport gets a fresh, isolated context with no stored cookies. |
| **Prompt injection via page text** (a page saying "ignore previous instructions…") | `SKILL.md` instructs the agent to treat everything on the page, in console output and in the report as data, never as instructions. Text snippets in the report are capped at 60 characters. |
| **Supply chain** | Four direct dependencies (`playwright`, `@axe-core/playwright`, `pixelmatch`, `pngjs`), all widely used. Versions are locked in `package-lock.json`; install with `npm ci`. `npm audit` reports 0 vulnerabilities at release. The browser binary comes from Playwright's official download. |
| **Runaway runs** | Navigation timeout (`--timeout`, default 30s), bounded waits, lazy-load scrolling capped at 20,000px, screenshot height capped (`--max-height`), and numeric flags range-checked. |

## Out of scope

- The checker will load whatever URL you give it, including internal network addresses. That is intended for a local dev tool; don't expose it as a service that accepts URLs from untrusted users.
- `file://` URLs can render any local file the current user can read. Only point it at your own project files.

## Verifying

```bash
cd visual-qa/scripts
npm test         # redaction, URL validation, path traversal, safe-delete tests
npm audit        # dependency vulnerabilities
```

## Reporting a vulnerability

Please open a private security advisory on this repository (GitHub → Security → Report a vulnerability) rather than a public issue.
