/**
 * Streaming decoders shared by the provider clients.
 *
 * The captured providers use three wire shapes:
 *   - SSE (`data: {...}` … `data: [DONE]`)         — Obscurify, Lumo, Venice
 *   - raw NDJSON (one JSON object per line)        — ChatGPT unauth-mweb
 *   - OpenAI-style `chat.completion.chunk` payloads — Obscurify, Lumo, Kilo
 *
 * `SseParser` accepts all three: `data:`-prefixed lines, bare JSON lines and
 * comments, and is safe against chunk boundaries splitting a frame.
 */

import { ApiError, ERROR_CODES } from "./errors.js";
import { readTextBounded } from "./http.js";

export class SseParser {
  constructor(opts = {}) {
    this.buffer = "";
    this.dataLines = [];
    this.event = null;
    this.done = false;
    this.maxLineBytes = Number(opts.maxLineBytes) || 1024 * 1024;
    this.malformed = 0;
    this.onMalformed = typeof opts.onMalformed === "function" ? opts.onMalformed : null;
  }

  /** @returns {Array<{event: string|null, data: string}>} */
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
      const raw = this.buffer;
      this.buffer = "";
      this.malformed += 1;
      this.onMalformed?.(raw);
      out.push({ event: null, data: raw.slice(0, 512) });
    }
    return out;
  }

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
      this.#dispatch(out);
      return;
    }
    if (line.startsWith(":")) return; // comment / heartbeat
    if (line.startsWith("event:")) {
      this.event = line.slice(6).trim();
      return;
    }
    if (line.startsWith("id:") || line.startsWith("retry:")) return;
    if (line.startsWith("data:")) {
      this.dataLines.push(line.slice(5).replace(/^ /, ""));
      return;
    }
    // Bare JSON line (ChatGPT NDJSON, TAP-style streams).
    const payload = line.trim();
    if (!payload) return;
    if (payload === "[DONE]") {
      this.done = true;
      return;
    }
    out.push({ event: this.event, data: payload });
    this.event = null;
  }

  #dispatch(out) {
    const event = this.event;
    this.event = null;
    if (!this.dataLines.length) return;
    const data = this.dataLines.join("\n").trim();
    this.dataLines = [];
    if (!data) return;
    if (data === "[DONE]") {
      this.done = true;
      return;
    }
    out.push({ event, data });
  }
}

/** Parse a full SSE/NDJSON body into `{event, data}` frames. */
export function parseEventStream(body) {
  const parser = new SseParser();
  return [...parser.push(String(body || "")), ...parser.end()];
}

/** Parse a body into JSON payloads, skipping `[DONE]` and malformed frames. */
export function parseJsonFrames(body, { onMalformed } = {}) {
  const out = [];
  for (const frame of parseEventStream(body)) {
    const value = tryParseJson(frame.data);
    if (value === undefined) {
      onMalformed?.(frame.data);
      continue;
    }
    if (value !== null) out.push({ event: frame.event, json: value });
  }
  return out;
}

export function tryParseJson(text) {
  const trimmed = String(text ?? "").trim();
  if (!trimmed || trimmed === "[DONE]") return null;
  try {
    return JSON.parse(trimmed);
  } catch (_) {
    return undefined;
  }
}

function idleError(ms) {
  const err = new ApiError(`stream idle for ${ms}ms`, { code: ERROR_CODES.TIMEOUT, retryable: true });
  return err;
}

async function withIdle(promise, idleMs, onTimeout) {
  if (!idleMs) return promise;
  let timer;
  let timedOut = false;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      timedOut = true;
      const err = idleError(idleMs);
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
    if (timedOut) Promise.resolve(promise).catch(() => {});
  }
}

/**
 * Consume a fetch Response and yield `{event, data, json}` frames.
 * `json` is `undefined` for malformed payloads, `null` for control frames.
 */
export async function* iterateFrames(response, opts = {}) {
  const parser = new SseParser({ onMalformed: opts.onMalformed });
  const idleMs = Number(opts.idleTimeoutMs) || 0;
  const body = response && response.body;

  const emit = function* (frames) {
    for (const frame of frames) {
      const json = tryParseJson(frame.data);
      if (json === undefined) {
        parser.malformed += 1;
        opts.onMalformed?.(frame.data);
        continue;
      }
      yield { ...frame, json };
    }
  };

  if (!body || typeof body.getReader !== "function") {
    const text = response && typeof response.text === "function" ? await response.text() : "";
    yield* emit([...parser.push(text), ...parser.end()]);
    return;
  }

  const reader = body.getReader();
  const decoder = new TextDecoder();
  try {
    for (;;) {
      const { value, done } = await withIdle(reader.read(), idleMs, () => {
        reader.cancel(idleError(idleMs)).catch(() => {});
      });
      if (done) break;
      yield* emit(parser.push(decoder.decode(value, { stream: true })));
      if (parser.done) break;
    }
    if (!parser.done) yield* emit(parser.push(decoder.decode()));
  } finally {
    try {
      if (parser.done) await reader.cancel().catch(() => {});
      reader.releaseLock();
    } catch (_) {}
  }
  if (!parser.done) yield* emit(parser.end());
}

/** Read a JSON body with a size ceiling (for non-streaming responses). */
export async function readJsonBody(response, maxBytes = 8 * 1024 * 1024) {
  const text = await readTextBounded(response, maxBytes);
  if (!text.trim()) return null;
  try {
    return JSON.parse(text);
  } catch (e) {
    throw new ApiError("expected JSON body", {
      code: ERROR_CODES.PARSE_ERROR,
      details: text.slice(0, 300),
      cause: e,
    });
  }
}
