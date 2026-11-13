# Lumo (Proton) — Reverse Engineering

> **Target:** `https://lumo.proton.me/` (Proton Lumo, privacy-first AI assistant)  
> **Scope:** Unofficial web-client interface — guest bootstrap/session flow, Proton API auth/cookies, models/limits, and encrypted chat completion protocol as observed in a guest session.  
> **Date:** 2026-11-13 · **Method:** Chromium capture (Playwright-bundled Chromium 1254, headless, Puppeteer-driven) · **Status:** ✅ guest chat flow and streamed completions captured (end-to-end encrypted payloads; plaintext not observable at network layer)

---

## Table of Contents

- [Overview](#overview)
- [Capture Environment](#capture-environment)
- [High-Level Architecture](#high-level-architecture)
- [Observed Guest Flow](#observed-guest-flow)
- [Authentication, Session & Cookies](#authentication-session--cookies)
- [Client Headers & Identity](#client-headers--identity)
- [Endpoints](#endpoints)
  - [POST /api/auth/v4/sessions](#1-post-apiauthv4sessions)
  - [POST /api/core/v4/auth/cookies](#2-post-apicorev4authcookies)
  - [GET /api/feature/v2/frontend](#3-get-apifeaturev2frontend)
  - [GET /api/ai/v1/models](#4-get-apiaiv1models)
  - [GET /api/ai/v1/limits](#5-get-apiaiv1limits)
  - [POST /api/ai/v1/chat/completions](#6-post-apiaiv1chatcompletions)
  - [POST /api/feature/v2/frontend/client/metrics](#7-post-apifeaturev2frontendclientmetrics)
- [Chat Completion Request Contract](#chat-completion-request-contract)
- [Streaming Response (SSE)](#streaming-response-sse)
- [Encryption & Privacy Model (Observed)](#encryption--privacy-model-observed)
- [Conversation State](#conversation-state)
- [Security Headers / CSP Notes](#security-headers--csp-notes)
- [Gaps & Next Steps](#gaps--next-steps)
- [Limitations & Notes](#limitations--notes)

---

## Overview

Lumo is Proton's web AI assistant (`lumo.proton.me`) built on Proton's account/API infrastructure. In a **guest** session the client obtains a Proton-style session (UID, access/refresh tokens), exchanges them for auth cookies, fetches feature flags/models/limits, and submits chat turns to an OpenAI-compatible-ish streaming completions endpoint.

A defining characteristic observed on the wire: **message content and reasoning are end-to-end encrypted client-side** (`encrypted: true`, base64 ciphertext in requests and streamed deltas) with per-request key material (`lumo.request_key`) carried alongside the request. The server streams back encrypted chunks and usage/quota metadata, but the plaintext prompt/answer is not visible in captured network traffic.

**Captured example (successful, guest):**

| Item | Value |
|---|---|
| Entry | `https://lumo.proton.me/` → guest session → `https://lumo.proton.me/guest/c/32894077-8aad-406c-92e7-45ea535f26e5` |
| Prompt (UI) | `Reply with exactly: PONG` |
| Main model (request) | `lumo-max` (`reasoning_effort: "high"`) |
| Title model (request) | `lumo-lite` (`reasoning_effort: "none"`, `lumo.target: "title"`) |
| Stream endpoint | `POST /api/ai/v1/chat/completions` (`text/event-stream`) |
| Stream result | 200 SSE, encrypted deltas + `finish_reason: "stop"` + usage/limits + `data: [DONE]` |
| Backend model id (response) | `bff6c543`, `provider: "lumo"` (observed) |
| Quota snapshot (response) | `remaining_limits: {"lite":19,"max":19,"images":20}` (after turn) |

---

## Capture Environment

| Component | Detail |
|---|---|
| Browser | `/root/.cache/ms-playwright/chromium-1254/chrome-linux64/chrome` (headless, `--no-sandbox`) |
| Automation | Puppeteer (Chromium-driven) |
| User-Agent | `Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36` |
| Locale | `en-US,en` / `x-pm-locale: en_US` |
| Viewport | `1280×900` |
| App version (header) | `web-lumo@2.1.0.6` (`x-pm-appversion`) |
| Session (observed) | Guest; `Session-Id=aveAF4Awmp8Ecx9OI4BBqwAAAMQ`, `UID=wutgdfpdy3esccirp4tcagwnc33eg353` |

---

## High-Level Architecture

- **Frontend:** SPA on `https://lumo.proton.me` (hashed `/assets/static/*` bundles, strict CSP). Routes observed: `/guest`, `/guest/c/<conversation-uuid>`.
- **Auth/session (Proton-style):** guest session bootstrap via `/api/auth/v4/sessions`, cookie materialization via `/api/core/v4/auth/cookies` (sets `AUTH-<UID>` for `/api/`, `REFRESH-<UID>` for `/api/auth/refresh`, plus `Session-Id`, `Tag`).
- **Product/config:** feature flags via `/api/feature/v2/frontend`; model catalog via `/api/ai/v1/models`; quota via `/api/ai/v1/limits`.
- **Inference:** `POST /api/ai/v1/chat/completions` with `stream: true` (SSE, `text/event-stream; charset=UTF-8`). Requests/responses carry **encrypted** message content/reasoning.
- **Ecosystem:** CSP allows connections to Proton storage hosts and `wss://lumo-api.proton.me`; frames/integration with other Proton apps (account/mail/drive/docs/etc.) permitted by policy.

---

## Observed Guest Flow

```text
[Browser]
   │
   ├─► GET  https://lumo.proton.me/  (and /guest UI bootstrap)
   │
   ├─► POST https://lumo.proton.me/api/auth/v4/sessions
   │        └─◄ 200 {Code, AccessToken, RefreshToken, TokenType:"Bearer", UID, LocalID, Scopes:[]}
   │             + Set-Cookie: Session-Id, Tag
   │
   ├─► POST https://lumo.proton.me/api/core/v4/auth/cookies
   │        Authorization: Bearer <AccessToken>, x-pm-uid: <UID>
   │        body: {UID, ResponseType:"token", GrantType:"refresh_token", RefreshToken, RedirectURI, Persistent:0, State}
   │        └─◄ 200 {Code, UID, LocalID, RefreshCounter}
   │             + Set-Cookie: REFRESH-<UID> (path=/api/auth/refresh), AUTH-<UID> (path=/api/), Session-Id, Tag
   │
   ├─► GET  /api/feature/v2/frontend?sessionId=<id>&appName=-&environment=default   (toggles)
   ├─► GET  /api/ai/v1/models                                                       (model catalog)
   ├─► GET  /api/ai/v1/limits                                                       (quota)
   │
   ├─► POST /api/ai/v1/chat/completions  (model: lumo-lite, lumo.target:"title", encrypted msgs)
   │        └─◄ 200 text/event-stream  (encrypted chunks, usage, [DONE])
   │
   ├─► POST /api/ai/v1/chat/completions  (model: lumo-max, encrypted system+user, tools, streaming)
   │        └─◄ 200 text/event-stream  (encrypted reasoning/content deltas, usage/remaining_limits, [DONE])
   │
   └─► UI navigates to /guest/c/<conversation-uuid>
```

---

## Authentication, Session & Cookies

**Session creation (`/api/auth/v4/sessions`, observed):**
- Returns `Code: 1000`, `AccessToken` (compact JWE-like token string observed), `RefreshToken`, `TokenType: "Bearer"`, `UID`, `LocalID`, `Scopes: []`.

**Cookie establishment (`/api/core/v4/auth/cookies`, observed):**
- Request includes `Authorization: Bearer <AccessToken>` and `x-pm-uid`, with refresh/grant details in body.
- Response sets (HttpOnly, Secure, `SameSite=None`):
  - `REFRESH-<UID>` — scoped to `path=/api/auth/refresh` (JSON payload with `ClientID:"WebLumo"`, grant/refresh material), long-lived (≈1y observed).
  - `AUTH-<UID>` — scoped to `path=/api/` (access token value), long-lived (≈1y observed).
  - `Session-Id` — `Domain=proton.me; Path=/` (≈90d observed).
  - `Tag=default`.

Subsequent API calls rely on `AUTH-<UID>` cookie (and `x-pm-uid`/app headers). Feature-flag fetches were also observed with `Authorization: "-"` in this guest flow.

---

## Client Headers & Identity

| Header / Cookie | Example / notes (observed) |
|---|---|
| `x-pm-appversion` | `web-lumo@2.1.0.6` |
| `x-pm-locale` | `en_US` |
| `x-pm-uid` | `wutgdfpdy3esccirp4tcagwnc33eg353` (guest UID) |
| `accept` (API/AI) | `application/vnd.protonmail.v1+json` (completions/models/limits/sessions) |
| `accept` (features) | `application/json` |
| `authorization` | `Bearer <AccessToken>` or `-` depending on call |
| Cookies | `Session-Id`, `Tag`, `AUTH-<UID>`, `REFRESH-<UID>`, plus client state like `Features`, `LumoOnboardingCompleted=false` |

---

## Endpoints

Base: `https://lumo.proton.me` (unless noted).

### 1) `POST /api/auth/v4/sessions`

Bootstraps a (guest) session.

**Response (200, JSON, observed):**
```json
{
  "Code": 1000,
  "AccessToken": "<token>",
  "RefreshToken": "<refresh>",
  "TokenType": "Bearer",
  "Scopes": [],
  "UID": "wutgdfpdy3esccirp4tcagwnc33eg353",
  "LocalID": 0
}
```
Sets `Session-Id`, `Tag`.

### 2) `POST /api/core/v4/auth/cookies`

Exchanges session/refresh material for scoped auth cookies.

**Request body (observed):**
```json
{
  "UID": "wutgdfpdy3esccirp4tcagwnc33eg353",
  "ResponseType": "token",
  "GrantType": "refresh_token",
  "RefreshToken": "<refresh>",
  "RedirectURI": "https://protonmail.com",
  "Persistent": 0,
  "State": "s7K351L4u3jm4TVqSyugO4oT"
}
```

**Response (200, JSON):** `{"Code":1000,"UID":"...","LocalID":1,"RefreshCounter":0}` plus `AUTH-<UID>`, `REFRESH-<UID>`, `Session-Id`, `Tag` cookies.

### 3) `GET /api/feature/v2/frontend`

**Request:** `GET /api/feature/v2/frontend?sessionId=555197571&appName=-&environment=default`

**Response (200, JSON):** large `toggles[]` (Unleash-like: `name`, `enabled`, `variant`, etc.). Examples observed include many `Lumo*` flags (e.g. `LumoTooling`, `LumoRetrievalTools`, `LumoApertusModel`, `LumoMaxAvailableGuest`, `LumoImageTools`, `LumoCustomAgents`, `LumoProjects`, etc.) alongside broader Proton flags.

### 4) `GET /api/ai/v1/models`

**Response (200, JSON, observed):**
```json
{
  "object": "list",
  "data": [
    {
      "object": "model",
      "id": "lumo-lite",
      "created": 1779890182,
      "owned_by": "proton",
      "capabilities": { "completion_chat": true, "function_calling": true, "vision": true },
      "name": "Lumo Lite",
      "description": "Fast, efficient model for everyday tasks.",
      "max_context_length": 131072,
      "aliases": [],
      "deprecation": null,
      "deprecation_replacement_model": null,
      "default_model_temperature": 1,
      "archived": false
    },
    {
      "object": "model",
      "id": "lumo-max",
      "created": 1779890182,
      "owned_by": "proton",
      "capabilities": { "completion_chat": true, "function_calling": true, "vision": true },
      "name": "Lumo Max",
      "description": "More capable model for complex reasoning and longer context.",
      "max_context_length": 131072,
      "aliases": [],
      "deprecation": null,
      "deprecation_replacement_model": null,
      "default_model_temperature": 1,
      "archived": false
    },
    {
      "object": "model",
      "id": "apertus-15",
      "created": 1779890182,
      "owned_by": "proton",
      "capabilities": { "completion_chat": true, "function_calling": true, "vision": true },
      "name": "Apertus 1.5",
      "description": "Fully open, Swiss-made model for lighter tasks",
      "max_context_length": 131072,
      "aliases": [],
      "deprecation": null,
      "deprecation_replacement_model": null,
      "default_model_temperature": 1,
      "archived": false
    }
  ]
}
```

### 5) `GET /api/ai/v1/limits`

**Response (200, JSON, observed):**
```json
{ "limits": { "lite": 20, "max": 20, "images": 20 } }
```
(Per-category quotas for the session/tier; post-completion `remaining_limits` reported in stream usage.)

### 6) `POST /api/ai/v1/chat/completions`

Primary chat endpoint. Streaming, OpenAI-chat-completions-like envelope with Proton/Lumo extensions and **encrypted** message payloads.

- **Request headers:** `content-type: application/json`, `accept: application/vnd.protonmail.v1+json`, `x-pm-appversion`, `x-pm-locale` (+ auth cookies / UID context)
- **Response:** `200`, `content-type: text/event-stream; charset=UTF-8`, `cache-control: no-store/no-cache...`, `x-accel-buffering: no`

See [Chat Completion Request Contract](#chat-completion-request-contract) and [Streaming Response (SSE)](#streaming-response-sse).

### 7) `POST /api/feature/v2/frontend/client/metrics`

Feature-flag exposure/metrics reporting.

- **Request (observed):** JSON bucket with `start/stop`, `toggles` exposure counts (e.g. Lumo flags seen during session), `appName`, `instanceId:"browser"`, `impactMetrics`.
- **Response:** `200`, body `ok` (`text/html; charset=UTF-8` observed).

---

## Chat Completion Request Contract

Two completions were issued for the captured turn (title generation and main reply).

### A) Title request (observed)
```json
{
  "model": "lumo-lite",
  "messages": [
    { "role": "user", "content": "<base64-ciphertext>", "encrypted": true },
    { "role": "assistant", "content": "<base64-ciphertext>", "encrypted": true }
  ],
  "stream": true,
  "stream_options": { "include_usage": true },
  "reasoning_effort": "none",
  "lumo": {
    "client_type": "frontend",
    "target": "title",
    "request_key": "<opaque/base64 key material>",
    "request_id": "cb590a73-c59d-4b21-8d0b-346a00531352",
    "feature_flags": { "LumoAiPaperTrailRoute": "true", "LumoApertusModel": "true", "LumoArtifactsView": "true", "LumoCustomAgents": "true", "LumoTooling": "true", "LumoRetrievalTools": "true", "...": "..." }
  }
}
```

### B) Main chat request (observed, shape)
```json
{
  "model": "lumo-max",
  "messages": [
    { "role": "system", "content": "<base64-ciphertext>", "encrypted": true },
    { "role": "user", "content": "<base64-ciphertext>", "encrypted": true }
  ],
  "stream": true,
  "stream_options": { "include_usage": true },
  "reasoning_effort": "high",
  "tools": [
    { "name": "web_search" },
    { "name": "weather" },
    { "name": "stock" },
    { "name": "cryptocurrency" },
    { "name": "web_extract" },
    { "name": "proton_info" },
    { "name": "generate_image" },
    { "name": "describe_image" },
    { "name": "edit_image" },
    {
      "type": "function",
      "function": {
        "name": "search_knowledge",
        "description": "Search the user's files and earlier chat messages for passages relevant to a query. ...",
        "parameters": { "type": "object", "properties": { "query": {"type":"string"}, "scope": {"enum":["this_chat","project","all"]}, "sources": {"type":"array","items":{"enum":["files","messages"]}}, "file_ids": {"type":"array"}, "limit": {"type":"integer","minimum":1,"maximum":10} }, "required": ["query"], "additionalProperties": false }
      }
    },
    {
      "type": "function",
      "function": {
        "name": "read_knowledge",
        "description": "Read pages of a file, or of a chat message, found with search_knowledge or listed in the file list. ...",
        "parameters": { "type": "object", "properties": { "file_id": {"type":"string"}, "file_name": {"type":"string"}, "message_id": {"type":"string"}, "...": "..." } }
      }
    }
  ],
  "lumo": {
    "client_type": "frontend",
    "target": "...",
    "request_key": "<opaque/base64 key material>",
    "request_id": "<uuid>",
    "feature_flags": { "...": "..." }
  }
}
```

**Notes:**
- `messages[].content` (and system content) are **encrypted** (base64 ciphertext) with `encrypted: true`; the client also echoes prior assistant turns as encrypted context.
- `lumo.request_key` carries per-request key material used for E2E encryption of the exchange (exact derivation/algorithm not recoverable from network capture alone).
- `lumo.feature_flags` mirrors relevant client-side Lumo toggles for the request.
- `tools` mixes named built-in tools and JSON-schema function tools (`search_knowledge`, `read_knowledge`) for retrieval over user data.

---

## Streaming Response (SSE)

Responses are line-delimited SSE frames: `data: {json}` chunks followed by `data: [DONE]`.

**Chunk envelope (observed):**
```json
{
  "object": "chat.completion.chunk",
  "id": "chatcmpl-bkitjcm2",
  "created": 1794605136,
  "model": "bff6c543",
  "provider": "lumo",
  "choices": [
    {
      "index": 0,
      "delta": {
        "role": "assistant",
        "content": "<base64-ciphertext | null>",
        "reasoning": "<base64-ciphertext | null>",
        "encrypted": true
      },
      "finish_reason": null
    }
  ]
}
```

**Observed sequence:** encrypted `delta` chunks (reasoning and/or content) → terminal chunk with `finish_reason: "stop"` → usage chunk (often `choices: []`) → `data: [DONE]`.

**Usage/limits chunk (observed examples):**
```json
{
  "object": "chat.completion.chunk",
  "id": "chatcmpl-bkitjcm2",
  "created": 1794605136,
  "model": "bff6c543",
  "provider": "lumo",
  "choices": [],
  "usage": {
    "completion_tokens": 11,
    "prompt_tokens": 436,
    "total_tokens": 447,
    "prompt_tokens_details": { "cached_tokens": 0 },
    "completion_tokens_details": { "reasoning_tokens": 5 },
    "remaining_limits": { "lite": 19, "max": 19, "images": 20 },
    "applied_limit_category": "lite"
  }
}
```
(Title request reported `applied_limit_category: "max"` and higher prompt/cached tokens in its context.)

---

## Encryption & Privacy Model (Observed)

- **Client-side encryption:** `messages[*].content` and streamed `delta.content`/`delta.reasoning` are base64 ciphertext with `encrypted: true`. Plaintext prompts/answers are **not** visible in captured HTTP(S) traffic.
- **Per-request keying:** requests include `lumo.request_key` (and `request_id`), consistent with client-generated key material for the exchange; server echoes encrypted deltas decryptable by the client.
- **Context handling:** prior turns are resubmitted as encrypted blobs (client maintains encrypted conversation state/context).
- **Implication for RE:** network-level capture reveals protocol, endpoints, auth, models, tools, quotas, and metadata — but not message plaintext without client-side key access/decryption logic.

---

## Conversation State

- Guest chat materializes as a conversation route: `https://lumo.proton.me/guest/c/<uuid>` (e.g. `/guest/c/32894077-8aad-406c-92e7-45ea535f26e5`).
- Conversation persistence/sync APIs beyond the observed completions+UI routing were not explicitly isolated in this capture (state may be client-managed/encrypted or synced via additional Proton endpoints not triggered).

---

## Security Headers / CSP Notes

Responses include a strict CSP (representative): `default-src 'self'`; `connect-src 'self' blob: https://*.proton.me storage hosts wss://lumo-api.proton.me`; restricted `script-src` (`'wasm-unsafe-eval'`, specific hash), `frame-src`/`frame-ancestors` limited to Proton properties; plus `strict-transport-security`, `x-content-type-options: nosniff`, `expect-ct`, `referrer-policy`, `permissions` hardening. CORS allows `https://lumo.proton.me` with credentials for AI responses.

---

## Gaps & Next Steps

- **Decryption/key derivation:** trace client bundles to document how `lumo.request_key` is generated and how `encrypted` content/reasoning is encrypted/decrypted (algorithm, IV/tag encoding).
- **Authenticated (non-guest) flow:** compare logged-in Proton account sessions, token scopes, and quota/feature differences.
- **Tool execution loop:** capture end-to-end tool calls/results (built-in and `search_knowledge`/`read_knowledge`) including how tool outputs are fed back (encrypted) into subsequent completions.
- **Conversation sync/storage:** identify APIs used to persist/retrieve encrypted conversation history across reloads/devices.
- **Model routing:** clarify mapping between requested `model` (`lumo-lite`/`lumo-max`/`apertus-15`) and response `model` ids (e.g. `bff6c543`).
- **WebSocket path:** CSP allows `wss://lumo-api.proton.me`; observe whether/when it is used vs HTTP SSE.

---

## Limitations & Notes

- **Guest-only, single-turn capture:** observed from an anonymous guest session with one prompt; behavior may differ for signed-in users, longer histories, or other tools/models.
- **Encrypted payloads:** request/response message bodies are ciphertext on the wire; plaintext not recoverable from this capture alone.
- **Ephemeral/versioned:** app build (`web-lumo@...`), tokens, UIDs, cookies, feature toggles, limits, and model/backend IDs can change.
- **Sensitive artifacts:** access/refresh tokens, UID-bound cookies, and session identifiers were present in capture context and must be treated as secrets (not committed).
- **Use responsibly:** unofficial interface; for interoperability research/defensive understanding and in accordance with applicable terms and law.

---

*Generated from live Chromium captures of `lumo.proton.me` (guest flow, `/api/ai/v1/chat/completions`), 2026-11-13.*
