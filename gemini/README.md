# Gemini Web API — Reverse Engineering Notes (Chromium)

Target: `https://gemini.google.com` (web client, "BardChatUi")  
Date: 2026-11-13  
Method: automated Chromium capture (Playwright-bundled Chromium 1254, headless) of the unauthenticated/landing app load; network and asset observations recorded. No authenticated chat prompt was submitted in this capture.

## Scope

Documents the *unofficial web-client interface* used by Gemini's web app (not the Google AI / Gemini developer API). Focus: client boot, RPC transport, and observed endpoints/identifiers.

## Live capture (Chromium)

- Browser: `/root/.cache/ms-playwright/chromium-1254/chrome-linux64/chrome` (headless)
- Script: `capture_gemini.mjs`
- Result: page loaded successfully (`title: "Google Gemini"`, `url: https://gemini.google.com/app`), UI elements present (`rich-textarea`, `[contenteditable="true"]`, prompt aria labels). Batchexecute RPC calls observed during app initialization.
- Artifacts: `home.html`, `home.png`, `page_assets.json`, `network_capture.jsonl`, `capture_gemini.mjs`

## Architecture (observed)

- **Frontend codename:** `BardChatUi` (BOQ/UIServer stack), served from `gemini.google.com` with static JS from `gemini.gstatic.com/_/mss/boq-gemini-web-uiserver/...` and islands/assets from `www.gstatic.com/bg3/boq-bard-web/...`
- **Transport:** Google's batched RPC (`batchexecute`) over HTTPS POST/GET-style query params returning chunked JSON with anti-XSSI prefix (see below). Streaming/generation flows use related RPCs (not captured unauthenticated here).
- **Auth:** Google account session cookies; unauthenticated load reaches `/app` shell and issues bootstrap RPCs but interactive generation requires sign-in (UI shows sign-in affordances).

## Endpoints observed

| Endpoint | Method | Purpose (observed/inferred) |
|---|---|---|
| `/app` | GET | Main SPA entry |
| `/_/BardChatUi/data/batchexecute` | POST/GET (query-driven) | Batched RPC endpoint; `rpcids` selects operations |
| `/_/BardChatUi/manifest.json` | GET | Web app manifest |
| `/_/BardChatUi/cspreport` | POST | CSP violation reporting |
| `/generate_204` | GET | Connectivity/telemetry beacon |
| `https://gemini.gstatic.com/_/mss/boq-gemini-web-uiserver/_/js/...` | GET | Versioned JS modules (chunked by module ids in path) |

### `batchexecute` request shape (observed)

Example URLs captured:
```
/_/BardChatUi/data/batchexecute?rpcids=ku4Jyf&source-path=%2Fapp&bl=boq_gemini-web-uiserver_20261113.00_p0&f.sid=4720972268720899512&hl=en-US&_reqid=1174167&rt=c
/_/BardChatUi/data/batchexecute?rpcids=aPya6c&source-path=%2Fapp&bl=boq_gemini-web-uiserver_20261113.00_p0&f.sid=4720972268720899512&hl=en-US&_reqid=1274167&rt=c
```

Parameters:
- `rpcids`: operation identifier(s) (e.g. `ku4Jyf`, `aPya6c`)
- `source-path`: current client path (e.g. `/app`)
- `bl`: build label (`boq_gemini-web-uiserver_<date>.<ver>_p<n>`)
- `f.sid`: frontend/session id (numeric string)
- `hl`: locale (`en-US`)
- `_reqid`: request sequence/counter (e.g. increments like `1174167`, `1274167`)
- `rt`: response type (`c` observed)

(Full POST bodies for data-bearing calls were not captured in this bootstrap-only, unauthenticated run; authenticated prompt/generation calls typically POST form-encoded `f.req` payloads containing serialized RPC arguments and include `at`/XSRF tokens.)

### `batchexecute` response shape (observed)

- `content-type: application/json; charset=utf-8`, `content-disposition: attachment; filename="response.bin"`, often brotli-compressed.
- Body begins with anti-XSSI prefix: `)]}'\n`
- Followed by length-prefixed chunks: `<byte-length>\n` + `<json-array>\n`
- Envelope entries of the form:
  ```json
  ["wrb.fr", "<rpcid>", "<payload-or-json-string>", null, null, null, "generic"]
  ```
  plus housekeeping frames like `["di", <n>]`, `["af.httprm", ...]`, and end marker `["e", 4, null, null, <n>]`.

Observed examples:
- `rpcids=ku4Jyf` → payload `"[]"` (empty result)
- `rpcids=aPya6c` → payload `"[false,0,[]]"`

## Client assets / build identifiers (observed)

- BOQ JS base: `https://gemini.gstatic.com/_/mss/boq-gemini-web-uiserver/_/js/k=boq-gemini-web-uiserver.BardChatUi.en_US.QjT4E1LV9yE.2018.O/ck=boq-gemini-web-uiserver.BardChatUi.sLt2Sdq-9QA.L.B1.O/am=.../rs=...`
- Module chunking via `m=<module>` query/path segments (e.g. `vLefie`, `fSXoCf`, `CK6Z6b`, etc.) and `wli=BardChatUi.0pbvwtmWPUQ.mediaIntentWasm.O%3A%3B`
- Islands runtime: `https://www.gstatic.com/bg3/boq-bard-web/islands/assets/islands-DWa24vka.js`, `island-bootstrap-runtime-C5gNxvnS.js`
- Manifest: `/_/BardChatUi/manifest.json`

## Gaps / next steps for full RE

1. **Authenticated session**: sign in to capture prompt submission/generation RPCs (common ids include message-send/stream RPCs), `at` (SNlM0e) token, cookies, and streaming behavior.
2. **Request bodies**: capture POST `f.req` (and `at`) for `batchexecute` to map rpcid → argument schema.
3. **JS analysis**: download/beautify the BOQ bundles, locate rpcid registry, request builders, and response parsers for chat/streaming.
4. **Streaming**: observe how incremental model output is delivered (chunked batchexecute frames vs other transports) during an active generation.

## Limitations

Unauthenticated, bootstrap-only capture. rpcids/params/build labels are versioned and will change. No credentials or user data included. Use only in accordance with applicable terms/law.
