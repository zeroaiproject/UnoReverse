/**
 * Wire constants for the Kilo AI anonymous gateway (see ../DOCS.md).
 */

export const PROVIDER = "kiloai";

export const BASE_URL = "https://api.kilo.ai";

export const PATHS = Object.freeze({
  chat: "/api/gateway/v1/chat/completions",
  models: "/api/gateway/v1/models",
});

export const DEFAULT_MODEL = "reflection/beam-free";

export const DEFAULT_TIMEOUT_MS = 120_000;
export const DEFAULT_STREAM_IDLE_TIMEOUT_MS = 60_000;
export const DEFAULT_MAX_RESPONSE_BYTES = 16 * 1024 * 1024;

/** Tor defaults: SOCKS on 9050, control port on 9051 (Debian/Ubuntu tor). */
export const DEFAULT_SOCKS_PROXY = "socks5h://127.0.0.1:9050";
export const DEFAULT_TOR_CONTROL = Object.freeze({ host: "127.0.0.1", port: 9051 });

export const DEFAULT_HEADERS = Object.freeze({
  "user-agent":
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
});
