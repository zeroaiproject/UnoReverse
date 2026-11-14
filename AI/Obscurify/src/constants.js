/**
 * Wire constants for the anonymous Obscurify gateway (see ../DOCS.md).
 */

export const PROVIDER = "obscurify";

export const BASE_URL = "https://obscurify.ai";

export const PATHS = Object.freeze({
  models: "/v1/models",
  frontierModels: "/frontier_models",
  uncensoredModels: "/uncensored_models",
  codeMode: "/code_mode",
  anonymousChat: "/anon/chat/completions",
});

/** Captured guest default; the catalog is the source of truth at runtime. */
export const DEFAULT_MODEL = "deepseek/deepseek-v4-flash";

export const DEFAULT_TIMEOUT_MS = 60_000;
export const DEFAULT_STREAM_IDLE_TIMEOUT_MS = 45_000;
export const DEFAULT_MAX_RESPONSE_BYTES = 16 * 1024 * 1024;

/** The guest endpoint is origin-gated, so mimic the web app's own requests. */
export const WEB_HEADERS = Object.freeze({
  origin: "https://obscurify.ai",
  referer: "https://obscurify.ai/",
  "user-agent":
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
});

export const THREAD_HEADER = "x-obscurify-thread";
