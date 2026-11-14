import assert from "node:assert/strict";
import test from "node:test";
import http from "node:http";

import { KiloClient, kiloChat } from "../src/client.js";
import { ERROR_CODES } from "../../../lib/errors.js";
import { parseArgs } from "../src/cli.js";
import { startSocksServer } from "./socks.js";

function sseBody(lines) {
  return lines.map((line) => `${line}\n\n`).join("");
}

const CHUNK = (delta, extra = {}) =>
  `data: ${JSON.stringify({
    id: "chatcmpl-k",
    object: "chat.completion.chunk",
    model: "reflection/beam-free",
    choices: [{ index: 0, delta, finish_reason: null }],
    ...extra,
  })}`;

function pongLines() {
  return [
    CHUNK({ role: "assistant", content: "PO" }),
    CHUNK({ content: "NG" }),
    `data: ${JSON.stringify({
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      usage: { prompt_tokens: 9, completion_tokens: 2, total_tokens: 11 },
    })}`,
    "data: [DONE]",
  ];
}

async function withServer(handler, fn) {
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  try {
    return await fn(port);
  } finally {
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
  }
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

test("chat streams through a SOCKS5 tunnel to the gateway", async () => {
  const socks = await startSocksServer();
  let seen;
  try {
    await withServer(
      (req, res) => {
        seen = { url: req.url, headers: req.headers };
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.end(sseBody(pongLines()));
      },
      async (port) => {
        const client = new KiloClient({
          baseUrl: `http://127.0.0.1:${port}`,
          proxy: `socks5h://127.0.0.1:${socks.port}`,
        });
        const res = await client.chat({ messages: [{ role: "user", content: "Reply with exactly: PONG" }] });
        assert.equal(res.ok, true, JSON.stringify(res.errorInfo));
        assert.equal(res.answer, "PONG");
        assert.equal(res.usage.total_tokens, 11);
        assert.match(res.meta.proxy, /socks5h:\/\/127\.0\.0\.1/);
      }
    );
  } finally {
    await socks.close();
  }
  assert.equal(seen.url, "/api/gateway/v1/chat/completions");
});

test("429 triggers a Tor circuit renewal and a retry", async () => {
  let calls = 0;
  const fetchImpl = mockFetch(() => {
    calls += 1;
    if (calls === 1) return new Response("rate limited", { status: 429, headers: { "retry-after": "0" } });
    return new Response(sseBody(pongLines()), { status: 200, headers: { "content-type": "text/event-stream" } });
  });
  let renewed = 0;
  const client = new KiloClient({
    fetchImpl,
    retries: 1,
    renewIdentity: async ({ reason }) => {
      renewed += 1;
      assert.equal(reason, ERROR_CODES.RATE_LIMITED);
    },
  });
  const res = await client.chat({ messages: [{ role: "user", content: "hi" }] });
  assert.equal(res.ok, true);
  assert.equal(calls, 2);
  assert.equal(renewed, 1);
  assert.equal(res.meta.torRotations, 1);
});

test("rotation is skipped when disabled", async () => {
  let calls = 0;
  const fetchImpl = mockFetch(() => {
    calls += 1;
    return new Response("nope", { status: 429, headers: { "retry-after": "0" } });
  });
  let renewed = 0;
  const client = new KiloClient({
    fetchImpl,
    retries: 2,
    rotateOnRateLimit: false,
    renewIdentity: async () => {
      renewed += 1;
    },
  });
  const res = await client.chat({ messages: [{ role: "user", content: "hi" }] });
  assert.equal(res.ok, false);
  assert.equal(res.errorInfo.code, ERROR_CODES.RATE_LIMITED);
  assert.equal(renewed, 0);
  assert.equal(calls, 3);
});

test("403 is classified as forbidden and not retried", async () => {
  const fetchImpl = mockFetch(() => new Response("blocked", { status: 403 }));
  const res = await kiloChat({ prompt: "hi", fetchImpl, retries: 3 });
  assert.equal(res.ok, false);
  assert.equal(res.errorInfo.code, ERROR_CODES.FORBIDDEN);
  assert.equal(fetchImpl.calls.length, 1);
  assert.match(res.errorInfo.hint, /attestation|cookies|automated/i);
});

test("non-stream JSON responses are normalized", async () => {
  const fetchImpl = mockFetch(
    () =>
      new Response(
        JSON.stringify({
          model: "reflection/beam-free",
          choices: [{ message: { role: "assistant", content: "PONG" }, finish_reason: "stop" }],
          usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 },
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      )
  );
  const res = await kiloChat({ prompt: "hi", fetchImpl, stream: false });
  assert.equal(res.ok, true);
  assert.equal(res.answer, "PONG");
  assert.equal(res.usage.total_tokens, 4);
});

test("reasoning deltas are collected separately", async () => {
  const fetchImpl = mockFetch(
    () =>
      new Response(
        sseBody([
          CHUNK({ reasoning_content: "thinking", content: "" }),
          CHUNK({ content: "PONG" }),
          "data: [DONE]",
        ]),
        { status: 200, headers: { "content-type": "text/event-stream" } }
      )
  );
  const res = await kiloChat({ prompt: "hi", fetchImpl });
  assert.equal(res.ok, true);
  assert.equal(res.answer, "PONG");
  assert.ok(res.reasoning.length >= 0);
});

test("listModels returns the data array", async () => {
  const fetchImpl = mockFetch(
    () => new Response(JSON.stringify({ data: [{ id: "reflection/beam-free" }] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    })
  );
  const client = new KiloClient({ fetchImpl });
  assert.deepEqual(await client.listModels(), [{ id: "reflection/beam-free" }]);
});

test("parseArgs wires --tor to the SOCKS default and control settings", () => {
  const args = parseArgs(["hello", "--tor", "--tor-port", "9052", "--reasoning", "none"]);
  assert.equal(args.prompt, "hello");
  assert.equal(args.tor, true);
  assert.equal(args.proxy, "socks5h://127.0.0.1:9050");
  assert.equal(args.torPort, 9052);
  assert.equal(args.reasoningEffort, "none");
  assert.throws(() => parseArgs(["--retries", "x"]), /non-negative/);
});
