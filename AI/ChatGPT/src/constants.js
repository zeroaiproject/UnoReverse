/**
 * Wire constants for the ChatGPT web client (`unauth-mweb`), see ../DOCS.md.
 */

export const PROVIDER = "chatgpt";

export const BASE_URL = "https://chatgpt.com";

export const PATHS = Object.freeze({
  sentinelPrepare: "/unauth-mweb/sentinel/chat-requirements/prepare",
  sentinelFinalize: "/unauth-mweb/sentinel/chat-requirements/finalize",
  sentinelPing: "/unauth-mweb/sentinel/ping",
  conversationPrepare: "/unauth-mweb/conversation/prepare?lightweight_authenticated=0",
  conversationUpdates: "/unauth-mweb/conversation/updates",
});

export const DEFAULT_TIMEOUT_MS = 60_000;
export const DEFAULT_STREAM_IDLE_TIMEOUT_MS = 60_000;
export const DEFAULT_MAX_RESPONSE_BYTES = 16 * 1024 * 1024;

export const DEFAULT_HEADERS = Object.freeze({
  "user-agent":
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  "accept-language": "en-US,en;q=0.9",
  origin: "https://chatgpt.com",
  referer: "https://chatgpt.com/",
});

/** Root conversation state for a first, unauthenticated turn. */
export const INITIAL_CONVERSATION_STATE = Object.freeze({
  messages: [],
  parentMessageId: "client-created-root",
  safety: { dismissedInterventionIds: [] },
  userMessageCount: 0,
});

export const DEFAULT_CLIENT_CONTEXT = Object.freeze({
  app_name: "chatgpt.com",
  has_web_push_capabilities: true,
  is_dark_mode: false,
  web_push_notification_permission: "default",
  page_height: 900,
  page_width: 1280,
  pixel_ratio: 1,
  screen_height: 600,
  screen_width: 800,
  time_since_loaded: 1,
});

export const CONVERSATION_RETRY_OWNER = Object.freeze({ mode: "anonymous", sessionEpoch: null });
