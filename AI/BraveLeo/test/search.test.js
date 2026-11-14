import assert from "node:assert/strict";
import test from "node:test";

import {
  braveLeoSearch,
  braveLeoSearchOrThrow,
  braveLeoEventStream,
  streamWithAsk,
} from "../src/search.js";
import { ERROR_CODES } from "../src/errors.js";
import { BraveLeoClient } from "../src/client.js";
import {
  CONVERSATION,
  PONG_STREAM,
  hangUntilAborted,
  mockFetch,
  searchPageHtml,
  streamResponse,
  textResponse,
} from "./helpers.js";

const answerStream = () => streamResponse(PONG_STREAM, { headers: { "x-stream-format": "tap" } });

test("braveLeoSearch resolves a conversation then streams the answer", async () => {
  const fetchImpl = mockFetch((url) =>
    url.includes("with_ask") ? answerStream() : textResponse(searchPageHtml())
  );

  const res = await braveLeoSearch({ query: "Reply with exactly: PONG", fetchImpl });

  assert.equal(res.ok, true);
  assert.equal(res.answer, "**PONG**");
  assert.equal(res.conversation, CONVERSATION);
  assert.equal(res.answerSource, "enrichments.raw_response");
  assert.equal(res.usage.completion_tokens, 4);
  assert.equal(res.meta.streamFormat, "tap");
  assert.equal(res.meta.cookies, undefined, "cookies must not leak into results by default");
  assert.equal(fetchImpl.calls.length, 2);
  assert.match(fetchImpl.calls[1].url, /api\/chatllm\/with_ask\?conversation=/);
});

test("braveLeoSearch streams a known conversation directly", async () => {
  const fetchImpl = mockFetch(() => answerStream());
  const events = [];
  const res = await braveLeoSearch({
    conversation: CONVERSATION,
    fetchImpl,
    onEvent: (ev) => events.push(ev.type),
  });
  assert.equal(res.ok, true);
  assert.deepEqual(events.slice(0, 2), ["text_start", "text_delta"]);
  assert.equal(fetchImpl.calls.length, 1);
});

test("rates limits are retried and Retry-After is honoured", async () => {
  let calls = 0;
  const fetchImpl = mockFetch(() => {
    calls += 1;
    if (calls === 1) return textResponse("slow down", { status: 429, headers: { "retry-after": "0" } });
    return answerStream();
  });
  const retries = [];
  const res = await braveLeoSearch({
    conversation: CONVERSATION,
    fetchImpl,
    retries: 2,
    onRetry: (info) => retries.push(info),
  });
  assert.equal(res.ok, true);
  assert.equal(calls, 2);
  assert.equal(retries.length, 1);
  assert.equal(retries[0].error.code, ERROR_CODES.RATE_LIMITED);
});

test("403 is classified as BLOCKED and is not retried", async () => {
  const fetchImpl = mockFetch(() => textResponse("challenge", { status: 403 }));
  let attempts = 0;
  const res = await braveLeoSearch({
    conversation: CONVERSATION,
    fetchImpl,
    retries: 3,
    onRetry: () => attempts++,
  });
  assert.equal(res.ok, false);
  assert.equal(res.errorInfo.code, ERROR_CODES.BLOCKED);
  assert.equal(res.errorInfo.retryable, false);
  assert.match(res.errorInfo.hint, /automated traffic/i);
  assert.equal(fetchImpl.calls.length, 1);
  assert.equal(attempts, 0);
});

test("422 on a malformed conversation is CONVERSATION_INVALID", async () => {
  const fetchImpl = mockFetch(() => textResponse("bad id", { status: 422 }));
  const res = await braveLeoSearch({ conversation: CONVERSATION, fetchImpl });
  assert.equal(res.errorInfo.code, ERROR_CODES.CONVERSATION_INVALID);
  assert.equal(res.errorInfo.status, 422);
});

test("timeouts surface as TIMEOUT with retry metadata", async () => {
  const res = await braveLeoSearch({ conversation: CONVERSATION, fetchImpl: hangUntilAborted, timeoutMs: 20 });
  assert.equal(res.ok, false);
  assert.equal(res.errorInfo.code, ERROR_CODES.TIMEOUT);
  assert.equal(res.errorInfo.retryable, true);
});

test("a stream that dies mid-way is reported as partial", async () => {
  const fetchImpl = mockFetch(() => streamResponse([PONG_STREAM[0], PONG_STREAM[1]], { failAt: 2 }));
  const res = await braveLeoSearch({ conversation: CONVERSATION, fetchImpl });
  assert.equal(res.ok, false);
  assert.equal(res.partial, true);
  assert.equal(res.errorInfo.code, ERROR_CODES.STREAM_ERROR);
  assert.ok(res.warnings.some((w) => /partial/.test(w)));
});

test("allowPartial=false drops partial output instead of returning it", async () => {
  const fetchImpl = mockFetch(() => streamResponse([PONG_STREAM[1]], { failAt: 1 }));
  const res = await braveLeoSearch({ conversation: CONVERSATION, fetchImpl, allowPartial: false });
  assert.equal(res.ok, false);
  assert.equal(res.answer, "");
  assert.equal(res.errorInfo.code, ERROR_CODES.STREAM_ERROR);
});

test("a stalled stream aborts via streamIdleTimeoutMs", async () => {
  const fetchImpl = mockFetch(() => streamResponse([PONG_STREAM[1]], { stallAt: 1 }));
  const started = Date.now();
  const res = await braveLeoSearch({ conversation: CONVERSATION, fetchImpl, streamIdleTimeoutMs: 30 });
  assert.equal(res.ok, false);
  assert.equal(res.partial, true);
  assert.equal(res.answer, "*");
  assert.equal(res.answerSource, "text_delta");
  assert.ok(Date.now() - started < 2000, "idle timeout should fire quickly");
});

test("failed resolution explains attempts instead of guessing", async () => {
  const fetchImpl = mockFetch(() => textResponse("unusual traffic", { status: 429 }));
  const res = await braveLeoSearch({ query: "anything", fetchImpl });
  assert.equal(res.ok, false);
  assert.equal(res.errorInfo.code, ERROR_CODES.CONVERSATION_NOT_FOUND);
  assert.equal(res.resolution.attempts.length, 3);
  assert.match(res.error, /Attempts — search:429/);
  assert.match(res.error, /anti-bot|automated traffic/i);
  assert.equal(res.errorInfo.details.cookies, undefined, "cookie header must be redacted from diagnostics");
});

test("missing query and conversation is INVALID_INPUT", async () => {
  const res = await braveLeoSearch({});
  assert.equal(res.ok, false);
  assert.equal(res.errorInfo.code, ERROR_CODES.INVALID_INPUT);
});

test("includeCookies opts the session cookie into the result", async () => {
  const fetchImpl = mockFetch((url) =>
    url.includes("with_ask") ? answerStream() : textResponse(searchPageHtml())
  );
  const res = await braveLeoSearch({
    query: "hi",
    fetchImpl,
    cookies: "sid=secret",
    includeCookies: true,
  });
  assert.equal(res.meta.cookies, "sid=secret");
  assert.equal(res.meta.resolution.cookies, "sid=secret");
});

test("resolution cookies stay out of results by default", async () => {
  const fetchImpl = mockFetch((url) =>
    url.includes("with_ask") ? answerStream() : textResponse(searchPageHtml())
  );
  const res = await braveLeoSearch({ query: "hi", fetchImpl, cookies: "sid=secret" });
  assert.equal(res.ok, true);
  assert.equal(res.meta.cookies, undefined);
  assert.equal(res.meta.resolution.cookies, undefined);
  assert.equal(res.resolution.attempts.length, 1);
});

test("streamWithAsk exposes cookie state and records usage", async () => {
  const tracker = new BraveLeoClient({ fetchImpl: mockFetch(() => answerStream()) }).usageTracker;
  const out = await streamWithAsk(CONVERSATION, {
    fetchImpl: mockFetch(() => answerStream()),
    usageTracker: tracker,
  });
  assert.equal(out.ok, true);
  assert.equal(tracker.snapshot().requests, 1);
  assert.equal(tracker.snapshot().total_tokens, 11181);
});

test("braveLeoSearchOrThrow throws a BraveLeoError with the result attached", async () => {
  const fetchImpl = mockFetch(() => textResponse("", { status: 403 }));
  await assert.rejects(
    () => braveLeoSearchOrThrow({ conversation: CONVERSATION, fetchImpl }),
    (err) => err.name === "BraveLeoError" && err.code === ERROR_CODES.BLOCKED && err.result.ok === false
  );
});

test("braveLeoEventStream yields events and finalizes", async () => {
  const fetchImpl = mockFetch(() => answerStream());
  const collected = [];
  const gen = braveLeoEventStream(CONVERSATION, { fetchImpl });
  for await (const { event } of gen) collected.push(event.type);
  assert.deepEqual(collected, [
    "text_start",
    "text_delta",
    "text_delta",
    "text_stop",
    "usage",
    "followups",
    "enrichments",
  ]);
});

test("BraveLeoClient caches resolved conversations per query", async () => {
  let searchHits = 0;
  const fetchImpl = mockFetch((url) => {
    if (url.includes("with_ask")) return answerStream();
    searchHits += 1;
    return textResponse(searchPageHtml());
  });
  const client = new BraveLeoClient({ fetchImpl });
  const first = await client.ask({ query: "same query" });
  const second = await client.ask({ query: "same query" });
  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  assert.equal(searchHits, 1, "second ask must reuse the cached conversation");
  assert.equal(client.getUsage().requests, 2);
  assert.deepEqual(Object.keys(client.exportState().conversations), ["web\u0000same query"]);
});
