/**
 * Shared error taxonomy, HTTP mapping and retry machinery for the provider
 * clients in `AI/`.
 *
 * Each client tags errors with its `provider` so a caller can tell a Lumo quota
 * rejection from an Obscurify rate limit without parsing message strings.
 */

export const ERROR_CODES = Object.freeze({
  INVALID_INPUT: "INVALID_INPUT",
  FETCH_UNAVAILABLE: "FETCH_UNAVAILABLE",
  UNAUTHORIZED: "UNAUTHORIZED",
  FORBIDDEN: "FORBIDDEN",
  NOT_FOUND: "NOT_FOUND",
  RATE_LIMITED: "RATE_LIMITED",
  BAD_REQUEST: "BAD_REQUEST",
  HTTP_ERROR: "HTTP_ERROR",
  TIMEOUT: "TIMEOUT",
  ABORTED: "ABORTED",
  NETWORK_ERROR: "NETWORK_ERROR",
  PARSE_ERROR: "PARSE_ERROR",
  STREAM_ERROR: "STREAM_ERROR",
  PROXY_ERROR: "PROXY_ERROR",
  INTERNAL_ERROR: "INTERNAL_ERROR",
});

export class ApiError extends Error {
  constructor(message, opts = {}) {
    super(message || "ApiError");
    this.name = "ApiError";
    this.provider = opts.provider ?? null;
    this.code = opts.code || ERROR_CODES.INTERNAL_ERROR;
    this.status = opts.status ?? null;
    this.retryable = !!opts.retryable;
    this.retryAfterMs = opts.retryAfterMs ?? null;
    this.details = opts.details ?? null;
    this.hint = opts.hint ?? null;
    this.cause = opts.cause;
  }

  toJSON() {
    return {
      name: this.name,
      provider: this.provider,
      code: this.code,
      message: this.message,
      status: this.status,
      retryable: this.retryable,
      retryAfterMs: this.retryAfterMs,
      details: this.details,
      hint: this.hint,
    };
  }
}

export function truncate(value, max = 1200) {
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
  return s.length > max ? `${s.slice(0, max)}…[+${s.length - max}]` : s;
}

export function isRetryableStatus(status) {
  return status === 408 || status === 425 || status === 429 || (status >= 500 && status <= 599);
}

export function codeForStatus(status) {
  if (status === 400 || status === 422) return ERROR_CODES.BAD_REQUEST;
  if (status === 401) return ERROR_CODES.UNAUTHORIZED;
  if (status === 403) return ERROR_CODES.FORBIDDEN;
  if (status === 404) return ERROR_CODES.NOT_FOUND;
  if (status === 429) return ERROR_CODES.RATE_LIMITED;
  return ERROR_CODES.HTTP_ERROR;
}

const STATUS_HINTS = {
  401: "Credentials or session token rejected.",
  403: "Access denied — the provider may require attestation, cookies, or a non-automated client.",
  404: "Endpoint not found; the provider may have changed its route.",
  422: "Payload rejected; check required fields and token shapes.",
  429: "Rate limited — wait, retry, or rotate egress (see the Kilo proxy helpers).",
};

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

/**
 * Normalize anything thrown by fetch/http into an ApiError.
 * `status`/`body` may be supplied when the caller already has a response.
 */
export function classifyError(error, { provider, status, body, headers, hint } = {}) {
  if (error instanceof ApiError) {
    if (!error.provider && provider) error.provider = provider;
    return error;
  }

  if (error && error.code === ERROR_CODES.TIMEOUT) {
    return new ApiError(error.message || "Request timed out", {
      provider,
      code: ERROR_CODES.TIMEOUT,
      retryable: true,
      cause: error,
    });
  }

  if (isAbortError(error)) {
    const timedOut = /timed? ?out/i.test(String(error.message || "")) || error.code === ERROR_CODES.TIMEOUT;
    return new ApiError(timedOut ? "Request timed out" : "Request aborted", {
      provider,
      code: timedOut ? ERROR_CODES.TIMEOUT : ERROR_CODES.ABORTED,
      retryable: timedOut,
      cause: error,
    });
  }

  if (Number.isFinite(status)) {
    const code = codeForStatus(status);
    return new ApiError(error?.message || `HTTP ${status}`, {
      provider,
      code,
      status,
      retryable: isRetryableStatus(status),
      retryAfterMs: parseRetryAfter(headers) ?? error?.retryAfterMs ?? null,
      details: body != null ? truncate(body) : (error?.details ?? null),
      hint: hint ?? STATUS_HINTS[status] ?? null,
      cause: error,
    });
  }

  if (
    error &&
    (error.name === "TypeError" ||
      /fetch|network|ECONN|ENOTFOUND|EAI_AGAIN|socket|TLS|certificate/i.test(error.message || ""))
  ) {
    return new ApiError(error.message || "Network request failed", {
      provider,
      code: ERROR_CODES.NETWORK_ERROR,
      retryable: true,
      cause: error,
    });
  }

  return new ApiError(error?.message ? error.message : String(error), {
    provider,
    code: ERROR_CODES.INTERNAL_ERROR,
    retryable: false,
    cause: error,
  });
}

export function computeBackoffMs(attempt, opts = {}) {
  const base = Math.max(0, Number(opts.retryDelayMs ?? 500));
  const max = Math.max(base, Number(opts.maxRetryDelayMs ?? 8000));
  const exp = Math.min(max, base * 2 ** Math.max(0, attempt));
  const jitter = Math.floor(Math.random() * Math.max(1, exp));
  return Math.min(max, jitter + Math.floor(exp * 0.25));
}

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

/** Child AbortSignal that fires after `timeoutMs` or when `signal` aborts. */
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
    const err = new Error(`timeout after ${timeoutMs}ms`);
    err.code = ERROR_CODES.TIMEOUT;
    try {
      ctrl.abort(err);
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
 * Retry `fn(attempt)` while the error is retryable. `beforeRetry` can mutate
 * client state (e.g. renew a Tor circuit or re-mint an attestation token).
 */
export async function withRetry(fn, opts = {}) {
  const retries = Math.max(0, Number(opts.retries ?? 0) || 0);
  const signal = opts.signal;
  let attempt = 0;
  for (;;) {
    try {
      return await fn(attempt);
    } catch (e) {
      const err = e instanceof ApiError ? e : classifyError(e, opts.context || {});
      const allowed =
        attempt < retries &&
        err.retryable &&
        !(signal && signal.aborted) &&
        err.code !== ERROR_CODES.ABORTED &&
        (typeof opts.retryOn === "function" ? opts.retryOn(err, attempt) : true);
      if (!allowed) throw err;
      if (typeof opts.beforeRetry === "function") {
        try {
          await opts.beforeRetry(err, attempt + 1);
        } catch (hookError) {
          throw classifyError(hookError, opts.context || {});
        }
      }
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
