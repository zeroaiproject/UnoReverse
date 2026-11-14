import assert from "node:assert/strict";
import test from "node:test";

import { LumoClient, lumoChat, PASSTHROUGH_CODEC } from "../src/client.js";
import { ERROR_CODES } from "../../../lib/errors.js";
import { parseArgs } from "../src/cli.js";

function sse(lines, { status = 200 } = {}) {
  const body = lines.map((l) => (l.endsWith("\n\n") ? l : `${l}\n\n`)).join("");
  return new Response(body, {
    status,
    headers: { "content-type": "text/event-stream; charset=UTF-8" },
  });
}

function json(body, { status = 200, headers = {} } = {}) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
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

function guestBootstrap(fetchImplLog) {
  return (url) => {
    if (url.endsWith("/api/auth/v4/sessions")) {
      return json({ Code: 1000, AccessToken: "at", RefreshToken: "rt", TokenType: "Bearer", Scopes: [], UID: "uid-1", LocalID: 0 });
    }
    if (url.endsWith("/api/core/v4/auth/cookies")) {
      return json({ Code: 1000, UID: "uid-1", LocalID: 1, RefreshCounter: 0 }, { headers: { "set-cookie": "AUTH-uid-1=abc; Path=/" } });
    }
    if (url.endsWith("/api/ai/v1/models")) {
      return json({ object: "list", data: [{ id: "lumo-max" }, { id: "lumo-lite" }] });
    }
    if (url.endsWith("/api/ai/v1/limits")) {
      return json({ limits: { lite: 20, max: 19, images: 20 } });
    }
    return null;
  };
}

const CHUNK = (delta, extra = {}) =>
  `data: ${JSON.stringify({
    object: "chat.completion.chunk",
    id: "chatcmpl-1",
    created: 1,
    model: "bff6c543",
    provider: "lumo",
    choices: [{ index: 0, delta, finish_reason: null }],
    ...extra,
  })}`;

test("guestAuth bootstraps session and exchanges for cookies", async () => {
  const base = guestBootstrap();
  const fetchImpl = mockFetch((url) => base(url) || json({}, { status: 404 }));
  const client = new LumoClient({ fetchImpl });
  const session = await client.guestAuth();
  assert.equal(session.UID, "uid-1");
  assert.equal(session.AccessToken, "at");
  assert.equal(client.cookieJar.get("AUTH-uid-1"), "abc");
  assert.equal(fetchImpl.calls.length, 2);
});

test("chat auto-bootstraps, sends encrypted-capable envelope and parses SSE usage", async () => {
  const base = guestBootstrap();
  const fetchImpl = mockFetch((url, init) => {
    const hit = base(url);
    if (hit) return hit;
    if (url.endsWith("/api/ai/v1/chat/completions")) {
      return sse([
        CHUNK({ role: "assistant", content: "UE9ORw==", encrypted: true }),
        `data: ${JSON.stringify({
          object: "chat.completion.chunk",
          choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
        })}`,
        `data: ${JSON.stringify({
          object: "chat.completion.chunk",
          choices: [],
          usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12, remaining_limits: { lite: 20, max: 19, images: 20 } },
        })}`,
        "data: [DONE]",
      ]);
    }
    return json({}, { status: 404 });
  });

  const codec = {
    ...PASSTHROUGH_CODEC,
    requestKey: () => "req-key",
    async encodeContent(content) {
      return { content: Buffer.from(String(content), "utf8").toString("base64"), encrypted: true };
    },
    async decodeText(text) {
      return Buffer.from(String(text || ""), "base64").toString("utf8");
    },
  };

  const res = await lumoChat({ prompt: "Reply with exactly: PONG", fetchImpl, codec, suppressEncryptionWarning: true });
  assert.equal(res.ok, true, JSON.stringify(res.errorInfo));
  assert.equal(res.answer, "PONG");
  assert.equal(res.usage.total_tokens, 12);
  assert.deepEqual(res.usage.remaining_limits, { lite: 20, max: 19, images: 20 });
  assert.equal(res.meta.uid, "uid-1");

  const chatCall = fetchImpl.calls.find((c) => c.url.endsWith("/api/ai/v1/chat/completions"));
  const body = JSON.parse(chatCall.init.body);
  assert.equal(body.stream, true);
  assert.deepEqual(body.stream_options, { include_usage: true });
  assert.equal(body.lumo.request_key, "req-key");
  assert.equal(body.messages.at(-1).encrypted, true);
  assert.equal(chatCall.init.headers["x-pm-uid"], "uid-1");
});

test("without an encrypting codec the client warns and returns ciphertext text", async () => {
  const base = guestBootstrap();
  const fetchImpl = mockFetch((url) => {
    const hit = base(url);
    if (hit) return hit;
    return sse([CHUNK({ content: "CIPHERTEXT", encrypted: true }), "data: [DONE]"]);
  });
  const client = new LumoClient({ fetchImpl });
  const res = await client.chat({ messages: [{ role: "user", content: "hi" }] });
  assert.equal(res.ok, true);
  assert.equal(res.answer, "CIPHERTEXT");
  assert.ok(res.warnings.some((w) => /encrypt/i.test(w)));
});

test("listModels and limits use the bootstrapped session", async () => {
  const base = guestBootstrap();
  const fetchImpl = mockFetch((url) => base(url) || json({}, { status: 404 }));
  const client = new LumoClient({ fetchImpl });
  assert.deepEqual(await client.listModels(), [{ id: "lumo-max" }, { id: "lumo-lite" }]);
  assert.deepEqual(await client.limits(), { limits: { lite: 20, max: 19, images: 20 } });
});

test("HTTP errors are classified", async () => {
  const base = guestBootstrap();
  const fetchImpl = mockFetch((url) => {
    const hit = base(url);
    if (hit) return hit;
    return new Response("unauthorized", { status: 401 });
  });
  const res = await lumoChat({ prompt: "hi", fetchImpl });
  assert.equal(res.ok, false);
  assert.equal(res.errorInfo.code, ERROR_CODES.UNAUTHORIZED);
});

test("parseArgs handles models/limits flags and prompt", () => {
  const args = parseArgs(["hello", "--model", "lumo-lite", "--reasoning", "high", "--json"]);
  assert.equal(args.prompt, "hello");
  assert.equal(args.model, "lumo-lite");
  assert.equal(args.reasoningEffort, "high");
  assert.equal(args.json, true);
  assert.equal(parseArgs(["--models"]).listModels, true);
  assert.equal(parseArgs(["--limits"]).limits, true);
  assert.throws(() => parseArgs(["--bogus"]), /unknown option/);
});
