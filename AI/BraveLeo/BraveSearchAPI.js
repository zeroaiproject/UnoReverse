/**
 * BraveSearchAPI.js
 *
 * Agent/tool-calling friendly web-search & AI-grounded answer proxy for
 * Brave Leo / "Answer with AI" (search.brave.com chatllm).
 *
 * Observed protocol (UnoReverse, 2026-11-13, see DOCS.md):
 *   GET https://search.brave.com/api/chatllm/with_ask?conversation=<id>&enable_inline_entities=true
 *   -> 200 text/event-stream; charset=utf-8  (x-stream-format: tap)
 *   -> line-delimited JSON events:
 *        text_start
 *        text_delta { delta }
 *        text_stop  { text }
 *        usage      { prompt_tokens, completion_tokens, reasoning_tokens }
 *        followups  { followups: [...] }
 *        enrichments{ enrichments: { raw_response, references, urls, reference_urls,
 *                                    images, qa, entities, main_entity, main_entity_infobox,
 *                                    predicate, context, context_urls, context_results } }
 *
 * Gaps / notes:
 * - Exact conversation initiation trigger was not fully isolated in capture. This proxy can:
 *   (a) consume a known `conversation` id, or
 *   (b) best-effort resolve one from Brave Search pages for a query (heuristic; cookies/session
 *       and browser-like environment may be required for Brave to emit a conversation-backed answer).
 * - Unofficial, versioned interface. Use responsibly and per applicable terms/law.
 */

const BRAVE_ORIGIN = "https://search.brave.com";
const WITH_ASK_PATH = "/api/chatllm/with_ask";

const DEFAULT_UA =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

const BASE_HEADERS = {
  "accept-language": "en-US,en;q=0.9",
  "user-agent": DEFAULT_UA,
};

const STREAM_REQUEST_HEADERS = {
  ...BASE_HEADERS,
  accept: "application/json",
  "sec-fetch-dest": "empty",
  "sec-fetch-mode": "cors",
  "sec-fetch-site": "same-origin",
};

const NAVIGATE_HEADERS = {
  ...BASE_HEADERS,
  accept:
    "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
  "upgrade-insecure-requests": "1",
  "sec-fetch-dest": "document",
  "sec-fetch-mode": "navigate",
  "sec-fetch-site": "none",
  "sec-fetch-user": "?1",
};

// --- Errors, retry, and reliability utilities ---

const ERROR_CODES = Object.freeze({
  FETCH_UNAVAILABLE: "FETCH_UNAVAILABLE",
  INVALID_INPUT: "INVALID_INPUT",
  CONVERSATION_NOT_FOUND: "CONVERSATION_NOT_FOUND",
  HTTP_ERROR: "HTTP_ERROR",
  RATE_LIMITED: "RATE_LIMITED",
  TIMEOUT: "TIMEOUT",
  ABORTED: "ABORTED",
  NETWORK_ERROR: "NETWORK_ERROR",
  PARSE_ERROR: "PARSE_ERROR",
  STREAM_ERROR: "STREAM_ERROR",
  UNKNOWN_TOOL: "UNKNOWN_TOOL",
  INTERNAL_ERROR: "INTERNAL_ERROR",
});

function sleep(ms, signal) {
  if (!ms || ms <= 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    if (signal) {
      if (signal.aborted) {
        clearTimeout(t);
        return reject(Object.assign(new Error("Request aborted"), { name: "AbortError" }));
      }
      signal.addEventListener(
        "abort",
        () => {
          clearTimeout(t);
          reject(Object.assign(new Error("Request aborted"), { name: "AbortError" }));
        },
        { once: true }
      );
    }
  });
}

function withTimeout(signal, timeoutMs) {
  if (!timeoutMs || timeoutMs <= 0) return { signal, cleanup: () => {} };
  const ctrl = new AbortController();
  const onAbort = () => {
    try { ctrl.abort(signal && signal.reason); } catch (_) { ctrl.abort(); }
  };
  if (signal) {
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
  }
  const t = setTimeout(() => {
    const e = new Error(`timeout after ${timeoutMs}ms`);
    e.code = ERROR_CODES.TIMEOUT;
    try { ctrl.abort(e); } catch (_) { ctrl.abort(); }
  }, timeoutMs);
  return {
    signal: ctrl.signal,
    cleanup: () => {
      clearTimeout(t);
      if (signal) signal.removeEventListener("abort", onAbort);
    },
  };
}

class BraveLeoError extends Error {
  constructor(message, opts = {}) {
    super(message || "BraveLeoError");
    this.name = "BraveLeoError";
    this.code = opts.code || ERROR_CODES.INTERNAL_ERROR;
    this.status = opts.status ?? null;
    this.retryable = !!opts.retryable;
    this.retryAfterMs = opts.retryAfterMs ?? null;
    this.details = opts.details ?? null;
    this.cause = opts.cause;
    this.conversation = opts.conversation ?? null;
  }
  toJSON() {
    return {
      name: this.name,
      code: this.code,
      message: this.message,
      status: this.status,
      retryable: this.retryable,
      retryAfterMs: this.retryAfterMs,
      details: this.details,
      conversation: this.conversation,
    };
  }
}

function asError(error, fallback = {}) {
  if (error instanceof BraveLeoError) return error;
  const e = error || {};
  const msg = e && e.message ? String(e.message) : String(error || fallback.message || "Unknown error");
  return new BraveLeoError(msg, { ...fallback, cause: error });
}

function truncate(str, max = 2000) {
  if (str == null) return str;
  const s = typeof str === "string" ? str : (() => { try { return JSON.stringify(str); } catch (_) { return String(str); } })();
  return s.length > max ? s.slice(0, max) + `...[truncated ${s.length - max} chars]` : s;
}

function parseRetryAfter(headers) {
  if (!headers) return null;
  const h = typeof headers.get === "function" ? headers.get("retry-after") : (headers["retry-after"] || headers["Retry-After"]);
  if (h == null) return null;
  const n = Number(h);
  if (Number.isFinite(n)) return Math.max(0, n * 1000);
  const d = Date.parse(String(h));
  if (Number.isFinite(d)) return Math.max(0, d - Date.now());
  return null;
}

function isAbortError(e) {
  return !!(e && (e.name === "AbortError" || e.code === "ABORT_ERR"));
}

function isTimeoutError(e) {
  return !!(e && (e.code === ERROR_CODES.TIMEOUT || /timeout/i.test(e.message || "")));
}

function classifyError(error, context = {}) {
  if (error instanceof BraveLeoError) return error;
  if (isAbortError(error)) {
    const timeout = isTimeoutError(error) || isTimeoutError(error && error.cause) || /timeout/i.test(String((error && error.message) || ""));
    return new BraveLeoError(timeout ? "Request timed out" : "Request aborted", {
      code: timeout ? ERROR_CODES.TIMEOUT : ERROR_CODES.ABORTED,
      retryable: timeout,
      status: context.status ?? null,
      conversation: context.conversation ?? null,
      cause: error,
    });
  }
  const status = error && (error.status ?? error.statusCode);
  if (Number.isFinite(status)) {
    const retryAfterMs = parseRetryAfter(error.headers) ?? error.retryAfterMs ?? null;
    const rate = status === 429;
    return new BraveLeoError(error.message || `HTTP ${status}`, {
      code: rate ? ERROR_CODES.RATE_LIMITED : ERROR_CODES.HTTP_ERROR,
      status,
      retryable: !!(error.retryable || isRetryableStatus(status)),
      retryAfterMs,
      details: error.body ? truncate(error.body, 1500) : (error.details ?? null),
      conversation: context.conversation ?? error.conversation ?? null,
      cause: error,
    });
  }
  // Fetch/network failures often surface as TypeError with no status
  if (error && (error.name === "TypeError" || /fetch|network|ECONN|ENOTFOUND|EAI_AGAIN|socket/i.test(error.message || ""))) {
    return new BraveLeoError(error.message || "Network request failed", {
      code: ERROR_CODES.NETWORK_ERROR,
      retryable: true,
      conversation: context.conversation ?? null,
      cause: error,
    });
  }
  return new BraveLeoError(error && error.message ? error.message : String(error), {
    code: ERROR_CODES.INTERNAL_ERROR,
    retryable: false,
    conversation: context.conversation ?? null,
    cause: error,
  });
}

function computeBackoffMs(attempt, opts = {}) {
  const base = Math.max(0, Number(opts.retryDelayMs ?? 500));
  const max = Math.max(base, Number(opts.maxRetryDelayMs ?? 8000));
  const exp = Math.min(max, base * Math.pow(2, Math.max(0, attempt)));
  // full jitter
  const jitter = Math.floor(Math.random() * Math.max(1, exp));
  return Math.min(max, jitter + Math.floor(exp * 0.25));
}

async function withRetry(fn, opts = {}) {
  const retries = Math.max(0, Number(opts.retries ?? 0) || 0);
  const signal = opts.signal;
  let attempt = 0;
  while (true) {
    try {
      return await fn(attempt);
    } catch (e) {
      const err = classifyError(e, opts.context || {});
      const canRetry =
        attempt < retries &&
        err.retryable &&
        !(signal && signal.aborted) &&
        err.code !== ERROR_CODES.ABORTED &&
        (typeof opts.retryOn === "function" ? opts.retryOn(err, attempt) : true);
      if (!canRetry) throw err;
      const wait = err.retryAfterMs != null ? Math.min(err.retryAfterMs, opts.maxRetryDelayMs ?? 15000) : computeBackoffMs(attempt, opts);
      if (typeof opts.onRetry === "function") {
        try { opts.onRetry({ attempt: attempt + 1, retries, waitMs: wait, error: err }); } catch (_) {}
      }
      await sleep(wait, signal);
      attempt++;
    }
  }
}

// --- Usage/token tracking ---

function emptyUsage() {
  return { prompt_tokens: 0, completion_tokens: 0, reasoning_tokens: 0, total_tokens: 0, requests: 0 };
}

function addUsage(target, usage) {
  if (!usage || typeof usage !== "object") return target;
  const p = Number(usage.prompt_tokens || 0) || 0;
  const c = Number(usage.completion_tokens || 0) || 0;
  const r = Number(usage.reasoning_tokens || 0) || 0;
  target.prompt_tokens += p;
  target.completion_tokens += c;
  target.reasoning_tokens += r;
  target.total_tokens += p + c + r;
  target.requests += 1;
  target.last = {
    prompt_tokens: usage.prompt_tokens ?? null,
    completion_tokens: usage.completion_tokens ?? null,
    reasoning_tokens: usage.reasoning_tokens ?? null,
  };
  return target;
}

class UsageTracker {
  constructor() {
    this.usage = emptyUsage();
  }
  record(usage) {
    addUsage(this.usage, usage);
    return this.snapshot();
  }
  snapshot() {
    return JSON.parse(JSON.stringify(this.usage));
  }
  reset() {
    this.usage = emptyUsage();
  }
}

// --- Fetch/assert ---

function assertFetch(fetchImpl) {
  if (!fetchImpl) {
    throw new BraveLeoError("fetch is not available in this environment", {
      code: ERROR_CODES.FETCH_UNAVAILABLE,
      retryable: false,
    });
  }
  return fetchImpl;
}

function normalizeConversationId(id) {
  if (id == null) return null;
  const s = String(id).trim();
  if (!s) return null;
  // Observed: 32 hex chars; accept broader hex token defensively.
  if (!/^[a-f0-9]{16,64}$/i.test(s)) return null;
  return s;
}

function extractConversationId(text) {
  if (!text) return null;
  const s = String(text);
  const patterns = [
    /[?&]conversation=([a-f0-9]{16,64})/i,
    /\\u0026conversation=([a-f0-9]{16,64})/i,
    /["']conversation["']\s*[:=]\s*["']([a-f0-9]{16,64})["']/i,
    /["']conversation_id["']\s*[:=]\s*["']([a-f0-9]{16,64})["']/i,
    /["']conversationId["']\s*[:=]\s*["']([a-f0-9]{16,64})["']/i,
    /data-conversation=["']([a-f0-9]{16,64})["']/i,
  ];
  for (const re of patterns) {
    const m = s.match(re);
    if (m) return m[1];
  }
  // Fallback: look for 32-hex tokens near the word "conversation" in JSON-ish blobs
  const near = s.match(/conversation[^a-f0-9]{0,20}([a-f0-9]{32})/i);
  return near ? near[1] : null;
}

function headersToObject(headers) {
  const out = {};
  if (!headers) return out;
  try {
    if (typeof headers.forEach === "function") {
      headers.forEach((v, k) => {
        out[String(k).toLowerCase()] = v;
      });
      return out;
    }
  } catch (_) {}
  try {
    for (const [k, v] of headers.entries ? headers.entries() : Object.entries(headers)) {
      out[String(k).toLowerCase()] = v;
    }
  } catch (_) {}
  return out;
}

function mergeHeaders(...parts) {
  const out = {};
  for (const p of parts) {
    if (!p) continue;
    const obj = typeof p.forEach === "function" || p.entries ? headersToObject(p) : p;
    for (const [k, v] of Object.entries(obj)) {
      if (v === undefined || v === null) continue;
      out[String(k).toLowerCase()] = String(v);
    }
  }
  return out;
}

/** Minimal cookie accumulator (Set-Cookie -> Cookie) for session reuse. */
class CookieJar {
  constructor(initial) {
    this.map = new Map();
    if (typeof initial === "string" && initial.trim()) this.addCookieHeader(initial);
    else if (initial instanceof CookieJar) this.addCookieHeader(initial.toString());
    else if (initial && typeof initial === "object" && !Array.isArray(initial)) {
      for (const [k, v] of Object.entries(initial)) this.map.set(k, String(v));
    }
  }
  addSetCookie(setCookie) {
    if (!setCookie) return;
    const values = Array.isArray(setCookie) ? setCookie : [setCookie];
    for (const raw of values) {
      if (!raw) continue;
      const first = String(raw).split(";")[0];
      const idx = first.indexOf("=");
      if (idx <= 0) continue;
      const name = first.slice(0, idx).trim();
      const value = first.slice(idx + 1).trim();
      if (name) this.map.set(name, value);
    }
  }
  ingestResponse(res) {
    try {
      if (!res || !res.headers) return;
      // Node/undici: getSetCookie(); browsers may expose only a combined header.
      if (typeof res.headers.getSetCookie === "function") {
        this.addSetCookie(res.headers.getSetCookie());
      } else {
        const sc = res.headers.get("set-cookie");
        if (sc) this.addSetCookie(sc);
      }
    } catch (_) {}
  }
  addCookieHeader(cookieHeader) {
    for (const part of String(cookieHeader || "").split(";")) {
      const idx = part.indexOf("=");
      if (idx <= 0) continue;
      const name = part.slice(0, idx).trim();
      const value = part.slice(idx + 1).trim();
      if (name) this.map.set(name, value);
    }
  }
  toString() {
    if (!this.map.size) return "";
    return Array.from(this.map.entries())
      .map(([k, v]) => `${k}=${v}`)
      .join("; ");
  }
  get size() {
    return this.map.size;
  }
  clone() {
    return new CookieJar(this.toString());
  }
}

function buildSearchUrl(query, opts = {}) {
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

function buildAskUrl(query, opts = {}) {
  const url = new URL("/ask", BRAVE_ORIGIN);
  url.searchParams.set("q", String(query ?? ""));
  if (opts.source) url.searchParams.set("source", String(opts.source));
  return url.toString();
}

function buildFollowupUrl(query, conversation, opts = {}) {
  // Observed pattern: /ask?q=...&source=chatllm-elaborate&conversation=<id>&query_type=answer_with_ai_follow_up
  const url = new URL("/ask", BRAVE_ORIGIN);
  url.searchParams.set("q", String(query ?? ""));
  url.searchParams.set("source", opts.source || "chatllm-elaborate");
  if (conversation) url.searchParams.set("conversation", String(conversation));
  url.searchParams.set("query_type", opts.queryType || "answer_with_ai_follow_up");
  return url.toString();
}

function buildWithAskUrl(conversation, enableInlineEntities = true) {
  const url = new URL(WITH_ASK_PATH, BRAVE_ORIGIN);
  url.searchParams.set("conversation", String(conversation));
  url.searchParams.set("enable_inline_entities", String(enableInlineEntities !== false));
  return url.toString();
}

// --- Conversation resolution ---

/**
 * Best-effort: resolve a Brave chatllm conversation id for a query.
 * Tries Brave search/ask pages and extracts `conversation=<id>` from final URL or HTML.
 * Heuristic (initiation not fully captured); cookies/session improve odds.
 */
async function resolveConversation(query, opts = {}) {
  const fetchImpl = assertFetch(opts.fetchImpl || globalThis.fetch);
  if (!query || !String(query).trim()) throw new Error("query is required");

  const jar = opts.cookieJar instanceof CookieJar ? opts.cookieJar : new CookieJar(opts.cookies);
  const source = opts.source || "web";

  const candidates = [
    { name: "search", url: buildSearchUrl(query, { source }) },
    { name: "search+summary", url: buildSearchUrl(query, { source, extraParams: { summary: "1" } }) },
    { name: "ask", url: buildAskUrl(query, { source: "web" }) },
  ];

  let last = null;
  for (const cand of candidates) {
    const t = withTimeout(opts.signal, opts.timeoutMs);
    try {
      const headers = mergeHeaders(NAVIGATE_HEADERS, opts.headers, jar.toString() ? { cookie: jar.toString() } : null);
      const res = await fetchImpl(cand.url, {
        method: "GET",
        headers,
        redirect: "follow",
        signal: t.signal,
      });
      jar.ingestResponse(res);

      const finalUrl = res.url || cand.url;
      let conversation = extractConversationId(finalUrl);
      let html = "";
      try {
        html = await res.text();
      } catch (_) {
        html = "";
      }
      if (!conversation && html) conversation = extractConversationId(html);

      last = {
        conversation: conversation || null,
        finalUrl,
        status: res.status,
        strategy: cand.name,
        cookies: jar.toString() || null,
      };
      if (conversation) return last;
    } catch (e) {
      last = {
        conversation: null,
        finalUrl: cand.url,
        status: null,
        strategy: cand.name,
        error: e && e.message ? e.message : String(e),
        cookies: jar.toString() || null,
      };
      // continue to next candidate on failure/timeout
    } finally {
      t.cleanup();
    }
  }

  return last || { conversation: null, finalUrl: null, status: null, strategy: null, cookies: jar.toString() || null };
}

// --- Stream parsing / consumption ---

async function safeReadText(res) {
  try {
    return await res.text();
  } catch (_) {
    return "";
  }
}

function parseLine(line) {
  const trimmed = String(line || "").trim();
  if (!trimmed) return null;
  const payload = trimmed.startsWith("data:") ? trimmed.slice(5).trim() : trimmed;
  if (!payload || payload === "[DONE]") return null;
  try {
    return JSON.parse(payload);
  } catch (_) {
    return { type: "unparsed", raw: payload };
  }
}

/** Parse Brave `x-stream-format: tap` body (line-delimited JSON event objects). */
function parseEventStream(body) {
  const events = [];
  const text = String(body || "");
  const lines = text.split(/\r?\n/);
  for (const line of lines) {
    const ev = parseLine(line);
    if (ev) events.push(ev);
  }
  return events;
}

function applyEvent(state, ev) {
  if (!ev || typeof ev !== "object") return;
  switch (ev.type) {
    case "text_start":
      state.started = true;
      break;
    case "text_delta":
      if (typeof ev.delta === "string") state.deltaText += ev.delta;
      break;
    case "text_stop":
      if (typeof ev.text === "string") state.stopText = ev.text;
      state.stopped = true;
      break;
    case "usage":
      state.usage = {
        prompt_tokens: ev.prompt_tokens ?? null,
        completion_tokens: ev.completion_tokens ?? null,
        reasoning_tokens: ev.reasoning_tokens ?? null,
        raw: ev,
      };
      break;
    case "followups":
      state.followups = Array.isArray(ev.followups) ? ev.followups : [];
      break;
    case "enrichments":
      if (ev.enrichments && typeof ev.enrichments === "object") state.enrichments = ev.enrichments;
      break;
    default:
      break;
  }
}

function uniqStrings(items) {
  const out = [];
  const seen = new Set();
  for (const it of items || []) {
    let key;
    if (typeof it === "string") key = it;
    else if (it && typeof it === "object") key = it.url || it.link || it.href || JSON.stringify(it);
    else key = String(it);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(it);
  }
  return out;
}

function toCitation(item) {
  if (!item) return null;
  if (typeof item === "string") {
    return /^https?:\/\//i.test(item) ? { url: item } : { text: item };
  }
  if (typeof item !== "object") return { text: String(item) };
  const url = item.url || item.link || item.href || item.source_url || null;
  const title = item.title || item.name || item.heading || null;
  const snippet =
    item.snippet || item.description || item.text || item.excerpt || item.summary || null;
  const source = item.source || item.site || item.domain || item.hostname || null;
  const out = {};
  if (url) out.url = String(url);
  if (title) out.title = String(title);
  if (snippet) out.snippet = String(snippet);
  if (source) out.source = String(source);
  if (item.favicon) out.favicon = String(item.favicon);
  if (item.page_age || item.age || item.date) out.age = item.page_age || item.age || item.date;
  return Object.keys(out).length ? out : null;
}

function dedupeCitations(items) {
  const out = [];
  const seen = new Set();
  for (const it of items || []) {
    const c = toCitation(it);
    if (!c) continue;
    const key =
      (c.url && `url:${c.url}`) ||
      (c.title && c.snippet && `ts:${c.title}|${c.snippet}`) ||
      (c.title && `t:${c.title}`) ||
      JSON.stringify(c);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(c);
  }
  return out;
}

function extractSources(enrichments) {
  if (!enrichments || typeof enrichments !== "object") {
    return {
      references: [],
      urls: [],
      reference_urls: [],
      context_urls: [],
      context: [],
      context_results: [],
      images: [],
      qa: [],
      entities: [],
      main_entity: null,
      main_entity_infobox: null,
      predicate: null,
      citations: [],
      all_urls: [],
    };
  }
  const arr = (v) => (Array.isArray(v) ? v : []);
  const references = arr(enrichments.references);
  const urls = arr(enrichments.urls);
  const reference_urls = arr(enrichments.reference_urls);
  const context_urls = arr(enrichments.context_urls);
  const context_results = arr(enrichments.context_results);
  const urlLike = (x) => (typeof x === "string" ? x : x && (x.url || x.link || x.href));
  const all_urls = uniqStrings(
    [...urls, ...reference_urls, ...context_urls, ...references.map(urlLike), ...context_results.map(urlLike)].filter(Boolean)
  );
  const citations = dedupeCitations([
    ...references,
    ...reference_urls,
    ...urls,
    ...context_urls,
    ...context_results,
  ]);
  return {
    references,
    urls,
    reference_urls,
    context_urls,
    context: arr(enrichments.context),
    context_results,
    images: arr(enrichments.images),
    qa: arr(enrichments.qa),
    entities: arr(enrichments.entities),
    main_entity: enrichments.main_entity ?? null,
    main_entity_infobox: enrichments.main_entity_infobox ?? null,
    predicate: enrichments.predicate ?? null,
    citations,
    all_urls,
  };
}

function finalizeState(state) {
  const enrichments = state.enrichments || null;
  const answer =
    (enrichments && typeof enrichments.raw_response === "string" ? enrichments.raw_response : null) ??
    state.stopText ??
    state.deltaText ??
    "";
  return {
    answer,
    text: answer,
    usage: state.usage || null,
    followups: state.followups || [],
    enrichments,
    sources: extractSources(enrichments),
    started: !!state.started,
    stopped: !!state.stopped,
  };
}

/** Reduce parsed events into a structured result (buffered). */
function reduceEvents(events) {
  const state = { deltaText: "", stopText: null, usage: null, followups: [], enrichments: null, started: false, stopped: false };
  for (const ev of events || []) applyEvent(state, ev);
  return finalizeState(state);
}

async function* iterateNdjsonStream(response) {
  const body = response && response.body;
  if (!body) return;
  const decoder = new TextDecoder();
  let buffer = "";

  const feed = function* (chunkText) {
    buffer += chunkText;
    let idx;
    while ((idx = buffer.search(/\r?\n/)) !== -1) {
      const nl = buffer[idx] === "\r" && buffer[idx + 1] === "\n" ? 2 : 1;
      const line = buffer.slice(0, idx);
      buffer = buffer.slice(idx + nl);
      const ev = parseLine(line);
      if (ev) yield ev;
    }
  };

  if (typeof body.getReader === "function") {
    const reader = body.getReader();
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        yield* feed(decoder.decode(value, { stream: true }));
      }
      yield* feed(decoder.decode());
    } finally {
      try { reader.releaseLock(); } catch (_) {}
    }
  } else if (typeof body[Symbol.asyncIterator] === "function") {
    for await (const chunk of body) {
      yield* feed(typeof chunk === "string" ? chunk : decoder.decode(chunk, { stream: true }));
    }
    yield* feed(decoder.decode());
  } else {
    const text = await safeReadText(response);
    for (const ev of parseEventStream(text)) yield ev;
    return;
  }

  if (buffer.trim()) {
    const ev = parseLine(buffer);
    if (ev) yield ev;
  }
}

function isRetryableStatus(status) {
  return status === 408 || status === 425 || status === 429 || (status >= 500 && status <= 599);
}

function isRetryableNetworkError(error) {
  if (!error) return false;
  if (isAbortError(error)) return false;
  const msg = String(error.message || error || "");
  return (
    error.name === "TypeError" ||
    /fetch failed|network|ECONNRESET|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|socket hang up/i.test(msg)
  );
}

async function streamWithAskOnce(conversation, opts = {}) {
  const fetchImpl = assertFetch(opts.fetchImpl || globalThis.fetch);
  const conv = normalizeConversationId(conversation) || String(conversation || "").trim();
  if (!conv) {
    throw new BraveLeoError("conversation id is required", {
      code: ERROR_CODES.INVALID_INPUT,
      retryable: false,
    });
  }

  const jar = opts.cookieJar instanceof CookieJar ? opts.cookieJar : new CookieJar(opts.cookies);
  const url = buildWithAskUrl(conv, opts.enableInlineEntities !== false);
  const headers = mergeHeaders(
    STREAM_REQUEST_HEADERS,
    opts.referer ? { referer: opts.referer } : null,
    jar.toString() ? { cookie: jar.toString() } : null,
    opts.headers
  );

  const t = withTimeout(opts.signal, opts.timeoutMs);
  let res;
  try {
    try {
      res = await fetchImpl(url, { method: "GET", headers, signal: t.signal });
    } catch (e) {
      throw classifyError(e, { conversation: conv });
    }
    jar.ingestResponse(res);

    const resHeaders = headersToObject(res.headers);
    if (!res.ok) {
      const bodyText = await safeReadText(res);
      const retryAfterMs = parseRetryAfter(res.headers) ?? parseRetryAfter(resHeaders);
      throw new BraveLeoError(`with_ask request failed: ${res.status} ${res.statusText || ""}`.trim(), {
        code: res.status === 429 ? ERROR_CODES.RATE_LIMITED : ERROR_CODES.HTTP_ERROR,
        status: res.status,
        retryable: isRetryableStatus(res.status),
        retryAfterMs,
        details: truncate(bodyText, 1500),
        conversation: conv,
      });
    }

    const state = { deltaText: "", stopText: null, usage: null, followups: [], enrichments: null, started: false, stopped: false };
    const events = [];
    const includeEvents = opts.includeEvents !== false;
    const onEvent = typeof opts.onEvent === "function" ? opts.onEvent : null;
    const incremental = opts.incremental !== false && !!res.body;
    let streamError = null;

    const consume = async (iter) => {
      try {
        for await (const ev of iter) {
          if (includeEvents) events.push(ev);
          applyEvent(state, ev);
          if (onEvent) {
            try { onEvent(ev, { ...finalizeState(state), partial: true, conversation: conv }); } catch (_) {}
          }
        }
      } catch (e) {
        streamError = classifyError(e, { conversation: conv });
        streamError.code = isAbortError(e) ? streamError.code : ERROR_CODES.STREAM_ERROR;
        streamError.retryable = false; // partial stream already consumed
      }
    };

    if (incremental) {
      await consume(iterateNdjsonStream(res));
    } else {
      const bodyText = await safeReadText(res);
      await consume((async function* () { for (const ev of parseEventStream(bodyText)) yield ev; })());
    }

    const reduced = finalizeState(state);
    const result = {
      ok: !streamError,
      conversation: conv,
      answer: reduced.answer,
      text: reduced.text,
      usage: reduced.usage,
      followups: reduced.followups,
      enrichments: reduced.enrichments,
      sources: reduced.sources,
      events: includeEvents ? events : undefined,
      status: res.status,
      headers: resHeaders,
      contentType: (resHeaders["content-type"] || "").toLowerCase(),
      streamFormat: resHeaders["x-stream-format"] || null,
      cookies: jar.toString() || null,
    };
    if (streamError) {
      result.partial = true;
      result.error = streamError.message;
      result.errorInfo = streamError.toJSON ? streamError.toJSON() : { message: streamError.message, code: ERROR_CODES.STREAM_ERROR };
      // Surface partial result to caller instead of throwing away collected data.
      // Attach for callers that want to throw while keeping partial data.
      streamError.partialResult = result;
    }
    if (opts.usageTracker && result.usage) {
      try { opts.usageTracker.record(result.usage); } catch (_) {}
    }
    if (streamError && !opts.allowPartial) throw streamError;
    return result;
  } finally {
    t.cleanup();
  }
}

/**
 * Fetch and consume the `with_ask` stream for a conversation (with retries/backoff/rate-limit handling).
 */
async function streamWithAsk(conversation, opts = {}) {
  const retries = Math.max(0, Number(opts.retries ?? 0) || 0);
  return withRetry(
    async () => {
      try {
        return await streamWithAskOnce(conversation, opts);
      } catch (e) {
        throw classifyError(e, { conversation });
      }
    },
    {
      retries,
      signal: opts.signal,
      retryDelayMs: opts.retryDelayMs,
      maxRetryDelayMs: opts.maxRetryDelayMs,
      onRetry: opts.onRetry,
      context: { conversation },
    }
  );
}

/**
 * Async generator: yields each stream event, then returns/finalizes with reduced result.
 * Usage: for await (const ev of braveLeoStream(...)) { ... }  (collect via helper) or
 *        const gen = braveLeoStream(...); for await (const ev of gen) ... not directly returning final,
 * so prefer `braveLeoSearch` with `onEvent`, or use this with a collector:
 */
async function* braveLeoEventStream(conversation, opts = {}) {
  // Implement as incremental pass-through by tapping onEvent-like collection.
  const queue = [];
  let done = false;
  let final = null;
  let err = null;
  let notify;
  const wake = () => { if (notify) { const n = notify; notify = null; n(); } };

  const p = streamWithAsk(conversation, {
    ...opts,
    incremental: true,
    onEvent: (ev, partial) => {
      queue.push({ event: ev, partial });
      wake();
      if (opts.onEvent) try { opts.onEvent(ev, partial); } catch (_) {}
    },
  })
    .then((r) => { final = r; })
    .catch((e) => { err = e; })
    .finally(() => { done = true; wake(); });

  while (!done || queue.length) {
    if (queue.length) {
      yield queue.shift();
      continue;
    }
    await new Promise((r) => { notify = r; });
  }
  await p.catch(() => {});
  if (err) throw err;
  return final;
}

// --- High-level tool/agent API ---

function buildAgentResult({ ok, query, conversation, resolution, stream, error, includeEvents = true }) {
  if (!ok) {
    const errObj = typeof error === "object" && error ? error : null;
    return {
      ok: false,
      query: query || null,
      conversation: conversation || null,
      answer: "",
      text: "",
      usage: null,
      followups: [],
      enrichments: null,
      sources: extractSources(null),
      error: errObj ? errObj.message || "Unknown error" : (error || "Unknown error"),
      errorInfo: errObj && errObj.code ? errObj : (errObj && errObj.errorInfo) || null,
      resolution: resolution || null,
    };
  }
  const result = {
    ok: true,
    query: query || null,
    conversation: stream.conversation,
    answer: stream.answer,
    text: stream.text,
    usage: stream.usage,
    followups: stream.followups,
    enrichments: stream.enrichments,
    sources: stream.sources,
    meta: {
      status: stream.status,
      contentType: stream.contentType,
      streamFormat: stream.streamFormat,
      resolution: resolution || null,
      cookies: stream.cookies || null,
    },
  };
  if (includeEvents && stream.events) result.events = stream.events;
  return result;
}

/** Compact result for LLM/tool context (drops raw events/headers, keeps essentials). */
function compactResult(result, opts = {}) {
  if (!result || typeof result !== "object") return result;
  const maxSources = Number.isFinite(opts.maxSources) ? opts.maxSources : 10;
  const maxFollowups = Number.isFinite(opts.maxFollowups) ? opts.maxFollowups : 5;
  const src = result.sources || extractSources(result.enrichments);
  const citations = (src.citations || []).slice(0, maxSources);
  const sourceUrls = uniqStrings([
    ...(src.all_urls || []),
    ...citations.map((c) => c && c.url).filter(Boolean),
  ]).slice(0, maxSources);
  const compact = {
    ok: !!result.ok,
    query: result.query || null,
    conversation: result.conversation || null,
    answer: result.answer || result.text || "",
    followups: Array.isArray(result.followups) ? result.followups.slice(0, maxFollowups) : [],
    citations,
    sources: sourceUrls,
    usage: result.usage || null,
  };
  if (!result.ok) compact.error = result.error || "Unknown error";
  if (result.errorInfo) compact.errorInfo = result.errorInfo;
  if (result.status != null) compact.status = result.status;
  if (result.partial) compact.partial = true;
  if (src.main_entity) compact.main_entity = src.main_entity;
  return compact;
}

/** Format a result as concise text for agent consumption. */
function formatResultAsText(result, opts = {}) {
  if (!result) return "";
  if (!result.ok) return `Error: ${result.error || "request failed"}`;
  const parts = [];
  if (result.answer) parts.push(String(result.answer));
  const compact = compactResult(result, opts);
  if (compact.citations && compact.citations.length) {
    parts.push(
      "\nSources:\n" +
        compact.citations
          .map((c, i) => {
            const label = c.title ? `${c.title} — ${c.url || ""}` : c.url || c.text || JSON.stringify(c);
            const snip = c.snippet ? `\n   ${String(c.snippet).slice(0, 180)}` : "";
            return `${i + 1}. ${label}${snip}`;
          })
          .join("\n")
    );
  } else if (compact.sources && compact.sources.length) {
    parts.push("\nSources:\n" + compact.sources.map((s, i) => `${i + 1}. ${typeof s === "string" ? s : JSON.stringify(s)}`).join("\n"));
  }
  if (compact.followups && compact.followups.length) {
    parts.push(
      "\nFollow-ups:\n" +
        compact.followups.map((f) => `- ${typeof f === "string" ? f : JSON.stringify(f)}`).join("\n")
    );
  }
  return parts.join("\n");
}

/**
 * High-level: get a Brave Leo / Answer with AI web-grounded answer.
 * - If `conversation` provided: streams it directly.
 * - Else: best-effort resolves a conversation id from Brave Search for `query`.
 */
async function braveLeoSearch(input = {}) {
  const {
    query,
    enableInlineEntities = true,
    source = "web",
    fetchImpl,
    headers,
    signal,
    onEvent,
    incremental = true,
    cookies,
    includeEvents = true,
    timeoutMs,
    retries = 0,
    retryDelayMs,
    maxRetryDelayMs,
    onRetry,
    allowPartial = true,
    usageTracker,
  } = input;

  let conversation =
    normalizeConversationId(input.conversation) ||
    (input.conversation ? String(input.conversation).trim() : null);
  const jar = input.cookieJar instanceof CookieJar ? input.cookieJar : new CookieJar(cookies);
  let resolution = null;

  try {
    if (!conversation) {
      if (!query || !String(query).trim()) {
        throw new BraveLeoError("Either 'conversation' or 'query' must be provided", {
          code: ERROR_CODES.INVALID_INPUT,
          retryable: false,
        });
      }
      resolution = await resolveConversation(query, {
        source,
        fetchImpl,
        headers,
        signal,
        cookieJar: jar,
        timeoutMs,
      });
      conversation = normalizeConversationId(resolution.conversation);
    }

    if (!conversation) {
      const err = new BraveLeoError(
        "Could not resolve a Brave chatllm conversation id for the query. " +
          "Conversation initiation was not fully captured; provide a known 'conversation' id, " +
          "or pass browser/session cookies in an environment where Brave Search returns a conversation-backed answer.",
        { code: ERROR_CODES.CONVERSATION_NOT_FOUND, retryable: false }
      );
      const res = buildAgentResult({
        ok: false,
        query,
        conversation: null,
        resolution,
        error: err.message,
        includeEvents,
      });
      res.errorInfo = err.toJSON();
      res.meta = { resolution, cookies: jar.toString() || null };
      return res;
    }

    const referer = query
      ? `${BRAVE_ORIGIN}/search?${new URLSearchParams({ q: String(query), source }).toString()}&conversation=${conversation}`
      : `${BRAVE_ORIGIN}/search?conversation=${conversation}`;

    const stream = await streamWithAsk(conversation, {
      enableInlineEntities,
      fetchImpl,
      headers,
      referer,
      signal,
      onEvent,
      incremental,
      cookieJar: jar,
      includeEvents,
      timeoutMs,
      retries,
      retryDelayMs,
      maxRetryDelayMs,
      onRetry,
      allowPartial,
      usageTracker,
    });

    const built = buildAgentResult({ ok: stream.ok !== false, query, conversation, resolution, stream, includeEvents });
    if (stream.partial) built.partial = true;
    if (stream.error) built.error = stream.error;
    if (stream.errorInfo) built.errorInfo = stream.errorInfo;
    return built;
  } catch (e) {
    const err = classifyError(e, { conversation });
    // If a partial stream result was attached, return it with error details.
    if (err.partialResult && allowPartial) {
      const pr = err.partialResult;
      const built = buildAgentResult({ ok: false, query, conversation: pr.conversation || conversation, resolution, stream: pr, includeEvents });
      built.partial = true;
      built.answer = pr.answer || "";
      built.text = pr.text || pr.answer || "";
      built.usage = pr.usage || null;
      built.followups = pr.followups || [];
      built.sources = pr.sources || extractSources(null);
      built.error = err.message;
      built.errorInfo = err.toJSON();
      return built;
    }
    const out = {
      ok: false,
      query: query || null,
      conversation: conversation || null,
      answer: "",
      text: "",
      usage: null,
      followups: [],
      enrichments: null,
      sources: extractSources(null),
      error: err.message,
      errorInfo: err.toJSON(),
      status: err.status ?? null,
      resolution,
      meta: { cookies: jar.toString() || null },
    };
    return out;
  }
}

/** Throw on failure, return structured result on success. */
async function braveLeoSearchOrThrow(input = {}) {
  const out = await braveLeoSearch(input);
  if (!out.ok) {
    const err = new Error(out.error || "braveLeoSearch failed");
    err.result = out;
    err.status = out.status;
    throw err;
  }
  return out;
}

/**
 * Stateful client for session/cookie reuse and convenience methods.
 */
class BraveLeoClient {
  constructor(opts = {}) {
    this.fetchImpl = opts.fetchImpl || globalThis.fetch;
    this.cookieJar = opts.cookieJar instanceof CookieJar ? opts.cookieJar : new CookieJar(opts.cookies);
    this.headers = opts.headers ? { ...opts.headers } : {};
    this.source = opts.source || "web";
    this.timeoutMs = opts.timeoutMs;
    this.retries = Math.max(0, Number(opts.retries ?? 0) || 0);
    this.retryDelayMs = opts.retryDelayMs;
    this.maxRetryDelayMs = opts.maxRetryDelayMs;
    this.usageTracker = opts.usageTracker instanceof UsageTracker ? opts.usageTracker : new UsageTracker();
  }
  setCookies(cookies) {
    if (cookies instanceof CookieJar) this.cookieJar = cookies.clone();
    else this.cookieJar = new CookieJar(cookies);
    return this;
  }
  clearCookies() {
    this.cookieJar = new CookieJar();
    return this;
  }
  setHeader(name, value) {
    if (!name) return this;
    if (value == null) delete this.headers[String(name).toLowerCase()];
    else this.headers[String(name).toLowerCase()] = String(value);
    return this;
  }
  setAuthorization(tokenOrHeader) {
    if (!tokenOrHeader) return this.setHeader("authorization", null);
    const v = String(tokenOrHeader);
    this.setHeader("authorization", /^bearer\s/i.test(v) ? v : `Bearer ${v}`);
    return this;
  }
  exportState() {
    return {
      cookies: this.cookieJar.toString() || null,
      headers: { ...this.headers },
      source: this.source,
      usage: this.usageTracker.snapshot(),
    };
  }
  importState(state = {}) {
    if (state.cookies != null) this.setCookies(state.cookies);
    if (state.headers && typeof state.headers === "object") this.headers = { ...this.headers, ...state.headers };
    if (state.source) this.source = state.source;
    return this;
  }
  getUsage() {
    return this.usageTracker.snapshot();
  }
  resetUsage() {
    this.usageTracker.reset();
    return this;
  }
  async resolveConversation(query, opts = {}) {
    return resolveConversation(query, {
      fetchImpl: this.fetchImpl,
      headers: { ...this.headers, ...(opts.headers || {}) },
      cookieJar: this.cookieJar,
      source: opts.source || this.source,
      timeoutMs: opts.timeoutMs ?? this.timeoutMs,
      signal: opts.signal,
    });
  }
  async ask(input = {}) {
    const query = typeof input === "string" ? input : input.query;
    const opts = typeof input === "string" ? {} : input;
    return braveLeoSearch({
      source: this.source,
      timeoutMs: this.timeoutMs,
      retries: this.retries,
      retryDelayMs: this.retryDelayMs,
      maxRetryDelayMs: this.maxRetryDelayMs,
      ...opts,
      query,
      fetchImpl: this.fetchImpl,
      headers: { ...this.headers, ...(opts.headers || {}) },
      cookieJar: this.cookieJar,
      cookies: undefined, // jar is authoritative
      usageTracker: this.usageTracker,
    });
  }
  async stream(conversation, opts = {}) {
    return streamWithAsk(conversation, {
      fetchImpl: this.fetchImpl,
      headers: { ...this.headers, ...(opts.headers || {}) },
      cookieJar: this.cookieJar,
      timeoutMs: opts.timeoutMs ?? this.timeoutMs,
      retries: opts.retries ?? this.retries,
      retryDelayMs: opts.retryDelayMs ?? this.retryDelayMs,
      maxRetryDelayMs: opts.maxRetryDelayMs ?? this.maxRetryDelayMs,
      usageTracker: this.usageTracker,
      ...opts,
    });
  }
  get cookies() {
    return this.cookieJar.toString() || null;
  }
}

// --- Tool-calling integration (agent-friendly) ---

const TOOL_NAME = "brave_leo_search";

const TOOL_DESCRIPTION =
  "Web search with an AI-grounded answer via Brave Leo / 'Answer with AI' (search.brave.com chatllm). " +
  "Use for up-to-date web questions, fact-finding, and cited answers. " +
  "Returns: answer, citations/sources (URLs, titles/snippets when available), follow-up questions, and usage. " +
  "Pass a natural-language 'query'. A known Brave 'conversation' id can be provided for direct streaming/resume, " +
  "but conversation creation is best-effort and may require browser/session cookies in some environments.";

const TOOL_PARAMETERS = {
  type: "object",
  properties: {
    query: {
      type: "string",
      description:
        "The web search question or intent to answer (natural language). Example: \"latest Node.js LTS version and release date\".",
    },
    conversation: {
      type: "string",
      description:
        "Optional existing Brave chatllm conversation id (hex, ~32 chars as observed). Prefer omitting unless resuming a known conversation.",
    },
    enableInlineEntities: {
      type: "boolean",
      description: "Request inline entities/enrichments/sources when available (default: true).",
      default: true,
    },
    compact: {
      type: "boolean",
      description:
        "Return compact LLM-friendly payload without raw stream events (default: true for tool calls).",
      default: true,
    },
    format: {
      type: "string",
      enum: ["json", "text"],
      description:
        "Tool result content format: 'json' (structured, default) or 'text' (formatted answer + sources).",
      default: "json",
    },
  },
  required: ["query"],
  additionalProperties: false,
};

/** OpenAI-compatible tool/function schema. */
const BRAVE_LEO_TOOL = {
  type: "function",
  function: {
    name: TOOL_NAME,
    description: TOOL_DESCRIPTION,
    parameters: TOOL_PARAMETERS,
  },
};

/** Convenience: OpenAI `tools` array. */
const BRAVE_LEO_TOOLS = [BRAVE_LEO_TOOL];

/** Anthropic-style tool schema (input_schema). */
const BRAVE_LEO_TOOL_ANTHROPIC = {
  name: TOOL_NAME,
  description: TOOL_DESCRIPTION,
  input_schema: TOOL_PARAMETERS,
};

function safeJsonParse(v) {
  if (v == null) return {};
  if (typeof v === "object") return v;
  if (typeof v !== "string") return {};
  try {
    return JSON.parse(v);
  } catch (_) {
    return { query: String(v) };
  }
}

/** Normalize tool-call argument shapes (string/object/OpenAI function.arguments). */
function normalizeToolArgs(args) {
  if (args == null) return {};
  if (typeof args === "string") return safeJsonParse(args);
  if (typeof args === "object") {
    // OpenAI chat tool_call: { function: { name, arguments } }
    if (args.function && (args.function.arguments || args.function.name)) {
      return safeJsonParse(args.function.arguments);
    }
    // Generic { name, arguments } / { arguments }
    if (typeof args.arguments === "string") return safeJsonParse(args.arguments);
    if (args.arguments && typeof args.arguments === "object") return { ...args.arguments };
    return { ...args };
  }
  return {};
}

function makeToolPayload(result, opts = {}) {
  const compact = compactResult(result, opts);
  const payload = {
    ...compact,
    content: formatResultAsText(result, opts),
  };
  return payload;
}

/**
 * Tool-dispatch wrapper optimized for LLM tool calling.
 * Defaults: compact=true, includeEvents=false.
 * Returns { ok, query, conversation, answer, citations, sources, followups, usage, content, error? }
 */
async function braveLeoSearchTool(args = {}) {
  const normalized = normalizeToolArgs(args);
  const compact = normalized.compact !== false; // default true for tool calls
  const format = normalized.format || "json";
  const res = await braveLeoSearch({
    ...normalized,
    query: normalized.query,
    conversation: normalized.conversation,
    includeEvents: compact ? false : normalized.includeEvents !== false,
  });
  const payload = makeToolPayload(res);
  if (format === "text") {
    return {
      ok: payload.ok,
      conversation: payload.conversation,
      content: payload.content,
      answer: payload.answer,
      citations: payload.citations,
      sources: payload.sources,
      followups: payload.followups,
      usage: payload.usage,
      ...(payload.ok ? {} : { error: payload.error }),
    };
  }
  return payload;
}

/**
 * Execute a tool call in common agent formats.
 * Accepts: raw args object, JSON args string, OpenAI {function:{name,arguments}},
 * {name, arguments}, or {tool, input}. Returns a JSON string (default) or object.
 */
async function executeToolCall(toolCallOrArgs = {}, opts = {}) {
  try {
    const name =
      toolCallOrArgs &&
      (toolCallOrArgs.name ||
        toolCallOrArgs.tool ||
        (toolCallOrArgs.function && toolCallOrArgs.function.name));
    if (name && name !== TOOL_NAME) {
      const err = {
        ok: false,
        error: `Unknown tool: ${name}`,
        errorInfo: { code: ERROR_CODES.UNKNOWN_TOOL, message: `Unknown tool: ${name}`, expected: TOOL_NAME },
        expected: TOOL_NAME,
      };
      return opts.asObject ? err : JSON.stringify(err);
    }
    const args = normalizeToolArgs(toolCallOrArgs);
    if (!args.query && toolCallOrArgs && typeof toolCallOrArgs.input === "string") {
      args.query = toolCallOrArgs.input;
    }
    // Merge executor-level defaults (e.g. client-managed cookies/usage/retries)
    const merged = { ...(opts.defaults || {}), ...args };
    const result = await braveLeoSearchTool(merged);
    if (opts.asObject) return result;
    if (opts.format === "text" || args.format === "text") return result.content || "";
    return JSON.stringify(result);
  } catch (e) {
    const err = classifyError(e);
    const payload = {
      ok: false,
      error: err.message,
      errorInfo: err.toJSON(),
      answer: "",
      citations: [],
      sources: [],
      followups: [],
      usage: null,
      content: `Error: ${err.message}`,
    };
    if (opts.asObject) return payload;
    if (opts.format === "text") return payload.content;
    return JSON.stringify(payload);
  }
}

/** Create an OpenAI tool result message payload. */
function toToolResultMessage(toolCall, result, opts = {}) {
  const toolCallId = (toolCall && (toolCall.id || toolCall.tool_call_id)) || opts.toolCallId || null;
  const content =
    typeof result === "string" ? result : JSON.stringify(result && result.ok !== undefined ? result : makeToolPayload(result || {}));
  if (toolCallId) {
    return { role: "tool", tool_call_id: toolCallId, name: TOOL_NAME, content };
  }
  return { role: "tool", name: TOOL_NAME, content };
}

/** Suggested system hint for agents using this tool. */
const TOOL_SYSTEM_HINT =
  `You can call \`${TOOL_NAME}\` for web-grounded answers. ` +
  `Use the returned \`answer\` as the primary response and cite \`citations\`/\`sources\` when relevant. ` +
  `If \`ok\` is false, report \`error\` and ask for a known conversation id or browser/session cookies if needed.`;

// --- ESM exports ---
export {
  BRAVE_ORIGIN,
  WITH_ASK_PATH,
  ERROR_CODES,
  BraveLeoError,
  UsageTracker,
  TOOL_NAME,
  TOOL_DESCRIPTION,
  TOOL_PARAMETERS,
  BRAVE_LEO_TOOL,
  BRAVE_LEO_TOOLS,
  BRAVE_LEO_TOOL_ANTHROPIC,
  TOOL_SYSTEM_HINT,
  CookieJar,
  BraveLeoClient,
  buildSearchUrl,
  buildAskUrl,
  buildFollowupUrl,
  buildWithAskUrl,
  normalizeConversationId,
  extractConversationId,
  parseEventStream,
  reduceEvents,
  extractSources,
  compactResult,
  formatResultAsText,
  makeToolPayload,
  normalizeToolArgs,
  executeToolCall,
  toToolResultMessage,
  resolveConversation,
  streamWithAsk,
  braveLeoEventStream,
  braveLeoSearch,
  braveLeoSearchOrThrow,
  braveLeoSearchTool,
};

// --- CommonJS compatibility (best-effort) ---
try {
  // eslint-disable-next-line no-undef
  if (typeof module !== "undefined" && module.exports) {
    const api = {
      BRAVE_ORIGIN,
      WITH_ASK_PATH,
      ERROR_CODES,
      BraveLeoError,
      UsageTracker,
      TOOL_NAME,
      TOOL_DESCRIPTION,
      TOOL_PARAMETERS,
      BRAVE_LEO_TOOL,
      BRAVE_LEO_TOOLS,
      BRAVE_LEO_TOOL_ANTHROPIC,
      TOOL_SYSTEM_HINT,
      CookieJar,
      BraveLeoClient,
      buildSearchUrl,
      buildAskUrl,
      buildFollowupUrl,
      buildWithAskUrl,
      normalizeConversationId,
      extractConversationId,
      parseEventStream,
      reduceEvents,
      extractSources,
      compactResult,
      formatResultAsText,
      makeToolPayload,
      normalizeToolArgs,
      executeToolCall,
      toToolResultMessage,
      resolveConversation,
      streamWithAsk,
      braveLeoEventStream,
      braveLeoSearch,
      braveLeoSearchOrThrow,
      braveLeoSearchTool,
    };
    // eslint-disable-next-line no-undef
    module.exports = { ...api, default: api };
  }
} catch (_) {}

// --- CLI ---
const isDirectRun = (() => {
  try {
    if (typeof process === "undefined" || !process.argv) return false;
    const argv1 = process.argv[1] || "";
    return /BraveSearchAPI\.js$/.test(argv1);
  } catch (_) {
    return false;
  }
})();

function parseArgs(argv) {
  const out = {
    queryParts: [],
    conversation: null,
    json: false,
    stream: false,
    compact: false,
    noEntities: false,
    source: "web",
    cookies: null,
    timeoutMs: null,
    retries: 0,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--conversation" || a === "-c") out.conversation = argv[++i] || null;
    else if (a === "--json") out.json = true;
    else if (a === "--stream") out.stream = true;
    else if (a === "--compact") out.compact = true;
    else if (a === "--no-inline-entities") out.noEntities = true;
    else if (a === "--source") out.source = argv[++i] || "web";
    else if (a === "--cookies") out.cookies = argv[++i] || null;
    else if (a === "--timeout") out.timeoutMs = Number(argv[++i]) || null;
    else if (a === "--retries") out.retries = Math.max(0, Number(argv[++i]) || 0);
    else if (a === "--help" || a === "-h") out.help = true;
    else out.queryParts.push(a);
  }
  out.query = out.queryParts.join(" ").trim();
  return out;
}

if (isDirectRun) {
  (async () => {
    const args = parseArgs(process.argv.slice(2));
    if (args.help || (!args.query && !args.conversation)) {
      console.error(
        [
          "Usage: node BraveSearchAPI.js <query> [options]",
          "       node BraveSearchAPI.js --conversation <id> [options]",
          "",
          "Options:",
          "  -c, --conversation <id>   Stream a known Brave chatllm conversation id",
          "      --source <src>        Brave search source (default: web)",
          "      --cookies <str>       Cookie header for session continuity",
          "      --timeout <ms>        Request timeout in milliseconds",
          "      --retries <n>         Retry transient/rate-limit/network failures (default: 0)",
          "      --no-inline-entities  Disable inline entity/enrichment request",
          "      --stream              Print answer deltas live to stdout",
          "      --compact             Print compact LLM-friendly JSON/text result",
          "      --json                Print full structured JSON result",
          "  -h, --help                Show this help",
        ].join("\n")
      );
      process.exit(args.help ? 0 : 2);
    }

    try {
      let live = "";
      const onEvent =
        args.stream && !args.json
          ? (ev) => {
              if (ev && ev.type === "text_delta" && typeof ev.delta === "string") {
                process.stdout.write(ev.delta);
                live += ev.delta;
              }
            }
          : undefined;

      const out = await braveLeoSearch({
        query: args.query || undefined,
        conversation: args.conversation || undefined,
        enableInlineEntities: !args.noEntities,
        source: args.source,
        cookies: args.cookies || undefined,
        timeoutMs: args.timeoutMs || undefined,
        retries: args.retries || 0,
        onEvent,
        includeEvents: !args.compact,
      });

      const view = args.compact ? compactResult(out) : out;

      if (args.json) {
        console.log(JSON.stringify(view, null, 2));
      } else if (args.stream) {
        if (!live && (view.answer || out.answer)) process.stdout.write(view.answer || out.answer);
        process.stdout.write("\n");
        if (out.conversation) console.error(`\n[conversation] ${out.conversation}`);
        const followups = view.followups || out.followups || [];
        if (followups.length) console.error("[followups] " + JSON.stringify(followups));
        const srcs = (view.sources && Array.isArray(view.sources) ? view.sources : (out.sources && out.sources.all_urls) || []).slice(0, 10);
        if (srcs.length) console.error("[sources] " + JSON.stringify(srcs));
        if (!out.ok) console.error("[error] " + out.error);
      } else {
        if (out.ok) {
          if (args.compact) {
            console.log(JSON.stringify(view, null, 2));
          } else {
            console.log(formatResultAsText(out));
            if (out.conversation) console.error(`\n[conversation] ${out.conversation}`);
          }
        } else {
          console.error(JSON.stringify(view, null, 2));
        }
      }
      process.exit(out.ok ? 0 : 1);
    } catch (e) {
      console.error(JSON.stringify({ ok: false, error: e.message, status: e.status, body: e.body }, null, 2));
      process.exit(1);
    }
  })();
}
