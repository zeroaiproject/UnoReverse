/**
 * Stateful client: cookie/session reuse, header defaults, usage accounting and
 * a small conversation cache (resolution is a 3-request heuristic — do not
 * repeat it for the same query).
 */

import { ERROR_CODES, BraveLeoError } from "./errors.js";
import { CookieJar, toCookieJar } from "./http.js";
import { normalizeConversationId, resolveConversation } from "./conversation.js";
import { braveLeoSearch, streamWithAsk } from "./search.js";

export function emptyUsage() {
  return { prompt_tokens: 0, completion_tokens: 0, reasoning_tokens: 0, total_tokens: 0, requests: 0 };
}

export function addUsage(target, usage) {
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

export class UsageTracker {
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

export class BraveLeoClient {
  constructor(opts = {}) {
    this.fetchImpl = opts.fetchImpl || globalThis.fetch;
    this.cookieJar = toCookieJar(opts.cookieJar ?? opts.cookies);
    this.headers = opts.headers ? { ...opts.headers } : {};
    this.source = opts.source || "web";
    this.timeoutMs = opts.timeoutMs;
    this.streamIdleTimeoutMs = opts.streamIdleTimeoutMs;
    this.retries = Math.max(0, Number(opts.retries ?? 0) || 0);
    this.retryDelayMs = opts.retryDelayMs;
    this.maxRetryDelayMs = opts.maxRetryDelayMs;
    this.usageTracker = opts.usageTracker instanceof UsageTracker ? opts.usageTracker : new UsageTracker();
    /** @type {Map<string,string>} query -> conversation id */
    this.conversationCache = new Map();
    this.useConversationCache = opts.useConversationCache !== false;
  }

  setCookies(cookies) {
    this.cookieJar = cookies instanceof CookieJar ? cookies.clone() : new CookieJar(cookies);
    return this;
  }

  clearCookies() {
    this.cookieJar = new CookieJar();
    return this;
  }

  setHeader(name, value) {
    if (!name) return this;
    const key = String(name).toLowerCase();
    if (value == null) delete this.headers[key];
    else this.headers[key] = String(value);
    return this;
  }

  setAuthorization(tokenOrHeader) {
    if (!tokenOrHeader) return this.setHeader("authorization", null);
    const v = String(tokenOrHeader);
    return this.setHeader("authorization", /^bearer\s/i.test(v) ? v : `Bearer ${v}`);
  }

  exportState() {
    return {
      cookies: this.cookieJar.toString() || null,
      headers: { ...this.headers },
      source: this.source,
      usage: this.usageTracker.snapshot(),
      conversations: Object.fromEntries(this.conversationCache),
    };
  }

  importState(state = {}) {
    if (state.cookies != null) this.setCookies(state.cookies);
    if (state.headers && typeof state.headers === "object") this.headers = { ...this.headers, ...state.headers };
    if (state.source) this.source = state.source;
    if (state.conversations && typeof state.conversations === "object") {
      for (const [k, v] of Object.entries(state.conversations)) {
        const conv = normalizeConversationId(v);
        if (conv) this.conversationCache.set(k, conv);
      }
    }
    return this;
  }

  getUsage() {
    return this.usageTracker.snapshot();
  }

  resetUsage() {
    this.usageTracker.reset();
    return this;
  }

  clearConversationCache() {
    this.conversationCache.clear();
    return this;
  }

  #cacheKey(query, source) {
    return `${source || this.source}\u0000${String(query || "")}`;
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
    const source = opts.source || this.source;

    let conversation = normalizeConversationId(opts.conversation);
    if (!conversation && query && this.useConversationCache && opts.useConversationCache !== false) {
      conversation = this.conversationCache.get(this.#cacheKey(query, source)) || null;
    }

    const out = await braveLeoSearch({
      source,
      timeoutMs: this.timeoutMs,
      streamIdleTimeoutMs: this.streamIdleTimeoutMs,
      retries: this.retries,
      retryDelayMs: this.retryDelayMs,
      maxRetryDelayMs: this.maxRetryDelayMs,
      ...opts,
      query,
      conversation,
      fetchImpl: this.fetchImpl,
      headers: { ...this.headers, ...(opts.headers || {}) },
      cookieJar: this.cookieJar,
      usageTracker: this.usageTracker,
    });

    if (out.ok && out.conversation && query && this.useConversationCache) {
      this.conversationCache.set(this.#cacheKey(query, source), out.conversation);
    }
    return out;
  }

  async stream(conversation, opts = {}) {
    const conv = normalizeConversationId(conversation) || String(conversation || "").trim();
    if (!conv) {
      throw new BraveLeoError("conversation id is required for stream()", {
        code: ERROR_CODES.INVALID_INPUT,
        retryable: false,
      });
    }
    return streamWithAsk(conv, {
      ...opts,
      fetchImpl: this.fetchImpl,
      headers: { ...this.headers, ...(opts.headers || {}) },
      cookieJar: this.cookieJar,
      timeoutMs: opts.timeoutMs ?? this.timeoutMs,
      streamIdleTimeoutMs: opts.streamIdleTimeoutMs ?? this.streamIdleTimeoutMs,
      retries: opts.retries ?? this.retries,
      retryDelayMs: opts.retryDelayMs ?? this.retryDelayMs,
      maxRetryDelayMs: opts.maxRetryDelayMs ?? this.maxRetryDelayMs,
      usageTracker: this.usageTracker,
    });
  }

  get cookies() {
    return this.cookieJar.toString() || null;
  }
}
