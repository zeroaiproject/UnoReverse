/**
 * HTTP plumbing: header normalization, minimal cookie jar, bounded body reads.
 */

import { DEFAULT_MAX_RESPONSE_BYTES } from "./constants.js";
import { BraveLeoError, ERROR_CODES } from "./errors.js";

/** Lowercase a Headers instance or plain object into a plain object. */
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
    for (const [k, v] of entries) out[String(k).toLowerCase()] = v;
  } catch (_) {}
  return out;
}

/** Merge Headers/objects left-to-right; later values win, nullish values are skipped. */
export function mergeHeaders(...parts) {
  const out = {};
  for (const part of parts) {
    if (!part) continue;
    const obj = typeof part.forEach === "function" || part.entries ? headersToObject(part) : part;
    for (const [k, v] of Object.entries(obj)) {
      if (v === undefined || v === null) continue;
      out[String(k).toLowerCase()] = String(v);
    }
  }
  return out;
}

/** Minimal cookie accumulator (Set-Cookie -> Cookie header) for session reuse. */
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
      // Node/undici exposes getSetCookie(); browsers only expose the combined header.
      if (typeof res.headers.getSetCookie === "function") {
        this.addSetCookie(res.headers.getSetCookie());
      } else {
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

/** Resolve a CookieJar from a jar/string/object option. */
export function toCookieJar(value) {
  return value instanceof CookieJar ? value : new CookieJar(value);
}

/**
 * Read a response body as text with a hard size ceiling.
 * Fail closed: oversize bodies throw instead of being silently truncated.
 */
export async function readTextBounded(res, maxBytes = DEFAULT_MAX_RESPONSE_BYTES) {
  if (!res) return "";
  const body = res.body;
  if (!maxBytes || !body) {
    try {
      return await res.text();
    } catch (_) {
      return "";
    }
  }
  if (typeof body.getReader === "function") {
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
          const err = new BraveLeoError(`response exceeded ${maxBytes} bytes`, {
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
  try {
    return await res.text();
  } catch (_) {
    return "";
  }
}
