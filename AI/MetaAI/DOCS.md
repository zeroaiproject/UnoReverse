# Meta AI (meta.ai) — Reverse Engineering

> **Target:** `https://www.meta.ai/` (Meta AI web assistant)  
> **Scope:** Unofficial web-client interface — observed bootstrap/API surfaces, logged-out behavior, and inferred chat transport hints from a Chromium capture.  
> **Date:** 2026-11-13 · **Method:** Chromium capture (Playwright-bundled Chromium 1254, headless, Puppeteer-driven) · **Status:** ⚠️ partial capture — logged-out chat submission gated by TOS dialog; **no prompt/message completion request or stream captured**

---

## Table of Contents

- [Overview](#overview)
- [Capture Environment](#capture-environment)
- [High-Level Architecture](#high-level-architecture)
- [Observed Flow (Logged Out)](#observed-flow-logged-out)
- [Endpoints & Surfaces](#endpoints--surfaces)
  - [POST /api/graphql](#1-post-apigraphql)
  - [POST /api/analytics](#2-post-apianalytics)
- [Chat Transport Hints (CSP)](#chat-transport-hints-csp)
- [UI / Interaction Signals](#ui--interaction-signals)
- [Cookies & Client State](#cookies--client-state)
- [Gaps & Limitations](#gaps--limitations)
- [Limitations & Notes](#limitations--notes)

---

## Overview

Meta AI's web app (`www.meta.ai`, Next.js on Vercel behind Meta/FB edge infrastructure) exposes a logged-out landing experience with a prompt composer. In this automated, logged-out capture the client bootstrapped session/credential state via GraphQL and telemetry via analytics, but attempting to send a prompt triggered a **Terms of Service (TOS) dialog** instead of dispatching a chat request. As a result, the actual prompt transport (HTTP mutation and/or WebSocket stream) and response format were **not observed**.

**Captured context (attempted):**
| Item | Value |
|---|---|
| Page | `https://www.meta.ai/` ("Meta AI - Your AI Assistant for Images, Shopping and More") |
| UI input | `input[aria-label="Ask Meta AI"]`, placeholder `Ask Meta AI anything...` |
| Prompt typed | `Reply with exactly: PONG` |
| Send action | Clicked `button[aria-label="Send"]` (UI event logged) |
| Outcome | `tos_dialog_impression` logged; no chat completion/request/stream captured |

---

## Capture Environment

| Component | Detail |
|---|---|
| Browser | `/root/.cache/ms-playwright/chromium-1254/chrome-linux64/chrome` (headless, `--no-sandbox`) |
| Automation | Puppeteer (Chromium-driven) |
| User-Agent | `Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36` |
| Locale | `en-US,en` |
| Viewport | `1280×900` |
| Auth state | Logged out / anonymous (observed: `userID: 0`, `experience: "logged_out"`) |

---

## High-Level Architecture

- **Frontend:** Next.js SPA (`/_next/static/immutable/chunks/*`) hosted on Vercel, fronted by Meta proxy/edge (`x-fb-*`/via headers observed).
- **App/API (same origin):** `POST /api/graphql` (document-id based GraphQL), `POST /api/analytics` (client telemetry/events).
- **Identity/session bootstrap:** temp-user/credential fetch via GraphQL (`fetchTempUserCredentials`) with `tosIsAccepted` signaling.
- **Likely chat transport (from CSP, not exercised):** WebSocket endpoints allowed in `connect-src` include `wss://gateway.meta.ai`, `wss://edge-chat-latest.meta.ai`, `wss://edge-chat.meta.ai`, `wss://shortwave.meta.ai` (and additional Meta realtime hosts) — consistent with streaming chat over WebSockets, but **not captured** here.
- **Telemetry:** Sentry (tracing/baggage, CSP report-uri) and first-party analytics batching.

---

## Observed Flow (Logged Out)

```text
[Load https://www.meta.ai/]
        │
        ├─► GET  /, /_next/static/* assets
        │
        ├─► POST /api/graphql
        │        body: {"doc_id":"2943394199ee6545d1f0c69d5b6e577f","variables":{}}
        │        └─◄ {"data":{"fetchTempUserCredentials":{
        │               "errorType":null,"errorMessage":null,"accessToken":null,
        │               "viewer":null,"success":true,"tosIsAccepted":false
        │            }}}
        │
        ├─► POST /api/analytics  (impressions, initialLoad, trace/QPL)
        │        └─◄ {"success":true,"logged":...}
        │
[User types prompt + clicks Send]
        │
        ├─► (client logs) send_message / logged_out_composer_send
        └─► (client logs) tos_dialog_impression  → TOS dialog shown
             => no chat GraphQL mutation / WebSocket message / completion stream observed
```

---

## Endpoints & Surfaces

### 1) `POST /api/graphql`

Document-ID (persisted-query style) GraphQL endpoint.

**Request (observed):**
```http
POST /api/graphql HTTP/2
Host: www.meta.ai
Content-Type: application/json
Origin: https://www.meta.ai
Referer: https://www.meta.ai/
Cookie: rd_challenge=<...>; datr=<...>; wd=1280x900; dpr=1
```
```json
{ "doc_id": "2943394199ee6545d1f0c69d5b6e577f", "variables": {} }
```

**Response (200, observed):**
```json
{
  "data": {
    "fetchTempUserCredentials": {
      "errorType": null,
      "errorMessage": null,
      "accessToken": null,
      "viewer": null,
      "success": true,
      "tosIsAccepted": false
    }
  }
}
```

**Notes:** bootstraps logged-out/temp credentials state; `tosIsAccepted:false` aligns with send being gated by a TOS dialog. Other GraphQL operations (prompt send, thread, streaming control) were **not observed**.

### 2) `POST /api/analytics`

Batched client telemetry (impressions, interactions, navigation/initial-load traces).

- **Request:** `Content-Type: application/json`; payload includes `events[]`, `interactions[]`, `navigations[]`, `initialLoad` (trace/QPL/timing/annotations, `userID:0`, `experience:"logged_out"`, `tracePolicy:"ecto.home"`).
- **Response:** `200 {"success":true,"logged":<n>}`.

**Observed events relevant to send gating (example):** `artifact_prompt_composer_impression`, `home_page_impression`, `logged_out_composer_first_input`, `send_message` (action on `EctoLoggedOutComposer`), `logged_out_composer_send` (metadata incl. `messageLength`), `tos_dialog_impression` (target `EctoLoggedOutTOSDialog`).

---

## Chat Transport Hints (CSP)

Response CSP `connect-src` (observed) allows, among others:
- `https://www.meta.ai`, `https://*.meta.ai`, `https://*.facebook.com`
- `wss://gateway.meta.ai`
- `wss://edge-chat-latest.meta.ai`
- `wss://edge-chat.meta.ai`
- `wss://shortwave.meta.ai`
- multiple regional Meta realtime hosts: `wss://*.prn{0,1,2}.facebook.com:*`, `wss://*.frc{0,1,2}.facebook.com:*`, `wss://*.ash{0,1}.facebook.com:*`, `wss://*.cco0.facebook.com:*`, `wss://*.lax0.facebook.com:*`, `wss://*.atl0.facebook.com:*`, `wss://*.dfw0.facebook.com:*`, `wss://*.lla0.facebook.com:*`, `wss://*.atn0.facebook.com:*`, `wss://*.ftw0.facebook.com:*`, `wss://*.rva0.facebook.com:*`, `wss://*.pnb0.facebook.com:*`

These strongly suggest real-time chat/streaming over WebSockets, but no WebSocket connection or message frames were captured in this session.

---

## UI / Interaction Signals

- Composer input: `input[type="text"][aria-label="Ask Meta AI"]` with placeholder `Ask Meta AI anything...`.
- Send control: `button[aria-label="Send"]` (clicked in capture); interaction logged as `send_message`/`logged_out_composer_send`.
- Gating: `tos_dialog_impression` (`EctoLoggedOutTOSDialog`) fired after send attempt in logged-out state (`tosIsAccepted:false`).

---

## Cookies & Client State

Cookies observed in requests (values session-specific): `rd_challenge`, `datr`, `wd` (e.g. `1280x900`), `dpr` (`1`). Telemetry reports `userID: 0`, `experience: "logged_out"`, session/trace identifiers.

---

## Gaps & Limitations

- **No chat completion captured:** prompt submission was blocked by TOS dialog in logged-out flow; actual send mutation/transport and assistant stream/response schema not observed.
- **No WebSocket traffic captured:** despite CSP hints (`gateway/edge-chat/shortwave`), no WS handshake/messages recorded.
- **GraphQL surface incomplete:** only `fetchTempUserCredentials` (`doc_id 2943394199ee6545d1f0c69d5b6e577f`) observed; prompt/thread/mutation doc_ids unknown.
- **Auth/TOS states:** behavior after accepting TOS and/or authenticating not captured.
- **Automation factors:** headless environment may influence gating/anti-automation; not isolated.

## Limitations & Notes

- **Partial, best-effort:** documents only what was observable without completing TOS/auth-gated chat.
- **Ephemeral/versioned:** `doc_id` values, chunk hashes, CSP endpoints, cookie names, and UI identifiers change over time.
- **Sensitive/opaque:** cookies and trace/session IDs are session-specific.
- **Use responsibly:** unofficial interface; for interoperability research/defensive understanding and in accordance with applicable terms and law.

---

*Generated from live Chromium captures of `www.meta.ai` (logged-out), 2026-11-13.*
