/**
 * URL builders, conversation-id handling and best-effort conversation
 * resolution.
 *
 * Conversation initiation was never isolated in the capture: the browser gets a
 * `conversation=<hex>` id from the search/ask page, then calls `with_ask`. This
 * module reproduces that as a heuristic and reports every attempt so callers can
 * see *why* resolution failed (429/403 are anti-bot, not a wrong id).
 */

import {
  BRAVE_ORIGIN,
  CONVERSATION_ID_RE,
  DEFAULT_MAX_RESPONSE_BYTES,
  NAVIGATE_HEADERS,
  WITH_ASK_PATH,
} from "./constants.js";
import { BraveLeoError, ERROR_CODES, classifyError, codeForStatus, truncate, withTimeout } from "./errors.js";
import { mergeHeaders, toCookieJar } from "./http.js";
import { readTextBounded } from "./http.js";

export function buildSearchUrl(query, opts = {}) {
  const url = new URL("/search", BRAVE_ORIGIN);
  url.searchParams.set("q", String(query ?? ""));
  url.searchParams.set("source", opts.source || "web");
  if (opts.conversation) url.searchParams.set("conversation", String(opts.conversation));
  if (opts.extraParams && typeof opts.extraParams === "object") {
    for (const [k, v] of Object.entries(opts.extraParams)) {
      if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
    }
  }
  return url.toString();
}

export function buildAskUrl(query, opts = {}) {
  const url = new URL("/ask", BRAVE_ORIGIN);
  url.searchParams.set("q", String(query ?? ""));
  if (opts.source) url.searchParams.set("source", String(opts.source));
  if (opts.conversation) url.searchParams.set("conversation", String(opts.conversation));
  if (opts.extraParams && typeof opts.extraParams === "object") {
    for (const [k, v] of Object.entries(opts.extraParams)) {
      if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
    }
  }
  return url.toString();
}

/** Observed follow-up pattern: /ask?q=...&source=chatllm-elaborate&conversation=<id>&query_type=... */
export function buildFollowupUrl(query, conversation, opts = {}) {
  const url = new URL("/ask", BRAVE_ORIGIN);
  url.searchParams.set("q", String(query ?? ""));
  url.searchParams.set("source", opts.source || "chatllm-elaborate");
  if (conversation) url.searchParams.set("conversation", String(conversation));
  url.searchParams.set("query_type", opts.queryType || "answer_with_ai_follow_up");
  return url.toString();
}

export function buildWithAskUrl(conversation, enableInlineEntities = true) {
  const url = new URL(WITH_ASK_PATH, BRAVE_ORIGIN);
  url.searchParams.set("conversation", String(conversation));
  url.searchParams.set("enable_inline_entities", String(enableInlineEntities !== false));
  return url.toString();
}

/** Accept only plausible hex ids; anything else means "absent", not "invalid". */
export function normalizeConversationId(id) {
  if (id == null) return null;
  const s = String(id).trim();
  if (!s || !CONVERSATION_ID_RE.test(s)) return null;
  return s;
}

const CONVERSATION_PATTERNS = [
  /[?&]conversation=([a-f0-9]{16,64})/i,
  /\\u0026conversation=([a-f0-9]{16,64})/i,
  /&amp;conversation=([a-f0-9]{16,64})/i,
  /["']conversation["']\s*[:=]\s*["']([a-f0-9]{16,64})["']/i,
  /["']conversation_id["']\s*[:=]\s*["']([a-f0-9]{16,64})["']/i,
  /["']conversationId["']\s*[:=]\s*["']([a-f0-9]{16,64})["']/i,
  /data-conversation=["']([a-f0-9]{16,64})["']/i,
];

/** Extract a conversation id from a URL, redirect location, HTML or JSON blob. */
export function extractConversationId(text) {
  if (!text) return null;
  const s = String(text);
  for (const re of CONVERSATION_PATTERNS) {
    const m = s.match(re);
    if (m) return m[1];
  }
  // Fallback: 32-hex token near the word "conversation" in JSON-ish blobs.
  const near = s.match(/conversation[^a-f0-9]{0,20}([a-f0-9]{32})/i);
  return near ? near[1] : null;
}

function defaultCandidates(query, source) {
  return [
    { name: "search", url: buildSearchUrl(query, { source }) },
    { name: "search+summary", url: buildSearchUrl(query, { source, extraParams: { summary: "1" } }) },
    { name: "ask", url: buildAskUrl(query, { source: "web" }) },
  ];
}

/**
 * Best-effort resolution of a chatllm conversation id for a query.
 * Never throws for per-attempt failures; returns `{ conversation: null, attempts }`
 * so the caller can explain the failure.
 *
 * @returns {Promise<{conversation: string|null, finalUrl: string|null, status: number|null,
 *   strategy: string|null, cookies: string|null, attempts: object[]}>}
 */
export async function resolveConversation(query, opts = {}) {
  const fetchImpl = opts.fetchImpl || globalThis.fetch;
  if (typeof fetchImpl !== "function") {
    throw new BraveLeoError("fetch is not available in this environment", {
      code: ERROR_CODES.FETCH_UNAVAILABLE,
      retryable: false,
    });
  }
  if (!query || !String(query).trim()) {
    throw new BraveLeoError("query is required to resolve a conversation", {
      code: ERROR_CODES.INVALID_INPUT,
      retryable: false,
    });
  }

  const jar = toCookieJar(opts.cookieJar ?? opts.cookies);
  const source = opts.source || "web";
  const maxBytes = opts.maxResponseBytes || DEFAULT_MAX_RESPONSE_BYTES;
  const candidates = Array.isArray(opts.candidates) ? opts.candidates : defaultCandidates(query, source);
  const attempts = [];
  let last = null;

  for (const cand of candidates) {
    const t = withTimeout(opts.signal, opts.timeoutMs);
    const startedAt = Date.now();
    try {
      const headers = mergeHeaders(
        NAVIGATE_HEADERS,
        opts.headers,
        jar.toString() ? { cookie: jar.toString() } : null
      );
      const res = await fetchImpl(cand.url, { method: "GET", headers, redirect: "follow", signal: t.signal });
      jar.ingestResponse(res);

      const finalUrl = res.url || cand.url;
      let conversation =
        extractConversationId(finalUrl) ||
        extractConversationId(res.headers && typeof res.headers.get === "function" ? res.headers.get("location") : null);
      let html = "";
      if (!conversation) {
        html = await readTextBounded(res, maxBytes);
        conversation = extractConversationId(html);
      }
      const attempt = {
        strategy: cand.name,
        url: cand.url,
        finalUrl,
        status: res.status,
        ok: res.ok,
        conversation: conversation || null,
        ms: Date.now() - startedAt,
      };
      if (!res.ok && !conversation) {
        attempt.error = truncate(html || res.statusText || `HTTP ${res.status}`, 300);
        attempt.code = codeForStatus(res.status);
        attempt.hint =
          res.status === 403 || res.status === 429
            ? "Brave served an anti-bot/challenge page; browser-like cookies are required."
            : undefined;
      }
      attempts.push(attempt);
      last = {
        conversation: conversation || null,
        finalUrl,
        status: res.status,
        strategy: cand.name,
        cookies: jar.toString() || null,
        attempts,
      };
      if (conversation) return last;
    } catch (e) {
      const err = classifyError(e, {});
      const attempt = {
        strategy: cand.name,
        url: cand.url,
        finalUrl: cand.url,
        status: err.status ?? null,
        ok: false,
        conversation: null,
        error: err.message,
        code: err.code,
        ms: Date.now() - startedAt,
      };
      attempts.push(attempt);
      last = {
        conversation: null,
        finalUrl: cand.url,
        status: null,
        strategy: cand.name,
        error: err.message,
        cookies: jar.toString() || null,
        attempts,
      };
      if (err.code === ERROR_CODES.ABORTED) throw err;
    } finally {
      t.cleanup();
    }
  }

  return (
    last || {
      conversation: null,
      finalUrl: null,
      status: null,
      strategy: null,
      cookies: jar.toString() || null,
      attempts,
    }
  );
}

/**
 * Strip the session cookie header from a resolution before it is embedded in a
 * result/log. Callers that genuinely need the cookies can use the `CookieJar`.
 */
export function redactResolution(resolution) {
  if (!resolution || typeof resolution !== "object") return resolution;
  const out = { ...resolution };
  delete out.cookies;
  if (Array.isArray(out.attempts)) out.attempts = out.attempts.map((a) => ({ ...a }));
  return out;
}

/** Explain a failed resolution using the per-attempt diagnostics. */
export function describeResolutionFailure(resolution) {
  const attempts = (resolution && resolution.attempts) || [];
  const statuses = attempts.map((a) => `${a.strategy}:${a.status ?? a.code ?? "error"}`).join(", ");
  const blocked = attempts.some((a) => a.code === ERROR_CODES.BLOCKED || a.status === 429 || a.status === 403);
  const base =
    "Could not resolve a Brave chatllm conversation id for the query. " +
    "Conversation initiation was not captured end-to-end; the most reliable path is to pass a known " +
    "'conversation' id (and the session cookies that created it).";
  const suffix = statuses ? ` Attempts — ${statuses}.` : "";
  const hint = blocked
    ? " Brave returned 403/429: the request was treated as automated traffic. Use a real browser session (cookies) or slow down/rotate egress."
    : "";
  return base + suffix + hint;
}
