import assert from "node:assert/strict";
import test from "node:test";

import { ObscurifyClient, obscurifyChat, toWireMessages } from "../src/client.js";
import { ERROR_CODES } from "../../../lib/errors.js";
import { parseArgs } from "../src/cli.js";

const THREAD = "thr_13381c6b0ff54a118cad0a66adfcaa15";

function sse(frames, { status = 200, headers = {}, failAfter = null } = {}) {
  const encoder = new TextEncoder();
  let sent = 0;
  const stream = new ReadableStream({
    pull(controller) {
      if (failAfter !== null && sent >= failAfter) {
        controller.error(new Error("socket hang up"));
        return;
      }
      if (sent >= frames.length) {
        controller.close();
        return;
      }
      const frame = frames[sent++];
      controller.enqueue(encoder.encode(frame.endsWith("\n\n") ? frame : `${frame}\n\n`));
    },
  });
  return new Response(stream, {
    status,
    headers: { "content-type": "text/event-stream", ...headers },
  });
}

function json(body, { status = 200 } = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function mockFetch(handler) {
  const calls = [];
  const fn = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    return handler(String(url), init, calls.length);
  };
  fn.calls = calls;
  return fn;
}

const CHUNK = (delta, extra = {}) =>
  `data: ${JSON.stringify({
    id: "chatcmpl-1",
    object: "chat.completion.chunk",
    model: "deepseek/deepseek-v4-flash",
    choices: [{ index: 0, delta, finish_reason: null }],
    ...extra,
  })}`;

function pongStream() {
  return [
    CHUNK({ role: "assistant", content: "", reasoning: "The", reasoning_details: [{ index: 0, type: "reasoning.text", text: "The" }] }),
    CHUNK({ content: "", reasoning: " user wants" }),
    CHUNK({ content: "PO" }),
    CHUNK({ content: "NG" }),
    `data: ${JSON.stringify({
      id: "chatcmpl-1",
      object: "chat.completion.chunk",
      model: "deepseek/deepseek-v4-flash",
      choices: [{ index: 0, delta: { content: "" }, finish_reason: "stop" }],
    })}`,
    `data: ${JSON.stringify({
      id: "chatcmpl-1",
      object: "chat.completion.chunk",
      choices: [],
      usage: { prompt_tokens: 12, completion_tokens: 2, total_tokens: 14 },
    })}`,
    "data: [DONE]",
  ];
}

test("chat assembles reasoning, content, usage and the thread header", async () => {
  const fetchImpl = mockFetch(() => sse(pongStream(), { headers: { "x-obscurify-thread": THREAD } }));
  const res = await obscurifyChat({ prompt: "Reply with exactly: PONG", fetchImpl });

  assert.equal(res.ok, true);
  assert.equal(res.answer, "PONG");
  assert.equal(res.reasoning, "The user wants");
  assert.equal(res.thread, THREAD);
  assert.equal(res.finishReason, "stop");
  assert.equal(res.usage.prompt_tokens, 12);
  assert.equal(res.usage.completion_tokens, 2);
  assert.equal(res.model, "deepseek/deepseek-v4-flash");
  assert.equal(fetchImpl.calls.length, 1);
  assert.equal(fetchImpl.calls[0].url, "https://obscurify.ai/anon/chat/completions");

  const body = JSON.parse(fetchImpl.calls[0].init.body);
  assert.equal(body.model, "deepseek/deepseek-v4-flash");
  assert.equal(body.stream, true);
  assert.deepEqual(body.stream_options, { include_usage: true });
  assert.deepEqual(body.messages, [{ role: "user", content: "Reply with exactly: PONG" }]);
});

test("the thread id is replayed on follow-up turns", async () => {
  const fetchImpl = mockFetch(() => sse(pongStream(), { headers: { "x-obscurify-thread": THREAD } }));
  const client = new ObscurifyClient({ fetchImpl });
  const first = await client.chat({ messages: [{ role: "user", content: "hello" }] });
  assert.equal(first.thread, THREAD);

  await client.chat({
    messages: [
      { role: "user", content: "hello" },
      { role: "assistant", content: "PONG" },
      { role: "user", content: "again" },
    ],
    thread: first.thread,
  });
  const headers = fetchImpl.calls[1].init.headers;
  assert.equal(headers["x-obscurify-thread"], THREAD);
  assert.equal(headers.origin, "https://obscurify.ai");
  assert.match(headers.referer, /obscurify\.ai/);
});

test("model catalog, frontier and uncensored lists are parsed", async () => {
  const fetchImpl = mockFetch((url) => {
    if (url.endsWith("/v1/models")) return json({ object: "list", data: [{ id: "a/b" }] });
    if (url.endsWith("/frontier_models")) return json({ frontier_models: ["a/b"] });
    return json({ uncensored_models: ["*uncensor*"] });
  });
  const client = new ObscurifyClient({ fetchImpl });
  assert.deepEqual(await client.listModels(), [{ id: "a/b" }]);
  assert.deepEqual(await client.listModels({ kind: "frontier" }), ["a/b"]);
  assert.deepEqual(await client.listModels({ kind: "uncensored" }), ["*uncensor*"]);
  assert.equal(fetchImpl.calls.length, 3);
});

test("code_mode configuration is returned verbatim", async () => {
  const fetchImpl = mockFetch(() => json({ enabled: true, direct_tools: [] }));
  const client = new ObscurifyClient({ fetchImpl });
  const config = await client.codeMode();
  assert.equal(config.enabled, true);
  assert.deepEqual(config.direct_tools, []);
});

test("429 is retried and Retry-After is honoured", async () => {
  let calls = 0;
  const fetchImpl = mockFetch(() => {
    calls += 1;
    if (calls === 1) {
      return new Response("slow down", { status: 429, headers: { "retry-after": "0" } });
    }
    return sse(pongStream(), { headers: { "x-obscurify-thread": THREAD } });
  });
  const retries = [];
  const client = new ObscurifyClient({ fetchImpl, retries: 1 });
  const res = await client.chat({ messages: [{ role: "user", content: "hi" }], onRetry: (info) => retries.push(info) });
  assert.equal(res.ok, true);
  assert.equal(calls, 2);
  assert.equal(retries.length, 1);
  assert.equal(retries[0].error.code, ERROR_CODES.RATE_LIMITED);
});

test("403 is classified and not retried", async () => {
  const fetchImpl = mockFetch(() => new Response("blocked", { status: 403 }));
  const res = await obscurifyChat({ prompt: "hi", fetchImpl, retries: 3 });
  assert.equal(res.ok, false);
  assert.equal(res.errorInfo.code, ERROR_CODES.FORBIDDEN);
  assert.equal(res.errorInfo.retryable, false);
  assert.equal(fetchImpl.calls.length, 1);
});

test("failure after partial output is reported as partial", async () => {
  const fetchImpl = mockFetch(() => sse(pongStream().slice(0, 4), { failAfter: 4 }));
  const res = await obscurifyChat({ prompt: "hi", fetchImpl });
  assert.equal(res.ok, false);
  assert.equal(res.partial, true);
  assert.equal(res.answer, "PONG");
  assert.equal(res.errorInfo.code, ERROR_CODES.STREAM_ERROR);
  assert.ok(res.warnings.some((w) => /partial/.test(w)));
});

test("allowPartial=false drops the buffered answer", async () => {
  const fetchImpl = mockFetch(() => sse(pongStream().slice(0, 4), { failAfter: 4 }));
  const res = await obscurifyChat({ prompt: "hi", fetchImpl, allowPartial: false });
  assert.equal(res.ok, false);
  assert.equal(res.answer, "");
});

test("non-stream JSON responses are normalized into one delta", async () => {
  const fetchImpl = mockFetch(() =>
    json({
      model: "deepseek/deepseek-v4-flash",
      choices: [{ message: { role: "assistant", content: "PONG" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 },
    })
  );
  const res = await obscurifyChat({ prompt: "hi", fetchImpl, stream: false });
  assert.equal(res.ok, true);
  assert.equal(res.answer, "PONG");
  assert.equal(res.usage.total_tokens, 7);
});

test("tool-call deltas are surfaced as events", async () => {
  const fetchImpl = mockFetch(() =>
    sse([
      `data: ${JSON.stringify({
        choices: [
          {
            index: 0,
            delta: { tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "web_search", arguments: "{}" } }] },
            finish_reason: "tool_calls",
          },
        ],
      })}`,
      "data: [DONE]",
    ])
  );
  const res = await obscurifyChat({ prompt: "search", fetchImpl });
  assert.equal(res.ok, true);
  assert.equal(res.toolCalls.length, 1);
  assert.equal(res.toolCalls[0].function.name, "web_search");
  assert.equal(res.finishReason, "tool_calls");
});

test("structured content is opt-out", async () => {
  assert.deepEqual(toWireMessages([{ role: "user", content: "hi" }], { structuredContent: true }), [
    { role: "user", content: [{ type: "text", text: "hi" }] },
  ]);
  assert.deepEqual(toWireMessages([{ role: "user", content: "hi" }]), [{ role: "user", content: "hi" }]);
});

test("parseArgs handles models, messages and numeric validation", () => {
  const args = parseArgs([
    "Reply with PONG",
    "--model",
    "x/y",
    "--message",
    "system=be brief",
    "--temperature",
    "0.2",
    "--max-tokens",
    "64",
    "--json",
  ]);
  assert.equal(args.prompt, "Reply with PONG");
  assert.equal(args.model, "x/y");
  assert.deepEqual(args.messages, [{ role: "system", content: "be brief" }]);
  assert.equal(args.temperature, 0.2);
  assert.equal(args.maxTokens, 64);
  assert.equal(args.json, true);
  assert.throws(() => parseArgs(["--retries", "-1"]), /non-negative/);
  assert.throws(() => parseArgs(["--bogus"]), /unknown option/);
});
