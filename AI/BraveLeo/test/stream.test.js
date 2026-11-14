import assert from "node:assert/strict";
import test from "node:test";

import { CookieJar, headersToObject, mergeHeaders, readTextBounded } from "../src/http.js";
import { CONVERSATION_ID_RE } from "../src/constants.js";
import { parseLine, StreamParser, applyEvent, createStreamState, extractSources, reduceEvents, finalizeState } from "../src/stream.js";
import { PONG_STREAM, streamResponse, textResponse } from "./helpers.js";

test("CookieJar parses, merges and serializes cookies", () => {
  const jar = new CookieJar("a=1; b=2");
  assert.equal(jar.size, 2);
  jar.addSetCookie(["c=3; Path=/; HttpOnly", "d=4; Secure"]);
  assert.equal(jar.toString(), "a=1; b=2; c=3; d=4");
  jar.addCookieHeader("a=9");
  assert.equal(jar.toString(), "a=9; b=2; c=3; d=4");
  assert.equal(jar.clone().toString(), jar.toString());
});

test("CookieJar ingests a Response set-cookie header", () => {
  const jar = new CookieJar();
  const res = textResponse("", { headers: { "set-cookie": "sid=abc; Path=/" } });
  jar.ingestResponse(res);
  assert.equal(jar.toString(), "sid=abc");
});

test("headersToObject/mergeHeaders normalize case and drop nullish", () => {
  const res = new Response("", { headers: { "X-Stream-Format": "tap" } });
  assert.equal(headersToObject(res.headers)["x-stream-format"], "tap");
  assert.deepEqual(mergeHeaders({ A: "1" }, { a: "2", b: null }, new Headers({ C: "3" })), {
    a: "2",
    c: "3",
  });
});

test("readTextBounded fails closed on oversized bodies", async () => {
  const res = streamResponse(["a".repeat(64), "b".repeat(64)]);
  await assert.rejects(() => readTextBounded(res, 100), /exceeded 100 bytes/);
});

test("StreamParser handles TAP lines split across chunks", () => {
  const parser = new StreamParser();
  assert.deepEqual(parser.push('{"type":"text_del'), []);
  const events = parser.push('ta","delta":"hi"}\n');
  assert.deepEqual(events, [{ type: "text_delta", delta: "hi" }]);
});

test("StreamParser handles SSE framing, comments and [DONE]", () => {
  const parser = new StreamParser();
  const events = [
    ...parser.push(": heartbeat\n\n"),
    ...parser.push('event: text_delta\ndata: {"type":"text_delta","delta":"a"}\n\n'),
    ...parser.push('data: {"type":"text_delta",\ndata: "delta":"b"}\n\n'),
    ...parser.push("data: [DONE]\n\n"),
  ];
  assert.deepEqual(events, [
    { type: "text_delta", delta: "a" },
    { type: "text_delta", delta: "b" },
  ]);
  assert.equal(parser.done, true);
});

test("StreamParser flushes a trailing line without newline", () => {
  const parser = new StreamParser();
  assert.deepEqual(parser.push('{"type":"text_stop","text":"x"}'), []);
  assert.deepEqual(parser.end(), [{ type: "text_stop", text: "x" }]);
});

test("StreamParser surfaces unparsable lines instead of throwing", () => {
  const events = new StreamParser().push("<html>bad gateway</html>\n");
  assert.equal(events.length, 1);
  assert.equal(events[0].type, "unparsed");
});

test("parseLine drops blank lines and [DONE]", () => {
  assert.equal(parseLine("   "), null);
  assert.equal(parseLine("data: [DONE]"), null);
  assert.deepEqual(parseLine('data: {"type":"usage"}'), { type: "usage" });
});

test("reduceEvents prefers enrichments.raw_response and dedupes citations", () => {
  const out = reduceEvents(PONG_STREAM.join("").split("\n").filter(Boolean).map((l) => JSON.parse(l)));
  assert.equal(out.answer, "**PONG**");
  assert.equal(out.answerSource, "enrichments.raw_response");
  assert.equal(out.usage.completion_tokens, 4);
  assert.deepEqual(
    out.sources.citations.map((c) => c.url),
    ["https://example.com/a", "https://example.com/b"]
  );
  assert.deepEqual(out.sources.all_urls, ["https://example.com/a", "https://example.com/b"]);
  assert.equal(out.started, true);
  assert.equal(out.stopped, true);
});

test("finalizeState falls back to text_stop then deltas", () => {
  const stop = createStreamState();
  applyEvent(stop, { type: "text_stop", text: "final" });
  assert.equal(finalizeState(stop).answerSource, "text_stop");

  const deltas = createStreamState();
  applyEvent(deltas, { type: "text_delta", delta: "a" });
  applyEvent(deltas, { type: "text_delta", delta: "b" });
  const out = finalizeState(deltas);
  assert.equal(out.answer, "ab");
  assert.equal(out.answerSource, "text_delta");
});

test("applyEvent records stream error events without discarding state", () => {
  const state = createStreamState();
  applyEvent(state, { type: "text_delta", delta: "partial" });
  applyEvent(state, { type: "error", message: "boom" });
  applyEvent(state, { type: "unparsed", raw: "x" });
  const out = finalizeState(state);
  assert.equal(out.answer, "partial");
  assert.equal(out.streamEventError.message, "boom");
  assert.equal(out.unparsedEvents, 1);
});

test("extractSources tolerates missing/odd enrichments", () => {
  assert.deepEqual(extractSources(null).citations, []);
  const src = extractSources({ references: ["https://x.test/1", { title: "T", url: "https://x.test/1" }], context_urls: ["https://x.test/2"] });
  assert.equal(src.citations.length, 2);
  assert.deepEqual(src.all_urls, ["https://x.test/2", "https://x.test/1", "https://x.test/1"].filter((u, i, a) => a.indexOf(u) === i));
});

test("conversation id regex accepts the observed 38-char id", () => {
  assert.match("09cc2f976f305994544a43e9f83b649a8e02", CONVERSATION_ID_RE);
});
