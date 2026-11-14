import assert from "node:assert/strict";
import test from "node:test";

import { ChatGPTClient, chatGPTChat, contentText } from "../src/client.js";
import { ERROR_CODES } from "../../../lib/errors.js";
import { parseArgs } from "../src/cli.js";

function ndjson(lines, { status = 200, headers = {} } = {}) {
  const body = lines.map((l) => `${typeof l === "string" ? l : JSON.stringify(l)}\n`).join("");
  return new Response(body, {
    status,
    headers: { "content-type": "application/vnd.openai.conversation-source+ndjson", ...headers },
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
    calls.push({ url: String(url), init: { ...init, headers: init.headers || {} } });
    return handler(String(url), init, calls.length);
  };
  fn.calls = calls;
  return fn;
}

const TOKENS = { chatRequirementsToken: "req", proofToken: "proof", turnstileToken: "turn" };

function conversationStream(text = "PONG", conversationId = "conv-123") {
  return [
    { version: 2, type: "control", detail: { kind: "started", operationId: "op1", streamType: "initial" } },
    {
      version: 2,
      type: "control",
      detail: { kind: "conversation-id", operationId: "op1", streamType: "initial", conversationId, canonicalPath: `/c/${conversationId}` },
      stopConduitToken: "stop.jwt",
    },
    { version: 2, type: "control", detail: { kind: "resume-token", resumeToken: "resume.jwt", operationId: "op1" } },
    {
      version: 2,
      type: "content",
      messageId: "m1",
      revision: 1,
      mode: "replace",
      markdown: "",
      status: "streaming",
      dil: { kind: "dil", fallbackMarkdown: text },
    },
    {
      version: 2,
      type: "content",
      messageId: "m1",
      revision: 2,
      mode: "append",
      baseRevision: 1,
      markdown: "",
      status: "complete",
    },
    {
      version: 2,
      type: "state",
      conversationState: JSON.stringify({ backendConversationId: conversationId, messages: [], parentMessageId: "m1", userMessageCount: 1 }),
      safety: { dismissedInterventionIds: [] },
    },
    { version: 2, type: "control", detail: { kind: "terminal-received", terminalKind: "complete", transportOnly: true, operationId: "op1" } },
    { version: 2, type: "end" },
  ];
}

test("chat runs prepare then streams NDJSON frames into an answer", async () => {
  const fetchImpl = mockFetch((url) => {
    if (url.includes("/conversation/prepare")) return json({ conduit_token: "conduit.jwt", prepare_cadence_enabled: true });
    if (url.includes("/conversation/updates")) return ndjson(conversationStream("PONG"));
    throw new Error(`unexpected ${url}`);
  });
  const res = await chatGPTChat({ prompt: "Reply with exactly: PONG", tokens: TOKENS, fetchImpl, sessionId: "sess-1" });
  assert.equal(res.ok, true, JSON.stringify(res.errorInfo));
  assert.equal(res.answer, "PONG");
  assert.equal(res.conversationId, "conv-123");
  assert.equal(res.sessionId, "sess-1");
  assert.equal(res.conversationState.backendConversationId, "conv-123");

  assert.equal(fetchImpl.calls.length, 2);
  assert.match(fetchImpl.calls[0].url, /conversation\/prepare\?lightweight_authenticated=0/);
  assert.match(fetchImpl.calls[1].url, /conversation\/updates\?lightweight_authenticated=0&operationId=/);

  const prepareBody = fetchImpl.calls[0].init.body;
  assert.match(prepareBody, /conversationState=/);
  assert.match(prepareBody, /timezone=UTC/);

  const submitBody = fetchImpl.calls[1].init.body;
  assert.match(submitBody, /prompt=Reply\+with\+exactly%3A\+PONG/);
  assert.match(submitBody, /chatRequirementsToken=req/);
  assert.match(submitBody, /proofToken=proof/);
  assert.match(submitBody, /turnstileToken=turn/);
  assert.match(submitBody, /oai-session-id=sess-1/);
});

test("streaming replace+append deltas build the answer incrementally", async () => {
  const fetchImpl = mockFetch((url) => {
    if (url.includes("/conversation/prepare")) return json({ conduit_token: "c" });
    return ndjson([
      { version: 2, type: "content", messageId: "m1", mode: "replace", markdown: "PO" },
      { version: 2, type: "content", messageId: "m1", mode: "append", markdown: "NG" },
      { version: 2, type: "content", messageId: "m1", mode: "replace", markdown: "PONG!" },
      { version: 2, type: "end" },
    ]);
  });
  const events = [];
  const res = await chatGPTChat({ prompt: "hi", tokens: TOKENS, fetchImpl, onEvent: (e) => events.push(e) });
  assert.equal(res.ok, true);
  assert.equal(res.answer, "PONG!");
  const deltas = events.filter((e) => e.type === "text_delta").map((e) => e.delta);
  const replaces = events.filter((e) => e.type === "text_replace").map((e) => e.text);
  assert.deepEqual(deltas, ["NG"]);
  assert.deepEqual(replaces, ["PO", "PONG!"]);
});

test("getRequirements hook receives context and supplies missing tokens", async () => {
  let hookContext = null;
  const fetchImpl = mockFetch((url) => {
    if (url.includes("/conversation/prepare")) return json({ conduit_token: "c.jwt" });
    return ndjson(conversationStream("OK", "conv-hook"));
  });
  const client = new ChatGPTClient({
    fetchImpl,
    prepare: true,
    getRequirements: async (ctx) => {
      hookContext = ctx;
      return { chatRequirementsToken: "r", proofToken: "p", turnstileToken: "t" };
    },
  });
  const res = await client.chat({ prompt: "hi" });
  assert.equal(res.ok, true);
  assert.equal(res.answer, "OK");
  assert.ok(hookContext);
  assert.equal(hookContext.prompt, "hi");
  assert.equal(hookContext.conversationPrepare.conduit_token, "c.jwt");
  assert.deepEqual(hookContext.missing.sort(), ["chatRequirementsToken", "proofToken", "turnstileToken"].sort());

  const submitBody = fetchImpl.calls[1].init.body;
  assert.match(submitBody, /chatRequirementsToken=r/);
});

test("missing anti-abuse tokens fail with a clear hint unless allowed", async () => {
  const fetchImpl = mockFetch((url) => {
    if (url.includes("/conversation/prepare")) return json({ conduit_token: "c" });
    return ndjson(conversationStream());
  });
  const res = await chatGPTChat({ prompt: "hi", tokens: {}, fetchImpl, prepare: false });
  assert.equal(res.ok, false);
  assert.equal(res.errorInfo.code, ERROR_CODES.INVALID_INPUT);
  assert.match(res.errorInfo.message, /chatRequirementsToken/);
  assert.match(res.errorInfo.hint, /getRequirements|browser/i);
  assert.equal(fetchImpl.calls.length, 0, "should not submit without required tokens");
});

test("allowMissingTokens submits with empty token fields when explicitly allowed", async () => {
  const fetchImpl = mockFetch((url) => {
    if (url.includes("/conversation/prepare")) return json({ conduit_token: "c" });
    return ndjson(conversationStream("OK"));
  });
  const res = await chatGPTChat({ prompt: "hi", tokens: {}, fetchImpl, allowMissingTokens: true });
  assert.equal(res.ok, true);
  const submitBody = fetchImpl.calls.at(-1).init.body;
  assert.match(submitBody, /chatRequirementsToken=&/);
  assert.match(submitBody, /proofToken=&/);
});

test("sentinel prepare/finalize run when sentinelP is supplied", async () => {
  const fetchImpl = mockFetch((url) => {
    if (url.includes("/conversation/prepare")) return json({ conduit_token: "c" });
    if (url.includes("/sentinel/chat-requirements/prepare")) return json({ persona: "chatgpt-noauth", prepare_token: "ptok" });
    if (url.includes("/sentinel/chat-requirements/finalize")) return json({ ok: true });
    if (url.includes("/conversation/updates")) return ndjson(conversationStream("OK"));
    throw new Error(`unexpected ${url}`);
  });
  const res = await chatGPTChat({ prompt: "hi", tokens: TOKENS, sentinelP: "opaque-p", fetchImpl });
  assert.equal(res.ok, true);
  const urls = fetchImpl.calls.map((c) => c.url);
  assert.ok(urls.some((u) => u.includes("/sentinel/chat-requirements/prepare")));
  assert.ok(urls.some((u) => u.includes("/sentinel/chat-requirements/finalize")));
  const prepCall = fetchImpl.calls.find((c) => c.url.includes("/sentinel/chat-requirements/prepare"));
  assert.deepEqual(JSON.parse(prepCall.init.body), { p: "opaque-p" });
});

test("submit 403/429 is classified and retried only at the transport layer hooks we control", async () => {
  const fetchImpl = mockFetch((url) => {
    if (url.includes("/conversation/prepare")) return json({ conduit_token: "c" });
    return new Response("blocked", { status: 403 });
  });
  const res = await chatGPTChat({ prompt: "hi", tokens: TOKENS, fetchImpl, retries: 2 });
  assert.equal(res.ok, false);
  assert.equal(res.errorInfo.code, ERROR_CODES.FORBIDDEN);
  assert.equal(fetchImpl.calls.length, 2);
});

test("contentText prefers markdown, falls back to DIL fallbackMarkdown", () => {
  assert.equal(contentText({ type: "content", markdown: "hello", dil: { fallbackMarkdown: "alt" } }), "hello");
  assert.equal(contentText({ type: "content", markdown: "", dil: { fallbackMarkdown: "alt" } }), "alt");
  assert.equal(contentText({ type: "content", markdown: "", dil: null }), "");
});

test("parseArgs collects tokens and flags", () => {
  const args = parseArgs([
    "hi",
    "--session-id",
    "s1",
    "--requirements-token",
    "r",
    "--proof-token",
    "p",
    "--turnstile-token",
    "t",
    "--sentinel-p",
    "blob",
    "--allow-missing-tokens",
    "--json",
  ]);
  assert.equal(args.prompt, "hi");
  assert.equal(args.sessionId, "s1");
  assert.equal(args.tokens.chatRequirementsToken, "r");
  assert.equal(args.sentinelP, "blob");
  assert.equal(args.allowMissingTokens, true);
  assert.equal(args.json, true);
  assert.throws(() => parseArgs(["--bogus"]), /unknown option/);
});
