/**
 * Wire constants for Proton Lumo (guest/web), see ../DOCS.md.
 */

export const PROVIDER = "lumo";

export const BASE_URL = "https://lumo.proton.me";

export const PATHS = Object.freeze({
  session: "/api/auth/v4/sessions",
  cookies: "/api/core/v4/auth/cookies",
  features: "/api/feature/v2/frontend",
  models: "/api/ai/v1/models",
  limits: "/api/ai/v1/limits",
  chat: "/api/ai/v1/chat/completions",
});

export const DEFAULT_MODEL = "lumo-max";

export const DEFAULT_TIMEOUT_MS = 60_000;
export const DEFAULT_STREAM_IDLE_TIMEOUT_MS = 60_000;
export const DEFAULT_MAX_RESPONSE_BYTES = 16 * 1024 * 1024;

export const DEFAULT_APP_VERSION = "web-lumo@1.0.0";
export const DEFAULT_LOCALE = "en_US";

/** Tools commonly exposed to the web client (observed). */
export const DEFAULT_TOOLS = Object.freeze([
  { name: "web_search" },
  { name: "weather" },
  { name: "stock" },
  { name: "cryptocurrency" },
  { name: "web_extract" },
  { name: "proton_info" },
  { name: "generate_image" },
  { name: "describe_image" },
  { name: "edit_image" },
]);

export const DEFAULT_HEADERS = Object.freeze({
  "user-agent":
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  origin: "https://lumo.proton.me",
  referer: "https://lumo.proton.me/",
});
