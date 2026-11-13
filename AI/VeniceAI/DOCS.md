# Venice.ai (Web Agent / v2 Chat) — Reverse Engineering

> **Target:** `https://venice.ai/` (Venice web chat / agent interface)  
> **Primary API origin:** `https://outerface.venice.ai` (observed)  
> **Scope:** Unofficial web-client interface — navigation/bootstrap, identity/attestation, rate-limits, and agent inference request contract as observed in a signed-out automated session.  
> **Date:** 2026-11-13 · **Method:** Chromium capture (Playwright-bundled Chromium 1254, headless, Puppeteer-driven) · **Status:** ⚠️ protocol partially captured; end-to-end chat completion/stream **not** captured (client attestation reports `webdriver:true`; inference requests retried without a usable streamed completion body)

---

## Table of Contents

- [Overview](#overview)
- [Capture Environment](#capture-environment)
- [High-Level Architecture](#high-level-architecture)
- [Observed Flow](#observed-flow)
- [Client Identity & Context](#client-identity--context)
- [Endpoints](#endpoints)
  - [POST /api/app/user/client_attestation/mint](#1-post-apippuserclient_attestationmint)
  - [GET /api/app/models](#2-get-apiappmodels)
  - [GET /api/app/user_country](#3-get-apiappuser_country)
  - [GET /api/inference/rate-limits](#4-get-apiinferencerate-limits)
  - [POST /api/inference/chat/agents/venice](#5-post-apiinferencechatagentsvenice)
  - [App / Auth-adjacent (observed)](#6-app--auth-adjacent-observed)
- [Client Attestation Token (JWT)](#client-attestation-token-jwt)
- [Agent Inference Request Contract](#agent-inference-request-contract)
- [Streaming Intent & Retry Behavior](#streaming-intent--retry-behavior)
- [Automation / WebDriver Limitation](#automation--webdriver-limitation)
- [Gaps & Next Steps](#gaps--next-steps)
- [Limitations & Notes](#limitations--notes)

---

## Overview

The Venice web app (Next.js, served from `venice.ai`, behind Cloudflare/Vercel) routes chat interactions to an agent-style interface and performs inference against `outerface.venice.ai`. Before (and during) inference attempts the client mints **client attestation** tokens (ES256 JWTs) describing the runtime environment and attaches them to inference requests along with versioning, locale, distinct-id, and tracing headers.

In this capture the environment was **anonymous/signed-out** (Clerk) and automated (`webdriver:true`). Attestation minting and surrounding metadata requests were observed, and multiple inference POSTs were issued with the expected contract (`Accept: text/event-stream`, `clientTools` + `input.messages`), but **no successful completion stream or response body was captured** — requests were retried (`x-retry-count` incrementing) consistent with attestation/environment rejection.

**Captured example (attempted turn):**
| Item | Value |
|---|---|
| Entry | `https://venice.ai/chat/v2` → redirect to `https://venice.ai/chat/agent` (agent session URL observed) |
| Prompt | `Reply with exactly: PONG` |
| Inference endpoint | `POST https://outerface.venice.ai/api/inference/chat/agents/venice` |
| Stream intent | `Accept: text/event-stream` |
| Distinct ID | `01a1d6c3-b978-799e-96d0-98f7bce68051` (observed) |
| Attestation env | `webdriver:true`, `nativeIntegrityOk:true`, `sentryVersion:"10.50.0"` (observed) |
| Result | No captured streamed completion (retries observed; see [Automation / WebDriver Limitation](#automation--webdriver-limitation)) |

---

## Capture Environment

| Component | Detail |
|---|---|
| Browser | `/root/.cache/ms-playwright/chromium-1254/chrome-linux64/chrome` (headless, `--no-sandbox`) |
| Automation | Puppeteer (Chromium-driven) |
| User-Agent | `Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36` |
| Locale | `en-US,en` / `x-venice-locale: en` |
| Viewport | `1280×900` |
| Frontend build (observed) | `interface@20261113.210004+d136d76` (`x-venice-version`) |
| Middleface version (observed) | `0.1.1246` (`x-venice-middleface-version`) |
| Auth state (observed) | Signed out (Clerk headers: `x-clerk-auth-status: signed-out`, `x-clerk-auth-reason: session-token-and-uat-missing`) |

---

## High-Level Architecture

- **Web app:** Next.js SPA on `venice.ai` (hashed `/_next/static/*` assets), PWA manifest (`/manifest.json`, `start_url: /chat`). Pages observed: `/chat/v2` (302 → `/chat/agent`).
- **Identity/auth:** Clerk integration (`clerk.venice.ai`, `@clerk/clerk-js`/`@clerk/ui`), app session probe `GET /api/auth/session` (200 in capture); anonymous/signed-out in this run.
- **Inference/control plane:** `outerface.venice.ai` serves app metadata and chat inference:
  - `GET /api/app/models`, `GET /api/app/user_country`
  - `POST /api/app/user/client_attestation/mint` (issues short-lived attestation JWTs)
  - `GET /api/inference/rate-limits`
  - `POST /api/inference/chat/agents/venice` (agent chat; streamed, SSE-intended)
- **Trust/anti-automation:** client environment is attested via minted JWTs (`env.webdriver`, integrity/hash/globals/version signals) and attached per inference request (`x-venice-client-attestation`).
- **Telemetry/experiments:** Sentry (`sentry-trace`/`baggage`, `/monitoring`), PostHog-style endpoints on `t.venice.ai` (`early_access_features`, `surveys`).

---

## Observed Flow

```text
[Browser]
   │
   ├─► GET  https://venice.ai/chat/v2
   │        └─◄ 302 Location: /chat/agent  (Cloudflare/Vercel; __cf_bm set)
   │
   ├─► GET  https://venice.ai/chat/agent  (200, HTML shell, x-clerk-auth-status: signed-out)
   │        └─ loads Next.js chunks, Clerk JS/UI, session probes
   │
   ├─► GET  /api/auth/session  (venice.ai)                     → 200 (JSON)
   ├─► GET  /api/venice/version?{ts}                           → 200
   ├─► Clerk: /v1/environment, /v1/client                      → 200 (JSON)
   │
   ├─► GET  https://outerface.venice.ai/api/app/models?matureFilter=true&onlySafeVenice=true
   ├─► GET  https://outerface.venice.ai/api/app/user_country
   ├─► POST https://outerface.venice.ai/api/app/user/client_attestation/mint
   │        body: {count:5, env:{nativeIntegrityOk, reactStateHash, sentryVersion, unexpectedGlobalsCount, webdriver}}
   │        └─◄ 200 {expiresAt, tokens:[{nonce, token(JWT ES256)} ... x5]}
   │
   ├─► GET  https://outerface.venice.ai/api/inference/rate-limits
   │
   └─► POST https://outerface.venice.ai/api/inference/chat/agents/venice
            Accept: text/event-stream
            x-venice-client-attestation: <JWT>
            body: {clientTools:[...], input:{messages:[{role:"user", content:[{type:"output_text", text:"..."}], ...}]}}
            └─► (retried with x-retry-count: 1..4 and fresh/rotated attestation tokens; no completion stream captured)
```

---

## Client Identity & Context

Headers/context observed across `outerface.venice.ai` requests:

| Header / field | Example / notes |
|---|---|
| `x-venice-version` | `interface@20261113.210004+d136d76` (frontend build) |
| `x-venice-middleface-version` | `0.1.1246` |
| `x-venice-locale` | `en` |
| `x-venice-request-timestamp-ms` | epoch ms (e.g. `1794604512263`) |
| `x-venice-distinct-id` | anonymous/client distinct UUID (e.g. `01a1d6c3-b978-799e-96d0-98f7bce68051`), present after initial bootstrap |
| `x-venice-client-attestation` | ES256 JWT minted via `/api/app/user/client_attestation/mint` (per-request token from pool) |
| `x-retry-count` | `1`, `2`, `3`, `4` observed on inference retries |
| `sentry-trace` / `baggage` | Sentry distributed tracing (release = interface build, env `vercel-production`) |
| `accept` (inference) | `text/event-stream` |
| `content-type` | `application/json` |

Auth: Clerk signed-out (`x-clerk-auth-status: signed-out`). `POST /chat/v2` is not used directly; the UI transitions to the agent route.

---

## Endpoints

Base for inference/app APIs below: `https://outerface.venice.ai` (unless noted).

### 1) `POST /api/app/user/client_attestation/mint`

Mints a batch of short-lived client-attestation JWTs bound to the observed runtime environment.

**Request**
- **Method:** `POST`
- **Headers (observed):** `content-type: application/json`, `x-venice-version`, `x-venice-middleface-version`, `x-venice-locale`, `x-venice-request-timestamp-ms` (and later `x-venice-distinct-id`)
- **Body (observed):**
```json
{
  "count": 5,
  "env": {
    "nativeIntegrityOk": true,
    "reactStateHash": "b0447632072f076aa8a159db137c2e7e787cfc3212f58bb72e26611cef138b8b",
    "sentryVersion": "10.50.0",
    "unexpectedGlobalsCount": 674,
    "webdriver": true
  }
}
```
(`unexpectedGlobalsCount` varied slightly across mints, e.g. 674/679/679.)

**Response (200, JSON, observed):**
```json
{
  "expiresAt": 1794604812,
  "tokens": [
    { "nonce": "<hex>", "token": "<JWT ES256>" },
    { "nonce": "<hex>", "token": "<JWT ES256>" },
    { "nonce": "<hex>", "token": "<JWT ES256>" },
    { "nonce": "<hex>", "token": "<JWT ES256>" },
    { "nonce": "<hex>", "token": "<JWT ES256>" }
  ]
}
```
- `expiresAt`: Unix seconds (≈ `iat + 300s` per token claims).
- `count: 5` tokens returned per mint (pool consumed/rotated across inference attempts/retries).

---

### 2) `GET /api/app/models`

**Request (observed):** `GET /api/app/models?matureFilter=true&onlySafeVenice=true` (with `x-venice-*` context headers).  
**Response:** 200 JSON (model catalog/metadata; full payload not exhaustively enumerated here, but successfully returned in capture).

### 3) `GET /api/app/user_country`

**Request:** `GET /api/app/user_country`  
**Response:** 200 JSON (country/region context; body not expanded here).

### 4) `GET /api/inference/rate-limits`

**Request:** `GET /api/inference/rate-limits` (queried before and around inference).  
**Response:** 200 observed in flow (structured JSON expected); full body not captured in a readable form in the saved artifacts.

### 5) `POST /api/inference/chat/agents/venice`

Agent chat/inference endpoint. Client signals streaming and supplies tool declarations plus conversation input.

**Request**
- **Method:** `POST`
- **URL:** `https://outerface.venice.ai/api/inference/chat/agents/venice`
- **Headers (observed):** `accept: text/event-stream`, `content-type: application/json`, `x-venice-version`, `x-venice-middleface-version`, `x-venice-locale`, `x-venice-request-timestamp-ms`, `x-venice-distinct-id`, `x-venice-client-attestation` (JWT), `sentry-trace`, `baggage`; `x-retry-count` added on retries (`1`..`4`).
- **Body (shape observed):** see [Agent Inference Request Contract](#agent-inference-request-contract).

**Response (observed):** no usable completion/stream body captured (responses not readable as event-stream in artifacts; client retried). Successful event schema not observed.

### 6) App / Auth-adjacent (observed)

| Origin | Endpoint | Notes |
|---|---|---|
| `venice.ai` | `GET /api/auth/session` | 200 JSON (session probe) |
| `venice.ai` | `GET /api/venice/version?{ts}` | 200 (text/plain observed) |
| `clerk.venice.ai` | `/v1/environment`, `/v1/client`, `@clerk/*` assets | Clerk auth/bootstrap (signed-out) |
| `t.venice.ai` | `/api/early_access_features/?token=...`, `/api/surveys/?token=...` | Feature flags/surveys (PostHog-style token param observed) |

---

## Client Attestation Token (JWT)

Minted tokens are **ES256** JWTs (`alg: ES256` in header) with claims bound to environment and request context.

**Decoded payload example (observed, anonymous):**
```json
{
  "env": {
    "nativeIntegrityOk": true,
    "reactStateHash": "b0447632072f076aa8a159db137c2e7e787cfc3212f58bb72e26611cef138b8b",
    "sentryVersion": "10.50.0",
    "unexpectedGlobalsCount": 674,
    "webdriver": true
  },
  "nonce": "7a4f8f2859c2efdf931e416e806e16c9bf8381af54fde096a33d42ebc2aafc6c",
  "ua": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  "uaHash": "c5b76ff6062b0afb2f75e5962e1e7278ba143dcc568a478cf7024995a4b46575",
  "iss": "urn:venice:issuer",
  "aud": "urn:client_attestation:audience",
  "sub": "anonymous",
  "iat": 1794604512,
  "exp": 1794604812
}
```

**Claim notes (observed/inferred):**
| Claim | Meaning |
|---|---|
| `env.nativeIntegrityOk` | Client integrity signal |
| `env.reactStateHash` | Hash of client/react state (stable across mints in capture) |
| `env.sentryVersion` | Embedded Sentry SDK version (e.g. `10.50.0`) |
| `env.unexpectedGlobalsCount` | Count of unexpected globals (heuristic/anti-tamper signal) |
| `env.webdriver` | **Automation indicator** (`true` in this headless/automated run) |
| `nonce` | Per-token nonce (matches `tokens[].nonce`) |
| `ua`, `uaHash` | User-Agent and its hash |
| `iss` / `aud` | `urn:venice:issuer` / `urn:client_attestation:audience` |
| `sub` | `anonymous` (signed-out) |
| `iat` / `exp` | Issued/expiry (≈ 300s window) |

The client requests a pool (`count: 5`) and rotates tokens per attempt/retry, re-minting as needed.

---

## Agent Inference Request Contract

Observed `POST /api/inference/chat/agents/venice` JSON body:

```json
{
  "clientTools": [
    {
      "name": "approve_paid_usage",
      "description": "Asks the user to approve spending credits on paid usage. Venice calls this itself; never call it.",
      "inputSchema": { "properties": {}, "type": "object" }
    },
    {
      "name": "edit_video",
      "description": "Edit a video from the conversation and produce a new video. ...",
      "inputSchema": {
        "type": "object",
        "properties": {
          "operations": {
            "description": "Ordered list of edit operations applied to the source video.",
            "minItems": 1,
            "type": "array",
            "items": {
              "oneOf": [
                { "type": "object", "properties": { "op": { "const": "trim" }, "start_seconds": { "type": "number", "minimum": 0 }, "end_seconds": { "type": "number", "minimum": 0 } }, "required": ["end_seconds","op","start_seconds"], "additionalProperties": false },
                { "type": "object", "properties": { "op": { "const": "add_audio" }, "source_media_id": { "type": "string", "minLength": 1 }, "mode": { "enum": ["mix","replace"] }, "volume": { "type": "number", "minimum": 0 } }, "required": ["op","source_media_id"], "additionalProperties": false },
                { "type": "object", "properties": { "op": { "const": "concat" }, "source_media_ids": { "type": "array", "minItems": 1, "items": { "type": "string", "minLength": 1 } } }, "required": ["op","source_media_ids"], "additionalProperties": false },
                { "type": "object", "properties": { "op": { "const": "set_volume" }, "factor": { "type": "number", "minimum": 0 } }, "required": ["factor","op"], "additionalProperties": false },
                { "type": "object", "properties": { "op": { "const": "speed" }, "factor": { "type": "number", "exclusiveMinimum": 0 } }, "required": ["factor","op"], "additionalProperties": false },
                { "type": "object", "properties": { "op": { "const": "resize" }, "height": { "type": "integer", "exclusiveMinimum": 0 }, "width": { "type": "integer", "exclusiveMinimum": 0 }, "fit": { "enum": ["contain","cover","fill"] } }, "required": ["height","op","width"], "additionalProperties": false }
              ]
            }
          },
          "source_media_id": { "type": "string", "minLength": 1 }
        },
        "required": ["operations","source_media_id"],
        "additionalProperties": false
      }
    }
  ],
  "input": {
    "messages": [
      {
        "content": [
          { "annotations": [], "text": "Reply with exactly: PONG", "type": "output_text" }
        ],
        "id": "Z8jF8bCdmQdYW0",
        "role": "user",
        "status": "completed",
        "type": "message"
      }
    ]
  }
}
```

**Notes:**
- `clientTools` declares client-executable/mediated tools (e.g. paid-usage approval, rich video editing operations) passed with the turn.
- `input.messages[]` uses structured `content` parts (`type: "output_text"` with `text`/`annotations`) and per-message `id`, `role`, `status`, `type`.
- The same logical message/body was resent across retries; the attestation token and `x-retry-count`/timestamps changed.

---

## Streaming Intent & Retry Behavior

- **Intent:** inference requests set `Accept: text/event-stream` (SSE-style streaming expected), consistent with an agent/chat streaming response.
- **Retries:** the client reissued `POST /api/inference/chat/agents/venice` with `x-retry-count` = `1`, `2`, `3`, `4`, refreshing `x-venice-request-timestamp-ms`, `sentry-trace`, and `x-venice-client-attestation` (and re-minting tokens). No successful stream frames were captured in this environment.
- **Actual event schema:** **not observed** (completion blocked; see below).

---

## Automation / WebDriver Limitation

- Minted attestation tokens embed **`env.webdriver: true`** (alongside integrity/hash/globals signals) for this headless automated browser.
- Inference attempts **did not yield a captured completion/stream** and were retried repeatedly, strongly indicating the attested environment was not accepted for chat generation in this context.
- This is a **protocol observation gap**, not proof of absence of a public/legitimate flow: a non-automated, non-webdriver environment with a valid attestation is expected to be required to observe the full response/event stream.

---

## Gaps & Next Steps

- **Successful completion capture:** run in a non-automated (or non-`webdriver`) context to capture the `text/event-stream` event schema, message assembly, tool-call/result turns, and finish semantics.
- **Rate-limits/models payloads:** record full JSON bodies for `/api/inference/rate-limits`, `/api/app/models`, and `/api/app/user_country`.
- **Conversation/session model:** determine how agent conversation IDs/threads are created and referenced across turns (beyond the observed route/session).
- **Attestation lifecycle:** map token selection/rotation rules, nonce usage, and re-mint triggers precisely.
- **Authenticated flows:** compare signed-in (Clerk session) behavior, `sub`/claims differences, and any capability/rate-limit changes.
- **CORS/preflight:** capture corresponding preflight/response headers on `outerface.venice.ai` for completeness.

---

## Limitations & Notes

- **Partial capture:** no streamed agent completion captured; inference blocked by environment/attestation signals (`webdriver:true`).
- **Ephemeral/versioned:** build IDs (`interface@...`), `x-venice-middleface-version`, hashes, nonces, tokens, distinct IDs, and bundle hashes change over time.
- **Anonymous context:** observed signed-out (Clerk) only.
- **Sensitive/opaque artifacts:** attestation JWTs, distinct IDs, traces, and nonces are session-specific.
- **Use responsibly:** unofficial interface; document for interoperability research/defensive understanding and in accordance with applicable terms and law.

---

*Generated from live Chromium captures of `venice.ai` → `outerface.venice.ai` (chat/agent v2 flow), 2026-11-13.*
