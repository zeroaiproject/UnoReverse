# Obscurify.ai (Anonymous AI Gateway) — Reverse Engineering

> **Target:** `https://obscurify.ai/` (Obscurify AI — anonymous/private AI chat & gateway)  
> **Scope:** Unofficial web-client interface — model catalog & policy lists, code/tools mode config, and anonymous (guest) chat completions as observed in-browser.  
> **Date:** 2026-11-13 · **Method:** Chromium capture (Playwright-bundled Chromium 1254, headless, Puppeteer-driven) · **Status:** ✅ guest chat completion captured (streamed SSE, no account)

---

## Table of Contents

- [Overview](#overview)
- [Capture Environment](#capture-environment)
- [High-Level Architecture](#high-level-architecture)
- [Observed Guest Flow](#observed-guest-flow)
- [Endpoints](#endpoints)
  - [GET /v1/models](#1-get-v1models)
  - [GET /frontier_models](#2-get-frontier_models)
  - [GET /uncensored_models](#3-get-uncensored_models)
  - [GET /code_mode](#4-get-code_mode)
  - [POST /anon/chat/completions](#5-post-anonchatcompletions)
- [Anonymous Chat Request Contract](#anonymous-chat-request-contract)
- [Streaming Response (SSE)](#streaming-response-sse)
- [Headers, Identity & Threading](#headers-identity--threading)
- [Privacy & Access Model (Observed/Stated)](#privacy--access-model-observedstated)
- [Gaps & Next Steps](#gaps--next-steps)
- [Limitations & Notes](#limitations--notes)

---

## Overview

Obscurify.ai presents itself as an anonymous AI gateway/proxy: a web chat (and OpenAI-compatible API surface) that lets users access many third-party models while obscuring user identity from model providers. The site advertises 300+ models (frontier, uncensored, local/browser-run), Tor onion access, and guest usage without signup.

In this capture a **guest** (no account, no auth cookies/headers observed) successfully completed a chat turn via the anonymous completions endpoint with streamed reasoning and a final answer.

**Captured example (successful, guest):**

| Item | Value |
|---|---|
| Page | `https://obscurify.ai/` ("Obscurify AI: Anonymous, Private AI Chat with No Logs") |
| Endpoint | `POST https://obscurify.ai/anon/chat/completions` |
| Model (request) | `deepseek/deepseek-v4-flash` |
| Prompt | `Reply with exactly: PONG` |
| Stream | `text/event-stream` (SSE), `stream: true`, `stream_options.include_usage: true` |
| Thread header | `x-obscurify-thread: thr_13381c6b0ff54a118cad0a66adfcaa15` |
| Assistant output | reasoning deltas + content `PONG` + `finish_reason: "stop"` + `data: [DONE]` |

---

## Capture Environment

| Component | Detail |
|---|---|
| Browser | `/root/.cache/ms-playwright/chromium-1254/chrome-linux64/chrome` (headless, `--no-sandbox`) |
| Automation | Puppeteer (Chromium-driven) |
| User-Agent | `Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36` |
| Locale | `en-US,en` |
| Viewport | `1280×900` |
| Session | Guest / unauthenticated (no `Authorization` or session cookies observed on anon chat request) |

---

## High-Level Architecture

- **Web app:** SPA on `obscurify.ai` (nginx; strict CSP, `cache-control: no-store` for app/API; hashed/static assets cached long-term).
- **OpenAI-compatible catalog surface:** `GET /v1/models` returns an OpenAI-style `{"object":"list","data":[...]}` model list with pricing/capability metadata.
- **Policy/catalog helpers:** `GET /frontier_models` and `GET /uncensored_models` expose model-id allow/deny/grouping lists for UI gating.
- **Tools / Code Mode config:** `GET /code_mode` returns feature flags, direct tools, pricing hints, and system prompts for client-side tool/code execution modes.
- **Anonymous chat:** guest completions via `POST /anon/chat/completions` (SSE), distinct from authenticated/API-key flows implied by the product (not exercised here).
- **Tor:** `Onion-Location` header advertises the equivalent onion service for the site/endpoints.

---

## Observed Guest Flow

```text
[Browser loads https://obscurify.ai/]
        │
        ├─► GET  /v1/models            → 200 (OpenAI-style model list)
        ├─► GET  /frontier_models      → 200 {"frontier_models":[...]}
        ├─► GET  /uncensored_models    → 200 {"uncensored_models":[...]}
        └─► GET  /code_mode            → 200 {enabled, direct_tools, prompts, ...}

[User submits prompt (guest)]
        │
        └─► POST /anon/chat/completions
                 content-type: application/json
                 body: {model, stream, stream_options, tools, messages[...] }
                 └─◄ 200 text/event-stream
                      x-obscurify-thread: thr_...
                      data: chat.completion.chunk (reasoning deltas) → content "PONG" → finish_reason "stop" → [DONE]
```

---

## Endpoints

### 1) `GET /v1/models`

OpenAI-compatible model catalog.

- **Response:** `200`, `application/json`, `cache-control: no-store`
- **Shape:** `{"object":"list","data":[ {id, object:"model", owned_by, name, pricing, context_length, decisions, tools, categories, e2ee, created}, ... ]}`
- **Notable headers:** `access-control-allow-origin: *`, `access-control-expose-headers: Deprecation, X-Obscurify-Notice, Retry-After, X-Obscurify-Thread, X-Obscurify-Reply, X-Obscurify-Reply-Running, X-Obscurify-TEE-Receipt, X-Obscurify-TEE-Route`, `onion-location` present.

**Example entry (observed, guest default model):**
```json
{
  "id": "deepseek/deepseek-v4-flash",
  "object": "model",
  "owned_by": "deepseek",
  "name": "DeepSeek: DeepSeek V4 Flash",
  "pricing": {
    "prompt": 1.17e-7,
    "completion": 2.34e-7,
    "image": 0.0,
    "request": 0.0,
    "input_cache_read": 2.34e-8
  },
  "context_length": 1048576,
  "decisions": false,
  "tools": true,
  "categories": ["Zero retention"],
  "e2ee": false,
  "created": 1777000666
}
```

### 2) `GET /frontier_models`

- **Response:** `200`, `application/json`
- **Body:** `{"frontier_models":[ "<model-id>", ... ]}` (IDs gated to higher/paid tiers per product behavior; list observed).

### 3) `GET /uncensored_models`

- **Response:** `200`, `application/json`
- **Body:** `{"uncensored_models":[ "<id-or-pattern>", ... ]}` (includes explicit IDs and wildcard/pattern entries such as `*uncensor*`, `*abliterat*`, etc.).

### 4) `GET /code_mode`

Client tools/code execution configuration (served to web/app).

- **Response (200, JSON, observed keys):**
  - `enabled`: `true`
  - `paid_tools`: `false`
  - `per_call_usd`: `1.0`
  - `direct_tools`: `[{"function":{"name":"web_search",...}}, {"function":{"name":"find_tools",...}}, {"function":{"name":"inspect_tool",...}}]` (tool schemas included)
  - `prompts`: keys `code`, `code_tools`, `tools` (long system-prompt texts instructing on-device sandbox execution, `run_code`, display helpers, safety, etc.)

> Code/tool execution described here runs client-side in a sandboxed context (per prompts/JS); the completions API receives the model's tool calls/messages as part of the agent loop.

### 5) `POST /anon/chat/completions`

Anonymous (guest) chat completion endpoint. Accepts an OpenAI-chat-completions-style payload and returns SSE when streaming.

- **Request:** `POST https://obscurify.ai/anon/chat/completions`, `content-type: application/json`, `origin/referer: https://obscurify.ai/` (no `Authorization`/cookies observed for guest).
- **Response:** `200`, `content-type: text/event-stream`, `cache-control: no-store`, `access-control-allow-origin: https://obscurify.ai`, `x-obscurify-thread: <id>`.

---

## Anonymous Chat Request Contract

**Observed request body (guest turn):**
```json
{
  "model": "deepseek/deepseek-v4-flash",
  "stream": true,
  "stream_options": { "include_usage": true },
  "tools": [
    {
      "type": "function",
      "function": {
        "name": "run_code",
        "description": "Run Python or JavaScript in a sandbox on the user's device and get back what it printed, its result or its error. See the system prompt for what the sandbox offers.",
        "parameters": {
          "type": "object",
          "properties": {
            "code": { "type": "string", "description": "The code to run." },
            "language": { "type": "string", "enum": ["python", "javascript"], "description": "python (Pyodide) or javascript" }
          },
          "required": ["language", "code"]
        }
      }
    },
    { "type": "function", "function": { "name": "web_search", "description": "Search the web. Returns {answer, results: [{title, url, content}]}. Free.", "parameters": { "type": "object", "properties": { "query": { "type": "string" } }, "required": ["query"] } } },
    { "type": "function", "function": { "name": "find_tools", "description": "Search a marketplace of thousands of tools that charge per use ... Returns [{id, name, description, price_usd, price_basis}]. Free.", "parameters": { "type": "object", "properties": { "limit": { "type": "integer", "description": "How many results, default 8" }, "query": { "type": "string" } }, "required": ["query"] } } },
    { "type": "function", "function": { "name": "inspect_tool", "description": "Get a marketplace tool's parameters and price before calling it ... Never guess parameters.", "parameters": { "type": "object", "properties": { "id": { "type": "string" } }, "required": ["id"] } } }
  ],
  "messages": [
    {
      "role": "system",
      "content": "<long Code/Tools system prompt (~5164 chars observed), aligned with /code_mode prompts; instructs on-device sandbox, run_code, direct tools, safety, display helpers>"
    },
    {
      "role": "user",
      "content": [
        { "type": "text", "text": "Reply with exactly: PONG" }
      ]
    }
  ]
}
```

**Notes:**
- `messages[].content` for the user turn used **structured parts** (`[{ "type": "text", "text": "..." }]`).
- `tools` are sent per-request (client-assembled: `run_code` + direct tools consistent with `/code_mode`); tool execution is client-orchestrated in the agent loop.
- No account token/API key required for this guest path (as observed).

---

## Streaming Response (SSE)

`Content-Type: text/event-stream`. Chunks are OpenAI-compatible `chat.completion.chunk` objects including reasoning fields.

**Captured stream (representative):**
```text
data: {"choices":[{"delta":{"content":"","reasoning":"The","reasoning_details":[{"index":0,"text":"The","type":"reasoning.text"}],"role":"assistant"},"finish_reason":null,"index":0}],"created":1794605478,"id":"chatcmpl-wkaQIXvaeqE6ATdZK7EFxzDaywoKg","model":"deepseek/deepseek-v4-flash","object":"chat.completion.chunk"}

data: {"choices":[{"delta":{"content":"","reasoning":" user wants","reasoning_details":[{"index":0,"text":" user wants","type":"reasoning.text"}],"role":"assistant"},"finish_reason":null,"index":0}],...}
...
data: {"choices":[{"delta":{"content":"PONG","role":"assistant"},"finish_reason":null,"index":0}],...}

data: {"choices":[{"delta":{"content":"","reasoning":null,"role":"assistant"},"finish_reason":"stop","index":0}],...}

data: [DONE]
```

**Observed fields:** `delta.content`, `delta.reasoning`, `delta.reasoning_details[]` (`type: "reasoning.text"`), `delta.role`, `finish_reason` (`null` → `"stop"`), `id`, `model`, `created`, `object:"chat.completion.chunk"`. (A final usage payload may be included when provided by the backend; not separately observed beyond the requested `stream_options.include_usage` in this short turn.)

---

## Headers, Identity & Threading

| Header / signal | Observed |
|---|---|
| `x-obscurify-thread` | `thr_13381c6b0ff54a118cad0a66adfcaa15` (returned on anon completion response; thread correlation) |
| `access-control-expose-headers` (`/v1/models`) | includes `X-Obscurify-Notice`, `Retry-After`, `X-Obscurify-Thread`, `X-Obscurify-Reply`, `X-Obscurify-Reply-Running`, `X-Obscurify-TEE-Receipt`, `X-Obscurify-TEE-Route` |
| `Onion-Location` | present on site and API responses (e.g. `http://obscurizgk4wr5bg5fatq5tedqszcjrbgkot6qw7tnip74bakp6oztid.onion/...`) |
| Guest auth | No `Authorization` header and no session cookies observed on `POST /anon/chat/completions` in this capture |

---

## Privacy & Access Model (Observed/Stated)

- **Guest access (stated/observed):** free guest chat available without account/email/cookies in UI; guest request completed without auth credentials.
- **Proxy/privacy stance (stated):** identity obfuscation toward model providers; prompts/responses not saved by Obscurify per product claims, though providers process prompt content; IP/rate-limiting/abuse handling and logging policies as described on-site (e.g. transient/IP-log retention claims) — **not independently verified** here.
- **Tiers/gating:** `/frontier_models` and `/uncensored_models` indicate model access segmentation (plans/accounts/API); not exercised.
- **Tor/local modes:** onion service advertised; local/browser-executed models and on-device sandboxed code/tools are client-side features (partially reflected via `/code_mode` and UI).

---

## Gaps & Next Steps

- **Authenticated/API-key flow:** capture `/v1/chat/completions` (OpenAI-compatible, with `Authorization`/balance/plan) vs `/anon/chat/completions` differences.
- **Tool/agent loop in practice:** exercise `run_code`, `web_search`, `find_tools`/`inspect_tool` and document tool-call/result message turns and any `X-Obscurify-Reply*` / TEE receipt headers.
- **Usage/billing details:** capture streamed `usage` chunks, per-model pricing application, and rate-limit/`Retry-After` behavior (guest limits stated in UI).
- **Thread lifecycle:** how `x-obscurify-thread` is reused/sent on follow-ups and persisted.
- **Frontier/uncensored access:** behavior and enforcement when requesting gated models.
- **Full `/v1/models` coverage:** enumerate catalog and field semantics across models (captured body was large/truncated in artifacts; sample extracted).

---

## Limitations & Notes

- **Guest-only capture:** single prompt/turn; no account, payments, or gated models tested.
- **Ephemeral/versioned:** model IDs, availability, pricing, prompts, tool schemas, and config (`/code_mode`, catalogs) can change.
- **Product claims:** privacy/retention/TEE-related claims are reported as stated/indicated, not independently verified.
- **Use responsibly:** unofficial interface; for interoperability research/defensive understanding and in accordance with applicable terms and law.

---

*Generated from live Chromium captures of `obscurify.ai` (guest `/anon/chat/completions`), 2026-11-13.*

---

## Client

A zero-dependency Node.js client, streaming parser and CLI live in [`ObscurifyAPI.js`](./ObscurifyAPI.js) / [`src/`](./src/), built on the shared helpers in [`/lib`](../../lib/).

- **Guest, keyless:** `POST /anon/chat/completions` with `origin`/`referer: https://obscurify.ai/` (no auth). Thread reuse via the `x-obscurify-thread` response header.
- **Catalogs:** `GET /v1/models`, `/frontier_models`, `/uncensored_models`, `/code_mode`.
- **Streaming:** OpenAI-style SSE (`chat.completion.chunk`), including reasoning deltas and `stream_options.include_usage`.
- **Offline tests:** mocked `fetch`, no network (`node --test AI/Obscurify/test/*.test.js`).

```bash
node AI/Obscurify/ObscurifyAPI.js "Reply with exactly: PONG" --stream
node AI/Obscurify/ObscurifyAPI.js --models --kind all
node AI/Obscurify/ObscurifyAPI.js --code-mode
node AI/Obscurify/ObscurifyAPI.js "follow up" --thread thr_... --json
```

```js
import { obscurifyChat, ObscurifyClient } from "./AI/Obscurify/ObscurifyAPI.js";

const res = await obscurifyChat({ prompt: "Reply with exactly: PONG" });
// res = { ok, answer, reasoning, thread, usage, finishReason, model, ... }

const client = new ObscurifyClient({ retries: 1 });
const models = await client.listModels();
```
