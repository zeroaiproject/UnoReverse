# ChatGPT Web (unauth-mweb) — Reverse Engineering Notes (Chromium)

Target: `https://chatgpt.com/` (unauthenticated/mobile-web "unauth-mweb" shell)  
Date: 2026-11-13  
Method: automated Chromium capture (Playwright-bundled Chromium 1254, headless) loading the home page and attempting a prompt input. Network, assets, and bootstrap API calls were recorded.

## Scope

Documents the *unofficial unauthenticated web-client interface* observed from the `chatgpt.com` unauth-mweb experience (not the OpenAI developer API). Capture is bootstrap/input-start oriented (no completed conversation turn observed).

## Live capture (Chromium)

- Browser: `/root/.cache/ms-playwright/chromium-1254/chrome-linux64/chrome` (headless)
- Script: `capture_chatgpt.mjs`
- Result: page loaded (`title: "ChatGPT: Chat, Work, Create & Code with AI"`, `url: https://chatgpt.com/`), prompt/composer assets loaded, input focus/start events observed; sentinel and conversation prepare calls captured.
- Artifacts: `home.html`, `home.png`, `after.html`, `page_assets.json`, `network_capture.jsonl`, `capture_chatgpt.mjs`

## Observed architecture

- **Client shell:** "unauth-mweb" / "octane" style frontend (`/unauth-mweb/assets/...`), with modular conversation/sentinel/control bundles and telemetry endpoints.
- **Bootstrap (unauth) flow observed:**
  1. Load SPA/assets and establish document/session context (worker/build identifiers, `oai-session-id` context in telemetry headers).
  2. `POST /unauth-mweb/sentinel/chat-requirements/prepare` → returns `persona` + `prepare_token`.
  3. `POST /unauth-mweb/conversation/prepare?lightweight_authenticated=0` → returns `conduit_token` (JWT/ES256) + `prepare_cadence_enabled`.
  4. Auth/account context probe: `GET /api/auth/account-picker` → `{"unified_sessions":[]}` (unauth).
  5. Anonymous beacon: `GET /backend-anon/beacons/home?product=chatgpt`.

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

- No completed message send/stream captured in this run (prompt typed but full conversation submit/stream endpoint not confirmed from captured traffic). A fuller flow likely involves authenticated/anon conversation submit endpoints (e.g. backend-anon/backend-api conversation/stream paths) using `prepare_token`/`conduit_token` and additional anti-abuse/sentinel signals.
- To extend: capture a full successful turn (submit prompt, observe streaming response transport and request schema), correlate tokens/headers to requests, and trace bundle code for request builders and stream parsers.

## Limitations

Unauthenticated, partial/bootstrap capture. Tokens, build IDs, asset hashes, and schemas are versioned and ephemeral. No credentials or user content beyond a test prompt attempt included. Use only in accordance with applicable terms/law.
