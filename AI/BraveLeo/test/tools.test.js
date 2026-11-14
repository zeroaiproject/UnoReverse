import assert from "node:assert/strict";
import test from "node:test";

import {
  BRAVE_LEO_TOOL,
  BRAVE_LEO_TOOL_ANTHROPIC,
  TOOL_NAME,
  TOOL_SYSTEM_HINT,
  executeToolCall,
  normalizeToolArgs,
  toToolResultMessage,
} from "../src/tools.js";
import { compactResult, formatResultAsText, makeToolPayload } from "../src/result.js";
import { parseArgs } from "../src/cli.js";
import {
  CONVERSATION,
  PONG_STREAM,
  mockFetch,
  streamResponse,
  textResponse,
} from "./helpers.js";

const answerStream = () => streamResponse(PONG_STREAM);

test("tool schemas are consistent across providers", () => {
  assert.equal(BRAVE_LEO_TOOL.function.name, TOOL_NAME);
  assert.equal(BRAVE_LEO_TOOL_ANTHROPIC.name, TOOL_NAME);
  assert.deepEqual(BRAVE_LEO_TOOL.function.parameters, BRAVE_LEO_TOOL_ANTHROPIC.input_schema);
  assert.match(TOOL_SYSTEM_HINT, new RegExp(TOOL_NAME));
});

test("normalizeToolArgs accepts every common agent shape", () => {
  assert.deepEqual(normalizeToolArgs('{"query":"x"}'), { query: "x" });
  assert.deepEqual(normalizeToolArgs({ function: { name: TOOL_NAME, arguments: '{"query":"y"}' } }), { query: "y" });
  assert.deepEqual(normalizeToolArgs({ arguments: { query: "z" } }), { query: "z" });
  assert.deepEqual(normalizeToolArgs({ name: TOOL_NAME, query: "q" }), { name: TOOL_NAME, query: "q" });
  assert.deepEqual(normalizeToolArgs("not json"), { query: "not json" });
});

test("executeToolCall dispatches OpenAI-style calls and returns JSON by default", async () => {
  const fetchImpl = mockFetch(() => answerStream());
  const raw = await executeToolCall(
    { id: "call_1", type: "function", function: { name: TOOL_NAME, arguments: JSON.stringify({ query: "hi" }) } },
    { defaults: { conversation: CONVERSATION, fetchImpl } }
  );
  const payload = JSON.parse(raw);
  assert.equal(payload.ok, true);
  assert.equal(payload.answer, "**PONG**");
  assert.equal(payload.content.includes("**PONG**"), true);
  assert.equal(payload.events, undefined, "compact payloads must not carry raw events");
});

test("executeToolCall rejects unknown tools", async () => {
  const raw = await executeToolCall({ name: "other_tool", args: {} });
  const payload = JSON.parse(raw);
  assert.equal(payload.ok, false);
  assert.equal(payload.errorInfo.code, "UNKNOWN_TOOL");
  assert.equal(payload.expected, TOOL_NAME);
});

test("executeToolCall can return text or an object", async () => {
  const fetchImpl = mockFetch(() => answerStream());
  const text = await executeToolCall(
    { query: "hi", format: "text" },
    { defaults: { conversation: CONVERSATION, fetchImpl } }
  );
  assert.equal(typeof text, "string");
  assert.match(text, /\*\*PONG\*\*/);

  const obj = await executeToolCall(
    { query: "hi" },
    { asObject: true, defaults: { conversation: CONVERSATION, fetchImpl, includeCookies: false } }
  );
  assert.equal(obj.ok, true);
  assert.equal(obj.conversation, CONVERSATION);
});

test("toToolResultMessage builds OpenAI tool messages with or without an id", () => {
  const withId = toToolResultMessage({ id: "call_9" }, { ok: true, answer: "a" });
  assert.equal(withId.role, "tool");
  assert.equal(withId.tool_call_id, "call_9");
  assert.equal(withId.name, TOOL_NAME);
  assert.equal(JSON.parse(withId.content).answer, "a");

  const withoutId = toToolResultMessage(null, "raw");
  assert.equal(withoutId.content, "raw");
});

test("compactResult bounds sources and drops heavy fields", () => {
  const result = {
    ok: true,
    query: "q",
    answer: "a",
    followups: ["1", "2", "3", "4", "5", "6"],
    sources: { citations: Array.from({ length: 20 }, (_, i) => ({ url: `https://x.test/${i}` })), all_urls: [] },
    events: [{ big: true }],
    meta: { status: 200, cookies: "sid=secret" },
  };
  const compact = compactResult(result, { maxSources: 3, maxFollowups: 2 });
  assert.equal(compact.citations.length, 3);
  assert.equal(compact.followups.length, 2);
  assert.equal(compact.events, undefined);
  assert.equal(compact.meta, undefined);
  assert.equal(compact.status, 200);
});

test("formatResultAsText renders answer, sources and follow-ups", () => {
  const text = formatResultAsText({
    ok: true,
    answer: "Answer body",
    sources: { citations: [{ url: "https://x.test/1", title: "One", snippet: "snip" }], all_urls: [] },
    followups: ["Why?"],
  });
  assert.match(text, /Answer body/);
  assert.match(text, /1\. One — https:\/\/x\.test\/1/);
  assert.match(text, /- Why\?/);
  assert.equal(formatResultAsText({ ok: false, error: "nope" }), "Error: nope");
});

test("makeToolPayload exposes structured fields and content", () => {
  const payload = makeToolPayload({ ok: true, answer: "a", sources: {} });
  assert.equal(payload.answer, "a");
  assert.equal(typeof payload.content, "string");
});

test("parseArgs handles flags, aliases and env defaults", () => {
  const args = parseArgs(["latest", "node", "lts", "--json", "--retries", "2", "--no-inline-entities"], {});
  assert.equal(args.query, "latest node lts");
  assert.equal(args.json, true);
  assert.equal(args.retries, 2);
  assert.equal(args.noEntities, true);

  const env = parseArgs([], { BRAVE_CONVERSATION: CONVERSATION, BRAVE_COOKIES: "a=1", BRAVE_TIMEOUT_MS: "1234" });
  assert.equal(env.conversation, CONVERSATION);
  assert.equal(env.cookies, "a=1");
  assert.equal(env.timeoutMs, 1234);

  assert.throws(() => parseArgs(["--timeout", "abc"]), /positive integer/);
  assert.throws(() => parseArgs(["--nope"]), /unknown option/);
  assert.throws(() => parseArgs(["--query"]), /missing value/);
});

test("CLI usage errors exit 2", async () => {
  const { main } = await import("../src/cli.js");
  assert.equal(await main(["--bogus"]), 2);
  assert.equal(await main([]), 2);
  assert.equal(await main(["--version"]), 0);
});
