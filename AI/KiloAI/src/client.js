/**
 * Kilo AI anonymous gateway client.
 *
 * OpenAI-compatible `POST /api/gateway/v1/chat/completions` with no API key.
 * Access control is IP-based, so the documented workflow is egress through
 * Tor's SOCKS5 port and a fresh circuit (`SIGNAL NEWNYM`) when the gateway
 * answers 429/403. Both are wired in here; the transport comes from
 * `lib/proxy.js` because Node's `fetch` has no SOCKS support.
 */

import {
  ApiError,
  ERROR_CODES,
  classifyError,
  sleep,
  truncate,
  withRetry,
} from "../../../lib/errors.js";
import { mergeHeaders, requestResponse } from "../../../lib/http.js";
import { extractChunk, extractCompletion, normalizeUsage } from "../../../lib/openai.js";
import { createProxyFetch, parseProxyUrl, torRenewIdentity } from "../../../lib/proxy.js";
import { iterateFrames, readJsonBody } from "../../../lib/stream.js";
import {
  BASE_URL,
  DEFAULT_HEADERS,
  DEFAULT_MAX_RESPONSE_BYTES,
  DEFAULT_MODEL,
  DEFAULT_STREAM_IDLE_TIMEOUT_MS,
  DEFAULT_TIMEOUT_MS,
  DEFAULT_TOR_CONTROL,
  PATHS,
  PROVIDER,
} from "./constants.js";

function emptyUsage() {
  return { prompt_tokens: 0, completion_tokens: 0, reasoning_tokens: 0, total_tokens: 0 };
}

function mergeUsage(target, usage) {
  if (!usage) return target;
  target.prompt_tokens = usage.prompt_tokens || target.prompt_tokens;
  target.completion_tokens = usage.completion_tokens || target.completion_tokens;
  target.reasoning_tokens = usage.reasoning_tokens || target.reasoning_tokens;
  target.total_tokens = usage.total_tokens || target.total_tokens;
  target.raw = usage.raw;
  return target;
}

function normalizeMessages(messages) {
  if (!Array.isArray(messages) || messages.length === 0) {
    throw new ApiError("at least one message is required", {
      provider: PROVIDER,
      code: ERROR_CODES.INVALID_INPUT,
    });
  }
  return messages.map((m) => {
    if (!m || !m.role) {
      throw new ApiError("each message needs a role", { provider: PROVIDER, code: ERROR_CODES.INVALID_INPUT });
    }
    return { role: m.role, content: typeof m.content === "string" ? m.content : String(m.content ?? "") };
  });
}

export class KiloClient {
  constructor(opts = {}) {
    if (typeof opts === "string") opts = { model: opts };
    this.baseUrl = (opts.baseUrl || BASE_URL).replace(/\/+$/, "");
    this.headers = mergeHeaders(DEFAULT_HEADERS, opts.headers);
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.streamIdleTimeoutMs = opts.streamIdleTimeoutMs ?? DEFAULT_STREAM_IDLE_TIMEOUT_MS;
    this.retries = Math.max(0, Number(opts.retries ?? 0) || 0);
    this.retryDelayMs = opts.retryDelayMs;
    this.maxResponseBytes = opts.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;

    this.proxy = parseProxyUrl(opts.proxy);
    const rawFetch = opts.fetchImpl || globalThis.fetch;
    this.fetchImpl = this.proxy ? createProxyFetch(this.proxy, { fetchImpl: rawFetch }) : rawFetch;

    this.tor = KiloClient.normalizeTor(opts.tor);
    this.renewIdentity =
      typeof opts.renewIdentity === "function"
        ? opts.renewIdentity
        : this.tor
          ? () => torRenewIdentity(this.tor)
          : null;
    this.rotateOnRateLimit = opts.rotateOnRateLimit ?? !!this.renewIdentity;
    this.rotationSettleMs = opts.rotationSettleMs ?? 0;
    this.rotations = 0;
  }

  static normalizeTor(tor) {
    if (!tor) return null;
    if (tor === true) return { ...DEFAULT_TOR_CONTROL };
    if (typeof tor === "string") return { ...DEFAULT_TOR_CONTROL, ...parseProxyUrl(tor) };
    return { ...DEFAULT_TOR_CONTROL, ...tor };
  }

  url(path) {
    return `${this.baseUrl}${path}`;
  }

  #headers(extra = {}) {
    return mergeHeaders({ accept: "application/json", ...this.headers }, extra);
  }

  async listModels({ signal } = {}) {
    return withRetry(
      async () => {
        const { res } = await requestResponse(
          this.url(PATHS.models),
          { method: "GET", headers: this.#headers(), signal },
          { fetchImpl: this.fetchImpl, timeoutMs: this.timeoutMs, provider: PROVIDER }
        );
        const body = await readJsonBody(res, this.maxResponseBytes);
        return Array.isArray(body?.data) ? body.data : Array.isArray(body) ? body : [];
      },
      {
        retries: this.retries,
        signal,
        retryDelayMs: this.retryDelayMs,
        beforeRetry: (err, attempt) => this.#beforeRetry(err, attempt, signal),
        context: { provider: PROVIDER },
      }
    );
  }

  async #beforeRetry(error, attempt, signal) {
    if (!this.rotateOnRateLimit || !this.renewIdentity) return;
    if (error.code !== ERROR_CODES.RATE_LIMITED && error.code !== ERROR_CODES.FORBIDDEN) return;
    await this.renewIdentity({ attempt, reason: error.code });
    this.rotations += 1;
    if (this.rotationSettleMs) await sleep(this.rotationSettleMs, signal);
  }

  #body(opts) {
    const body = {
      model: opts.model || DEFAULT_MODEL,
      messages: normalizeMessages(opts.messages),
      stream: opts.stream !== false,
    };
    if (body.stream) body.stream_options = { include_usage: true };
    if (opts.maxTokens !== undefined) body.max_tokens = opts.maxTokens;
    if (opts.temperature !== undefined) body.temperature = opts.temperature;
    if (opts.topP !== undefined) body.top_p = opts.topP;
    if (opts.reasoningEffort !== undefined) body.reasoning_effort = opts.reasoningEffort;
    if (opts.stop !== undefined) body.stop = opts.stop;
    for (const [k, v] of Object.entries(opts.extra || {})) if (v !== undefined) body[k] = v;
    return body;
  }

  async #open(body, { signal, hint } = {}) {
    return requestResponse(
      this.url(PATHS.chat),
      {
        method: "POST",
        headers: this.#headers({ "content-type": "application/json", accept: "text/event-stream" }),
        body: JSON.stringify(body),
        signal,
      },
      {
        fetchImpl: this.fetchImpl,
        timeoutMs: this.timeoutMs,
        maxResponseBytes: this.maxResponseBytes,
        provider: PROVIDER,
        hint,
      }
    );
  }

  async *streamChat(opts = {}) {
    const body = this.#body({ ...opts, stream: opts.stream !== false });
    let opened;
    try {
      opened = await withRetry(() => this.#open(body, opts), {
        retries: this.retries,
        signal: opts.signal,
        retryDelayMs: this.retryDelayMs,
        onRetry: opts.onRetry,
        beforeRetry: (err, attempt) => this.#beforeRetry(err, attempt, opts.signal),
        context: { provider: PROVIDER },
      });
    } catch (e) {
      throw classifyError(e, { provider: PROVIDER });
    }

    const { res } = opened;
    const contentType = String(opened.headers["content-type"] || "");
    let model = body.model;

    if (!/event-stream|ndjson/i.test(contentType)) {
      const payload = await readJsonBody(res, this.maxResponseBytes);
      const parsed = extractCompletion(payload);
      if (!parsed) {
        throw new ApiError("empty gateway response", {
          provider: PROVIDER,
          code: ERROR_CODES.PARSE_ERROR,
        });
      }
      if (parsed.error) {
        throw new ApiError(parsed.message, {
          provider: PROVIDER,
          code: ERROR_CODES.STREAM_ERROR,
          details: truncate(parsed.error, 600),
        });
      }
      if (parsed.reasoning) yield { type: "reasoning_delta", delta: parsed.reasoning };
      if (parsed.content) yield { type: "text_delta", delta: parsed.content };
      if (parsed.toolCalls) yield { type: "tool_calls", toolCalls: parsed.toolCalls };
      if (parsed.usage) yield { type: "usage", usage: parsed.usage.raw };
      yield { type: "finish", reason: parsed.finishReason || "stop", model: parsed.model || model };
      return;
    }

    let finishReason = null;
    let frames = 0;
    let usageSeen = false;

    for await (const frame of iterateFrames(res, {
      idleTimeoutMs: this.streamIdleTimeoutMs,
      onMalformed: opts.onMalformed,
    })) {
      if (frame.json == null) continue;
      frames += 1;
      const parsed = extractChunk(frame.json);
      if (parsed?.error) {
        throw new ApiError(parsed.message, {
          provider: PROVIDER,
          code: ERROR_CODES.STREAM_ERROR,
          details: truncate(parsed.error, 600),
        });
      }
      if (!parsed) continue;
      if (parsed.model) model = parsed.model;
      if (parsed.reasoning) yield { type: "reasoning_delta", delta: parsed.reasoning };
      if (parsed.content) yield { type: "text_delta", delta: parsed.content };
      if (parsed.toolCalls) yield { type: "tool_calls", toolCalls: parsed.toolCalls };
      if (parsed.usage) {
        usageSeen = true;
        yield { type: "usage", usage: parsed.usage.raw };
      }
      if (parsed.finishReason) finishReason = parsed.finishReason;
    }

    if (frames === 0) {
      throw new ApiError("stream closed without any frames", {
        provider: PROVIDER,
        code: ERROR_CODES.STREAM_ERROR,
        retryable: true,
      });
    }
    yield { type: "finish", reason: finishReason || "stop", model, usageIncluded: usageSeen };
  }

  async chat(opts = {}) {
    const usage = emptyUsage();
    const answer = [];
    const reasoning = [];
    const toolCalls = [];
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
        else if (event.type === "tool_calls") toolCalls.push(...event.toolCalls);
        else if (event.type === "usage") mergeUsage(usage, normalizeUsage(event.usage));
        else if (event.type === "finish") {
          finishReason = event.reason;
          if (event.model) model = event.model;
        }
      }
    } catch (e) {
      partial = answer.length > 0;
      let error = classifyError(e, { provider: PROVIDER });
      if (partial && error.code === ERROR_CODES.NETWORK_ERROR) {
        error = new ApiError("stream ended early", {
          provider: PROVIDER,
          code: ERROR_CODES.STREAM_ERROR,
          retryable: false,
          cause: e,
        });
      }
      if (opts.allowPartial === false) answer.length = 0;
      return {
        ok: false,
        provider: PROVIDER,
        model,
        answer: answer.join(""),
        reasoning: reasoning.join(""),
        toolCalls,
        finishReason,
        usage,
        error: error.message,
        errorInfo: error.toJSON(),
        partial,
        events,
        warnings: partial ? ["stream ended early; the answer is partial"] : [],
        meta: {
          durationMs: Date.now() - startedAt,
          proxy: this.proxy ? `${this.proxy.type}://${this.proxy.host}:${this.proxy.port}` : null,
          torRotations: this.rotations,
        },
      };
    }

    return {
      ok: true,
      provider: PROVIDER,
      model,
      answer: answer.join(""),
      reasoning: reasoning.join(""),
      toolCalls,
      finishReason,
      usage,
      error: null,
      errorInfo: null,
      partial: false,
      events,
      warnings: [],
      meta: {
        durationMs: Date.now() - startedAt,
        proxy: this.proxy ? `${this.proxy.type}://${this.proxy.host}:${this.proxy.port}` : null,
        torRotations: this.rotations,
      },
    };
  }
}

export function kiloMessages({ prompt, system, messages } = {}) {
  if (Array.isArray(messages) && messages.length) return messages;
  if (!prompt) {
    throw new ApiError("prompt or messages is required", {
      provider: PROVIDER,
      code: ERROR_CODES.INVALID_INPUT,
    });
  }
  const out = [];
  if (system) out.push({ role: "system", content: String(system) });
  out.push({ role: "user", content: String(prompt) });
  return out;
}

export async function kiloChat(opts = {}) {
  const client = opts.client instanceof KiloClient ? opts.client : new KiloClient(opts);
  return client.chat({ ...opts, messages: opts.messages || kiloMessages(opts) });
}

export async function kiloChatOrThrow(opts = {}) {
  const result = await kiloChat(opts);
  if (!result.ok) throw Object.assign(new Error(result.error), result.errorInfo || {});
  return result;
}
