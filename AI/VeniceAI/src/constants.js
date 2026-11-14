/**
 * Wire constants for Venice.ai web agent inference (see ../DOCS.md).
 */

export const PROVIDER = "veniceai";

export const BASE_URL = "https://outerface.venice.ai";
export const WEB_ORIGIN = "https://venice.ai";

export const PATHS = Object.freeze({
  attestationMint: "/api/app/user/client_attestation/mint",
  models: "/api/app/models",
  userCountry: "/api/app/user_country",
  rateLimits: "/api/inference/rate-limits",
  agentChat: "/api/inference/chat/agents/venice",
});

export const DEFAULT_TIMEOUT_MS = 60_000;
export const DEFAULT_STREAM_IDLE_TIMEOUT_MS = 60_000;
export const DEFAULT_MAX_RESPONSE_BYTES = 16 * 1024 * 1024;

export const DEFAULT_FRONTEND_VERSION = "interface@unknown";
export const DEFAULT_MIDDLEFACE_VERSION = "0.1.0";

export const DEFAULT_HEADERS = Object.freeze({
  "user-agent":
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  origin: WEB_ORIGIN,
  referer: "https://venice.ai/",
});
