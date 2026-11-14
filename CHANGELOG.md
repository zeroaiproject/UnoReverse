# Changelog

All notable changes to the tooling in this repository. Documentation-only
additions for other services are noted under "Docs".

## [0.2.0] — 2026-11-14

### Brave Leo client — structure

- Split the 1,700-line `AI/BraveLeo/BraveSearchAPI.js` into focused ESM modules
  under `AI/BraveLeo/src/` (`constants`, `errors`, `http`, `conversation`,
  `stream`, `search`, `result`, `client`, `tools`, `cli`, `index`).
- `AI/BraveLeo/BraveSearchAPI.js` remains the entry point: same import path,
  same named exports, same CLI. A `default` namespace export is available.
- Added `package.json` (ESM, no dependencies) and `npm test`.

### Brave Leo client — fixes

- **Partial results were discarded.** `buildAgentResult` dropped answer/usage/
  sources when `ok === false`, so a stream that died mid-answer returned empty
  text even with `allowPartial: true`.
- **Idle timeout never fired.** The timeout handler cancelled the reader before
  rejecting, so `reader.cancel()` resolved the pending read and won the race —
  a stalled stream looked like a clean EOF. It now rejects first, then releases
  the reader.
- **Cookies leaked into results.** `meta.cookies`, `resolution.cookies` and
  `errorInfo.details.cookies` exposed the session cookie header. They are now
  omitted unless `includeCookies: true`.
- **Client `stream()` options clobbered merged headers.** `...opts` was spread
  after computed headers; defaults are now applied first.
- **Abort listener leak in `sleep()`** on every retry.
- **Conversation stream aborts on early exit.** Breaking out of
  `braveLeoEventStream` now cancels the request instead of leaking it.
- Resolution errors now report the real cause (403/429 anti-bot vs. unknown id)
  instead of a generic "could not resolve".

### Brave Leo client — features

- Incremental TAP **and** SSE parser (comments, `event:`, multi-line `data:`,
  `[DONE]`, chunk-boundary safety, oversized-line guard).
- `streamIdleTimeoutMs`, `maxResponseBytes` (fail-closed), `retryOn`,
  `answerSource`, `warnings[]`, and per-attempt `resolution.attempts[]`.
- `BraveLeoClient` conversation cache + `exportState()/importState()` now
  includes cached conversations.
- CLI: `--version`, `--text`, `--query`, `--cookie-file`, `--out`,
  `--idle-timeout`, `--retry-delay`, `--max-sources`, `--show-cookies`,
  `--quiet`, stdin query (`-`), documented exit codes (0/1/2), env defaults
  (`BRAVE_CONVERSATION`, `BRAVE_COOKIES`, `BRAVE_TIMEOUT_MS`,
  `BRAVE_LEO_DEBUG`).
- Error taxonomy extended with `BLOCKED` (401/403) and `CONVERSATION_INVALID`
  (422), each carrying a `hint`.

### Tests & CI

- 49 `node:test` cases with a mocked `fetch` (no network): parsing, citation
  dedupe, resolution diagnostics, retry/`Retry-After`, 403/422/timeout
  classification, partial + stalled streams, redaction, tool dispatch,
  compaction, CLI parsing.
- GitHub Actions workflow running the suite on Node 20, 22 and 24.

### Docs

- Root `README.md`: service table, module map, quick start, CLI reference,
  error-code table, testing instructions.
- `AI/BraveLeo/DOCS.md`: client-library section, option table, v0.2 behavior
  guarantees, 2026-11-14 endpoint probe matrix, corrected conversation-id shape
  (observed ids are 38 hex chars, not 32), rewritten gaps.

## Earlier

- `9ad35b2`…`ab60d84` — Brave Leo proxy iterations (streaming, sessions,
  citations, retries) and README updates.
- `4dace9e` — Meta AI reverse-engineering notes (later superseded).
