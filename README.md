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
- [Brave Leo: Search & Answer Proxy (`BraveSearchAPI.js`)](#brave-leo-search--answer-proxy-bravesearchapijs)
- [Methodology](#methodology)
- [Contributing / Updates](#contributing--updates)
- [Notes & Safety](#notes--safety)

---

## Services

| Service | Artifacts | Status | Summary |
|---|---|---:|---|
| **Brave Leo / Answer with AI** | [`AI/BraveLeo/DOCS.md`](AI/BraveLeo/DOCS.md) · [`AI/BraveLeo/BraveSearchAPI.js`](AI/BraveLeo/BraveSearchAPI.js) | ✅ Captured | Brave Search `chatllm` / `with_ask` streaming answer protocol + agent/tool-calling proxy (SSE/tap events: text, usage, follow-ups, enrichments/citations). |
| **ChatGPT (unauth-mweb)** | [`AI/ChatGPT/DOCS.md`](AI/ChatGPT/DOCS.md) | ✅ Captured | Unauthenticated web flow: bootstrap/sentinel/finalize and `POST /unauth-mweb/conversation/updates` (NDJSON stream), end-to-end turn captured. |
| **Kilo AI** | [`AI/KiloAI/DOCS.md`](AI/KiloAI/DOCS.md) | 📄 Documented | Tor + anonymous keyless OpenAI-compatible gateway (`https://api.kilo.ai/api/gateway/v1`, e.g. `reflection/beam-free`) with SOCKS5/IP rotation notes. |
| **Lumo (Proton)** | [`AI/Lumo/DOCS.md`](AI/Lumo/DOCS.md) | ✅ Captured | Guest session/auth flow and `POST /api/ai/v1/chat/completions` (SSE). E2E-encrypted payloads (`encrypted:true`, `lumo.request_key`); plaintext not observable on the wire. |
| **Obscurify.ai** | [`AI/Obscurify/DOCS.md`](AI/Obscurify/DOCS.md) | ✅ Captured | Anonymous multi-model gateway: catalogs, code/tools config, and guest `POST /anon/chat/completions` (SSE with reasoning/tooling). |
| **Venice.ai** | [`AI/VeniceAI/DOCS.md`](AI/VeniceAI/DOCS.md) | ⚠️ Partial | `outerface.venice.ai` agent flow observed (client attestation mint, rate-limits, inference contract). Completion stream not captured due to `webdriver:true` attestation in automation. |

**Legend:** ✅ end-to-end interaction captured · ⚠️ partial/protocol observed with blockers · 📄 technical/method documentation

---

## Repository Structure

```text
.
├── README.md
└── AI/
    ├── BraveLeo/
    │   ├── DOCS.md              # Reverse-engineering notes (protocol, flow, events, gaps)
    │   └── BraveSearchAPI.js    # Agent/tool-calling search & answer proxy
    ├── ChatGPT/
    │   └── DOCS.md
    ├── KiloAI/
    │   └── DOCS.md
    ├── Lumo/
    │   └── DOCS.md
    ├── Obscurify/
    │   └── DOCS.md
    └── VeniceAI/
        └── DOCS.md
```

Service documentation typically includes:
- **Context:** target, date, capture method, and status
- **Flow:** observed architecture and request sequence
- **Contract:** endpoints, headers, and request/response schemas
- **Streaming:** event/frame formats and examples (where applicable)
- **Gaps:** limitations, blockers, and next steps

---

## Brave Leo: Search & Answer Proxy (`BraveSearchAPI.js`)

[`AI/BraveLeo/BraveSearchAPI.js`](AI/BraveLeo/BraveSearchAPI.js) is an agent/tool-calling friendly proxy for **Brave Leo / "Answer with AI"** (`search.brave.com` chatllm), built from the observed protocol in [`AI/BraveLeo/DOCS.md`](AI/BraveLeo/DOCS.md).

### Observed protocol (summary)

- **Endpoint:** `GET https://search.brave.com/api/chatllm/with_ask?conversation=<id>&enable_inline_entities=true`
- **Response:** `text/event-stream` (`x-stream-format: tap`, line-delimited JSON events)
- **Events:** `text_start` → `text_delta*` → `text_stop` → `usage` → `followups` → `enrichments` (answer, references/URLs/entities/context when available)

### Capabilities

- **Streaming & parsing:** incremental stream consumption with live `onEvent` callbacks and buffered fallback; tolerant TAP/NDJSON-style parsing.
- **Agent-friendly results:** normalized output with `answer`, `citations` (deduped URLs/titles/snippets), `sources`, `followups`, `usage`, and formatted `content`; compact LLM payloads and `formatResultAsText`.
- **Tool-calling integration:** OpenAI/Anthropic-style tool schemas (`BRAVE_LEO_TOOL`, `BRAVE_LEO_TOOLS`, `BRAVE_LEO_TOOL_ANTHROPIC`), `executeToolCall`/`normalizeToolArgs`/`toToolResultMessage`, and `TOOL_SYSTEM_HINT`.
- **Session & state:** `CookieJar` and stateful `BraveLeoClient` (cookie/header/auth management, export/import, shared defaults) for environments where session continuity is needed.
- **Reliability:** structured `BraveLeoError` + `ERROR_CODES`, timeout handling, retries with exponential backoff/jitter, `Retry-After`/rate-limit awareness, and partial-result preservation on stream failures.
- **Usage tracking:** `UsageTracker` for aggregated prompt/completion/reasoning token accounting across requests.
- **Conversation handling:** direct streaming when a known `conversation` id is provided; best-effort `conversation` resolution from Brave Search pages for a query (heuristic — initiation flow was not fully isolated in capture).
- **CLI:** query or `--conversation` mode with `--stream`, `--json`, `--compact`, `--cookies`, `--timeout`, `--retries`, etc.

### Quick usage

**CLI**
```bash
node AI/BraveLeo/BraveSearchAPI.js "latest Node.js LTS version"
node AI/BraveLeo/BraveSearchAPI.js "what is brave leo" --stream --json
node AI/BraveLeo/BraveSearchAPI.js --conversation <conversation_id> --json
```

**Programmatic (ESM)**
```js
import {
  braveLeoSearch,
  BraveLeoClient,
  BRAVE_LEO_TOOLS,
  executeToolCall,
} from "./AI/BraveLeo/BraveSearchAPI.js";

// Direct call (requires a resolvable/provided conversation context)
const res = await braveLeoSearch({ query: "latest Node.js LTS version", retries: 2, timeoutMs: 30000 });
console.log(res.ok, res.answer, res.citations, res.usage);

// Stateful client (session/cookies + usage tracking)
const client = new BraveLeoClient({ retries: 2, timeoutMs: 30000 });
// client.setCookies("..."); // if you have browser/session cookies
const out = await client.ask({ query: "what is brave leo" });

// Tool-call dispatch (agent frameworks)
const toolResult = await executeToolCall(
  { function: { name: "brave_leo_search", arguments: JSON.stringify({ query: "latest Node.js LTS version" }) } },
  { asObject: true }
);
```

> [!NOTE]
> Conversation creation/initiation was not fully captured; providing a known `conversation` id is the most reliable path. Best-effort resolution may depend on cookies, geo, and Brave's current UI/anti-bot behavior.

---

## Methodology

- **Live capture:** Chromium-based automated sessions with network inspection (requests, responses, headers, and bodies where available).
- **Documentation-first:** findings consolidated into per-service Markdown docs; transient capture artifacts (scripts, logs, HAR/JSONL, HTML) are intentionally not committed.
- **Best-effort & scoped:** results reflect what was observable at capture time (auth state, geo/tier, anti-bot/attestation, client/runtime constraints). Blockers and gaps are documented explicitly rather than inferred.

---

## Contributing / Updates

- Keep contributions focused and clean: one service per directory under `AI/<Service>/`.
- Prefer a structured `DOCS.md` (overview/context, flow, endpoints/contract, streaming, gaps/limitations).
- Commit derived tooling (proxies/parsers) only when it is clearly based on documented observations and includes appropriate caveats.
- When behavior changes upstream, update docs/code to reflect observed reality and note capture date/status.

---

## Notes & Safety

- Treat captured identifiers, tokens, cookies, nonces, and sample payloads as **session-specific and sensitive** — do not commit secrets.
- Expect drift: providers frequently change builds, endpoints, headers, models, and protections.
- This repository is **not** an official client or affiliation with any listed service/provider.
