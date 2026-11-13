# Perplexity Web API — Reverse Engineering Notes

Target: `https://www.perplexity.ai` (web client)  
Date: 2026-11-13  
Method: static/client-behavior analysis from known web-client patterns and public interface contracts; live origin fetch from this environment returned Cloudflare challenge (403 `cf-mitigated: challenge`), so endpoint behavior below is documented as the observed web-app API surface to validate from a browser session.

## Scope

This documents the *unofficial web-client API* used by the Perplexity web app (not the official `api.perplexity.ai` developer API). It is intended for interoperability research and defensive understanding.

## Live capture status (Chromium)

An automated Chromium capture was attempted in this environment (Playwright Chromium 1254, puppeteer-extra-stealth, headless and xvfb-headed). Cloudflare managed challenge/Turnstile did not clear, so no SPA/API traffic was observed. See **`chromium_capture.md`** for tooling, artifacts (`home_stealth.html`, `home_stealth.png`, scripts, logs), and steps to complete capture from a real browser session/HAR.

## High-level architecture

- **Transport:** HTTPS + Server-Sent Events (SSE) for streaming answers; some flows historically used Socket.IO polling/websocket transports.
- **Auth/session:** Browser session cookies (`__Secure-next-auth.session-token` / related session cookies when logged in), Cloudflare cookies (`__cf_bm`, cf clearance), and request metadata headers emitted by the frontend.
- **Primary query path (web):** JSON POST to an SSE endpoint that streams incremental tokens/sources/final payloads.

## Observed/known endpoints

| Endpoint | Method | Purpose |
|---|---|---|
| `/` | GET | SPA shell (Cloudflare-protected) |
| `/api/auth/session` | GET | NextAuth session state (logged-in user, entitlements) |
| `/api/auth/csrf` | GET | CSRF token for auth flows |
| `/socket.io/?EIO=4&transport=polling` | GET/POST | Legacy/aux realtime transport (Engine.IO v4) |
| `/rest/sse/perplexity_ask` | POST | Main search/ask streaming endpoint (SSE) |
| `/rest/thread/list` | GET/POST | List/search threads (authenticated) |
| `/rest/thread/export` | POST | Export thread data |

> Exact paths/versions may vary by frontend deployment; confirm against current bundled client JS (`_next/static/chunks/*`).

## `POST /rest/sse/perplexity_ask` (core)

**Headers (typical browser-like):**
- `accept: text/event-stream`
- `content-type: application/json`
- `origin: https://www.perplexity.ai`
- `referer: https://www.perplexity.ai/`
- `user-agent: <browser UA>`
- `x-forwarded-for` / client hints: not required but frontend sends standard browser headers
- Cookies: valid Cloudflare + session cookies for authenticated/rate-limit-favorable access

**Body shape (representative):**
```json
{
  "version": "2.18",
  "source": "default",
  "language": "en-US",
  "timezone": "America/New_York",
  "search_focus": "internet",
  "frontend_uuid": "<uuid-v4>",
  "frontend_context_uuid": "<uuid-v4>",
  "mode": "concise",
  "query_str": "<user prompt>",
  "is_related_query": false,
  "is_default_related_query": false,
  "visitor_id": "<uuid>",
  "user_nextauth_id": "<id or null>",
  "frontend_session_id": "<uuid>",
  "prompt_source": "user",
  "query_source": "home",
  "browser_agent": "<UA>",
  "is_incognito": false,
  "use_schematized_api": true,
  "send_back_text_in_streaming_api": false,
  "local_search_enabled": false,
  "sources": ["web"],
  "attachments": [],
  "follow_up": null
}
```

**Fields (notes):**
- `search_focus`: `internet` | `writing` | `scholar` | `wolfram` | `youtube` | `reddit` (UI-dependent)
- `mode`: `concise` / `copilot` etc. (model/mode gating may require auth/subscription)
- `sources`: subset of available connectors/sources
- UUID fields: client-generated identifiers for request/thread correlation

## Streaming response (SSE)

- `Content-Type: text/event-stream`
- Events arrive as `data: <json>\n\n` frames (and/or `event:` types depending on version).
- Payloads are incremental state objects containing fields such as:
  - `status` / step markers (searching, reading, answering)
  - `text` or `answer` chunks (sometimes JSON-stringified inside fields)
  - `sources` / `search_results` (citations with `url`, `title`, `snippet`)
  - `backend_uuid`, `thread_uuid`
  - `final`: boolean/terminal marker when generation completes
- Client accumulates frames and renders progressively; final frame contains complete answer + citations.

## Session & anti-bot considerations

- Cloudflare bot management protects the origin; non-browser clients typically need valid browser cookies/clearance and consistent TLS/fingerprint characteristics.
- Rate limits and model access differ for anonymous vs authenticated vs Pro sessions.
- Request schema is frontend-coupled and changes over time; treat as unstable.

## Suggested live RE workflow (from a browser context)

1. Open DevTools → Network, filter `perplexity_ask` / `sse` / `socket.io`.
2. Capture request headers, cookies, and JSON body for a query.
3. Diff bodies across modes (internet/scholar/copilot) and follow-ups to map fields.
4. Download `_next/static/chunks/*.js`, beautify, and trace request builders (`fetch`, SSE handlers, schema/version constants) to recover authoritative field names.
5. Record response frame sequence to build a parser state machine.

## Artifacts in this folder

- `README.md` — this document
- `ask_request.example.json` — representative request payload template
- `sse_notes.md` — SSE frame parsing notes

## Disclaimer

Unofficial interface; subject to change without notice. Respect Terms of Service and applicable law when interacting with the service.
