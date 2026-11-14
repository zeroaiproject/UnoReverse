/**
 * Request execution: the single `with_ask` attempt, the retrying wrapper, the
 * event-stream generator and the high-level `braveLeoSearch` entry point.
 */

import {
  BRAVE_ORIGIN,
  DEFAULT_MAX_RESPONSE_BYTES,
  DEFAULT_STREAM_IDLE_TIMEOUT_MS,
  STREAM_REQUEST_HEADERS,
} from "./constants.js";
import {
  BraveLeoError,
  ERROR_CODES,
  classifyError,
  codeForStatus,
  isAbortError,
  isRetryableStatus,
  parseRetryAfter,
  truncate,
  withRetry,
  withTimeout,
} from "./errors.js";
import { headersToObject, mergeHeaders, readTextBounded, toCookieJar } from "./http.js";
import {
  buildWithAskUrl,
  describeResolutionFailure,
  normalizeConversationId,
  redactResolution,
  resolveConversation,
} from "./conversation.js";
import {
  applyEvent,
  createStreamState,
  emptySources,
  finalizeState,
  iterateStreamEvents,
  parseEventStream,
} from "./stream.js";
import { buildAgentResult } from "./result.js";

function assertFetch(fetchImpl) {
  if (typeof fetchImpl !== "function") {
    throw new BraveLeoError("fetch is not available in this environment", {
      code: ERROR_CODES.FETCH_UNAVAILABLE,
      retryable: false,
    });
  }
  return fetchImpl;
}

function httpErrorFor(res, body, conversation) {
  const status = res.status;
  const code = codeForStatus(status);
  const hints = {
    [ERROR_CODES.BLOCKED]:
      "Brave treated the request as automated traffic. Supply cookies from a real browser session.",
    [ERROR_CODES.CONVERSATION_INVALID]: "The conversation id was rejected; re-initiate it in a browser.",
    [ERROR_CODES.CONVERSATION_NOT_FOUND]: "The conversation id is unknown or expired.",
    [ERROR_CODES.RATE_LIMITED]: "Rate limited; retry after the indicated delay or rotate egress.",
  };
  return new BraveLeoError(`with_ask request failed: ${status} ${res.statusText || ""}`.trim(), {
    code,
    status,
    retryable: isRetryableStatus(status),
    retryAfterMs: parseRetryAfter(res.headers),
    details: truncate(body),
    hint: hints[code] ?? null,
    conversation,
  });
}

/**
 * One `with_ask` request + stream consumption. No retries.
 * Returns a result object; throws only when no partial data exists.
 */
export async function streamWithAskOnce(conversation, opts = {}) {
  const fetchImpl = assertFetch(opts.fetchImpl || globalThis.fetch);
  const conv = normalizeConversationId(conversation) || String(conversation || "").trim();
  if (!conv) {
    throw new BraveLeoError("conversation id is required", {
      code: ERROR_CODES.INVALID_INPUT,
      retryable: false,
    });
  }

  const jar = toCookieJar(opts.cookieJar ?? opts.cookies);
  const url = buildWithAskUrl(conv, opts.enableInlineEntities !== false);
  const headers = mergeHeaders(
    STREAM_REQUEST_HEADERS,
    opts.referer ? { referer: opts.referer } : null,
    jar.toString() ? { cookie: jar.toString() } : null,
    opts.headers
  );

  const timeout = withTimeout(opts.signal, opts.timeoutMs);
  try {
    let res;
    try {
      res = await fetchImpl(url, { method: "GET", headers, signal: timeout.signal });
    } catch (e) {
      throw classifyError(e, { conversation: conv });
    }
    jar.ingestResponse(res);

    const resHeaders = headersToObject(res.headers);
    if (!res.ok) {
      const body = await readTextBounded(res, opts.maxResponseBytes || DEFAULT_MAX_RESPONSE_BYTES);
      throw httpErrorFor(res, body, conv);
    }

    const state = createStreamState();
    const events = [];
    const includeEvents = opts.includeEvents !== false;
    const onEvent = typeof opts.onEvent === "function" ? opts.onEvent : null;
    const incremental = opts.incremental !== false && !!res.body;
    let streamError = null;

    const consume = async (iterable) => {
      try {
        for await (const ev of iterable) {
          if (includeEvents) events.push(ev);
          applyEvent(state, ev);
          if (onEvent) {
            try {
              onEvent(ev, { ...finalizeState(state), partial: true, conversation: conv });
            } catch (_) {}
          }
        }
      } catch (e) {
        streamError = classifyError(e, { conversation: conv });
        if (!isAbortError(e) && streamError.code !== ERROR_CODES.TIMEOUT) {
          streamError.code = ERROR_CODES.STREAM_ERROR;
        }
        // A truncated stream is retryable when the request is a plain idempotent GET.
        streamError.retryable = streamError.code === ERROR_CODES.TIMEOUT;
      }
    };

    if (incremental) {
      await consume(
        iterateStreamEvents(res, {
          idleTimeoutMs: opts.streamIdleTimeoutMs ?? opts.idleTimeoutMs ?? DEFAULT_STREAM_IDLE_TIMEOUT_MS,
          maxResponseBytes: opts.maxResponseBytes,
        })
      );
    } else {
      const body = await readTextBounded(res, opts.maxResponseBytes || DEFAULT_MAX_RESPONSE_BYTES);
      await consume(
        (async function* () {
          for (const ev of parseEventStream(body)) yield ev;
        })()
      );
    }

    const reduced = finalizeState(state);
    const result = {
      ok: !streamError,
      conversation: conv,
      answer: reduced.answer,
      text: reduced.text,
      answerSource: reduced.answerSource,
      usage: reduced.usage,
      followups: reduced.followups,
      enrichments: reduced.enrichments,
      sources: reduced.sources,
      events: includeEvents ? events : undefined,
      status: res.status,
      headers: resHeaders,
      contentType: (resHeaders["content-type"] || "").toLowerCase(),
      streamFormat: resHeaders["x-stream-format"] || null,
      cookies: jar.toString() || null,
      unparsedEvents: reduced.unparsedEvents,
      streamEventError: reduced.streamEventError,
    };

    if (streamError) {
      result.partial = true;
      result.error = streamError.message;
      result.errorInfo = streamError.toJSON();
      streamError.partialResult = result;
    }
    if (opts.usageTracker && result.usage) {
      try {
        opts.usageTracker.record(result.usage);
      } catch (_) {}
    }
    if (streamError && !opts.allowPartial) throw streamError;
    return result;
  } finally {
    timeout.cleanup();
  }
}

/**
 * `with_ask` with retries/backoff for transient and rate-limit failures.
 */
export async function streamWithAsk(conversation, opts = {}) {
  const retries = Math.max(0, Number(opts.retries ?? 0) || 0);
  return withRetry(
    async () => {
      try {
        return await streamWithAskOnce(conversation, opts);
      } catch (e) {
        throw classifyError(e, { conversation });
      }
    },
    {
      retries,
      signal: opts.signal,
      retryDelayMs: opts.retryDelayMs,
      maxRetryDelayMs: opts.maxRetryDelayMs,
      retryOn: opts.retryOn,
      onRetry: opts.onRetry,
      context: { conversation },
    }
  );
}

/**
 * Async generator over stream events. Breaking out of the loop aborts the
 * in-flight request instead of leaking it.
 */
export async function* braveLeoEventStream(conversation, opts = {}) {
  const queue = [];
  let done = false;
  let final = null;
  let err = null;
  let notify = null;
  const wake = () => {
    if (notify) {
      const n = notify;
      notify = null;
      n();
    }
  };

  const ctrl = new AbortController();
  const outer = opts.signal;
  const onOuterAbort = () => ctrl.abort(outer && outer.reason);
  if (outer) {
    if (outer.aborted) onOuterAbort();
    else outer.addEventListener("abort", onOuterAbort, { once: true });
  }

  const run = streamWithAsk(conversation, {
    ...opts,
    signal: ctrl.signal,
    incremental: true,
    onEvent: (ev, partial) => {
      queue.push({ event: ev, partial });
      wake();
      if (opts.onEvent) {
        try {
          opts.onEvent(ev, partial);
        } catch (_) {}
      }
    },
  })
    .then((r) => {
      final = r;
    })
    .catch((e) => {
      err = e;
    })
    .finally(() => {
      done = true;
      wake();
    });

  try {
    while (!done || queue.length) {
      if (queue.length) {
        yield queue.shift();
        continue;
      }
      await new Promise((resolve) => {
        notify = resolve;
      });
    }
  } finally {
    if (!done) ctrl.abort(Object.assign(new Error("consumer stopped"), { name: "AbortError" }));
    if (outer) outer.removeEventListener("abort", onOuterAbort);
  }

  await run.catch(() => {});
  if (err) throw err;
  return final;
}

/**
 * High-level entry point.
 *
 * - With `conversation`: streams it directly.
 * - Without: best-effort resolves a conversation id for `query` (cookies help).
 * - Never throws for expected failures; returns `{ ok: false, error, errorInfo }`.
 */
export async function braveLeoSearch(input = {}) {
  const {
    query,
    enableInlineEntities = true,
    source = "web",
    fetchImpl,
    headers,
    signal,
    onEvent,
    incremental = true,
    cookies,
    cookieJar,
    includeEvents = true,
    includeCookies = false,
    timeoutMs,
    streamIdleTimeoutMs,
    maxResponseBytes,
    retries = 0,
    retryDelayMs,
    maxRetryDelayMs,
    retryOn,
    onRetry,
    allowPartial = true,
    usageTracker,
  } = input;

  const jar = toCookieJar(cookieJar ?? cookies);
  const warnings = [];
  let conversation =
    normalizeConversationId(input.conversation) ||
    (input.conversation ? String(input.conversation).trim() : null) ||
    null;
  let resolution = null;

  try {
    if (!conversation) {
      if (!query || !String(query).trim()) {
        throw new BraveLeoError("Either 'conversation' or 'query' must be provided", {
          code: ERROR_CODES.INVALID_INPUT,
          retryable: false,
        });
      }
      resolution = await resolveConversation(query, {
        source,
        fetchImpl,
        headers,
        signal,
        cookieJar: jar,
        timeoutMs,
        maxResponseBytes,
      });
      conversation = normalizeConversationId(resolution.conversation);
      if (!conversation) {
        const err = new BraveLeoError(describeResolutionFailure(resolution), {
          code: ERROR_CODES.CONVERSATION_NOT_FOUND,
          retryable: false,
          details: redactResolution(resolution),
        });
        const out = buildAgentResult({
          ok: false,
          query,
          conversation: null,
          resolution,
          error: err,
          includeEvents,
          includeCookies,
          warnings,
        });
        out.errorInfo = err.toJSON();
        return out;
      }
    }

    const searchQuery = query ? String(query) : "";
    const refererParams = new URLSearchParams({ q: searchQuery, source });
    const referer = searchQuery
      ? `${BRAVE_ORIGIN}/search?${refererParams.toString()}&conversation=${conversation}`
      : `${BRAVE_ORIGIN}/search?conversation=${conversation}`;

    const stream = await streamWithAsk(conversation, {
      enableInlineEntities,
      fetchImpl,
      headers,
      referer,
      signal,
      onEvent,
      incremental,
      cookieJar: jar,
      includeEvents,
      timeoutMs,
      streamIdleTimeoutMs,
      maxResponseBytes,
      retries,
      retryDelayMs,
      maxRetryDelayMs,
      retryOn,
      onRetry,
      allowPartial,
      usageTracker,
    });

    if (stream.partial) warnings.push("stream ended early; result is partial");
    if (stream.unparsedEvents) warnings.push(`${stream.unparsedEvents} unparsable stream line(s) were skipped`);
    if (stream.streamEventError) warnings.push("stream reported an error event");

    const built = buildAgentResult({
      ok: stream.ok !== false,
      query,
      conversation,
      resolution,
      stream,
      includeEvents,
      includeCookies,
      warnings,
    });
    if (stream.partial) built.partial = true;
    if (stream.error) built.error = stream.error;
    if (stream.errorInfo) built.errorInfo = stream.errorInfo;
    return built;
  } catch (e) {
    const err = classifyError(e, { conversation });

    // Preserve whatever the stream already produced (callers can opt in).
    if (err.partialResult && allowPartial) {
      const built = buildAgentResult({
        ok: false,
        query,
        conversation: err.partialResult.conversation || conversation,
        resolution,
        stream: err.partialResult,
        error: err,
        includeEvents,
        includeCookies,
        warnings: [...warnings, "stream ended early; result is partial"],
      });
      built.partial = true;
      return built;
    }

    return buildAgentResult({
      ok: false,
      query,
      conversation,
      resolution,
      error: err,
      includeEvents,
      includeCookies,
      warnings,
    });
  }
}

/** Throw on failure, return the structured result on success. */
export async function braveLeoSearchOrThrow(input = {}) {
  const out = await braveLeoSearch(input);
  if (!out.ok) {
    const err = new BraveLeoError(out.error || "braveLeoSearch failed", {
      code: (out.errorInfo && out.errorInfo.code) || ERROR_CODES.INTERNAL_ERROR,
      status: out.status ?? null,
      retryable: !!(out.errorInfo && out.errorInfo.retryable),
      conversation: out.conversation,
    });
    err.result = out;
    throw err;
  }
  return out;
}
