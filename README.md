# UnoReverse

Reverse-engineering notes and research artifacts for web-based AI services.

This repository captures observed client behavior from live browser sessions — endpoints, request/response shapes, authentication/session flows, and streaming protocols — and, where useful, provides small research proxies/utilities built from those findings.

> [!IMPORTANT]
> **Disclaimer:** This project is for interoperability research, defensive understanding, and educational purposes only.
> Documented interfaces are **unofficial**, may be incomplete, and can change without notice. Captured identifiers/tokens/cookies are session-specific. Use responsibly and in accordance with applicable laws and terms of service.

---

## Contents

- [Services](#services)
- [Repository Structure](#repository-structure)
- [Quick Start](#quick-start)
- [Brave Leo: Search & Answer Proxy](#brave-leo-search--answer-proxy)
- [Library Architecture](#library-architecture)
- [Error Codes](#error-codes)
- [Tests & CI](#tests--ci)
- [Methodology](#methodology)
- [Contributing / Updates](#contributing--updates)
- [Notes & Safety](#notes--safety)

---

## Services

| Service | Artifacts | Status | Summary |
|---|---|---:|---|
| **Brave Leo / Answer with AI** | [`AI/BraveLeo/DOCS.md`](AI/BraveLeo/DOCS.md) · [`AI/BraveLeo/BraveSearchAPI.js`](AI/BraveLeo/BraveSearchAPI.js) | ✅ Captured · 🧰 Client | Brave Search `chatllm` / `with_ask` streaming answer protocol + agent/tool-calling proxy (SSE/TAP events: text, usage, follow-ups, enrichments/citations). |
| **ChatGPT (unauth-mweb)** | [`AI/ChatGPT/DOCS.md`](AI/ChatGPT/DOCS.md) | ✅ Captured | Unauthenticated web flow: bootstrap/sentinel/finalize and `POST /unauth-mweb/conversation/updates` (NDJSON stream), end-to-end turn captured. |
| **Kilo AI** | [`AI/KiloAI/DOCS.md`](AI/KiloAI/DOCS.md) | 📄 Documented | Tor + anonymous keyless OpenAI-compatible gateway (`https://api.kilo.ai/api/gateway/v1`, e.g. `reflection/beam-free`) with SOCKS5/IP rotation notes. |
| **Lumo (Proton)** | [`AI/Lumo/DOCS.md`](AI/Lumo/DOCS.md) | ✅ Captured | Guest session/auth flow and `POST /api/ai/v1/chat/completions` (SSE). E2E-encrypted payloads (`encrypted:true`, `lumo.request_key`); plaintext not observable on the wire. |
| **Obscurify.ai** | [`AI/Obscurify/DOCS.md`](AI/Obscurify/DOCS.md) | ✅ Captured | Anonymous multi-model gateway: catalogs, code/tools config, and guest `POST /anon/chat/completions` (SSE with reasoning/tooling). |
| **Venice.ai** | [`AI/VeniceAI/DOCS.md`](AI/VeniceAI/DOCS.md) | ⚠️ Partial | `outerface.venice.ai` agent flow observed (client attestation mint, rate-limits, inference contract). Completion stream not captured due to `webdriver:true` attestation in automation. |

**Legend:** ✅ end-to-end interaction captured · ⚠️ partial/protocol observed with blockers · 📄 technical/method documentation · 🧰 derived tooling

---

## Repository Structure

```text
.
├── README.md
├── CHANGELOG.md
├── package.json                 # ESM, node --test, no dependencies
├── .github/workflows/ci.yml     # tests on Node 20 / 22 / 24
└── AI/
    ├── BraveLeo/
    │   ├── DOCS.md              # Observed protocol, interface, gaps
    │   ├── BraveSearchAPI.js    # Compatibility entry point + CLI
    │   ├── src/
    │   │   ├── constants.js     # Endpoints, headers, limits, regexes
    │   │   ├── errors.js        # Error codes, classification, retry/backoff
    │   │   ├── http.js          # Header merge, CookieJar, bounded body reads
    │   │   ├── conversation.js  # URL builders, id extraction, resolution
    │   │   ├── stream.js        # TAP/SSE parser, event reduction, citations
    │   │   ├── search.js        # with_ask execution, retries, event stream
    │   │   ├── result.js        # Full/compact/text result shaping
    │   │   ├── client.js        # Session client + usage tracker + conv cache
    │   │   ├── tools.js         # OpenAI/Anthropic tool schemas + dispatcher
    │   │   ├── cli.js           # Argument parsing and CLI main
    │   │   └── index.js         # Public exports
    │   └── test/                # node:test suite (mocked fetch, no network)
    ├── ChatGPT/DOCS.md
    ├── KiloAI/DOCS.md
    ├── Lumo/DOCS.md
    ├── Obscurify/DOCS.md
    └── VeniceAI/DOCS.md
```

Service documentation typically includes:
- **Context:** target, date, capture method, and status
- **Flow:** observed architecture and request sequence
- **Contract:** endpoints, headers, and request/response schemas
- **Streaming:** event/frame formats and examples (where applicable)
- **Gaps:** limitations, blockers, and next steps

---

## Quick Start

No dependencies — Node.js ≥ 20.11 only.

```bash
git clone https://github.com/zeroaiproject/UnoReverse.git
cd UnoReverse

npm test                 # 49 tests, mocked HTTP, offline
node AI/BraveLeo/BraveSearchAPI.js --help
```

---

## Brave Leo: Search & Answer Proxy

[`AI/BraveLeo/BraveSearchAPI.js`](AI/BraveLeo/BraveSearchAPI.js) is an agent/tool-calling friendly proxy for **Brave Leo / "Answer with AI"** (`search.brave.com` chatllm), built from the observed protocol in [`AI/BraveLeo/DOCS.md`](AI/BraveLeo/DOCS.md).

### Observed protocol (summary)

- **Endpoint:** `GET https://search.brave.com/api/chatllm/with_ask?conversation=<id>&enable_inline_entities=true`
- **Response:** `text/event-stream` (`x-stream-format: tap`, line-delimited JSON events)
- **Events:** `text_start` → `text_delta*` → `text_stop` → `usage` → `followups` → `enrichments`
- **Status codes seen without a browser session:** `403`/`429` on `/search` and `/ask` (anti-bot), `422` on `with_ask` with a missing/invalid conversation.

### CLI

```bash
# Resolve a conversation for a query, then stream the answer
node AI/BraveLeo/BraveSearchAPI.js "latest Node.js LTS version"

# Stream a known conversation id (most reliable)
node AI/BraveLeo/BraveSearchAPI.js --conversation <id> --json

# Live deltas on stdout, diagnostics on stderr
node AI/BraveLeo/BraveSearchAPI.js "what is brave leo" --stream

# Compaction for LLM/agent consumption, cookies kept out of the output
node AI/BraveLeo/BraveSearchAPI.js "node 24 breaking changes" --compact --max-sources 3

# Reuse a browser session; read the query from a file/stdin
BRAVE_COOKIES="$(cat cookies.txt)" node AI/BraveLeo/BraveSearchAPI.js - --json < query.txt
```

Exit codes: `0` success · `1` request failed · `2` usage error. Full flag reference: `--help`.

### Programmatic (ESM)

```js
import {
  braveLeoSearch,
  braveLeoEventStream,
  BraveLeoClient,
  BRAVE_LEO_TOOLS,
  executeToolCall,
  ERROR_CODES,
} from "./AI/BraveLeo/BraveSearchAPI.js";

// One-shot: resolves a conversation (heuristic) or uses the id you pass
const res = await braveLeoSearch({
  query: "latest Node.js LTS version",
  retries: 2,                 // 429/5xx/network/timeout
  timeoutMs: 30_000,          // whole request
  streamIdleTimeoutMs: 45_000 // abort if the stream stalls
});
console.log(res.ok, res.answer, res.citations, res.usage);
if (!res.ok) console.log(res.errorInfo.code, res.errorInfo.hint);

// Stateful client: cookie reuse, usage accounting, conversation cache
const client = new BraveLeoClient({ retries: 2 });
// client.setCookies("...");   // browser session improves resolution odds
const out = await client.ask({ query: "what is brave leo" });
console.log(out.answer, client.getUsage());

// Incremental consumption (aborts the request when you break out)
for await (const { event } of braveLeoEventStream(conversationId)) {
  if (event.type === "text_delta") process.stdout.write(event.delta);
}

// Tool calling for agent frameworks
const toolResult = await executeToolCall(
  { function: { name: "brave_leo_search", arguments: JSON.stringify({ query: "node lts" }) } },
  { asObject: true }
);
```

> [!NOTE]
> Conversation creation was not captured end-to-end. `braveLeoSearch({ query })` performs a best-effort resolution (`/search`, `/search?summary=1`, `/ask`) and reports **every attempt** with its status code, so a `429` is distinguishable from a wrong id. The reliable path is a known `conversation` id plus the cookies that created it.

---

## Library Architecture

The Brave Leo client is split into single-purpose modules; `BraveSearchAPI.js` stays as the historical entry point and CLI.

| Module | Responsibility |
|---|---|
| `constants.js` | Observed endpoint, header sets, timeout/size defaults, id regex |
| `errors.js` | `BraveLeoError`, stable `ERROR_CODES`, status→code mapping, jittered backoff, retry loop, abortable sleep/timeouts |
| `http.js` | Header normalization/merge, `CookieJar`, size-bounded body reads (fail closed) |
| `conversation.js` | `/search` `/ask` `/with_ask` URL builders, id extraction, resolution + attempt diagnostics, cookie redaction |
| `stream.js` | Incremental TAP/SSE parser (chunk-safe, `[DONE]`, comments, multi-line `data:`), event reduction, citation/source extraction, idle-timeout reader |
| `search.js` | Single attempt, retrying wrapper, async event generator, `braveLeoSearch` / `braveLeoSearchOrThrow` |
| `result.js` | Full result, compact LLM payload, text renderer |
| `client.js` | Session client (cookies/headers), `UsageTracker`, conversation cache, state export/import |
| `tools.js` | OpenAI + Anthropic tool schemas, argument normalization, `executeToolCall`, tool messages |
| `cli.js` | Flag parsing, stdin/cookie-file support, exit codes |

Design rules followed in this codebase:

- **Fail closed.** Oversized bodies and malformed frames throw or are surfaced as `unparsed`, never silently swallowed.
- **Partial results are explicit.** A stream that dies mid-answer returns `{ ok: false, partial: true }` with the text received so far, plus `warnings`.
- **No secret leakage.** Session cookies are dropped from results, diagnostics and `resolution` unless `includeCookies: true`.
- **Timeouts are layered.** `timeoutMs` bounds the request; `streamIdleTimeoutMs` catches a stream that opens and then stalls.
- **Retries are policy, not magic.** Only retryable codes (429/408/425/5xx/network/timeout) retry, `Retry-After` wins over backoff, and `retryOn` can veto.

---

## Error Codes

| Code | Meaning | Retryable |
|---|---|:--:|
| `INVALID_INPUT` | Missing query/conversation or bad option | no |
| `FETCH_UNAVAILABLE` | Runtime has no `fetch` | no |
| `CONVERSATION_NOT_FOUND` | Id unknown/expired, or resolution failed | no |
| `CONVERSATION_INVALID` | `with_ask` rejected the id (HTTP 422) | no |
| `BLOCKED` | HTTP 401/403 — anti-bot/attestation/geo | no |
| `RATE_LIMITED` | HTTP 429 | yes |
| `HTTP_ERROR` | Other non-2xx | 5xx/408/425 |
| `TIMEOUT` | Request or stream-stall timeout | yes |
| `ABORTED` | Caller aborted | no |
| `NETWORK_ERROR` | DNS/socket/TLS/fetch failure | yes |
| `STREAM_ERROR` | Truncated/oversized/unreadable stream | partial only |
| `PARSE_ERROR` | Reserved for strict parsing modes | no |
| `UNKNOWN_TOOL` | Tool dispatcher got an unknown name | no |
| `INTERNAL_ERROR` | Unexpected failure | no |

---

## Tests & CI

```bash
npm test          # node --test, no network, no dependencies
npm run test:watch
```

The suite (49 tests) covers stream parsing (TAP, SSE, chunk splits, `[DONE]`, garbage), citation dedupe, conversation-id extraction, resolution diagnostics, retry/`Retry-After`, `403`/`422`/timeout classification, partial + stalled streams, cookie redaction, tool-call dispatch, result compaction and CLI parsing.

CI (`.github/workflows/ci.yml`) runs the same suite on Node 20, 22 and 24.

---

## Methodology

- **Live capture:** Chromium-based automated sessions with network inspection (requests, responses, headers, and bodies where available).
- **Documentation-first:** findings consolidated into per-service Markdown docs; transient capture artifacts (scripts, logs, HAR/JSONL, HTML) are intentionally not committed.
- **Best-effort & scoped:** results reflect what was observable at capture time (auth state, geo/tier, anti-bot/attestation, client/runtime constraints). Blockers and gaps are documented explicitly rather than inferred.
- **Tested tooling:** derived clients are exercised against mocked protocol fixtures so upstream drift shows up as a failing test, not a silent regression.

---

## Contributing / Updates

- Keep contributions focused and clean: one service per directory under `AI/<Service>/`.
- Prefer a structured `DOCS.md` (overview/context, flow, endpoints/contract, streaming, gaps/limitations).
- Commit derived tooling (proxies/parsers) only when it is clearly based on documented observations and includes appropriate caveats.
- New behavior in `AI/BraveLeo/src` must ship with a `node:test` case that does not require network access.
- When behavior changes upstream, update docs/code to reflect observed reality and note capture date/status.

---

## Notes & Safety

- Treat captured identifiers, tokens, cookies, nonces, and sample payloads as **session-specific and sensitive** — do not commit secrets.
- Expect drift: providers frequently change builds, endpoints, headers, models, and protections.
- This repository is **not** an official client or affiliation with any listed service/provider.
