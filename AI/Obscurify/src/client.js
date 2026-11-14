/**
 * Anonymous Obscurify client.
 *
 * Observed surface (DOCS.md):
 *   GET  /v1/models | /frontier_models | /uncensored_models | /code_mode
 *   POST /anon/chat/completions   (OpenAI-style SSE, no auth)
 *
 * The guest endpoint is stateless apart from the `x-obscurify-thread` header,
 * which this client captures from a response and reuses when one is supplied.
 */

import {
  ApiError,
  ERROR_CODES,
  classifyError,
  sleep,
  truncate,
  withRetry,
} from "../../../lib/errors.js";
import { DEFAULT_UA, mergeHeaders, requestResponse } from "../../../lib/http.js";
import { iterateFrames } from "../../../lib/stream.js";
import {
  BASE_URL,
  DEFAULT_MAX_RESPONSE_BYTES,
  DEFAULT_MODEL,
  DEFAULT_STREAM_IDLE_TIMEOUT_MS,
  DEFAULT_TIMEOUT_MS,
  PATHS,
  PROVIDER,
  THREAD_HEADER,
  WEB_HEADERS,
} from "./constants.js";

const DEFAULT_WEB_HEADERS = { ...WEB_HEADERS, "user-agent": DEFAULT_UA };

function emptyUsage() {
  return {
    prompt_tokens: 0,
    completion_tokens: 0,
    reasoning_tokens: 0,
    total_tokens: 0,
  };
}

function applyUsage(target, usage) {
  if (!usage || typeof usage !== "object") return target;
  const prompt = Number(usage.prompt_tokens) || 0;
  const completion = Number(usage.completion_tokens) || 0;
  const reasoning = Number(usage.completion_tokens_details?.reasoning_tokens ?? usage.reasoning_tokens) || 0;
  target.prompt_tokens = prompt || target.prompt_tokens;
  target.completion_tokens = completion || target.completion_tokens;
  target.reasoning_tokens = reasoning || target.reasoning_tokens;
  target.total_tokens = Number(usage.total_tokens) || prompt + completion || target.total_tokens;
  target.raw = usage;
  return target;
}

function textOf(content) {
  if (content == null) return "";
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === "string") return part;
        if (part && typeof part.text === "string") return part.text;
        return "";
      })
      .join("");
  }
  return String(content);
}

/**
 * Normalize caller input into wire messages. `structuredContent` mirrors the
 * captured guest shape (`[{type:"text", text}]`) for models that expect parts.
 */
export function toWireMessages(messages, { structuredContent = false } = {}) {
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
    const text = textOf(m.content);
    if (m.role === "user" && structuredContent) {
      return { role: "user", content: [{ type: "text", text }] };
    }
    return { role: m.role, content: text };
  });
}

export class ObscurifyClient {
  constructor(opts = {}) {
    if (typeof opts === "string") opts = { model: opts };
    this.fetchImpl = opts.fetchImpl || globalThis.fetch;
    this.baseUrl = (opts.baseUrl || BASE_URL).replace(/\/+$/, "");
    this.headers = mergeHeaders(DEFAULT_WEB_HEADERS, opts.headers);
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.streamIdleTimeoutMs = opts.streamIdleTimeoutMs ?? DEFAULT_STREAM_IDLE_TIMEOUT_MS;
    this.retries = Math.max(0, Number(opts.retries ?? 0) || 0);
    this.retryDelayMs = opts.retryDelayMs;
    this.maxResponseBytes = opts.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
    this.structuredContent = !!opts.structuredContent;
  }

  url(path) {
    return `${this.baseUrl}${path}`;
  }

  #headers(extra = {}) {
    return mergeHeaders({ accept: "application/json", ...this.headers }, extra);
  }

  async #getJson(path, { h, hint } = {}) {
    return withRetry(
      async () => {
        const { res } = await requestResponse(
          this.url(path),
          { method: "GET", headers: this.#headers(h) },
          { fetchImpl: this.fetchImpl, timeoutMs: this.timeoutMs, provider: PROVIDER, hint }
        );
        try {
          const body = await res.text();
          if (!body.trim()) return null;
          return JSON.parse(body);
        } catch (e) {
          throw new ApiError("expected a JSON catalog response", {
            provider: PROVIDER,
            code: ERROR_CODES.PARSE_ERROR,
            cause: e,
          });
        }
      },
      {
        retries: this.retries,
        signal: undefined,
        retryDelayMs: this.retryDelayMs,
        context: { provider: PROVIDER },
      }
    );
  }

  /** Full `/v1/models` catalog (`data[]`). */
  async listModels({ kind = "all" } = {}) {
    if (kind === "all") {
      const body = await this.#getJson(PATHS.models);
      return Array.isArray(body?.data) ? body.data : [];
    }
    if (kind === "frontier") {
      const body = await this.#getJson(PATHS.frontierModels);
      return body?.frontier_models ?? [];
    }
    if (kind === "uncensored") {
      const body = await this.#getJson(PATHS.uncensoredModels);
      return body?.uncensored_models ?? [];
    }
    throw new ApiError(`unknown model list "${kind}" (all|frontier|uncensored)`, {
      provider: PROVIDER,
      code: ERROR_CODES.INVALID_INPUT,
    });
  }

  /** Tools/code sandbox configuration served to the web client. */
  async codeMode() {
    return this.#getJson(PATHS.codeMode);
  }

  #body(opts) {
    const messages = toWireMessages(opts.messages, { structuredContent: this.structuredContent });
    const body = {
      model: opts.model || DEFAULT_MODEL,
      messages,
      stream: opts.stream !== false,
    };
    if (body.stream) body.stream_options = { include_usage: true };
    if (opts.tools) body.tools = opts.tools;
    if (opts.toolChoice !== undefined) body.tool_choice = opts.toolChoice;
    if (opts.temperature !== undefined) body.temperature = opts.temperature;
    if (opts.topP !== undefined) body.top_p = opts.topP;
    if (opts.maxTokens !== undefined) body.max_tokens = opts.maxTokens;
    if (opts.stop !== undefined) body.stop = opts.stop;
    for (const [k, v] of Object.entries(opts.extra || {})) {
      if (v !== undefined) body[k] = v;
    }
    return body;
  }

  async #open(body, { thread, signal, hint } = {}) {
    const headers = this.#headers({
      "content-type": "application/json",
      accept: "text/event-stream",
      ...(thread ? { [THREAD_HEADER]: thread } : {}),
    });
    const { res, headers: responseHeaders } = await requestResponse(
      this.url(PATHS.anonymousChat),
      { method: "POST", headers, body: JSON.stringify(body), signal },
      {
        fetchImpl: this.fetchImpl,
        timeoutMs: this.timeoutMs,
        maxResponseBytes: this.maxResponseBytes,
        provider: PROVIDER,
        hint,
      }
    );
    return {
      res,
      thread: responseHeaders[THREAD_HEADER] || thread || null,
      contentType: responseHeaders["content-type"] || "",
    };
  }

  /**
   * Yield normalized events: `text_delta`, `reasoning_delta`, `tool_calls`,
   * `usage`, `finish`. Non-stream responses are turned into a single delta.
   */
  async *streamChat(opts = {}) {
    const body = this.#body({ ...opts, stream: opts.stream !== false });
    let opened;
    try {
      opened = await withRetry(() => this.#open(body, opts), {
        retries: this.retries,
        signal: opts.signal,
        retryDelayMs: this.retryDelayMs,
        onRetry: opts.onRetry,
        context: { provider: PROVIDER },
      });
    } catch (e) {
      throw classifyError(e, { provider: PROVIDER });
    }

    const { res } = opened;
    if (opened.thread) yield { type: "thread", thread: opened.thread };

    if (!/event-stream|ndjson/i.test(opened.contentType)) {
      const text = await res.text();
      let payload = null;
      try {
        payload = text.trim() ? JSON.parse(text) : null;
      } catch (_) {}
      if (!payload) {
        throw new ApiError("expected JSON or SSE response", {
          provider: PROVIDER,
          code: ERROR_CODES.PARSE_ERROR,
          details: truncate(text, 400),
        });
      }
      const message = payload.choices?.[0]?.message || {};
      const content = textOf(message.content);
      const reasoning = textOf(message.reasoning);
      if (reasoning) yield { type: "reasoning_delta", delta: reasoning };
      if (content) yield { type: "text_delta", delta: content };
      if (Array.isArray(message.tool_calls)) yield { type: "tool_calls", toolCalls: message.tool_calls };
      if (payload.usage) yield { type: "usage", usage: payload.usage };
      yield { type: "finish", reason: payload.choices?.[0]?.finish_reason ?? "stop", model: payload.model };
      return;
    }

    let finishReason = null;
    let model = body.model;
    let sawUsage = false;
    let frames = 0;

    for await (const frame of iterateFrames(res, {
      idleTimeoutMs: this.streamIdleTimeoutMs,
      onMalformed: opts.onMalformed,
    })) {
      if (frame.json == null) continue;
      frames += 1;
      const payload = frame.json;
      if (payload.error) {
        const message = payload.error.message || JSON.stringify(payload.error);
        throw new ApiError(message, {
          provider: PROVIDER,
          code: ERROR_CODES.STREAM_ERROR,
          details: payload.error,
        });
      }
      if (payload.model) model = payload.model;
      if (payload.usage) {
        sawUsage = true;
        yield { type: "usage", usage: payload.usage };
      }
      const choice = payload.choices?.[0];
      if (!choice) continue;
      const delta = choice.delta || {};
      if (typeof delta.reasoning === "string" && delta.reasoning) {
        yield { type: "reasoning_delta", delta: delta.reasoning };
      } else if (Array.isArray(delta.reasoning_details)) {
        const text = delta.reasoning_details
          .map((d) => (typeof d?.text === "string" ? d.text : ""))
          .join("");
        if (text) yield { type: "reasoning_delta", delta: text };
      }
      if (typeof delta.content === "string" && delta.content) {
        yield { type: "text_delta", delta: delta.content };
      }
      if (Array.isArray(delta.tool_calls) && delta.tool_calls.length) {
        yield { type: "tool_calls", toolCalls: delta.tool_calls };
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
    yield {
      type: "finish",
      reason: finishReason || "stop",
      model,
      usageIncluded: sawUsage,
    };
  }

  /**
   * Collect a streamed turn. Never throws for API/transport failures: the
   * result carries `ok:false`, the partial answer and the classified error.
   */
  async chat(opts = {}) {
    const events = opts.onEvent ? [] : [];
    const answerParts = [];
    const reasoningParts = [];
    const toolCalls = [];
    const usage = emptyUsage();
    let thread = opts.thread || null;
    let model = opts.model || DEFAULT_MODEL;
    let finishReason = null;
    let partial = false;
    const startedAt = Date.now();

    try {
      for await (const event of this.streamChat(opts)) {
        events.push(event);
        opts.onEvent?.(event);
        switch (event.type) {
          case "thread":
            thread = event.thread;
            break;
          case "text_delta":
            answerParts.push(event.delta);
            break;
          case "reasoning_delta":
            reasoningParts.push(event.delta);
            break;
          case "tool_calls":
            toolCalls.push(...event.toolCalls);
            break;
          case "usage":
            applyUsage(usage, event.usage);
            break;
          case "finish":
            finishReason = event.reason ?? null;
            if (event.model) model = event.model;
            break;
          default:
            break;
        }
      }
    } catch (e) {
      partial = answerParts.length > 0;
      let error = classifyError(e, { provider: PROVIDER });
      if (partial && error.code === ERROR_CODES.NETWORK_ERROR) {
        error = new ApiError("stream ended early", {
          provider: PROVIDER,
          code: ERROR_CODES.STREAM_ERROR,
          retryable: false,
          details: error.message,
          cause: e,
        });
      }
      if (opts.allowPartial === false) answerParts.length = 0;
      return {
        ok: false,
        provider: PROVIDER,
        model,
        thread,
        answer: answerParts.join(""),
        reasoning: reasoningParts.join(""),
        toolCalls,
        finishReason,
        usage,
        error: error.message,
        errorInfo: error.toJSON(),
        partial,
        events,
        warnings: partial ? ["stream ended early; the answer is partial"] : [],
        meta: { durationMs: Date.now() - startedAt },
      };
    }

    return {
      ok: true,
      provider: PROVIDER,
      model,
      thread,
      answer: answerParts.join(""),
      reasoning: reasoningParts.join(""),
      toolCalls,
      finishReason,
      usage,
      error: null,
      errorInfo: null,
      partial: false,
      events,
      warnings: [],
      meta: { durationMs: Date.now() - startedAt },
    };
  }
}

/** One-shot helper: `await obscurifyChat({ prompt: "…" })`. */
export async function obscurifyChat(opts = {}) {
  const client = opts.client instanceof ObscurifyClient ? opts.client : new ObscurifyClient(opts);
  const messages = opts.messages || buildMessagesFromPrompt(opts);
  return client.chat({
    ...opts,
    messages,
  });
}

export function buildMessagesFromPrompt({ prompt, system, messages } = {}) {
  if (messages && Array.isArray(messages) && messages.length) return messages;
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

/** Convenience for callers that want exceptions. */
export async function obscurifyChatOrThrow(opts = {}) {
  const result = await obscurifyChat(opts);
  if (!result.ok) throw Object.assign(new Error(result.error), result.errorInfo || {});
  return result;
}

export { sleep };
