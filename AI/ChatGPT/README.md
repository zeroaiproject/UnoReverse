# ChatGPT Web (unauth-mweb) — Reverse Engineering Notes (Chromium)

Target: `https://chatgpt.com/` (unauthenticated/mobile-web "unauth-mweb" shell)  
Date: 2026-11-13  
Method: automated Chromium captures (Playwright-bundled Chromium 1254, headless) of the unauth-mweb flow: bootstrap/prepare and a **successful end-to-end conversation turn**.

## Scope

Documents the *unofficial unauthenticated web-client interface* observed from the `chatgpt.com` unauth-mweb experience (not the OpenAI developer API), including bootstrap, anti-abuse/sentinel steps, conversation submit, and streamed response.

## Live captures (Chromium)

- Browser: `/root/.cache/ms-playwright/chromium-1254/chrome-linux64/chrome` (headless)

### 1) Bootstrap capture
- Script: `capture_chatgpt.mjs`
- Result: page loaded (`title: "ChatGPT: Chat, Work, Create & Code with AI"`, `url: https://chatgpt.com/`), prompt/composer assets loaded, input focus/start events observed; sentinel and conversation prepare calls captured.
- Artifacts: `home.html`, `home.png`, `after.html`, `page_assets.json`, `network_capture.jsonl`

### 2) Conversation capture (successful)
- Script: `capture_chatgpt_convo.mjs`
- Prompt submitted: `Reply with exactly: PONG`
- Result: conversation created and streamed to completion; assistant replied `PONG`.
- Final page: `https://chatgpt.com/uc/6af7769c-b358-83ea-91dd-1ed7377e6bc0`
- Observed IDs (from this run): `operationId=8f21fb37-0b08-49a3-964b-aa82c4800123`, `oai-session-id=edaafb08-a3ea-41c9-9371-6247e985bf6c`, `conversationId=6af7769c-b358-83ea-91dd-1ed7377e6bc0`, user msg `92256950-28f5-4456-8f00-e5ae54f88984`, assistant msg `aca6515e-7af2-4ef0-b357-05a72c1ba43b`.
- Artifacts: `convo_after.html`, `convo_after.png`, `network_capture_convo.jsonl`, `capture_convo.log`

## Observed architecture

- **Client shell:** "unauth-mweb" / "octane" style frontend (`/unauth-mweb/assets/...`), with modular conversation/sentinel/control bundles and telemetry endpoints.
- **Bootstrap (unauth) flow observed:**
  1. Load SPA/assets and establish document/session context (worker/build identifiers, `oai-session-id` context in telemetry headers).
  2. `POST /unauth-mweb/sentinel/chat-requirements/prepare` → returns `persona` + `prepare_token`.
  3. `POST /unauth-mweb/conversation/prepare?lightweight_authenticated=0` → returns `conduit_token` (JWT/ES256) + `prepare_cadence_enabled`.
  4. Auth/account context probe: `GET /api/auth/account-picker` → `{"unified_sessions":[]}` (unauth).
  5. Anonymous beacon: `GET /backend-anon/beacons/home?product=chatgpt`.
- **Conversation turn flow observed (successful):**
  1. `POST /unauth-mweb/sentinel/chat-requirements/prepare` → `prepare_token`.
  2. `POST /unauth-mweb/sentinel/chat-requirements/finalize` with `{"prepare_token":"..."}` (seen after prepare; a second finalize observed around submit time in captured trace).
  3. Submit prompt: `POST /unauth-mweb/conversation/updates?lightweight_authenticated=0&operationId=<uuid>` (form fields: `prompt`, `chatRequirementsToken`, `proofToken`, `turnstileToken`, `oai-session-id`, `assistantMessageId` pending, `userMessageId`, `conversationState`, `clientContextualInfo`, `conversationRetryOwner`, `timezone`/`timezoneOffsetMinutes`, attachments/metadata, timing fields etc.).
  4. Streamed response on the same updates endpoint: NDJSON `application/vnd.openai.conversation-source+ndjson` (`version/type` frames: `control` started/conversation-id/resume-token/assistant-content-started/last-token-received/turn-latency/terminal-received, `shared` HTML templates, `content` DIL/markdown, `state` updates, final `end`) yielding `conversationId`, `canonicalPath` `/uc/<id>`, `stopConduitToken`, `resumeToken`, and assistant output (DIL `constants["0"]="PONG"` / `fallbackMarkdown:"PONG"`).
  5. `POST /unauth-mweb/sentinel/ping` observed with headers `openai-sentinel-chat-requirements-token` and `oai-session-id` (and related sentinel/affinity headers in context).

## Endpoints & payloads observed

### `POST /unauth-mweb/sentinel/chat-requirements/prepare`
- **Request (JSON):** `{"p":"<opaque base64/encrypted blob>"}`
- **Response (JSON):**
  - `persona`: `"chatgpt-noauth"`
  - `prepare_token`: opaque token string (`gAAAAA...`)

### `POST /unauth-mweb/conversation/prepare?lightweight_authenticated=0`
- **Content-Type:** `application/x-www-form-urlencoded` (observed)
- **Fields (observed):**
  - `conversationRetryOwner`: `{"mode":"anonymous","sessionEpoch":null}`
  - `conversationState`: `{"messages":[],"parentMessageId":"client-created-root","userMessageCount":0}`
  - `clientContextualInfo`: `{"app_name":"chatgpt.com","has_web_push_capabilities":true,"is_dark_mode":false,"web_push_notification_permission":"default","page_height":900,"page_width":1280,"pixel_ratio":1,"screen_height":600,"screen_width":800,"time_since_loaded":1}`
  - `timezone`: `UTC`
  - `timezoneOffsetMinutes`: `0`
- **Response (JSON):**
  - `conduit_token`: JWT (ES256, header `alg=ES256,typ=JWT`; payload observed to include `conduit_uuid`, `conduit_location`, `cluster`, `iat`, `exp`, `turn_topic_id`)
  - `prepare_cadence_enabled`: `true`

### `POST /unauth-mweb/sentinel/chat-requirements/finalize`
- **Request (JSON):** `{"prepare_token":"<token from prepare>"}`
- Used before/around conversation submit (finalize observed in captured turn flow).

### `POST /unauth-mweb/conversation/updates?lightweight_authenticated=0&operationId=<uuid>` (submit + stream)
- **Submit request:** `application/x-www-form-urlencoded` (POST) with fields observed including:
  - `prompt` (user text, e.g. `Reply with exactly: PONG`)
  - `chatRequirementsToken`, `proofToken`, `turnstileToken` (opaque/anti-abuse tokens)
  - `oai-session-id`
  - `assistantMessageId` (e.g. `pending-<uuid>`), `userMessageId`
  - `conversationState` (e.g. `{"messages":[],"parentMessageId":"client-created-root","safety":{"dismissedInterventionIds":[]},"userMessageCount":0}` for first turn)
  - `conversationRetryOwner`, `clientContextualInfo`, `timezone`, `timezoneOffsetMinutes`
  - `imageAttachments=[]`, `pendingImageUploads=[]`, `imageSaveData`, `imageEffectiveType`, `messageMetadata`, `workOrigin/Model/Effort/Tier`, `timingToken`, `telemetryToken` (as seen)
- **Streamed response:** `content-type: application/vnd.openai.conversation-source+ndjson` (NDJSON, one JSON object per line), `version: 2` frames such as:
  - `control` / `kind=started` (operationId, streamType)
  - `shared` (HTML template fragments)
  - `control` / `kind=conversation-id` with `conversationId`, `canonicalPath` (`/uc/<id>`), and `stopConduitToken`
  - `control` / `kind=resume-token` with `resumeToken`
  - `content` (messageId, revision/mode, `markdown`, `dil` renderer/payload with `constants` and `fallbackMarkdown`, status `streaming`→`complete`, `streamingParent`)
  - `control` / `kind=assistant-content-started`, `last-token-received`, `turn-latency` (tags/TTFB/TTFVT metrics), `terminal-received`
  - `state` updates (`conversationState` with `backendConversationId`, `parentMessageId`, `userMessageCount`, `safety`)
  - final `{"version":2,"type":"end"}`

### `POST /unauth-mweb/sentinel/ping`
- Observed during/around turn with headers including `openai-sentinel-chat-requirements-token` and `oai-session-id` (plus other sentinel/affinity headers); used as part of anti-abuse/sentinel flow.

### `GET /api/auth/account-picker`
- **Response:** `{"unified_sessions":[]}` (unauth context)

### `GET /backend-anon/beacons/home?product=chatgpt`
- **Response:** `{"beacon_ui_response":null}`

## Relevant client modules observed (assets)

Static bundles under `/unauth-mweb/assets/` indicate client-side handling for: sentinel prewarm/runtime and chat-requirements (`native-initial-sentinel-prewarm-*`, `native-initial-composer-sentinel-runtime-*`, `sentinel-*`), conversation prepare/followup/retry/control/observer/handoff/history (`conversation-prepare-client-*`, `conversation-followup-*`, `conversation-control-*`, `conversation-retry-*`, `conversation-observer-*`, `conversation-handoff-preparation-*`, `conversation-history-cache-boundary-*`), backend API helpers (`backend-api-*`), and image/attachment pipelines.

## Telemetry/events observed

- `POST /unauth-mweb/events/statsc/flush?lightweight_authenticated=0`
- `POST /unauth-mweb/events/performance?lightweight_authenticated=0`
- `POST /unauth-mweb/events/business` (e.g. `composer_focused`, `composer_input_started`)

## Gaps / next steps

- Map token provenance precisely (how `chatRequirementsToken`/`proofToken`/`turnstileToken` are derived), and correlate `conduit_token`/stop/resume tokens to stream lifecycle and reconnection.
- Capture multi-turn follow-ups and alternative transports/modes (attachments, edits, retries) to confirm state evolution (`conversationState`, parent/message IDs).
- Trace unauth-mweb bundles for request builders, sentinel/proof generation, and NDJSON/DIL stream parsing.

## Limitations

Unauthenticated capture. Tokens, build/asset IDs, endpoint params, and schemas are versioned, ephemeral, and session-bound. Captured artifacts include opaque tokens/blobs and a single test prompt/response (`PONG`). Use only in accordance with applicable terms/law.
