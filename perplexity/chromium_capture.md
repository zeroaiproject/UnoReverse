# Chromium Capture Attempt

**Date:** 2026-11-13  
**Goal:** Reverse Perplexity web API by driving Chromium, passing Cloudflare, triggering a query, and capturing network traffic (especially `/rest/sse/perplexity_ask`, `/api/*`, Socket.IO).

## Environment & tooling

- Browser: Playwright-bundled Chromium 1254 (`/root/.cache/ms-playwright/chromium-1254/chrome-linux64/chrome`)
- Automation: `puppeteer` / `puppeteer-extra@3.3.6` + `puppeteer-extra-plugin-stealth` (from `/opt/latvi/node_modules`)
- Display: headless (`new`) and headed via `xvfb-run -a`
- Scripts:
  - `capture_browser.mjs` — baseline Puppeteer capture
  - `capture_stealth.mjs` — puppeteer-extra + stealth, xvfb headed, polling for challenge clearance, attempts to submit a query

## Run results

| Run | Mode | Outcome |
|---|---|---|
| `capture_browser.mjs` | headless | Landed on Cloudflare interstitial (`title: "Just a moment..."`), no search input, no API requests captured |
| `capture_stealth.mjs` | headed (xvfb) + stealth | Remained on Cloudflare managed challenge/Turnstile for full poll window (~60s) and after; `title: "Just a moment..."`, no query submitted, no Perplexity app/API requests captured |

## Artifacts

- `home_snapshot.html`, `home_stealth.html`, `after_query.html` — Cloudflare challenge page DOM (`cf-mitigated` interstitial, Turnstile widget, `challenges.cloudflare.com` orchestrator scripts)
- `home_stealth.png` — screenshot of challenge page
- `network_capture.jsonl`, `network_capture_stealth.jsonl` — navigation/poll logs (no `/rest/sse/perplexity_ask` or app API traffic observed)
- Scripts above for reproducibility

## Blocker

`www.perplexity.ai` is protected by Cloudflare bot management/Turnstile. In this automated/headless/server context the challenge did not clear, so the SPA and its authenticated/anonymous query endpoints were never reached. Static asset paths probed directly (e.g. guessed `_next/static` paths, `pplx-next-static-public.perplexity.ai`) returned 404/unchallenged misses without revealing bundle hashes.

## How to complete the capture (manual/browser-session)

1. Use a **real, non-automated browser session** (local Chrome/Chromium with a normal profile, not driven by automation flags detectable by CF).
2. Open DevTools → **Network**, preserve log, filter `perplexity_ask` / `sse` / `rest` / `socket.io` / `api`.
3. Submit a query; export **HAR** (with content) and copy the `perplexity_ask` request as cURL/fetch.
4. In **Sources**, locate `_next/static/chunks/*.js`, save/pretty-print, and trace: request builder, schema/version constants, SSE reducer/state machine.
5. Repeat for modes/focuses (`internet`, `scholar`, `writing`, follow-ups, attachments, logged-in vs anonymous) to diff payloads and gating.
6. Redact cookies/tokens before sharing artifacts.

## Next automation options (if permitted)

- Drive an existing user Chrome profile via remote debugging (`--remote-debugging-port`) from a desktop session that can pass Turnstile.
- Use a residential/interactive environment where Turnstile can be satisfied (with user interaction) rather than fully headless automation.
- Capture traffic via an intercepting proxy (e.g. mitmproxy) attached to a manually-operated browser.
