# ChatGPT Web (unauth-mweb) — Reverse Engineering

> **Target:** `https://chatgpt.com/` (unauthenticated *unauth-mweb* / "octane" shell)  
> **Scope:** Unofficial web-client interface (not the OpenAI developer API) — bootstrap, sentinel/anti-abuse, conversation submit, and streamed response.  
> **Date:** 2026-11-13 · **Method:** Chromium capture (Playwright-bundled Chromium 1254, headless) · **Status:** ✅ end-to-end conversation turn captured (`PONG`)

---

## Table of Contents

- [Overview](#overview)
- [Capture Environment](#capture-environment)
- [High-Level Architecture](#high-level-architecture)
- [End-to-End Flow](#end-to-end-flow)
- [Endpoints & Payloads](#endpoints--payloads)
  - [Sentinel: chat-requirements prepare](#1-post-unauth-mwebsentinelchat-requirementsprepare)
  - [Conversation prepare](#2-post-unauth-mwebconversationpreparelightweight_authenticated0)
  - [Sentinel: chat-requirements finalize](#3-post-unauth-mwebsentinelchat-requirementsfinalize)
  - [Conversation submit & stream (updates)](#4-post-unauth-mwebconversationupdateslightweight_authenticated0operationiduuid)
  - [Sentinel ping](#5-post-unauth-mwebsentinelping)
  - [Auth / beacons](#6-auth--beacon-probes)
- [Stream Protocol (NDJSON)](#stream-protocol-ndjson)
- [Tokens & Session Artifacts](#tokens--session-artifacts)
- [Client Assets & Telemetry](#client-assets--telemetry)
- [Example: Captured Turn](#example-captured-turn)
- [Gaps & Next Steps](#gaps--next-steps)
- [Limitations & Notes](#limitations--notes)

---

## Overview

This document describes the observed **unauthenticated ChatGPT web flow** on `chatgpt.com`'s *unauth-mweb* client. A full conversation turn was successfully reproduced via automated Chromium:

| Item | Value (captured example) |
|---|---|
| Prompt | `Reply with exactly: PONG` |
| Assistant output | `PONG` |
| Conversation | `https://chatgpt.com/uc/6af7769c-b358-83ea-91dd-1ed7377e6bc0` |
| `conversationId` | `6af7769c-b358-83ea-91dd-1ed7377e6bc0` |
| `operationId` | `8f21fb37-0b08-49a3-964b-aa82c4800123` |
| `oai-session-id` | `edaafb08-a3ea-41c9-9371-6247e985bf6c` |
| User message ID | `92256950-28f5-4456-8f00-e5ae54f88984` |
| Assistant message ID | `aca6515e-7af2-4ef0-b357-05a72c1ba43b` |

> All IDs, tokens, build hashes, and schemas are **ephemeral/versioned** and session-bound.

---

## Capture Environment

| Component | Detail |
|---|---|
| Browser | `/root/.cache/ms-playwright/chromium-1254/chrome-linux64/chrome` (headless) |
| Automation | Puppeteer (Chromium-driven) |
| User-Agent (observed context) | `Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36` |
| Locale / TZ | `en-US,en` · `UTC` (offset `0`) |
| Viewport / screen (reported) | page `1280×900`, screen `800×600`, pixel ratio `1` |

---

## High-Level Architecture

- **Client shell:** *unauth-mweb* / "octane" SPA served from `chatgpt.com`, assets under `/unauth-mweb/assets/...`.
- **Modular bundles observed:** sentinel/prewarm & chat-requirements runtime, conversation prepare/followup/retry/control/observer/handoff/history, backend-api helpers, image/attachment pipelines.
- **Identity/session hints:** `oai-session-id`, `persona` (`chatgpt-noauth`), unified sessions empty when unauthenticated.
- **Conversation transport:** `POST .../conversation/updates` (submit) returning a **streamed NDJSON** response (`application/vnd.openai.conversation-source+ndjson`, `version: 2`) with `control`/`shared`/`content`/`state`/`end` frames.
- **Anti-abuse/sentinel:** chat-requirements `prepare` → `finalize`, `proofToken` / `turnstileToken` / `chatRequirementsToken` on submit, and `sentinel/ping` with sentinel/session headers.

---

## End-to-End Flow

```text
[Load SPA + /unauth-mweb/assets]
        │
        ├─► POST /unauth-mweb/sentinel/chat-requirements/prepare  {p:"<opaque>"}
        │        └─◄ { persona:"chatgpt-noauth", prepare_token:"..." }
        │
        ├─► POST /unauth-mweb/conversation/prepare?lightweight_authenticated=0
        │        └─◄ { conduit_token:<JWT ES256>, prepare_cadence_enabled:true }
        │
        ├─► GET  /api/auth/account-picker            ─► {"unified_sessions":[]}
        └─► GET  /backend-anon/beacons/home?product=chatgpt

[User submits prompt]
        │
        ├─► POST /unauth-mweb/sentinel/chat-requirements/finalize  {prepare_token:"..."}
        │
        ├─► POST /unauth-mweb/conversation/updates?lightweight_authenticated=0&operationId=<uuid>
        │        (form: prompt, chatRequirementsToken, proofToken, turnstileToken,
        │         oai-session-id, assistantMessageId, userMessageId, conversationState, ...)
        │        └─◄ 200 stream: application/vnd.openai.conversation-source+ndjson
        │              control(started) → conversation-id + stopConduitToken
        │              → resume-token → content(DIL/markdown) → state → terminal → end
        │
        └─► POST /unauth-mweb/sentinel/ping  (openai-sentinel-chat-requirements-token, oai-session-id)
```

---

## Endpoints & Payloads

### 1) `POST /unauth-mweb/sentinel/chat-requirements/prepare`

Bootstraps sentinel/chat requirements for the unauth persona.

**Request** (`application/json`)
```json
{
  "p": "<opaque base64/encrypted blob>"
}
```

**Response** (`application/json`)
```json
{
  "persona": "chatgpt-noauth",
  "prepare_token": "gAAAAABq93V7ABtr..."
}
```

---

### 2) `POST /unauth-mweb/conversation/prepare?lightweight_authenticated=0`

Prepares conversation/conduit context (unauth).

**Request** (`application/x-www-form-urlencoded`)

| Field | Example / shape |
|---|---|
| `conversationRetryOwner` | `{"mode":"anonymous","sessionEpoch":null}` |
| `conversationState` | `{"messages":[],"parentMessageId":"client-created-root","userMessageCount":0}` |
| `clientContextualInfo` | `{"app_name":"chatgpt.com","has_web_push_capabilities":true,"is_dark_mode":false,"web_push_notification_permission":"default","page_height":900,"page_width":1280,"pixel_ratio":1,"screen_height":600,"screen_width":800,"time_since_loaded":1}` |
| `timezone` | `UTC` |
| `timezoneOffsetMinutes` | `0` |

**Response** (`application/json`)
```json
{
  "conduit_token": "eyJhbGciOiJFUzI1NiIsInR5cCI6IkpXVCJ9.<payload>.<sig>",
  "prepare_cadence_enabled": true
}
```

`conduit_token` (JWT, ES256) payload fields observed: `conduit_uuid`, `conduit_location`, `cluster`, `iat`, `exp`, `turn_topic_id` (nullable).

---

### 3) `POST /unauth-mweb/sentinel/chat-requirements/finalize`

Finalizes prepared chat requirements before/around submit.

**Request** (`application/json`)
```json
{
  "prepare_token": "gAAAAABq93aNsEr5..."
}
```

**Response:** (not fully characterized here; observed as part of successful turn flow.)

---

### 4) `POST /unauth-mweb/conversation/updates?lightweight_authenticated=0&operationId=<uuid>`

Primary **submit + stream** endpoint for a conversation turn.

#### Submit request (`application/x-www-form-urlencoded`, POST)

| Field | Observed example / notes |
|---|---|
| `prompt` | `Reply with exactly: PONG` |
| `chatRequirementsToken` | opaque token (required; correlates with sentinel) |
| `proofToken` | opaque token |
| `turnstileToken` | opaque token |
| `oai-session-id` | `edaafb08-a3ea-41c9-9371-6247e985bf6c` |
| `assistantMessageId` | `pending-7c517607-bbdf-4d7c-a86c-430f53c8cbeb` |
| `userMessageId` | `92256950-28f5-4456-8f00-e5ae54f88984` |
| `conversationState` | `{"messages":[],"parentMessageId":"client-created-root","safety":{"dismissedInterventionIds":[]},"userMessageCount":0}` (first turn) |
| `conversationRetryOwner` | `{"mode":"anonymous","sessionEpoch":null}` |
| `clientContextualInfo` | app/page/screen/push/dark-mode + `time_since_loaded` |
| `timezone` / `timezoneOffsetMinutes` | `UTC` / `0` |
| `imageAttachments` | `[]` |
| `pendingImageUploads` | `[]` |
| `imageSaveData` | `off` |
| `imageEffectiveType` | `4g` |
| `messageMetadata` | *(empty/varies)* |
| `workOrigin` / `workModel` / `workEffort` / `workTier` | *(empty in observed turn)* |
| `timingToken` | `[1,null]` (observed) |
| `telemetryToken` | *(empty in observed turn)* |

#### Streamed response

- **Content-Type:** `application/vnd.openai.conversation-source+ndjson`
- **Format:** NDJSON — one JSON object per line, all with `"version": 2`
- **Frame types:** `control`, `shared`, `content`, `state`, `end` (see [Stream Protocol](#stream-protocol-ndjson))

---

### 5) `POST /unauth-mweb/sentinel/ping`

Observed during/around the turn as part of sentinel/anti-abuse.

**Headers (observed, notable):**
- `openai-sentinel-chat-requirements-token: <token>`
- `oai-session-id: <session uuid>`
- `oai-echo-logs` (present)
- additional sentinel/affinity headers may be present in full context

**Body:** empty in observed requests.

---

### 6) Auth / beacon probes

| Endpoint | Method | Observed response |
|---|---|---|
| `/api/auth/account-picker` | GET | `{"unified_sessions":[]}` |
| `/backend-anon/beacons/home?product=chatgpt` | GET | `{"beacon_ui_response":null}` |

---

## Stream Protocol (NDJSON)

Each line is a JSON object: `{"version":2,"type":...}`.

### Frame overview

| `type` | Purpose | Key fields |
|---|---|---|
| `control` | Lifecycle & metadata | `detail.kind`, `detail.operationId`, `streamType`, tokens/IDs, latency |
| `shared` | UI/template fragments | `html` (template snippets) |
| `content` | Assistant content | `messageId`, `revision`, `mode`, `markdown`, `dil`, `status` |
| `state` | Conversation state sync | `conversationState` (JSON string), `safety` |
| `end` | Stream terminator | — |

### Control `kind` values observed

`started` · `conversation-id` (+`canonicalPath`, `stopConduitToken`) · `resume-token` · `assistant-content-started` · `last-token-received` · `turn-latency` · `terminal-received` (`terminalKind:"complete"`, `transportOnly:true`)

### Examples

**`control` — started**
```json
{
  "version": 2,
  "type": "control",
  "detail": {
    "operationId": "8f21fb37-0b08-49a3-964b-aa82c4800123",
    "streamType": "initial",
    "kind": "started"
  }
}
```

**`control` — conversation-id** (includes `stopConduitToken`)
```json
{
  "version": 2,
  "type": "control",
  "detail": {
    "operationId": "8f21fb37-0b08-49a3-964b-aa82c4800123",
    "streamType": "initial",
    "kind": "conversation-id",
    "conversationId": "6af7769c-b358-83ea-91dd-1ed7377e6bc0",
    "canonicalPath": "/uc/6af7769c-b358-83ea-91dd-1ed7377e6bc0"
  },
  "stopConduitToken": "<JWT ES256>"
}
```

**`control` — resume-token**
```json
{
  "version": 2,
  "type": "control",
  "detail": {
    "operationId": "8f21fb37-0b08-49a3-964b-aa82c4800123",
    "streamType": "initial",
    "kind": "resume-token",
    "conversationId": "6af7769c-b358-83ea-91dd-1ed7377e6bc0",
    "resumeToken": "<JWT ES256>"
  }
}
```

**`content` — assistant output (DIL)**
```json
{
  "version": 2,
  "type": "content",
  "messageId": "aca6515e-7af2-4ef0-b357-05a72c1ba43b",
  "revision": 1,
  "mode": "replace",
  "markdown": "",
  "status": "streaming",
  "dil": {
    "kind": "dil",
    "renderer": "dil-v2",
    "status": "pending",
    "constants": { "0": "PONG" },
    "fallbackMarkdown": "PONG",
    "appData": { "opGenui": { "componentResults": {}, "interactionSurface": "mainline", "modelDataBindings": {} } },
    "viewState": { "widgets": {} }
  },
  "streamingParent": {
    "metadata": {
      "streaming_parent_id": "92256950-28f5-4456-8f00-e5ae54f88984",
      "streaming_parent_revision": 0
    }
  }
}
```

**`content` — completion append**
```json
{
  "version": 2,
  "type": "content",
  "messageId": "aca6515e-7af2-4ef0-b357-05a72c1ba43b",
  "revision": 2,
  "mode": "append",
  "baseRevision": 1,
  "markdown": "",
  "status": "complete",
  "streamingParent": {
    "metadata": {
      "streaming_parent_id": "92256950-28f5-4456-8f00-e5ae54f88984",
      "streaming_parent_revision": 0
    }
  }
}
```

**`state` — conversation sync**
```json
{
  "version": 2,
  "type": "state",
  "conversationState": "{\"backendConversationId\":\"6af7769c-b358-83ea-91dd-1ed7377e6bc0\",\"messages\":[],\"parentMessageId\":\"aca6515e-7af2-4ef0-b357-05a72c1ba43b\",\"userMessageCount\":1}",
  "safety": { "dismissedInterventionIds": [] }
}
```

**`control` — terminal & `end`**
```json
{
  "version": 2,
  "type": "control",
  "detail": {
    "kind": "terminal-received",
    "operationId": "8f21fb37-0b08-49a3-964b-aa82c4800123",
    "streamType": "initial",
    "conversationId": "6af7769c-b358-83ea-91dd-1ed7377e6bc0",
    "messageId": "aca6515e-7af2-4ef0-b357-05a72c1ba43b",
    "terminalKind": "complete",
    "transportOnly": true
  }
}
```
```json
{ "version": 2, "type": "end" }
```

---

## Tokens & Session Artifacts

| Artifact | Where seen | Notes |
|---|---|---|
| `persona` | sentinel prepare response | `chatgpt-noauth` (unauth) |
| `prepare_token` | sentinel prepare/finalize | opaque (`gAAAAA...`) |
| `conduit_token` | conversation prepare response | JWT ES256 (`conduit_uuid`, `conduit_location`, `cluster`, `iat`, `exp`, `turn_topic_id`) |
| `stopConduitToken` | stream `conversation-id` control | JWT ES256 (stream/turn control) |
| `resumeToken` | stream `resume-token` control | JWT ES256 (includes `turn_topic_id` like `conversation-turn-...`) |
| `chatRequirementsToken` | submit + sentinel ping header | opaque anti-abuse/requirements token |
| `proofToken`, `turnstileToken` | submit form | anti-abuse/proof tokens |
| `oai-session-id` | submit, headers | session UUID |
| `operationId` | updates query | per-turn operation UUID |

> Token provenance/generation (client-side sentinel/proof/turnstile logic) not fully mapped here.

---

## Client Assets & Telemetry

- **Static modules** (`/unauth-mweb/assets/`, hashed): sentinel prewarm/runtime & chat-requirements, conversation prepare/followup/retry/control/observer/handoff/history, backend-api helpers, image/attachment pipelines.
- **Telemetry/events observed:** `POST /unauth-mweb/events/statsc/flush?lightweight_authenticated=0`, `POST /unauth-mweb/events/performance?lightweight_authenticated=0`, `POST /unauth-mweb/events/business` (e.g. `composer_focused`, `composer_input_started`).

---

## Example: Captured Turn

**Request (conceptual, form fields):**
```http
POST /unauth-mweb/conversation/updates?lightweight_authenticated=0&operationId=8f21fb37-0b08-49a3-964b-aa82c4800123
Content-Type: application/x-www-form-urlencoded

prompt=Reply%20with%20exactly%3A%20PONG
&oai-session-id=edaafb08-a3ea-41c9-9371-6247e985bf6c
&assistantMessageId=pending-7c517607-bbdf-4d7c-a86c-430f53c8cbeb
&userMessageId=92256950-28f5-4456-8f00-e5ae54f88984
&conversationState={"messages":[],"parentMessageId":"client-created-root","safety":{"dismissedInterventionIds":[]},"userMessageCount":0}
&chatRequirementsToken=<...>&proofToken=<...>&turnstileToken=<...>
&conversationRetryOwner={"mode":"anonymous","sessionEpoch":null}
&timezone=UTC&timezoneOffsetMinutes=0
&imageAttachments=[]&pendingImageUploads=[]&imageSaveData=off&imageEffectiveType=4g
```

**Outcome:** stream produced `conversationId=6af7769c-b358-83ea-91dd-1ed7377e6bc0`, canonical `/uc/6af7769c-b358-83ea-91dd-1ed7377e6bc0`, assistant content `PONG` (DIL v2, `fallbackMarkdown:"PONG"`), state `userMessageCount:1`, `terminalKind: complete`, then `end`.

---

## Gaps & Next Steps

- **Token provenance:** fully map client-side generation of `chatRequirementsToken`, `proofToken`, `turnstileToken`, and correlate `conduit_token` / `stopConduitToken` / `resumeToken` to stream lifecycle & reconnection/resume.
- **State evolution:** capture multi-turn follow-ups, retries, edits, attachments to confirm `conversationState` / parent & message ID chaining.
- **Protocol depth:** trace unauth-mweb bundles for request builders, sentinel/proof logic, and NDJSON/DIL stream parsing/rendering; compare modes/regions/builds.

---

## Limitations & Notes

- **Unofficial & ephemeral:** endpoints, params, tokens, build/asset hashes, and schemas are versioned, session-bound, and subject to change without notice.
- **Unauthenticated context only:** observed under `persona=chatgpt-noauth` / `unified_sessions=[]`.
- **Captured content:** includes opaque tokens/blobs and a single benign test prompt/response (`PONG`).
- **Use responsibly:** for interoperability research/defensive understanding; comply with applicable terms and law.

---

*Generated from live Chromium captures of `chatgpt.com` (unauth-mweb), 2026-11-13.*
---

## Client

A zero-dependency Node.js client and CLI live in [`ChatGPTAPI.js`](./ChatGPTAPI.js) / [`src/`](./src/), implementing the observed unauth-mweb flow end-to-end where the inputs are known.

- **Flow:** `conversation/prepare` (conduit token) → optional sentinel prepare/finalize (when `p` is supplied) → `POST /conversation/updates?...&operationId=` → NDJSON v2 stream decoded into `control`/`state`/`text_delta`/`text_replace`/`end`.
- **Anti-abuse tokens:** `chatRequirementsToken`, `proofToken`, `turnstileToken` are browser-generated and were not reverse-engineered. Supply them via `tokens`/CLI flags, or a `getRequirements(context)` hook that receives the session/prepare context and returns them. Missing tokens fail with a clear hint (submit can be forced for debugging with `allowMissingTokens`).
- **Stateful turns:** the server's `state` frames return `conversationState` (with `backendConversationId`/`parentMessageId`) for follow-ups.
- **Offline tests:** mocked NDJSON streams (`node --test AI/ChatGPT/test/*.test.js`).

```bash
node AI/ChatGPT/ChatGPTAPI.js "Reply with exactly: PONG" \
  --requirements-token ... --proof-token ... --turnstile-token ... --json
```

```js
import { chatGPTChat, ChatGPTClient } from "./AI/ChatGPT/ChatGPTAPI.js";

const client = new ChatGPTClient({
  tokens: { chatRequirementsToken, proofToken, turnstileToken },
  // or: getRequirements: async (ctx) => acquireTokensFromBrowser(ctx),
});
const res = await client.chat({ prompt: "Reply with exactly: PONG" });
// res = { ok, answer, conversationId, conversationState, sessionId, frames, ... }
```
