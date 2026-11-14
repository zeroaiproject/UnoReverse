# UnoReverse

Reverse-engineering notes and research tooling for web-based AI services.

This repository captures observed client behavior from live browser sessions — endpoints, request/response shapes, authentication/session flows, and streaming protocols — and provides **zero-dependency Node.js clients/CLIs** built from those findings (offline-tested with mocked `fetch`, no network).

> [!IMPORTANT]
> **Disclaimer:** This project is for interoperability research, defensive understanding, and educational purposes only. Documented interfaces are **unofficial**, may be incomplete, and can change without notice. Captured identifiers/tokens/cookies are session-specific. Use responsibly and in accordance with applicable laws and terms of service.

---

## Contents

- [Services & Tooling](#services--tooling)
- [Repository Structure](#repository-structure)
- [Quick Start](#quick-start)
- [Shared Library (`lib/`)](#shared-library-lib)
- [Providers](#providers)
  - [Brave Leo](#brave-leo)
  - [Obscurify](#obscurify)
  - [Kilo AI](#kilo-ai)
  - [ChatGPT (unauth-mweb)](#chatgpt-unauth-mweb)
  - [Lumo (Proton)](#lumo-proton)
  - [Venice.ai](#veniceai)
- [Tests & CI](#tests--ci)
- [Methodology](#methodology)
- [Notes & Safety](#notes--safety)

---

## Services & Tooling

| Service | Status | Tooling | Summary |
|---|---:|---|---|
| **Brave Leo / Answer with AI** | ✅ + 🧰 | [`BraveLeo/BraveSearchAPI.js`](AI/BraveLeo/BraveSearchAPI.js) | `search.brave.com` chatllm `with_ask` stream (TAP/SSE): text, usage, follow-ups, enrichments/citations, retries, session/usage, tool schemas. |
| **Obscurify.ai** | ✅ + 🧰 | [`Obscurify/ObscurifyAPI.js`](AI/Obscurify/ObscurifyAPI.js) | Guest anonymous gateway: model/frontier/uncensored catalogs, code-mode config, `POST /anon/chat/completions` SSE with reasoning, usage and thread reuse. |
| **Kilo AI** | 📄 + 🧰 | [`KiloAI/KiloAPI.js`](AI/KiloAI/KiloAPI.js) | Keyless OpenAI-compatible gateway with built-in SOCKS5/HTTP-CONNECT egress and Tor `SIGNAL NEWNYM` rotation on 429/403. |
| **ChatGPT (unauth-mweb)** | ✅ + 🧰 | [`ChatGPT/ChatGPTAPI.js`](AI/ChatGPT/ChatGPTAPI.js) | Prepare + NDJSON v2 `conversation/updates` stream; sentinel/proof/turnstile tokens supplied via hook/flags (browser-generated, not reverse-engineered). |
| **Lumo (Proton)** | ✅ + 🧰 | [`Lumo/LumoAPI.js`](AI/Lumo/LumoAPI.js) | Guest session/cookie bootstrap, models/limits, encrypted SSE completions with a pluggable codec hook (`lumo.request_key` / E2E plaintext not on-wire). |
| **Venice.ai** | ⚠️ + 🧰 | [`VeniceAI/VeniceAPI.js`](AI/VeniceAI/VeniceAPI.js) | Client-attestation mint pool + agent inference with re-mint/retry; tolerant parser preserves raw frames (successful stream not captured in automation). |

**Legend:** ✅ end-to-end captured · ⚠️ partial/protocol observed with blockers · 📄 documented · 🧰 derived tooling

---

## Repository Structure

```text
.
├── README.md
├── CHANGELOG.md
├── package.json                 # ESM, node --test, no dependencies
├── .github/workflows/ci.yml     # syntax + tests + CLI smoke on Node 20 / 22 / 24
├── lib/                         # Shared provider-agnostic toolkit
│   ├── errors.js                # ApiError, codes, classification, retry/backoff
│   ├── http.js                  # headers, CookieJar, bounded reads, request helpers
│   ├── stream.js                # SSE/NDJSON/bare-JSON frame iterator + idle timeout
│   ├── proxy.js                 # SOCKS5/HTTP-CONNECT fetch transport, Tor NEWNYM
│   ├── openai.js                # chat.completion[.chunk] delta/usage extraction
│   ├── cli.js                   # argv/stdin/message/output/exit helpers
│   └── index.js                 # public re-exports
└── AI/
    ├── BraveLeo/                # DOCS + BraveSearchAPI.js + src/* + test/*
    ├── Obscurify/               # DOCS + ObscurifyAPI.js + src/* + test/*
    ├── KiloAI/                  # DOCS + KiloAPI.js + src/* + test/*
    ├── ChatGPT/                 # DOCS + ChatGPTAPI.js + src/* + test/*
    ├── Lumo/                    # DOCS + LumoAPI.js + src/* + test/*
    └── VeniceAI/                # DOCS + VeniceAPI.js + src/* + test/*
```

Each provider keeps its observed protocol in `DOCS.md` and a compatibility entry point (`<Name>API.js`) that re-exports `src/` and runs the CLI when executed directly. Brave Leo retains its original internal modules for compatibility; the other providers are built on `lib/`.

---

## Quick Start

No dependencies — Node.js ≥ 20.11 only.

```bash
git clone https://github.com/zeroaiproject/UnoReverse.git
cd UnoReverse

npm test                 # all provider suites, mocked HTTP, offline
npm run check            # syntax-check entry points
```

```bash
node AI/BraveLeo/BraveSearchAPI.js --help
node AI/Obscurify/ObscurifyAPI.js "Reply with exactly: PONG" --stream
node AI/KiloAI/KiloAPI.js "Explain how you work" --tor --retries 2
node AI/Lumo/LumoAPI.js --models
node AI/VeniceAI/VeniceAPI.js --models
```

---

## Shared Library (`lib/`)

- **`errors.js`** — `ApiError` with `provider/code/status/retryable/retryAfterMs/hint/details`, HTTP classification, `withRetry`/`withTimeout`/backoff, abort handling.
- **`http.js`** — header merging, `CookieJar` (Set-Cookie ingestion), bounded body reads, `requestText`/`requestJson`/`requestResponse` (headers-only timeout; stream idle handled by the consumer).
- **`stream.js`** — `SseParser`/`iterateFrames` that accept SSE `data:` frames, NDJSON, and bare JSON lines with idle timeout and `[DONE]` handling.
- **`proxy.js`** — zero-dependency `socks5`/`socks5h`/HTTP-CONNECT tunneling, a `createProxyFetch` adapter for Node, and `torRenewIdentity` (`SIGNAL NEWNYM`).
- **`openai.js`** — extract content/reasoning/tool_calls/usage from OpenAI-style messages and streamed chunks.
- **`cli.js`** — stdin, `role=text` messages, numeric/json arg parsing, live delta printer, JSON/text output, exit codes.

All network-facing clients accept an injected `fetchImpl` and classify failures without throwing for normal API outcomes (`result.ok === false` with `errorInfo`).

---

## Providers

### Brave Leo

[`AI/BraveLeo/DOCS.md`](AI/BraveLeo/DOCS.md) · [`AI/BraveLeo/BraveSearchAPI.js`](AI/BraveLeo/BraveSearchAPI.js)

Observed `GET /api/chatllm/with_ask` stream (TAP events: `text_start/delta/stop`, `usage`, `followups`, `enrichments`). Includes conversation resolution/caching, bounded streaming with idle timeout, retries, cookie/session reuse, usage accounting, OpenAI/Anthropic tool schemas, and a rich CLI.

```bash
node AI/BraveLeo/BraveSearchAPI.js "latest Node.js LTS version" --stream
node AI/BraveLeo/BraveSearchAPI.js --conversation <id> --json
```

> Datacenter egress often hits Brave anti-bot (403/429); a known `--conversation` id from a real browser session is the reliable path.

### Obscurify

[`AI/Obscurify/DOCS.md`](AI/Obscurify/DOCS.md) · [`AI/Obscurify/ObscurifyAPI.js`](AI/Obscurify/ObscurifyAPI.js)

Guest, keyless `POST /anon/chat/completions` (SSE) with model catalogs and `x-obscurify-thread` reuse. Returns answer, reasoning, tool calls, usage and finish reason.

```bash
node AI/Obscurify/ObscurifyAPI.js "Reply with exactly: PONG" --stream
node AI/Obscurify/ObscurifyAPI.js --models --kind frontier
```

### Kilo AI

[`AI/KiloAI/DOCS.md`](AI/KiloAI/DOCS.md) · [`AI/KiloAI/KiloAPI.js`](AI/KiloAI/KiloAPI.js)

Keyless OpenAI-compatible gateway. Built-in SOCKS5 egress and Tor circuit renewal to rotate IP-bound quotas.

```bash
node AI/KiloAI/KiloAPI.js "Explain how you work" --proxy socks5h://127.0.0.1:9050 --retries 2
node AI/KiloAI/KiloAPI.js "Explain how you work" --tor --retries 2
```

### ChatGPT (unauth-mweb)

[`AI/ChatGPT/DOCS.md`](AI/ChatGPT/DOCS.md) · [`AI/ChatGPT/ChatGPTAPI.js`](AI/ChatGPT/ChatGPTAPI.js)

Implements `conversation/prepare` and NDJSON v2 `conversation/updates` decoding. Sentinel `proof/turnstile/chatRequirements` tokens are browser-generated and must be provided via CLI flags or a `getRequirements` hook (the client fails with an explicit hint rather than guessing).

```bash
node AI/ChatGPT/ChatGPTAPI.js "Reply with exactly: PONG" \
  --requirements-token … --proof-token … --turnstile-token … --json
```

### Lumo (Proton)

[`AI/Lumo/DOCS.md`](AI/Lumo/DOCS.md) · [`AI/Lumo/LumoAPI.js`](AI/Lumo/LumoAPI.js)

Guest bootstrap, model/limit discovery, and encrypted SSE chat. A `codec` hook (`encodeContent`/`decodeText`/`requestKey`) is required for plaintext; without it the client operates on ciphertext and warns, since E2E plaintext is not observable on the wire.

```bash
node AI/Lumo/LumoAPI.js --models
node AI/Lumo/LumoAPI.js --limits
```

### Venice.ai

[`AI/VeniceAI/DOCS.md`](AI/VeniceAI/DOCS.md) · [`AI/VeniceAI/VeniceAPI.js`](AI/VeniceAI/VeniceAPI.js)

Mints/rotates client-attestation JWTs and posts the observed agent-inference body. Because successful automated streams were blocked (`webdriver:true`), the client is intentionally tolerant and exposes `rawFrames` for schema discovery.

```bash
node AI/VeniceAI/VeniceAPI.js "Reply with exactly: PONG" --json
node AI/VeniceAI/VeniceAPI.js --models
```

---

## Tests & CI

- **Offline, no dependencies:** `node:test` suites with mocked `fetch` (and an in-process fake SOCKS5 server for Kilo). No live network, no third-party packages.
- **Coverage focus:** request shaping, streaming/NDJSON parsing, partial-stream handling, retry/429/403 classification, token/thread/attestation mechanics, CLI arg parsing.
- **CI:** GitHub Actions runs syntax checks, the full test matrix, and CLI smoke tests on Node 20/22/24 (`.github/workflows/ci.yml`).

```bash
npm test
npm run test:brave
npm run test:obscurify
npm run test:kilo
npm run test:chatgpt
npm run test:lumo
npm run test:venice
```

---

## Methodology

- **Live capture:** Chromium-driven sessions (primarily Puppeteer) to observe network behavior, headers, payloads, and streamed frames.
- **Sanitization:** redact/avoid committing session-bound identifiers, cookies, and tokens. Document shapes, not secrets.
- **Status & reproducibility:** each write-up records target, date, capture method, and status (✅/⚠️/📄). Tooling mirrors the documented contract and stays testable offline.

## Notes & Safety

- Protocols and protections (attestation, anti-abuse, encryption) change; clients prefer explicit hooks over guesswork where a value cannot be derived.
- Treat outputs and endpoints as research artifacts: validate in controlled environments and respect applicable terms, rate limits, and laws.
- Contributions welcome: new captures, corrected schemas, additional provider clients, and hardened parsers/tests.
