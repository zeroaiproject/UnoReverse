/**
 * Shared HTTP helpers for the provider clients: header handling, a minimal
 * cookie jar, bounded body reads and a JSON request wrapper that never throws
 * for non-2xx (callers decide), but always classifies.
 */

import { ApiError, ERROR_CODES, classifyError, truncate, withTimeout } from "./errors.js";
export const DEFAULT_UA =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

export function headersToObject(headers) {
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
    const entries = typeof headers.entries === "function" ? headers.entries() : Object.entries(headers);
    for (const [k, v] of entries) out[String(k).toLowerCase()] = Array.isArray(v) ? v.join(", ") : v;
  } catch (_) {}
  return out;
}

export function mergeHeaders(...parts) {
  const out = {};
  for (const part of parts) {
    if (!part) continue;
    const obj =
      typeof part.forEach === "function" || typeof part.entries === "function" ? headersToObject(part) : part;
    for (const [k, v] of Object.entries(obj)) {
      if (v === undefined || v === null) continue;
      out[String(k).toLowerCase()] = String(v);
    }
  }
  return out;
}

/** Minimal cookie accumulator (Set-Cookie -> Cookie header). */
export class CookieJar {
  constructor(initial) {
    this.map = new Map();
    if (typeof initial === "string" && initial.trim()) this.addCookieHeader(initial);
    else if (initial instanceof CookieJar) this.addCookieHeader(initial.toString());
    else if (initial && typeof initial === "object" && !Array.isArray(initial)) {
      for (const [k, v] of Object.entries(initial)) this.map.set(k, String(v));
    }
  }

  addSetCookie(setCookie) {
    if (!setCookie) return this;
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
    return this;
  }

  ingestResponse(res) {
    try {
      if (!res || !res.headers) return this;
      if (typeof res.headers.getSetCookie === "function") this.addSetCookie(res.headers.getSetCookie());
      else {
        const sc = res.headers.get("set-cookie");
        if (sc) this.addSetCookie(sc);
      }
    } catch (_) {}
    return this;
  }

  addCookieHeader(cookieHeader) {
    for (const part of String(cookieHeader || "").split(";")) {
      const idx = part.indexOf("=");
      if (idx <= 0) continue;
      const name = part.slice(0, idx).trim();
      const value = part.slice(idx + 1).trim();
      if (name) this.map.set(name, value);
    }
    return this;
  }

  get(name) {
    return this.map.get(name) ?? null;
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

  toJSON() {
    return Object.fromEntries(this.map);
  }
}

export function toCookieJar(value) {
  return value instanceof CookieJar ? value : new CookieJar(value);
}

/** Bounded body read; oversize bodies throw instead of being truncated. */
export async function readTextBounded(res, maxBytes = 8 * 1024 * 1024) {
  if (!res) return "";
  const body = res.body;
  if (!maxBytes || !body || typeof body.getReader !== "function") {
    try {
      return await res.text();
    } catch (_) {
      return "";
    }
  }
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let received = 0;
  let text = "";
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      received += value.byteLength;
      if (received > maxBytes) {
        const err = new ApiError(`response exceeded ${maxBytes} bytes`, {
          code: ERROR_CODES.STREAM_ERROR,
          retryable: false,
        });
        try {
          await reader.cancel(err);
        } catch (_) {}
        throw err;
      }
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
    return text;
  } finally {
    try {
      reader.releaseLock();
    } catch (_) {}
  }
}

/** Encode an object as application/x-www-form-urlencoded. */
export function encodeForm(fields) {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(fields || {})) {
    if (v === undefined || v === null) continue;
    params.set(k, typeof v === "string" ? v : JSON.stringify(v));
  }
  return params.toString();
}

export function resolveUrl(base, path) {
  return new URL(path, base).toString();
}

/**
 * Perform a request and always return `{ ok, status, headers, body }` where
 * `body` is text. Throws only for transport failures.
 */
export async function requestText(url, init = {}, opts = {}) {
  const fetchImpl = opts.fetchImpl || globalThis.fetch;
  if (typeof fetchImpl !== "function") {
    throw new ApiError("fetch is not available in this environment", {
      provider: opts.provider,
      code: ERROR_CODES.FETCH_UNAVAILABLE,
      retryable: false,
    });
  }
  let res;
  try {
    res = await fetchImpl(url, init);
  } catch (e) {
    throw classifyError(e, { provider: opts.provider });
  }
  const headers = headersToObject(res.headers);
  const body = await readTextBounded(res, opts.maxResponseBytes);
  return { ok: res.ok, status: res.status, statusText: res.statusText || "", headers, body, res };
}

/** Same, but parses JSON and classifies non-2xx into an ApiError. */
export async function requestJson(url, init = {}, opts = {}) {
  const out = await requestText(url, init, opts);
  let json = null;
  if (out.body) {
    try {
      json = JSON.parse(out.body);
    } catch (_) {
      if (out.ok) {
        throw new ApiError("expected JSON response", {
          provider: opts.provider,
          code: ERROR_CODES.PARSE_ERROR,
          status: out.status,
          details: truncate(out.body),
        });
      }
    }
  }
  if (!out.ok) {
    throw classifyError(new Error(`HTTP ${out.status} ${out.statusText}`.trim()), {
      provider: opts.provider,
      status: out.status,
      body: out.body || json,
      headers: out.headers,
      hint: opts.hint,
    });
  }
  return { json, status: out.status, headers: out.headers };
}

/**
 * Start a request and return the raw `Response`, throwing a classified
 * `ApiError` for transport failures and non-2xx statuses. The body is left
 * untouched so stream callers can consume it frame by frame.
 *
 * `timeoutMs` bounds the wait for response headers only; streaming stalls are
 * the caller's concern (`idleTimeoutMs` in `iterateFrames`).
 */
export async function requestResponse(url, init = {}, opts = {}) {
  const fetchImpl = opts.fetchImpl || globalThis.fetch;
  if (typeof fetchImpl !== "function") {
    throw new ApiError("fetch is not available in this environment", {
      provider: opts.provider,
      code: ERROR_CODES.FETCH_UNAVAILABLE,
      retryable: false,
    });
  }

  const timeout = withTimeout(init.signal, opts.timeoutMs);
  let res;
  try {
    res = await fetchImpl(url, { ...init, signal: timeout.signal });
  } catch (e) {
    timeout.cleanup();
    throw classifyError(e, { provider: opts.provider });
  }
  timeout.cleanup();

  if (!res || !res.ok) {
    const status = res?.status ?? 0;
    let body = "";
    try {
      body = await readTextBounded(res, opts.maxResponseBytes);
    } catch (_) {}
    throw classifyError(new Error(`HTTP ${status} ${res?.statusText || ""}`.trim()), {
      provider: opts.provider,
      status,
      body,
      headers: res?.headers,
      hint: opts.hint,
    });
  }

  return { res, headers: headersToObject(res.headers), status: res.status };
}
