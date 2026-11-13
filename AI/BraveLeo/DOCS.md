# Brave Leo / Answer with AI (chatllm) — Reverse Engineering

> **Target:** Brave Search "Answer with AI" (`search.brave.com`, `chatllm` feature) — Brave's AI answer/chat integration (Leo/Brave AI).  
> **Observed endpoint:** `GET https://search.brave.com/api/chatllm/with_ask`  
> **Scope:** Unofficial web-client behavior observed via Chromium capture — search-triggered AI conversation, streaming response format, and related UI hooks.  
> **Date:** 2026-11-13 · **Method:** Chromium capture (Playwright-bundled Chromium 1254, headless) · **Status:** ✅ AI response successfully captured (`PONG`)

---

## Table of Contents

- [Overview](#overview)
- [Capture Environment](#capture-environment)
- [Observed Flow](#observed-flow)
- [Endpoints & Interface](#endpoints--interface)
  - [Conversation stream: with_ask](#1-get-apisearchbravecomapichatllmwith_ask)
  - [Feature callbacks (UI hooks)](#2-feature-callbacks-a-features-featurechatllm)
  - [Ask / follow-up navigation](#3-ask--follow-up-navigation)
- [Stream Protocol](#stream-protocol)
- [Response Enrichments & Metadata](#response-enrichments--metadata)
- [Identifiers & Correlation](#identifiers--correlation)
- [Related Surfaces](#related-surfaces)
- [Gaps & Next Steps](#gaps--next-steps)
- [Limitations & Notes](#limitations--notes)

---

## Overview

Brave Search can generate AI-powered answers ("Answer with AI", powered by Brave AI/Leo) for search queries. In the captured flow, a search query produced a conversation-backed answer streamed from `search.brave.com`'s `chatllm` API.

**Captured example (successful):**

| Item | Value |
|---|---|
| Search/query | `Reply with exactly: PONG` |
| Search page | `https://search.brave.com/search?q=Reply+with+exactly%3A+PONG&source=web` |
| Conversation page | `https://search.brave.com/search?q=Reply+with+exactly%3A+PONG&source=web&conversation=09cc2f976f305994544a43e9f83b649a8e02` |
| `conversation` | `09cc2f976f305994544a43e9f83b649a8e02` |
| Stream endpoint | `GET /api/chatllm/with_ask?conversation=09cc2f976f305994544a43e9f83b649a8e02&enable_inline_entities=true` |
| Assistant output (raw) | `**PONG**` |
| Usage (reported) | `prompt_tokens: 11177`, `completion_tokens: 4`, `reasoning_tokens: 0` |

---

## Capture Environment

| Component | Detail |
|---|---|
| Browser | `/root/.cache/ms-playwright/chromium-1254/chrome-linux64/chrome` (headless) |
| Automation | Puppeteer (Chromium-driven) |
| User-Agent | `Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36` |
| Locale | `en-US,en` |
| Viewport | `1280×900` |

> Note: `https://leo.brave.com/` was probed during capture but no load/response was captured in this run; the documented success is for the `search.brave.com` `chatllm` ("Answer with AI") flow.

---

## Observed Flow

```text
[User/search query]
        │
        ▼
https://search.brave.com/search?q=<query>&source=web
        │
        │  (Answer with AI / chatllm feature activates for the query)
        ▼
Conversation established: conversation=<id>
  - page URL gains &conversation=<id>
  - UI renders chatllm answer container
        │
        ▼
GET /api/chatllm/with_ask?conversation=<id>&enable_inline_entities=true
  Accept: application/json
  Referer: https://search.brave.com/search?q=...
        │
        └─◄ 200  content-type: text/event-stream; charset=utf-8
                 x-stream-format: tap
                 (sequence of JSON event objects, one per line)
                   text_start → text_delta* → text_stop → usage → followups → enrichments
```

The exact conversation-creation/initiation request was not isolated in the captured network log (the `conversation` ID appeared in the stream fetch and final page URL); the stream retrieval contract and payload format were fully observed.

---

## Endpoints & Interface

### 1) `GET /api/chatllm/with_ask`

Streams the AI answer for a given conversation.

**Request (observed):**
```http
GET /api/chatllm/with_ask?conversation=09cc2f976f305994544a43e9f83b649a8e02&enable_inline_entities=true HTTP/2
Host: search.brave.com
Accept: application/json
Referer: https://search.brave.com/search?q=Reply+with+exactly%3A+PONG&source=web
User-Agent: Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36
Accept-Language: en-US,en;q=0.9
Sec-Fetch-Dest: empty
Sec-Fetch-Mode: cors
Sec-Fetch-Site: same-origin
```

**Query parameters:**

| Parameter | Example | Purpose (observed/inferred) |
|---|---|---|
| `conversation` | `09cc2f976f305994544a43e9f83b649a8e02` | Conversation/session identifier for the AI answer |
| `enable_inline_entities` | `true` | Requests inline entity/enrichment data in the response |

**Response (observed):**
- **Status:** `200`
- **Content-Type:** `text/event-stream; charset=utf-8`
- **Cache-Control:** `no-store`
- **`x-stream-format`:** `tap`
- **Other headers:** `content-security-policy: sandbox`, `cross-origin-resource-policy: same-origin`, `x-content-type-options: nosniff`, `server-timing` (e.g. `search-backend-roundtrip;dur=13.628`), CDN headers (`via`, `x-amz-cf-*`)

---

### 2) Feature callbacks (`/a/features?feature=chatllm&...`)

The search page exposes `chatllm` feature callback endpoints (timestamp/nonce-protected) used by the UI, e.g.:

| Action | Path pattern (observed) |
|---|---|
| `lazy_load` | `/a/features?feature=chatllm&action=lazy_load&timestamp=...&nonce=...` |
| `show_more` | `/a/features?feature=chatllm&action=show_more&timestamp=...&nonce=...` |
| `copy_to_clipboard` | `/a/features?feature=chatllm&action=copy_to_clipboard&timestamp=...&nonce=...` |
| `share_link` | `/a/features?feature=chatllm&action=share_link&timestamp=...&nonce=...` |
| `ask_followup` | `/a/features?feature=chatllm&action=ask_followup&timestamp=...&nonce=...` |
| `close_chat` | `/a/features?feature=chatllm&action=close_chat&timestamp=...&nonce=...` |
| `open_leo` | `/a/features?feature=chatllm&action=open_leo&timestamp=...&nonce=...` |

> These were observed as page-embedded callback URLs; individual request/response payloads for these actions were not fully captured in this run.

---

### 3) Ask / follow-up navigation

UI strings and links indicate follow-up/Ask flows tied to the conversation, e.g.:
- "Answer with AI" (feature name) — *Powered by Brave AI*
- Links like `/ask?q=...&source=chatllm-elaborate&conversation=<id>&query_type=answer_with_ai_follow_up`
- OpenSearch/title hints for **Ask Brave** (`/opensearch.ask.xml`)

---

## Stream Protocol

The `with_ask` response is a **line-delimited sequence of JSON event objects** (`x-stream-format: tap`, `text/event-stream`).

### Event types (observed)

| `type` | Purpose | Key fields |
|---|---|---|
| `text_start` | Marks beginning of text generation | — |
| `text_delta` | Incremental text chunk | `delta` |
| `text_stop` | Finalized text output | `text` |
| `usage` | Token/usage accounting | `prompt_tokens`, `completion_tokens`, `reasoning_tokens` |
| `followups` | Suggested follow-up prompts | `followups[]` |
| `enrichments` | Answer metadata & grounding | `enrichments{...}` |

### Captured example (full stream)

```json
{"type":"text_start"}
{"type":"text_delta","delta":"*"}
{"type":"text_delta","delta":"*PONG**"}
{"type":"text_stop","text":"**PONG**"}
{"type":"usage","prompt_tokens":11177,"completion_tokens":4,"reasoning_tokens":0}
{"type":"followups","followups":[]}
{"type":"enrichments","enrichments":{"raw_response":"**PONG**","references":[],"urls":[],"reference_urls":[],"images":[],"qa":[],"entities":[],"main_entity":null,"main_entity_infobox":null,"predicate":null,"context":[],"context_urls":[],"context_results":[]}}
```

> Note: deltas in this short response included markdown fragments; clients should assemble/interpret `delta` chunks and/or rely on `text_stop.text` / `enrichments.raw_response` per UI behavior.

---

## Response Enrichments & Metadata

`enrichments` observed (empty/minimal for this trivial answer; structure is informative):

| Field | Example / meaning |
|---|---|
| `raw_response` | `"**PONG**"` — final answer text |
| `references`, `reference_urls`, `urls` | Source citations/links (none here) |
| `images`, `qa` | Related media/Q&A blocks (none here) |
| `entities`, `main_entity`, `main_entity_infobox`, `predicate` | Entity/knowledge signals (null/empty here) |
| `context`, `context_urls`, `context_results` | Retrieved/grounding context (none here) |

`usage`: token counts as reported by backend (`prompt_tokens`, `completion_tokens`, `reasoning_tokens`).

---

## Identifiers & Correlation

| Identifier | Where | Example |
|---|---|---|
| `conversation` | `with_ask` query param, search URL, UI links | `09cc2f976f305994544a43e9f83b649a8e02` |
| `source` | search URL | `web` |
| `q` | search/ask URL | `Reply with exactly: PONG` |
| feature callbacks | `/a/features?feature=chatllm...` | include `timestamp` + `nonce` |

---

## Related Surfaces

- **`leo.brave.com`**: probed but not successfully loaded/captured in this environment/run.
- **Brave Search Answer with AI**: UI labels/strings — "Answer with AI", "Powered by Brave AI", callbacks include `action=open_leo` and `/ask` follow-ups — indicating integration between search answers and Brave's broader Leo/AI experience.

---

## Gaps & Next Steps

- **Conversation initiation:** capture the exact request/trigger that creates the `conversation` ID and submits the prompt (search param, XHR/fetch, or feature action).
- **Follow-ups & callbacks:** exercise `ask_followup`, `show_more`, `share_link`, `close_chat`, `open_leo` and document request/response schemas.
- **Authenticated/premium flows:** compare behavior for logged-in or Brave Premium/Leo contexts and any additional headers/tokens.
- **Richer answers:** capture responses with citations, entities, images, and `context*` populated to fully map `enrichments`.
- **Standalone Leo:** capture `leo.brave.com` or in-browser Leo API surfaces (if accessible) for a complete Leo-specific protocol view.

---

## Limitations & Notes

- **Scope of success:** documents the `search.brave.com` `chatllm/with_ask` ("Answer with AI") flow as observed; standalone `leo.brave.com` was not captured here.
- **Ephemeral/versioned:** conversation IDs, callback `nonce`/`timestamp`, headers, stream event schema, and UI/feature flags may change.
- **Unauthenticated web context:** observed from public search usage in headless Chromium.
- **Captured content:** single benign test prompt/response (`PONG`).
- **Use responsibly:** unofficial interface; for interoperability research/defensive understanding and in accordance with applicable terms and law.

---

*Generated from live Chromium captures of Brave Search (chatllm / Answer with AI), 2026-11-13.*