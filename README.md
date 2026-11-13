# UnoReverse

A curated collection of reverse-engineering notes for web-based AI services.  
Each entry captures observed client behavior, endpoints, request/response schemas, and streaming protocols from live browser sessions.

> **Disclaimer:** For interoperability research, defensive understanding, and educational purposes only.  
> Documented interfaces are unofficial, may be incomplete, and can change without notice. Use responsibly and in accordance with applicable laws and terms of service.

---

## Quick Navigation

- [Service Catalog](#service-catalog)
- [Service Highlights](#service-highlights)
- [Repository Structure](#repository-structure)
- [Methodology](#methodology)
- [Safety & Notes](#safety--notes)

---

## Service Catalog

| Service | Documentation | Status | Focus |
|---|---|---:|---|
| **Brave Leo / Answer with AI** | [`AI/BraveLeo/DOCS.md`](AI/BraveLeo/DOCS.md) | ✅ Captured | Agent-oriented web search & answer stream (`/api/chatllm/with_ask`) with enrichments/follow-ups |
| **ChatGPT (unauth-mweb)** | [`AI/ChatGPT/DOCS.md`](AI/ChatGPT/DOCS.md) | ✅ Captured | Unauthenticated web flow (bootstrap/sentinel/finalize) and streamed conversation updates |
| **Kilo AI** | [`AI/KiloAI/DOCS.md`](AI/KiloAI/DOCS.md) | 📄 Documented | Tor-routed, keyless OpenAI-compatible gateway access pattern and limitations |
| **Lumo (Proton)** | [`AI/Lumo/DOCS.md`](AI/Lumo/DOCS.md) | ✅ Captured | Guest session/auth, models/limits, and E2E-encrypted chat completions (SSE) |
| **Obscurify.ai** | [`AI/Obscurify/DOCS.md`](AI/Obscurify/DOCS.md) | ✅ Captured | Anonymous multi-model gateway: catalogs, code/tools config, guest chat streaming |
| **Venice.ai** | [`AI/VeniceAI/DOCS.md`](AI/VeniceAI/DOCS.md) | ⚠️ Partial | Agent web flow (attestation, rate-limits, inference contract); completion blocked by `webdriver` attestation |

**Legend:** ✅ end-to-end interaction captured · ⚠️ partial/protocol observed with blockers · 📄 technical/method documentation

---

## Service Highlights

### Brave Leo / Answer with AI — web search & answer proxy for agents
- **Endpoint:** `GET https://search.brave.com/api/chatllm/with_ask?conversation=<id>&enable_inline_entities=true`
- **Protocol:** `text/event-stream` (`x-stream-format: tap`) with ordered JSON events: `text_start` → `text_delta*` → `text_stop` → `usage` → `followups` → `enrichments`.
- **Agent/tooling value:** streamable answer generation grounded in Brave Search context, plus structured **`enrichments`** (e.g. `raw_response`, references/URLs, entities, context fields) and **`followups`** — well-suited to be wrapped behind an agent/tool-calling web-search or QA proxy.
- **Docs:** [`AI/BraveLeo/DOCS.md`](AI/BraveLeo/DOCS.md) (includes captured example, headers, flow, and gaps such as conversation initiation).

### ChatGPT (unauth-mweb)
- Unauthenticated browser flow with bootstrap/sentinel/finalize stages and streamed conversation updates via `POST /unauth-mweb/conversation/updates` (NDJSON).  
- **Docs:** [`AI/ChatGPT/DOCS.md`](AI/ChatGPT/DOCS.md)

### Kilo AI
- Keyless OpenAI-compatible gateway pattern over Tor (`SOCKS5`) with exit-IP rotation notes (e.g. `reflection/beam-free`), including setup and limits.  
- **Docs:** [`AI/KiloAI/DOCS.md`](AI/KiloAI/DOCS.md)

### Lumo (Proton)
- Guest auth/session and AI endpoints (`/api/ai/v1/models`, `/limits`, `/chat/completions` SSE). Payloads/reasoning are client-side encrypted (`encrypted:true`, `lumo.request_key`), so plaintext is not visible on the wire.  
- **Docs:** [`AI/Lumo/DOCS.md`](AI/Lumo/DOCS.md)

### Obscurify.ai
- Anonymous multi-model gateway with model/policy catalogs, code/tools mode config, and guest `POST /anon/chat/completions` streaming (reasoning + tooling-oriented request contract).  
- **Docs:** [`AI/Obscurify/DOCS.md`](AI/Obscurify/DOCS.md)

### Venice.ai
- Web agent flow against `outerface.venice.ai` (client attestation mint, rate-limits, inference request contract) observed; streamed completion not captured in automated `webdriver`-attested environment.  
- **Docs:** [`AI/VeniceAI/DOCS.md`](AI/VeniceAI/DOCS.md)

---

## Repository Structure

```text
.
├── README.md
└── AI/
    ├── BraveLeo/DOCS.md
    ├── ChatGPT/DOCS.md
    ├── KiloAI/DOCS.md
    ├── Lumo/DOCS.md
    ├── Obscurify/DOCS.md
    └── VeniceAI/DOCS.md
```

Each service document typically includes:
- **Context:** target, date, capture method, and status
- **Flow:** observed architecture and request sequence
- **Contract:** endpoints, headers, and request/response schemas
- **Streaming:** event/frame formats and examples (where applicable)
- **Gaps:** limitations, blockers, and next steps

---

## Methodology

- **Live capture:** Chromium-based automated sessions with network inspection (requests, responses, headers, and bodies where available).
- **Documentation-first:** findings consolidated into per-service Markdown docs; transient capture artifacts (scripts, logs, HAR/JSONL, HTML) are intentionally not committed.
- **Best-effort:** results depend on environment, auth/tier, geo, and anti-bot or attestation controls at capture time.

---

## Safety & Notes

- Treat captured identifiers, tokens, cookies, nonces, and sample payloads as **session-specific and sensitive**.
- Expect drift: providers frequently change builds, endpoints, headers, models, and protections.
- Keep contributions consistent: one clean, structured `DOCS.md` per service under `AI/<Service>/`.
