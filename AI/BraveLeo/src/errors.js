/**
 * Error taxonomy, HTTP-error classification, timeouts and retry/backoff.
 *
 * Every failure surfaced by this library is a `BraveLeoError` carrying a stable
 * `code`, a `retryable` flag and enough context (status, conversation, body
 * snippet) to log or branch on without parsing message strings.
 */

import { MAX_BODY_SNIPPET } from "./constants.js";

export const ERROR_CODES = Object.freeze({
  FETCH_UNAVAILABLE: "FETCH_UNAVAILABLE",
  INVALID_INPUT: "INVALID_INPUT",
  CONVERSATION_NOT_FOUND: "CONVERSATION_NOT_FOUND",
  CONVERSATION_INVALID: "CONVERSATION_INVALID",
  BLOCKED: "BLOCKED",
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

/** HTTP statuses worth a retry with backoff. */
export function isRetryableStatus(status) {
  return status === 408 || status === 425 || status === 429 || (status >= 500 && status <= 599);
}

/** Map an HTTP status to the most specific error code we can justify. */
export function codeForStatus(status) {
  if (status === 429) return ERROR_CODES.RATE_LIMITED;
  if (status === 401 || status === 403) return ERROR_CODES.BLOCKED;
  if (status === 404) return ERROR_CODES.CONVERSATION_NOT_FOUND;
  if (status === 422) return ERROR_CODES.CONVERSATION_INVALID;
  return ERROR_CODES.HTTP_ERROR;
}

export class BraveLeoError extends Error {
  constructor(message, opts = {}) {
    super(message || "BraveLeoError");
    this.name = "BraveLeoError";
    this.code = opts.code || ERROR_CODES.INTERNAL_ERROR;
    this.status = opts.status ?? null;
    this.retryable = !!opts.retryable;
    this.retryAfterMs = opts.retryAfterMs ?? null;
    this.details = opts.details ?? null;
    this.hint = opts.hint ?? null;
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
      hint: this.hint,
      conversation: this.conversation,
    };
  }
}

export function asError(error, fallback = {}) {
  if (error instanceof BraveLeoError) return error;
  const e = error || {};
  const msg = e && e.message ? String(e.message) : String(error || fallback.message || "Unknown error");
  return new BraveLeoError(msg, { ...fallback, cause: error });
}

/** Bounded string form of anything, for logs and error details. */
export function truncate(value, max = MAX_BODY_SNIPPET) {
  if (value == null) return value;
  let s;
  if (typeof value === "string") s = value;
  else {
    try {
      s = JSON.stringify(value);
    } catch (_) {
      s = String(value);
    }
  }
  return s.length > max ? `${s.slice(0, max)}...[truncated ${s.length - max} chars]` : s;
}

/** Parse `Retry-After` (seconds or HTTP date) from Headers or a plain object. */
export function parseRetryAfter(headers) {
  if (!headers) return null;
  const raw =
    typeof headers.get === "function"
      ? headers.get("retry-after")
      : headers["retry-after"] ?? headers["Retry-After"];
  if (raw == null) return null;
  const seconds = Number(raw);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const at = Date.parse(String(raw));
  return Number.isFinite(at) ? Math.max(0, at - Date.now()) : null;
}

export function isAbortError(error) {
  return !!(error && (error.name === "AbortError" || error.code === "ABORT_ERR"));
}

export function isTimeoutError(error) {
  return !!(error && (error.code === ERROR_CODES.TIMEOUT || /timed? ?out/i.test(error.message || "")));
}

/**
 * Normalize anything thrown by fetch/undici/our own code into a BraveLeoError.
 * `context` may carry `{ status, conversation, headers, body }`.
 */
export function classifyError(error, context = {}) {
  if (error instanceof BraveLeoError) return error;

  // Our own timeout error (used as an AbortSignal reason) keeps its code.
  if (error && error.code === ERROR_CODES.TIMEOUT) {
    return new BraveLeoError(error.message || "Request timed out", {
      code: ERROR_CODES.TIMEOUT,
      retryable: true,
      status: context.status ?? null,
      conversation: context.conversation ?? null,
      cause: error,
    });
  }

  if (isAbortError(error)) {
    const timedOut =
      isTimeoutError(error) ||
      isTimeoutError(error && error.cause) ||
      /timed? ?out/i.test(String((error && error.message) || ""));
    return new BraveLeoError(timedOut ? "Request timed out" : "Request aborted", {
      code: timedOut ? ERROR_CODES.TIMEOUT : ERROR_CODES.ABORTED,
      retryable: timedOut,
      status: context.status ?? null,
      retryAfterMs: parseRetryAfter(context.headers ?? (error && error.headers)),
      conversation: context.conversation ?? null,
      cause: error,
    });
  }

  const status = context.status ?? (error && (error.status ?? error.statusCode));
  if (Number.isFinite(status)) {
    const code = codeForStatus(status);
    const retryAfterMs =
      parseRetryAfter(context.headers) ?? parseRetryAfter(error && error.headers) ?? error?.retryAfterMs ?? null;
    const hints = {
      [ERROR_CODES.BLOCKED]:
        "Request rejected (anti-bot/attestation or geo). A browser-like session and cookies are usually required.",
      [ERROR_CODES.CONVERSATION_INVALID]:
        "Brave refused the conversation id. Initiate the conversation in a browser and pass its id/cookies.",
      [ERROR_CODES.CONVERSATION_NOT_FOUND]: "Conversation id is unknown or expired.",
      [ERROR_CODES.RATE_LIMITED]: "Rate limited. Retry after the indicated delay or rotate session/IP.",
    };
    return new BraveLeoError(error?.message || `HTTP ${status}`, {
      code,
      status,
      retryable: !!(error?.retryable || isRetryableStatus(status)),
      retryAfterMs,
      details: context.body ? truncate(context.body) : (error?.details ?? null),
      hint: hints[code] ?? null,
      conversation: context.conversation ?? error?.conversation ?? null,
      cause: error,
    });
  }

  // undici/WHATWG fetch failures surface as TypeError with no status.
  if (
    error &&
    (error.name === "TypeError" ||
      /fetch|network|ECONN|ENOTFOUND|EAI_AGAIN|socket/i.test(error.message || ""))
  ) {
    return new BraveLeoError(error.message || "Network request failed", {
      code: ERROR_CODES.NETWORK_ERROR,
      retryable: true,
      conversation: context.conversation ?? null,
      cause: error,
    });
  }

  return new BraveLeoError(error?.message ? error.message : String(error), {
    code: ERROR_CODES.INTERNAL_ERROR,
    retryable: false,
    conversation: context.conversation ?? null,
    cause: error,
  });
}

/** Exponential backoff with full jitter, clamped to `maxRetryDelayMs`. */
export function computeBackoffMs(attempt, opts = {}) {
  const base = Math.max(0, Number(opts.retryDelayMs ?? 500));
  const max = Math.max(base, Number(opts.maxRetryDelayMs ?? 8000));
  const exp = Math.min(max, base * 2 ** Math.max(0, attempt));
  const jitter = Math.floor(Math.random() * Math.max(1, exp));
  return Math.min(max, jitter + Math.floor(exp * 0.25));
}

/** Abortable sleep. Removes its listener so retry loops do not leak. */
export function sleep(ms, signal) {
  if (!ms || ms <= 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(Object.assign(new Error("Request aborted"), { name: "AbortError" }));
    };
    const timer = setTimeout(() => {
      if (signal) signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    if (!signal) return;
    if (signal.aborted) return onAbort();
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Derive a child AbortSignal that fires after `timeoutMs` or when `signal`
 * aborts. Always call `cleanup()` in a `finally`.
 */
export function withTimeout(signal, timeoutMs) {
  if (!timeoutMs || timeoutMs <= 0) return { signal, cleanup: () => {} };
  const ctrl = new AbortController();
  const onAbort = () => {
    try {
      ctrl.abort(signal && signal.reason);
    } catch (_) {
      ctrl.abort();
    }
  };
  if (signal) {
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
  }
  const timer = setTimeout(() => {
    const e = new Error(`timeout after ${timeoutMs}ms`);
    e.code = ERROR_CODES.TIMEOUT;
    try {
      ctrl.abort(e);
    } catch (_) {
      ctrl.abort();
    }
  }, timeoutMs);
  return {
    signal: ctrl.signal,
    cleanup: () => {
      clearTimeout(timer);
      if (signal) signal.removeEventListener("abort", onAbort);
    },
  };
}

/**
 * Retry `fn(attempt)` while failures are retryable, honouring Retry-After and
 * `opts.retryOn(err, attempt)` when provided.
 */
export async function withRetry(fn, opts = {}) {
  const retries = Math.max(0, Number(opts.retries ?? 0) || 0);
  const signal = opts.signal;
  let attempt = 0;
  for (;;) {
    try {
      return await fn(attempt);
    } catch (e) {
      const err = classifyError(e, opts.context || {});
      const allowed =
        attempt < retries &&
        err.retryable &&
        !(signal && signal.aborted) &&
        err.code !== ERROR_CODES.ABORTED &&
        (typeof opts.retryOn === "function" ? opts.retryOn(err, attempt) : true);
      if (!allowed) throw err;
      const wait =
        err.retryAfterMs != null
          ? Math.min(err.retryAfterMs, opts.maxRetryDelayMs ?? 15_000)
          : computeBackoffMs(attempt, opts);
      if (typeof opts.onRetry === "function") {
        try {
          opts.onRetry({ attempt: attempt + 1, retries, waitMs: wait, error: err });
        } catch (_) {}
      }
      await sleep(wait, signal);
      attempt++;
    }
  }
}
