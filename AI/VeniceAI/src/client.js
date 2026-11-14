/**
 * Venice.ai web-agent client.
 *
 * The observed agent flow (DOCS.md) requires a short-lived client-attestation
 * JWT minted at `/api/app/user/client_attestation/mint` and attached to each
 * inference request as `x-venice-client-attestation`. Mints are issued as a
 * pool (typically 5); this client consumes and replenishes the pool and, on a
 * 401/403, re-mints before retrying.
 *
 * Capture status: the automated run was rejected (`env.webdriver:true`) so no
 * successful SSE schema was observed. The stream parser is therefore tolerant
 * and records every raw frame alongside best-effort text extraction.
 */

import { randomBytes } from "node:crypto";

import { ApiError, ERROR_CODES, classifyError, withRetry } from "../../../lib/errors.js";
import { mergeHeaders, readTextBounded, requestResponse } from "../../../lib/http.js";
import { iterateFrames } from "../../../lib/stream.js";
import {
  BASE_URL,
  DEFAULT_FRONTEND_VERSION,
  DEFAULT_HEADERS,
  DEFAULT_MAX_RESPONSE_BYTES,
  DEFAULT_MIDDLEFACE_VERSION,
  DEFAULT_STREAM_IDLE_TIMEOUT_MS,
  DEFAULT_TIMEOUT_MS,
  PATHS,
  PROVIDER,
} from "./constants.js";

function randomId(len = 12) {
  return randomBytes(Math.ceil(len / 2))
    .toString("base64url")
    .slice(0, len);
}

function textFromFrame(payload) {
  if (payload == null) return "";
  if (typeof payload === "string") return payload;
  if (typeof payload.text === "string") return payload.text;
  if (typeof payload.delta === "string") return payload.delta;
  if (typeof payload.content === "string") return payload.content;
  if (payload.delta && typeof payload.delta === "object") {
    if (typeof payload.delta.text === "string") return payload.delta.text;
    if (typeof payload.delta.content === "string") return payload.delta.content;
  }
  if (Array.isArray(payload.output)) {
    return payload.output
      .flatMap((o) => (Array.isArray(o?.content) ? o.content : []))
      .map((c) => (typeof c?.text === "string" ? c.text : ""))
      .join("");
  }
  const choice = payload.choices?.[0];
  if (choice?.delta?.content) return String(choice.delta.content);
  if (choice?.message?.content) return String(choice.message.content);
  return "";
}

function buildAgentMessage(text) {
  return {
    content: [{ annotations: [], text: String(text), type: "output_text" }],
    id: randomId(),
    role: "user",
    status: "completed",
    type: "message",
  };
}

export class VeniceClient {
  constructor(opts = {}) {
    this.fetchImpl = opts.fetchImpl || globalThis.fetch;
    this.baseUrl = (opts.baseUrl || BASE_URL).replace(/\/+$/, "");
    this.headers = mergeHeaders(DEFAULT_HEADERS, opts.headers);
    this.frontendVersion = opts.frontendVersion || DEFAULT_FRONTEND_VERSION;
    this.middlefaceVersion = opts.middlefaceVersion || DEFAULT_MIDDLEFACE_VERSION;
    this.locale = opts.locale || "en";
    this.distinctId = opts.distinctId || null;
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.streamIdleTimeoutMs = opts.streamIdleTimeoutMs ?? DEFAULT_STREAM_IDLE_TIMEOUT_MS;
    this.retries = Math.max(0, Number(opts.retries ?? 0) || 0);
    this.retryDelayMs = opts.retryDelayMs;
    this.maxResponseBytes = opts.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
    this.env = {
      nativeIntegrityOk: true,
      reactStateHash: randomId(64).replace(/[^a-f0-9]/gi, "a").slice(0, 64).toLowerCase(),
      sentryVersion: "10.50.0",
      unexpectedGlobalsCount: 0,
      webdriver: false,
      ...(opts.env || {}),
    };
    this.pool = [];
    this.expiresAt = 0;
  }

  url(path) {
    return `${this.baseUrl}${path}`;
  }

  #baseHeaders(extra = {}) {
    return mergeHeaders(
      {
        accept: "application/json",
        "x-venice-version": this.frontendVersion,
        "x-venice-middleface-version": this.middlefaceVersion,
        "x-venice-locale": this.locale,
        "x-venice-request-timestamp-ms": String(Date.now()),
        ...(this.distinctId ? { "x-venice-distinct-id": this.distinctId } : null),
        ...this.headers,
      },
      extra
    );
  }

  async #json(path, { method = "GET", body, signal, headers, retry = true, attestation = false } = {}) {
    const send = async () => {
      const extra = { ...headers };
      if (attestation) extra["x-venice-client-attestation"] = await this.takeAttestation({ signal });
      const init = {
        method,
        headers: this.#baseHeaders({
          ...(body ? { "content-type": "application/json" } : null),
          ...extra,
        }),
        signal,
      };
      if (body) init.body = JSON.stringify(body);
      const { res } = await requestResponse(this.url(path), init, {
        fetchImpl: this.fetchImpl,
        timeoutMs: this.timeoutMs,
        maxResponseBytes: this.maxResponseBytes,
        provider: PROVIDER,
      });
      const text = await readTextBounded(res, this.maxResponseBytes);
      try {
        return text ? JSON.parse(text) : null;
      } catch (e) {
        throw new ApiError("expected JSON response", {
          provider: PROVIDER,
          code: ERROR_CODES.PARSE_ERROR,
          details: text?.slice(0, 400),
          cause: e,
        });
      }
    };

    if (!retry) return send();
    return withRetry(send, {
      retries: this.retries,
      signal,
      retryDelayMs: this.retryDelayMs,
      beforeRetry: async (err) => {
        if ((err.code === ERROR_CODES.UNAUTHORIZED || err.code === ERROR_CODES.FORBIDDEN) && attestation) {
          this.pool = [];
          await this.mintAttestations({ signal, count: 5, force: true });
        }
      },
      context: { provider: PROVIDER },
    });
  }

  async mintAttestations({ count = 5, signal, force = false } = {}) {
    const now = Math.floor(Date.now() / 1000);
    if (!force && this.pool.length && this.expiresAt - now > 30) return [...this.pool];
    const body = await this.#json(PATHS.attestationMint, {
      method: "POST",
      body: { count, env: this.env },
      signal,
      retry: false,
    });
    const tokens = Array.isArray(body?.tokens) ? body.tokens : [];
    if (!tokens.length) {
      throw new ApiError("attestation mint returned no tokens", {
        provider: PROVIDER,
        code: ERROR_CODES.UNAUTHORIZED,
        details: body,
        hint: "the runtime env (e.g. webdriver) may have been rejected",
      });
    }
    this.pool = tokens.slice();
    this.expiresAt = Number(body.expiresAt) || now + 300;
    return tokens;
  }

  async takeAttestation({ signal } = {}) {
    await this.mintAttestations({ signal });
    const entry = this.pool.shift();
    if (!entry?.token) {
      throw new ApiError("attestation pool exhausted", { provider: PROVIDER, code: ERROR_CODES.UNAUTHORIZED });
    }
    return entry.token;
  }

  async listModels({ signal } = {}) {
    return this.#json(`${PATHS.models}?matureFilter=true&onlySafeVenice=true`, { signal });
  }

  async userCountry({ signal } = {}) {
    return this.#json(PATHS.userCountry, { signal });
  }

  async rateLimits({ signal } = {}) {
    return this.#json(PATHS.rateLimits, { signal });
  }

  #buildBody({ prompt, messages, clientTools }) {
    const wireMessages =
      Array.isArray(messages) && messages.length
        ? messages
        : [buildAgentMessage(prompt || "")];
    return {
      clientTools: Array.isArray(clientTools) ? clientTools : [],
      input: { messages: wireMessages },
    };
  }

  async #openInference(body, { signal, retryCount = 0 } = {}) {
    const token = await this.takeAttestation({ signal });
    return requestResponse(
      this.url(PATHS.agentChat),
      {
        method: "POST",
        headers: this.#baseHeaders({
          "content-type": "application/json",
          accept: "text/event-stream",
          "x-venice-client-attestation": token,
          ...(retryCount > 0 ? { "x-retry-count": String(retryCount) } : null),
        }),
        body: JSON.stringify(body),
        signal,
      },
      {
        fetchImpl: this.fetchImpl,
        timeoutMs: this.timeoutMs,
        maxResponseBytes: this.maxResponseBytes,
        provider: PROVIDER,
        hint: "inference may reject automated/webdriver environments; capture a fresh attestation from a real browser",
      }
    );
  }

  async *streamChat(opts = {}) {
    const body = this.#buildBody(opts);
    let lastError;
    const maxAttempts = 1 + Math.max(0, this.retries);

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      let opened;
      try {
        opened = await this.#openInference(body, { signal: opts.signal, retryCount: attempt });
      } catch (e) {
        const err = classifyError(e, { provider: PROVIDER });
        lastError = err;
        if (
          attempt < maxAttempts - 1 &&
          (err.code === ERROR_CODES.UNAUTHORIZED || err.code === ERROR_CODES.FORBIDDEN)
        ) {
          this.pool = [];
          await this.mintAttestations({ signal: opts.signal, force: true });
          opts.onRetry?.({ attempt: attempt + 1, retries: maxAttempts - 1, error: err, waitMs: 0 });
          continue;
        }
        throw err;
      }

      const { res } = opened;
      let frames = 0;
      let textSeen = false;
      for await (const frame of iterateFrames(res, {
        idleTimeoutMs: this.streamIdleTimeoutMs,
        onMalformed: opts.onMalformed,
      })) {
        frames += 1;
        yield { type: "raw", frame: frame.json ?? frame.data };
        if (frame.json == null) continue;
        const text = textFromFrame(frame.json);
        if (text) {
          textSeen = true;
          yield { type: "text_delta", delta: text };
        }
      }
      if (frames === 0 && attempt < maxAttempts - 1) {
        this.pool = [];
        await this.mintAttestations({ signal: opts.signal, force: true });
        continue;
      }
      yield { type: "finish", frames, textSeen };
      return;
    }

    throw lastError || new ApiError("inference failed without a response", { provider: PROVIDER, code: ERROR_CODES.STREAM_ERROR });
  }

  async chat(opts = {}) {
    const answer = [];
    const rawFrames = [];
    const events = [];
    let finish = null;
    let partial = false;
    const startedAt = Date.now();

    try {
      for await (const event of this.streamChat(opts)) {
        events.push(event);
        opts.onEvent?.(event);
        if (event.type === "text_delta") answer.push(event.delta);
        else if (event.type === "raw") rawFrames.push(event.frame);
        else if (event.type === "finish") finish = event;
      }
    } catch (e) {
      partial = answer.length > 0;
      const error = classifyError(e, { provider: PROVIDER });
      if (opts.allowPartial === false) answer.length = 0;
      return {
        ok: false,
        provider: PROVIDER,
        answer: answer.join(""),
        rawFrames,
        error: error.message,
        errorInfo: error.toJSON(),
        partial,
        warnings: partial ? ["stream ended early; the answer is partial"] : [],
        events,
        meta: { durationMs: Date.now() - startedAt, attestationPool: this.pool.length },
      };
    }

    return {
      ok: true,
      provider: PROVIDER,
      answer: answer.join(""),
      rawFrames,
      error: null,
      errorInfo: null,
      partial: false,
      warnings: answer.length ? [] : ["no text extracted; inspect rawFrames for the actual event schema"],
      events,
      meta: {
        durationMs: Date.now() - startedAt,
        attestationPool: this.pool.length,
        frames: finish?.frames ?? rawFrames.length,
      },
    };
  }
}

export async function veniceChat(opts = {}) {
  const client = opts.client instanceof VeniceClient ? opts.client : new VeniceClient(opts);
  return client.chat(opts);
}

export async function veniceChatOrThrow(opts = {}) {
  const result = await veniceChat(opts);
  if (!result.ok) throw Object.assign(new Error(result.error), result.errorInfo || {});
  return result;
}
