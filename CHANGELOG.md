# Changelog

All notable changes to the tooling in this repository. Documentation-only
additions for other services are noted under "Docs".

## [0.3.0] — 2026-11-14

### Shared provider toolkit

- Added `lib/` with provider-agnostic, zero-dependency helpers used by all new clients:
  - `lib/errors.js` — `ApiError` (provider-scoped), status classification, `withRetry`/`withTimeout`/backoff, abort handling.
  - `lib/http.js` — header merging, `CookieJar`, bounded body reads, `requestText`/`requestJson`/`requestResponse`.
  - `lib/stream.js` — `SseParser`/`iterateFrames` for SSE, NDJSON and bare JSON lines with idle timeout and `[DONE]` handling.
  - `lib/proxy.js` — SOCKS5/`socks5h` and HTTP-CONNECT tunneling, `createProxyFetch` (Node fetch has no SOCKS support), and Tor control-port `SIGNAL NEWNYM`.
  - `lib/openai.js` — OpenAI-style `chat.completion[.chunk]` delta/usage extraction.
  - `lib/cli.js` — stdin, `role=text` messages, numeric/JSON arg parsing, live delta printing, output routing, exit codes.

### Provider clients (new)

- **Obscurify** (`AI/Obscurify/ObscurifyAPI.js`, `src/*`): guest keyless `POST /anon/chat/completions` (SSE) with reasoning/tool/usage parsing, `x-obscurify-thread` reuse, model/frontier/uncensored catalogs and code-mode config; CLI and offline tests.
- **Kilo AI** (`AI/KiloAI/KiloAPI.js`, `src/*`): keyless OpenAI-compatible gateway client with built-in SOCKS5 egress and Tor circuit renewal on 429/403 (`--tor`, configurable control auth); model listing, streaming/non-streaming chat, CLI and offline tests (in-process fake SOCKS5 server).
- **ChatGPT unauth-mweb** (`AI/ChatGPT/ChatGPTAPI.js`, `src/*`): `conversation/prepare` + NDJSON v2 `conversation/updates` stream decoding (control/state/content/replace/end). Browser-generated sentinel/proof/turnstile/chatRequirements tokens are explicit inputs (`tokens` / `getRequirements` hook) rather than guessed; CLI and offline tests.
- **Lumo (Proton)** (`AI/Lumo/LumoAPI.js`, `src/*`): guest session → cookie bootstrap, models/limits, encrypted SSE chat with a pluggable codec hook (`encodeContent`/`decodeText`/`requestKey`) because E2E plaintext is not observable on the wire; usage/remaining-limits collection, CLI and offline tests.
- **Venice.ai** (`AI/VeniceAI/VeniceAPI.js`, `src/*`): client-attestation mint pool (`count:5`), agent inference with `x-venice-*` headers and re-mint/retry on 401/403, tolerant raw-frame parsing (successful automated stream not captured), metadata endpoints, CLI and offline tests.

### Docs, packaging & CI

- Root `README.md` rewritten to document all provider tooling, shared `lib/`, structure, and per-provider quick start/limits.
- Added "Client" sections to `AI/Obscurify|KiloAI|ChatGPT|Lumo|VeniceAI/DOCS.md`.
- `package.json` bumped to 0.3.0 with per-provider bins/scripts; CI now syntax-checks and tests all providers and runs CLI smoke tests on Node 20/22/24.

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
