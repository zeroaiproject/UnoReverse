# Duck.ai (DuckDuckGo AI Chat) — Reverse Engineering

> **Target:** `https://duck.ai/` (DuckDuckGo private AI chat)  
> **API base:** `https://duck.ai/duckchat/v1/*`  
> **Scope:** Unofficial web-client interface — session/status, capabilities, chat request schema, anti-bot/challenge flow, and observed streaming contract.  
> **Date:** 2026-11-13 · **Method:** Chromium capture (Playwright-bundled Chromium 1254, headless) · **Status:** ⚠️ protocol captured; end-to-end chat completion blocked in automation by anomaly challenge (`ERR_CHALLENGE`, HTTP 418)

---

## Table of Contents

- [Overview](#overview)
- [Capture Environment](#capture-environment)
- [High-Level Architecture](#high-level-architecture)
- [Observed Flow](#observed-flow)
- [Endpoints](#endpoints)
  - [GET /duckchat/v1/capabilities](#1-get-duckchatv1capabilities)
  - [GET /duckchat/v1/auth/token](#2-get-duckchatv1authtoken)
  - [GET /duckchat/v1/status](#3-get-duckchatv1status)
  - [POST /duckchat/v1/chat](#4-post-duckchatv1chat)
- [Request Headers & Client Signals](#request-headers--client-signals)
- [Chat Request Body](#chat-request-body)
- [Challenge / Anti-Bot (`ERR_CHALLENGE`)](#challenge--anti-bot-err_challenge)
- [Streaming & Identifiers (observed/expected)](#streaming--identifiers-observedexpected)
- [Telemetry (observed)](#telemetry-observed)
- [Gaps & Next Steps](#gaps--next-steps)
- [Limitations & Notes](#limitations--notes)

---

## Overview

Duck.ai is DuckDuckGo's web chat interface. The client bootstraps via `duckchat/v1` endpoints to fetch **capabilities**, optional auth state, and a **status** payload that includes an anti-bot/challenge context (`x-vqd-hash-1`). Chat turns are submitted to `POST /duckchat/v1/chat` with a rich JSON body and client-signal headers, expecting a streamed response (`Accept: text/event-stream`).

In this automated environment the chat request was rejected with **HTTP 418 / `ERR_CHALLENGE`**, triggering Duck.ai's anomaly challenge UI (image-selection assets). The request/response schema and surrounding protocol were still captured.

**Example (attempted) turn:**
| Item | Value |
|---|---|
| URL | `https://duck.ai/?chatID=84bca032-ebb1-400d-8ef1-015077186530` |
| Prompt | `Reply with exactly: PONG` |
| Model (client-selected) | `gpt-6-luna` |
| `conversationId` | `84bca032-ebb1-400d-8ef1-015077186530` |
| `messageId` (durable stream) | `73881f85-c4bf-4ef3-81ab-0f07c2678578` |
| `x-duckai-response-id` | `135c3e3b-3e38-44b0-9fbc-40d8ecb0eed5` |
| Result | `418 ERR_CHALLENGE` (chat not completed) |

---

## Capture Environment

| Component | Detail |
|---|---|
| Browser | `/root/.cache/ms-playwright/chromium-1254/chrome-linux64/chrome` (headless) |
| Automation | Puppeteer (Chromium-driven) |
| User-Agent | `Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36` |
| Locale | `en-US,en` |
| Viewport | `1280×900` |
| App version (telemetry) | `serp_20261113_122046_ET` (observed) |
| FE version header | `serp_20261113_122046_ET-4e32379a14a1f85ca4430ad2e32de2577da37124` (observed) |

---

## High-Level Architecture

- **Frontend:** SPA on `duck.ai` with hashed bundles under `/dist/duckai-dist/*` and locale/assets.
- **Chat API:** same-origin JSON/stream endpoints under `/duckchat/v1/` (`capabilities`, `auth/token`, `status`, `chat`).
- **Access tier:** `accessLevel: "public"` (unauthenticated/free tier observed), with `tier=free` in telemetry.
- **Anti-bot / anomaly:** status provides `x-vqd-hash-1` challenge context; chat may return `418 ERR_CHALLENGE` with challenge descriptor (`cd`) and anomaly assets to solve before proceeding.
- **Conversation model:** client supplies `conversationId` (`chatID` in URL), per-message `messageId`, and a `durableStream` envelope including an RSA public key (JWK) — suggesting resumable/encrypted stream support.
- **Streaming:** chat request advertises `Accept: text/event-stream` (actual stream frames not captured due to challenge).

---

## Observed Flow

```text
[Load https://duck.ai/]
        │
        ├─► GET  /duckchat/v1/capabilities
        │        └─◄ {"accessLevel":"public","flags":{}, ...}
        │
        ├─► GET  /duckchat/v1/auth/token   (journey-scoped)
        │        └─◄ {}
        │
        └─► GET  /duckchat/v1/status
                 (x-vqd-accept: 1, x-ddg-journey-id, cache-control: no-store)
                 └─◄ {"status":"0","secondaryStatus":"0","statusV2":0,"grant":null}
                      + response header: x-vqd-hash-1: <base64 JS/challenge payload>

[User submits prompt]
        │
        └─► POST /duckchat/v1/chat   (Accept: text/event-stream, application/json)
                 headers: x-fe-version, x-fe-signals, x-vqd-hash-1, x-ddg-journey-id,
                          x-duckai-response-id, x-duckai-tool-approval, x-duckai-consent-purposes, ...
                 body: { model, messages[], canUseTools, durableStream{messageId,conversationId,publicKey}, ... }
                 └─◄ 418 {"action":"error","status":418,"type":"ERR_CHALLENGE","cd":{...}}
                      → client loads /assets/anomaly/images/challenge/*.jpg + check.svg (challenge UI)
```

---

## Endpoints

### 1) `GET /duckchat/v1/capabilities`

Returns feature/capability flags for the current access level.

**Response (200, `application/json`)**
```json
{
  "accessLevel": "public",
  "flags": {},
  "experimentEnrollments": [],
  "experimentStateResets": [
    "client-tools-support",
    "duckai-framework-browser-profile-aa",
    "image-generation-model",
    "skills"
  ]
}
```

---

### 2) `GET /duckchat/v1/auth/token`

Probes/returns auth token state for the session/journey.

**Request headers (notable):** `x-ddg-journey-id`

**Response (200, `application/json`)**
```json
{}
```
(Unauthenticated/public context observed.)

---

### 3) `GET /duckchat/v1/status`

Establishes status and delivers anti-bot/challenge material.

**Request headers (observed):**
| Header | Example / purpose |
|---|---|
| `cache-control` | `no-store` |
| `accept` | `*/*` |
| `x-vqd-accept` | `1` (request VQD/challenge material) |
| `x-ddg-journey-id` | journey UUID (e.g. `2c09e5cfb4657032488dc861894eeb70`) |

**Response (200, `application/json`)**
```json
{
  "status": "0",
  "secondaryStatus": "0",
  "statusV2": 0,
  "grant": null
}
```

**Response headers (critical):**
- `x-vqd-hash-1`: large base64-encoded payload (observed to decode to obfuscated JavaScript/challenge logic and hash material, including `server_hashes`, `client_hashes`, `challenge_id`, timestamps, etc.). This is consumed by the client to produce/attach challenge proof for subsequent requests.

> `status`/`secondaryStatus` are string `"0"` in the observed payload (with `statusV2: 0`).

---

### 4) `POST /duckchat/v1/chat`

Submits a chat turn. Expects a streamed response when allowed.

**Request**
- **Method:** `POST`
- **Content-Type:** `application/json`
- **Accept:** `text/event-stream`
- **Origin/Referer:** `https://duck.ai/`

**Response (observed, blocked):** `418` with challenge error (see below). When successful, a streaming (SSE/event-stream) response is expected (not captured here).

---

## Request Headers & Client Signals

Headers observed on `POST /duckchat/v1/chat` (values are examples from capture):

| Header | Example / notes |
|---|---|
| `x-fe-version` | `serp_20261113_122046_ET-4e32379a14a1f85ca4430ad2e32de2577da37124` (frontend build/version) |
| `x-fe-signals` | base64 JSON (timing/interaction events: `start`, `events[]` with `name`/`delta` like `onboarding_impression`, `action` with `trusted`, `onboarding_finish`, `startNewChat_free`, `end`) |
| `x-vqd-hash-1` | base64 challenge/proof payload (derived from status challenge; includes `server_hashes`, `client_hashes`, `signals`, `meta` with `challenge_id`, `timestamp`, etc.) |
| `x-ddg-journey-id` | `e98efb2f7a23d27adc0dd1a118e36deb` (journey/session correlation) |
| `x-duckai-response-id` | `135c3e3b-3e38-44b0-9fbc-40d8ecb0eed5` (per-response/request correlation) |
| `x-duckai-continuation` | `resubmit-context` (observed) |
| `x-duckai-tool-approval` | `web-search` (observed) |
| `x-duckai-consent-purposes` | `user-location,image-generation,web-search` (observed) |
| `user-agent` | browser UA string |
| `accept-language` | `en-US,en;q=0.9` |

> `x-fe-signals` and `x-vqd-hash-1` are client-computed/encoded artifacts tied to anti-bot and UX telemetry; exact generation logic lives in frontend bundles and was not fully deobfuscated here.

---

## Chat Request Body

Observed JSON payload (`POST /duckchat/v1/chat`):

```json
{
  "model": "gpt-6-luna",
  "messages": [
    {
      "role": "user",
      "content": [
        { "type": "text", "text": "Reply with exactly: PONG" }
      ]
    }
  ],
  "canUseTools": true,
  "reasoningEffort": "none",
  "canUseApproxLocation": null,
  "canDelegateImageGeneration": null,
  "canShowGreeting": false,
  "durableStream": {
    "messageId": "73881f85-c4bf-4ef3-81ab-0f07c2678578",
    "conversationId": "84bca032-ebb1-400d-8ef1-015077186530",
    "publicKey": {
      "alg": "RSA-OAEP-256",
      "e": "AQAB",
      "ext": true,
      "key_ops": ["encrypt"],
      "kty": "RSA",
      "n": "<base64url modulus>",
      "use": "enc"
    }
  }
}
```

**Field notes:**
| Field | Meaning (inferred/observed) |
|---|---|
| `model` | Selected backend model alias (e.g. `gpt-6-luna`) |
| `messages[].content` | Structured content parts (text part observed) |
| `canUseTools` | Enables tool usage (e.g. web search) |
| `reasoningEffort` | Reasoning level hint (`none` observed) |
| `canUseApproxLocation` / `canDelegateImageGeneration` | Capability/consent toggles (`null` observed) |
| `durableStream.messageId` | Client-generated message/stream ID |
| `durableStream.conversationId` | Conversation/chat ID (matches URL `chatID`) |
| `durableStream.publicKey` | Client RSA-OAEP-256 JWK (`use: enc`) — suggests encrypted/durable stream transport support |

---

## Challenge / Anti-Bot (`ERR_CHALLENGE`)

When the request is not sufficiently trusted, the API responds with an anomaly challenge.

**Response (418, `application/json`) — observed:**
```json
{
  "action": "error",
  "status": 418,
  "type": "ERR_CHALLENGE",
  "overrideCode": "7fdc",
  "cd": {
    "cc": "duckchat",
    "e": 0,
    "er": null,
    "gk": "d4cd0dabcf4caa22ad92fab40844c786",
    "i": "3",
    "iadb": 1,
    "o": "wxopYhCR2r1Su4z138lxO8+3SKwWNSBTxKBUuRYXINR3DCC0qG7R3zdMt7B6CAb5nqd98/0+I/kk\nuBK91PCqhw==\n",
    "p": "700a07ae17e7b2e266b9f65dbb7dba3c-d2768f7e5904136210eb3157de78cab5-97bd8f2bf9b41ced1389bbf24ae1e4d9-9bcecadcfc862459f6382f5d679c5da7-13582088f95037f324f1105756ac2e91-061fde48423ea9f3a2cdacd8d52485cf-150cc053fbe447864dd078c29444f78f-3a6630c654b55d766a6ce3ab6149e994-e95879e11438d744bf48a3159908bf5b",
    "q": "",
    "r": "eun",
    "s": "aichat",
    "sc": 1
  }
}
```

**Observed client follow-up (challenge UI):**
- Fetches anomaly assets referenced/implied by challenge, e.g.:
  - `/assets/anomaly/images/challenge/<hash>.jpg` (multiple, matching IDs in `cd.p`)
  - `/assets/anomaly/check.svg`
- Telemetry reports failure: `duck-chat-interaction` complete with `feature.status=FAILURE`, `feature.status_reason=ERR_CHALLENGE`.

> Solving the challenge (and any required resubmission/proof) was not completed in this automated capture, so the post-challenge chat stream was not observed.

---

## Streaming & Identifiers (observed/expected)

- **Transport (expected):** `Accept: text/event-stream` on `POST /duckchat/v1/chat` (SSE-style stream typical for this endpoint family); exact frame/event schema not captured due to `ERR_CHALLENGE`.
- **Conversation URL:** `https://duck.ai/?chatID=<conversationId>`
- **Key identifiers:** `x-ddg-journey-id` (journey), `x-duckai-response-id` (response), `durableStream.conversationId` / `durableStream.messageId`, plus `x-vqd-hash-1` challenge context.

---

## Telemetry (observed)

Duck.ai emits client telemetry to `https://improving.duckduckgo.com` (pixels/beacons and `/e` events), e.g.:
- `wide_event_duck-chat-auth_token` (auth token outcome), UI impressions (`dc_impression`, onboarding, suggested prompts, recent chats), and interaction outcomes such as `wide_event_duck-chat-interaction_complete` with `status_reason=ERR_CHALLENGE` on blocked attempts.

These are analytics/diagnostic signals, not required to understand the core chat protocol, but they appear alongside normal flows.

---

## Gaps & Next Steps

- **Complete a successful turn:** solve/pass the anomaly challenge in a non-automated or challenge-capable session to capture the actual `text/event-stream` frames and response schema.
- **Deobfuscate challenge/proof:** trace frontend bundles (`/dist/duckai-dist/entry.*.js`, vendors/lib) to fully map `x-vqd-hash-1` / `x-fe-signals` generation and challenge solution submission.
- **Token lifecycle:** clarify `auth/token` semantics for logged-in/subscribed tiers and how `grant`/VQD values evolve across turns.
- **Durable/encrypted stream:** document how `durableStream.publicKey` (RSA-OAEP-256) is used (key exchange, encrypted chunks, resume).
- **Model & tool matrix:** enumerate available `model` aliases and tool/consent behaviors from `capabilities` across tiers/builds.

---

## Limitations & Notes

- **Partial capture:** chat completion/stream not observed; blocked by `ERR_CHALLENGE` (418) with anomaly image challenge.
- **Ephemeral/versioned:** endpoints, headers, challenge payloads, hashes, model aliases, and build IDs (`serp_*`, bundle hashes) change over time.
- **Unauthenticated/public tier:** observed as `accessLevel: "public"`, `tier=free`.
- **Sensitive artifacts:** captured examples include opaque/base64 blobs, journey IDs, and challenge data — treat as session-specific.
- **Use responsibly:** unofficial interface; for interoperability research/defensive understanding and in accordance with applicable terms and law.

---

*Generated from live Chromium captures of `duck.ai` (duckchat v1), 2026-11-13.*