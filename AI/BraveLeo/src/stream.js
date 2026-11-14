/**
 * Stream decoding for Brave `x-stream-format: tap`.
 *
 * Observed wire shape: one JSON event object per line (`text_start`,
 * `text_delta`, `text_stop`, `usage`, `followups`, `enrichments`). Brave serves
 * it as `text/event-stream`, so the parser also accepts real SSE framing
 * (`data:`/`event:`/comments/`[DONE]`) to survive a format switch.
 */

import { ERROR_CODES } from "./errors.js";
import { DEFAULT_MAX_RESPONSE_BYTES } from "./constants.js";
import { readTextBounded } from "./http.js";

/**
 * Incremental line/SSE parser. Feed raw decoded text, receive parsed events.
 * Safe against chunk boundaries splitting a line mid-JSON.
 */
export class StreamParser {
  constructor(opts = {}) {
    this.maxLineBytes = Number(opts.maxLineBytes) || 1024 * 1024;
    this.buffer = "";
    this.dataLines = [];
    this.eventName = null;
    this.done = false;
    this.droppedBytes = 0;
  }

  /** @returns {object[]} events completed by this chunk */
  push(chunk) {
    if (this.done) return [];
    this.buffer += chunk;
    const out = [];
    let idx;
    while (!this.done && (idx = this.buffer.indexOf("\n")) !== -1) {
      let line = this.buffer.slice(0, idx);
      this.buffer = this.buffer.slice(idx + 1);
      if (line.endsWith("\r")) line = line.slice(0, -1);
      this.#line(line, out);
    }
    if (!this.done && this.buffer.length > this.maxLineBytes) {
      // A newline-free blob this large is not a valid stream frame.
      const raw = this.buffer;
      this.buffer = "";
      this.droppedBytes += raw.length;
      out.push({ type: "unparsed", raw: raw.slice(0, 512), truncated: true });
    }
    return out;
  }

  /** Flush the trailing partial line / pending SSE event. */
  end() {
    if (this.done) return [];
    const out = [];
    if (this.buffer.length) {
      let line = this.buffer;
      this.buffer = "";
      if (line.endsWith("\r")) line = line.slice(0, -1);
      this.#line(line, out);
    }
    if (!this.done) this.#dispatch(out);
    this.done = true;
    return out;
  }

  #line(line, out) {
    if (!line) {
      this.#dispatch(out); // blank line terminates an SSE event
      return;
    }
    if (line.startsWith(":")) return; // SSE comment / heartbeat
    if (line.startsWith("event:")) {
      this.eventName = line.slice(6).trim();
      return;
    }
    if (line.startsWith("id:") || line.startsWith("retry:")) return;
    if (line.startsWith("data:")) {
      this.dataLines.push(line.slice(5).replace(/^ /, ""));
      return;
    }
    // TAP: bare JSON per line.
    if (line.trim() === "[DONE]") {
      this.done = true;
      this.dataLines = [];
      this.eventName = null;
      return;
    }
    out.push(this.#parse(line));
    this.dataLines = [];
    this.eventName = null;
  }

  #dispatch(out) {
    const name = this.eventName;
    this.eventName = null;
    if (!this.dataLines.length) return;
    const payload = this.dataLines.join("\n").trim();
    this.dataLines = [];
    if (!payload) return;
    if (payload === "[DONE]") {
      this.done = true;
      return;
    }
    const ev = this.#parse(payload);
    if (ev && name && ev.type == null) ev.event = name;
    out.push(ev);
  }

  #parse(payload) {
    try {
      return JSON.parse(payload);
    } catch (_) {
      return { type: "unparsed", raw: payload.slice(0, 2000) };
    }
  }
}

/** Parse a single line (kept for callers that already have a full body). */
export function parseLine(line) {
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

/** Parse a whole (buffered) stream body into events. */
export function parseEventStream(body) {
  const parser = new StreamParser();
  return [...parser.push(String(body || "")), ...parser.end()];
}

function idleTimeoutError(ms) {
  const err = new Error(`stream idle for ${ms}ms`);
  err.code = ERROR_CODES.TIMEOUT;
  return err;
}

/** read()/next() wrapped in an inactivity timer. */
async function withIdle(promise, idleMs, onTimeout) {
  if (!idleMs) return promise;
  let timer;
  let timedOut = false;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      timedOut = true;
      const err = idleTimeoutError(idleMs);
      // Reject first: calling reader.cancel() synchronously would resolve the
      // pending read and win the race, silently reporting a clean EOF.
      reject(err);
      queueMicrotask(() => {
        try {
          onTimeout?.(err);
        } catch (_) {}
      });
    }, idleMs);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
    // The abandoned read resolves once the caller cancels it; never leave a
    // rejection unhandled.
    if (timedOut) Promise.resolve(promise).catch(() => {});
  }
}

/**
 * Consume a fetch Response and yield parsed events.
 *
 * @param {Response} response
 * @param {{idleTimeoutMs?: number, maxResponseBytes?: number, maxLineBytes?: number}} opts
 */
export async function* iterateStreamEvents(response, opts = {}) {
  const idleMs = Number(opts.idleTimeoutMs) || 0;
  const maxBytes = Number(opts.maxResponseBytes) || DEFAULT_MAX_RESPONSE_BYTES;
  const parser = new StreamParser({ maxLineBytes: opts.maxLineBytes });
  const body = response && response.body;

  if (!body) {
    yield* parseEventStream(await readAllText(response, maxBytes));
    return;
  }

  if (typeof body.getReader === "function") {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let received = 0;
    try {
      for (;;) {
        const { value, done } = await withIdle(reader.read(), idleMs, () => {
          reader.cancel(idleTimeoutError(idleMs)).catch(() => {});
        });
        if (done) break;
        received += value.byteLength;
        if (received > maxBytes) {
          const err = new Error(`response exceeded ${maxBytes} bytes`);
          err.code = ERROR_CODES.STREAM_ERROR;
          await reader.cancel(err).catch(() => {});
          throw err;
        }
        yield* parser.push(decoder.decode(value, { stream: true }));
        if (parser.done) {
          await reader.cancel().catch(() => {});
          return;
        }
      }
      yield* parser.push(decoder.decode());
    } finally {
      try {
        reader.releaseLock();
      } catch (_) {}
    }
  } else if (typeof body[Symbol.asyncIterator] === "function") {
    const iterator = body[Symbol.asyncIterator]();
    const decoder = new TextDecoder();
    let received = 0;
    try {
      for (;;) {
        const { value, done } = await withIdle(iterator.next(), idleMs, () => {
          try {
            iterator.return?.();
          } catch (_) {}
        });
        if (done) break;
        const bytes = typeof value === "string" ? new TextEncoder().encode(value) : value;
        received += bytes.byteLength ?? 0;
        if (received > maxBytes) {
          const err = new Error(`response exceeded ${maxBytes} bytes`);
          err.code = ERROR_CODES.STREAM_ERROR;
          await iterator.return?.();
          throw err;
        }
        yield* parser.push(typeof value === "string" ? value : decoder.decode(bytes, { stream: true }));
        if (parser.done) {
          await iterator.return?.();
          return;
        }
      }
      yield* parser.push(decoder.decode());
    } finally {
      try {
        iterator.return?.();
      } catch (_) {}
    }
  } else {
    yield* parseEventStream(await readAllText(response, maxBytes));
    return;
  }

  yield* parser.end();
}

async function readAllText(response, maxBytes) {
  return readTextBounded(response, maxBytes);
}

// --- Event reduction ---

export function createStreamState() {
  return {
    deltaText: "",
    stopText: null,
    usage: null,
    followups: [],
    enrichments: null,
    started: false,
    stopped: false,
    eventError: null,
    unparsed: 0,
  };
}

/** Fold one event into a stream state. Unknown types are ignored by design. */
export function applyEvent(state, ev) {
  if (!ev || typeof ev !== "object") return state;
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
    case "error":
      state.eventError = ev;
      break;
    case "unparsed":
      state.unparsed += 1;
      break;
    default:
      break;
  }
  return state;
}

export function uniqStrings(items) {
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

function urlLike(x) {
  return typeof x === "string" ? x : x && (x.url || x.link || x.href);
}

/** Normalize one reference/URL/object into a citation shape. */
export function toCitation(item) {
  if (!item) return null;
  if (typeof item === "string") {
    return /^https?:\/\//i.test(item) ? { url: item } : { text: item };
  }
  if (typeof item !== "object") return { text: String(item) };
  const url = urlLike(item) || item.source_url || null;
  const title = item.title || item.name || item.heading || null;
  const snippet = item.snippet || item.description || item.text || item.excerpt || item.summary || null;
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

export function dedupeCitations(items) {
  const out = [];
  const seen = new Set();
  for (const item of items || []) {
    const c = toCitation(item);
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

export function emptySources() {
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

/** Flatten the `enrichments` event into citations, sources and entity signals. */
export function extractSources(enrichments) {
  if (!enrichments || typeof enrichments !== "object") return emptySources();
  const arr = (v) => (Array.isArray(v) ? v : []);
  const references = arr(enrichments.references);
  const urls = arr(enrichments.urls);
  const reference_urls = arr(enrichments.reference_urls);
  const context_urls = arr(enrichments.context_urls);
  const context_results = arr(enrichments.context_results);
  const all_urls = uniqStrings(
    [...urls, ...reference_urls, ...context_urls, ...references.map(urlLike), ...context_results.map(urlLike)].filter(
      Boolean
    )
  );
  const citations = dedupeCitations([...references, ...reference_urls, ...urls, ...context_urls, ...context_results]);
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

/**
 * Pick the final answer. `enrichments.raw_response` wins (it is the rendered
 * answer), then `text_stop.text`, then assembled deltas — deltas can duplicate
 * fragments (observed: `***PONG**` for `**PONG**`), so they are the last resort.
 */
export function finalizeState(state) {
  const enrichments = state.enrichments || null;
  const raw = enrichments && typeof enrichments.raw_response === "string" ? enrichments.raw_response : null;
  const candidates = [
    ["enrichments.raw_response", raw],
    ["text_stop", state.stopText],
    ["text_delta", state.deltaText],
  ];
  let answer = "";
  let answerSource = null;
  for (const [name, value] of candidates) {
    if (typeof value === "string" && value.trim()) {
      answer = value;
      answerSource = name;
      break;
    }
  }
  return {
    answer,
    text: answer,
    answerSource,
    usage: state.usage || null,
    followups: state.followups || [],
    enrichments,
    sources: extractSources(enrichments),
    started: !!state.started,
    stopped: !!state.stopped,
    unparsedEvents: state.unparsed || 0,
    streamEventError: state.eventError || null,
  };
}

/** Buffered reduction helper. */
export function reduceEvents(events) {
  const state = createStreamState();
  for (const ev of events || []) applyEvent(state, ev);
  return finalizeState(state);
}
