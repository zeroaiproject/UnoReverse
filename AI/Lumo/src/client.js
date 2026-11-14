/**
 * Proton Lumo (guest) client.
 *
 * Flow (DOCS.md): bootstrap a guest auth session, exchange it for cookies,
 * then call `/api/ai/v1/chat/completions` over SSE. The wire payloads are
 * end-to-end encrypted (`encrypted:true`, `lumo.request_key`) so plaintext is
 * not observable at the network layer; this client exposes a pluggable
 * `codec` for callers that have the browser's key material, and otherwise
 * returns the ciphertext blobs verbatim with an explicit warning.
 */

import { randomUUID } from "node:crypto";

import { ApiError, ERROR_CODES, classifyError, truncate, withRetry } from "../../../lib/errors.js";
import { CookieJar, mergeHeaders, readTextBounded, requestResponse, toCookieJar } from "../../../lib/http.js";
import { iterateFrames } from "../../../lib/stream.js";
import {
  BASE_URL,
  DEFAULT_APP_VERSION,
  DEFAULT_HEADERS,
  DEFAULT_LOCALE,
  DEFAULT_MAX_RESPONSE_BYTES,
  DEFAULT_MODEL,
  DEFAULT_STREAM_IDLE_TIMEOUT_MS,
  DEFAULT_TIMEOUT_MS,
  DEFAULT_TOOLS,
  PATHS,
  PROVIDER,
} from "./constants.js";

function emptyUsage() {
  return { prompt_tokens: 0, completion_tokens: 0, reasoning_tokens: 0, total_tokens: 0 };
}

function mergeUsage(target, usage) {
  if (!usage || typeof usage !== "object") return target;
  target.prompt_tokens = Number(usage.prompt_tokens) || target.prompt_tokens;
  target.completion_tokens = Number(usage.completion_tokens) || target.completion_tokens;
  target.reasoning_tokens = Number(usage.completion_tokens_details?.reasoning_tokens) || target.reasoning_tokens;
  target.total_tokens = Number(usage.total_tokens) || target.total_tokens;
  target.remaining_limits = usage.remaining_limits || target.remaining_limits || null;
  target.applied_limit_category = usage.applied_limit_category || target.applied_limit_category || null;
  target.raw = usage;
  return target;
}

const PASSTHROUGH_CODEC = Object.freeze({
  /** Encrypt/encode outbound message content. */
  async encodeContent(content) {
    return { content: typeof content === "string" ? content : String(content ?? ""), encrypted: false };
  },
  /** Decode inbound delta content/reasoning. */
  async decodeText(text) {
    return text == null ? "" : String(text);
  },
  /** Optional request key material. */
  requestKey() {
    return null;
  },
});

function asMessages(messages) {
  if (!Array.isArray(messages) || !messages.length) {
    throw new ApiError("at least one message is required", { provider: PROVIDER, code: ERROR_CODES.INVALID_INPUT });
  }
  return messages;
}

export class LumoClient {
  constructor(opts = {}) {
    this.fetchImpl = opts.fetchImpl || globalThis.fetch;
    this.baseUrl = (opts.baseUrl || BASE_URL).replace(/\/+$/, "");
    this.headers = mergeHeaders(DEFAULT_HEADERS, opts.headers);
    this.appVersion = opts.appVersion || DEFAULT_APP_VERSION;
    this.locale = opts.locale || DEFAULT_LOCALE;
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.streamIdleTimeoutMs = opts.streamIdleTimeoutMs ?? DEFAULT_STREAM_IDLE_TIMEOUT_MS;
    this.retries = Math.max(0, Number(opts.retries ?? 0) || 0);
    this.retryDelayMs = opts.retryDelayMs;
    this.maxResponseBytes = opts.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
    this.cookieJar = toCookieJar(opts.cookieJar ?? opts.cookies);
    this.codec = opts.codec || PASSTHROUGH_CODEC;
    this.featureFlags = opts.featureFlags || {};
    this.session = opts.session || null; // { AccessToken, RefreshToken, UID, ... }
    this.tools = opts.tools === null ? null : opts.tools || [...DEFAULT_TOOLS];
  }

  url(path) {
    return `${this.baseUrl}${path}`;
  }

  #baseHeaders(extra = {}) {
    const cookie = this.cookieJar.toString();
    return mergeHeaders(
      {
        accept: "application/json",
        "x-pm-appversion": this.appVersion,
        "x-pm-locale": this.locale,
        ...(this.session?.UID ? { "x-pm-uid": this.session.UID } : null),
        ...(cookie ? { cookie } : null),
        ...this.headers,
      },
      extra
    );
  }

  async #postJson(path, body, { headers, signal, retry = false } = {}) {
    const send = () =>
      requestResponse(
        this.url(path),
        {
          method: "POST",
          headers: this.#baseHeaders({ "content-type": "application/json", ...headers }),
          body: JSON.stringify(body),
          signal,
        },
        {
          fetchImpl: this.fetchImpl,
          timeoutMs: this.timeoutMs,
          maxResponseBytes: this.maxResponseBytes,
          provider: PROVIDER,
        }
      );
    const { res } = retry
      ? await withRetry(send, {
          retries: this.retries,
          signal,
          retryDelayMs: this.retryDelayMs,
          context: { provider: PROVIDER },
        })
      : await send();
    this.cookieJar.ingestResponse(res);
    const text = await readTextBounded(res, this.maxResponseBytes);
    try {
      return text ? JSON.parse(text) : null;
    } catch (e) {
      throw new ApiError("expected JSON response", {
        provider: PROVIDER,
        code: ERROR_CODES.PARSE_ERROR,
        details: truncate(text, 400),
        cause: e,
      });
    }
  }

  async #getJson(path, { signal, headers } = {}) {
    const { res } = await withRetry(
      () =>
        requestResponse(
          this.url(path),
          { method: "GET", headers: this.#baseHeaders(headers), signal },
          {
            fetchImpl: this.fetchImpl,
            timeoutMs: this.timeoutMs,
            maxResponseBytes: this.maxResponseBytes,
            provider: PROVIDER,
          }
        ),
      { retries: this.retries, signal, retryDelayMs: this.retryDelayMs, context: { provider: PROVIDER } }
    );
    this.cookieJar.ingestResponse(res);
    const text = await readTextBounded(res, this.maxResponseBytes);
    try {
      return text ? JSON.parse(text) : null;
    } catch (e) {
      throw new ApiError("expected JSON response", {
        provider: PROVIDER,
        code: ERROR_CODES.PARSE_ERROR,
        details: truncate(text, 400),
        cause: e,
      });
    }
  }

  /** Bootstrap a guest session and exchange it for auth cookies. */
  async guestAuth({ signal } = {}) {
    const session = await this.#postJson(PATHS.session, {}, { signal, retry: true });
    if (!session || !session.UID) {
      throw new ApiError("guest session bootstrap did not return a UID", {
        provider: PROVIDER,
        code: ERROR_CODES.UNAUTHORIZED,
        details: truncate(session),
      });
    }
    this.session = session;

    await this.#postJson(
      PATHS.cookies,
      {
        UID: session.UID,
        ResponseType: "token",
        GrantType: "refresh_token",
        RefreshToken: session.RefreshToken,
        RedirectURI: "https://protonmail.com",
        Persistent: 0,
        State: randomUUID().replace(/-/g, "").slice(0, 24),
      },
      { signal, retry: true }
    );
    return this.session;
  }

  async ensureSession({ signal } = {}) {
    if (this.session && this.cookieJar.size) return this.session;
    if (!this.session) return this.guestAuth({ signal });
    return this.session;
  }

  async listModels({ signal } = {}) {
    await this.ensureSession({ signal });
    const body = await this.#getJson(PATHS.models, { signal });
    return Array.isArray(body?.data) ? body.data : [];
  }

  async limits({ signal } = {}) {
    await this.ensureSession({ signal });
    return this.#getJson(PATHS.limits, { signal });
  }

  async features({ signal } = {}) {
    await this.ensureSession({ signal });
    return this.#getJson(`${PATHS.features}?sessionId=0&appName=-&environment=default`, { signal });
  }

  async #encodeMessages(messages) {
    const out = [];
    let encryptedCount = 0;
    for (const m of asMessages(messages)) {
      const encoded = await this.codec.encodeContent(m.content, m);
      if (encoded.encrypted) encryptedCount += 1;
      out.push({
        role: m.role,
        content: encoded.content,
        ...(encoded.encrypted ? { encrypted: true } : {}),
      });
    }
    return { messages: out, encrypted: encryptedCount > 0 };
  }

  #body({ messages, model, stream, target, tools, extra, requestKey, reasoningEffort }) {
    const body = {
      model: model || DEFAULT_MODEL,
      messages,
      stream: stream !== false,
    };
    if (body.stream) body.stream_options = { include_usage: true };
    if (reasoningEffort) body.reasoning_effort = reasoningEffort;
    if (tools && tools.length) body.tools = tools;
    for (const [k, v] of Object.entries(extra || {})) if (v !== undefined) body[k] = v;
    body.lumo = {
      client_type: "frontend",
      target: target || "chat",
      request_id: randomUUID(),
      feature_flags: this.featureFlags,
      ...(requestKey ? { request_key: requestKey } : {}),
    };
    return body;
  }

  async *streamChat(opts = {}) {
    const signal = opts.signal;
    await this.ensureSession({ signal });

    const encoded = await this.#encodeMessages(opts.messages);
    const requestKey = opts.requestKey || (typeof this.codec.requestKey === "function" ? this.codec.requestKey() : null);
    const body = this.#body({
      ...opts,
      messages: encoded.messages,
      tools: opts.tools === null ? null : opts.tools || this.tools,
      requestKey,
    });

    const { res } = await withRetry(
      () =>
        requestResponse(
          this.url(PATHS.chat),
          {
            method: "POST",
            headers: this.#baseHeaders({
              "content-type": "application/json",
              accept: "text/event-stream, application/vnd.protonmail.v1+json",
            }),
            body: JSON.stringify(body),
            signal,
          },
          {
            fetchImpl: this.fetchImpl,
            timeoutMs: this.timeoutMs,
            maxResponseBytes: this.maxResponseBytes,
            provider: PROVIDER,
          }
        ),
      {
        retries: this.retries,
        signal,
        retryDelayMs: this.retryDelayMs,
        context: { provider: PROVIDER },
        onRetry: opts.onRetry,
      }
    );

    if (!encoded.encrypted && !opts.suppressEncryptionWarning) {
      yield {
        type: "warning",
        message:
          "Lumo completions are normally E2E-encrypted on the wire; this request was sent without an encrypting codec, so the provider may reject it",
      };
    }

    let frames = 0;
    let model = body.model;
    let finishReason = null;

    for await (const frame of iterateFrames(res, {
      idleTimeoutMs: this.streamIdleTimeoutMs,
      onMalformed: opts.onMalformed,
    })) {
      if (frame.json == null) continue;
      frames += 1;
      const payload = frame.json;
      if (payload.model) model = payload.model;
      if (payload.error) {
        throw new ApiError(payload.error.message || JSON.stringify(payload.error), {
          provider: PROVIDER,
          code: ERROR_CODES.STREAM_ERROR,
          details: payload.error,
        });
      }
      if (payload.usage) yield { type: "usage", usage: payload.usage };

      const choice = payload.choices?.[0];
      if (!choice) continue;
      const delta = choice.delta || {};
      const encrypted = !!delta.encrypted || encoded.encrypted;
      if (delta.reasoning != null) {
        const text = await this.codec.decodeText(delta.reasoning, { encrypted, kind: "reasoning", payload });
        if (text) yield { type: "reasoning_delta", delta: text, encrypted };
      }
      if (delta.content != null) {
        const text = await this.codec.decodeText(delta.content, { encrypted, kind: "content", payload });
        if (text) yield { type: "text_delta", delta: text, encrypted };
      }
      if (choice.finish_reason) finishReason = choice.finish_reason;
    }

    if (frames === 0) {
      throw new ApiError("stream closed without any frames", {
        provider: PROVIDER,
        code: ERROR_CODES.STREAM_ERROR,
        retryable: true,
      });
    }
    yield { type: "finish", reason: finishReason || "stop", model };
  }

  async chat(opts = {}) {
    const answer = [];
    const reasoning = [];
    const warnings = [];
    const usage = emptyUsage();
    const events = [];
    let model = opts.model || DEFAULT_MODEL;
    let finishReason = null;
    let partial = false;
    const startedAt = Date.now();

    try {
      for await (const event of this.streamChat(opts)) {
        events.push(event);
        opts.onEvent?.(event);
        if (event.type === "text_delta") answer.push(event.delta);
        else if (event.type === "reasoning_delta") reasoning.push(event.delta);
        else if (event.type === "usage") mergeUsage(usage, event.usage);
        else if (event.type === "warning") warnings.push(event.message);
        else if (event.type === "finish") {
          finishReason = event.reason;
          if (event.model) model = event.model;
        }
      }
    } catch (e) {
      partial = answer.length > 0;
      const error = classifyError(e, { provider: PROVIDER });
      if (opts.allowPartial === false) answer.length = 0;
      return {
        ok: false,
        provider: PROVIDER,
        model,
        answer: answer.join(""),
        reasoning: reasoning.join(""),
        usage,
        finishReason,
        error: error.message,
        errorInfo: error.toJSON(),
        partial,
        warnings: partial ? [...warnings, "stream ended early; the answer is partial"] : warnings,
        events,
        meta: { durationMs: Date.now() - startedAt, uid: this.session?.UID || null },
      };
    }

    return {
      ok: true,
      provider: PROVIDER,
      model,
      answer: answer.join(""),
      reasoning: reasoning.join(""),
      usage,
      finishReason,
      error: null,
      errorInfo: null,
      partial: false,
      warnings,
      events,
      meta: { durationMs: Date.now() - startedAt, uid: this.session?.UID || null },
    };
  }
}

export function lumoMessages({ prompt, system, messages } = {}) {
  if (Array.isArray(messages) && messages.length) return messages;
  if (!prompt) {
    throw new ApiError("prompt or messages is required", { provider: PROVIDER, code: ERROR_CODES.INVALID_INPUT });
  }
  const out = [];
  if (system) out.push({ role: "system", content: String(system) });
  out.push({ role: "user", content: String(prompt) });
  return out;
}

export async function lumoChat(opts = {}) {
  const client = opts.client instanceof LumoClient ? opts.client : new LumoClient(opts);
  return client.chat({ ...opts, messages: opts.messages || lumoMessages(opts) });
}

export async function lumoChatOrThrow(opts = {}) {
  const result = await lumoChat(opts);
  if (!result.ok) throw Object.assign(new Error(result.error), result.errorInfo || {});
  return result;
}

export { PASSTHROUGH_CODEC };
