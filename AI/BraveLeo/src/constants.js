/**
 * Wire-level constants observed for Brave Search "Answer with AI" (chatllm).
 *
 * Source: AI/BraveLeo/DOCS.md (capture 2026-11-13). Everything here is a
 * protocol observation, not an official contract — override at call sites when
 * Brave ships a new build.
 */

export const BRAVE_ORIGIN = "https://search.brave.com";
export const WITH_ASK_PATH = "/api/chatllm/with_ask";

export const DEFAULT_UA =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

export const BASE_HEADERS = Object.freeze({
  "accept-language": "en-US,en;q=0.9",
  "user-agent": DEFAULT_UA,
});

export const STREAM_REQUEST_HEADERS = Object.freeze({
  ...BASE_HEADERS,
  accept: "application/json",
  "sec-fetch-dest": "empty",
  "sec-fetch-mode": "cors",
  "sec-fetch-site": "same-origin",
});

export const NAVIGATE_HEADERS = Object.freeze({
  ...BASE_HEADERS,
  accept: "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
  "upgrade-insecure-requests": "1",
  "sec-fetch-dest": "document",
  "sec-fetch-mode": "navigate",
  "sec-fetch-site": "none",
  "sec-fetch-user": "?1",
});

/** Default whole-request timeout (headers + first byte). */
export const DEFAULT_TIMEOUT_MS = 30_000;

/** Default "no bytes received" budget once a stream is open. 0 disables it. */
export const DEFAULT_STREAM_IDLE_TIMEOUT_MS = 45_000;

/** Hard ceiling for a single buffered/streamed response body. */
export const DEFAULT_MAX_RESPONSE_BYTES = 8 * 1024 * 1024;

/** How much of an error body is kept for diagnostics. */
export const MAX_BODY_SNIPPET = 1_500;

/** Conversation ids observed as 38 hex chars; accept a wider hex range for safety. */
export const CONVERSATION_ID_RE = /^[a-f0-9]{16,64}$/i;
