# UnoReverse

A curated collection of reverse-engineering notes for web-based AI services.  
Each entry documents observed client behavior, endpoints, request/response flows, and streaming protocols captured from live browser sessions.

> **Disclaimer:** This repository is for interoperability research, defensive understanding, and educational purposes only. Interfaces, endpoints, identifiers, and behaviors are unofficial, versioned, and subject to change. Do not use this information to violate applicable laws or terms of service.

---

## Contents

| Service | Path | Status | Notes |
|---|---|---:|---|
| **Brave Leo / Answer with AI** | [`AI/BraveLeo/DOCS.md`](AI/BraveLeo/DOCS.md) | ✅ Captured | Brave Search `chatllm` stream (`/api/chatllm/with_ask`, `text/event-stream`, `x-stream-format: tap`) with text/usage/followups/enrichments. |
| **ChatGPT (unauth-mweb)** | [`AI/ChatGPT/DOCS.md`](AI/ChatGPT/DOCS.md) | ✅ Captured | Unauthenticated web flow: bootstrap/sentinel/finalize and `POST /unauth-mweb/conversation/updates` (NDJSON stream), end-to-end turn captured. |
| **Kilo AI** | [`AI/KiloAI/DOCS.md`](AI/KiloAI/DOCS.md) | 📄 Documented | Tor + anonymous keyless OpenAI-compatible gateway (`https://api.kilo.ai/api/gateway/v1`, e.g. `reflection/beam-free`) with SOCKS5/IP rotation notes. |
| **Lumo (Proton)** | [`AI/Lumo/DOCS.md`](AI/Lumo/DOCS.md) | ✅ Captured | Guest session/auth flow and `POST /api/ai/v1/chat/completions` (SSE). E2E-encrypted payloads (`encrypted:true`, `lumo.request_key`); plaintext not observable on the wire. |
| **Obscurify.ai** | [`AI/Obscurify/DOCS.md`](AI/Obscurify/DOCS.md) | ✅ Captured | Anonymous gateway: `/v1/models`, `/frontier_models`, `/uncensored_models`, `/code_mode`, and guest `POST /anon/chat/completions` (SSE with reasoning/tooling). |
| **Venice.ai** | [`AI/VeniceAI/DOCS.md`](AI/VeniceAI/DOCS.md) | ⚠️ Partial | `outerface.venice.ai` agent flow observed (client attestation mint, rate-limits, inference contract). Chat completion/stream not captured due to `webdriver:true` attestation in automation. |

**Legend:** ✅ end-to-end interaction captured · ⚠️ partial/protocol observed with blockers · 📄 technical/method documentation

---

## Repository Structure

```text
.
└── AI/
    ├── BraveLeo/
    │   └── DOCS.md
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

Each service directory contains a single `DOCS.md` with:
- Overview and capture context (target, date, method, status)
- Architecture and observed flow
- Endpoints, headers, and request/response schemas
- Streaming/event formats (when applicable)
- Gaps, limitations, and notes

---

## Methodology

- **Live capture:** Chromium-based automated sessions with network inspection (requests, responses, headers, and bodies where available).
- **Documentation-first:** findings consolidated into per-service Markdown docs; transient capture artifacts (scripts/logs/HTML/JSONL) are not kept in the repository.
- **Best-effort & scoped:** results reflect what was observable at capture time (including auth state, geo/tier, anti-bot/attestation, and environment constraints).

---

## Notes

- Treat all captured identifiers, tokens, cookies, and sample payloads as **session-specific and sensitive**.
- Expect drift: providers frequently change builds, endpoints, headers, models, and protections.
- Contributions/updates should follow the existing style: one clean `DOCS.md` per service under `AI/<Service>/`.
