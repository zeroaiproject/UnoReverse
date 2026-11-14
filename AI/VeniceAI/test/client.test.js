import assert from "node:assert/strict";
import test from "node:test";

import { VeniceClient, veniceChat } from "../src/client.js";
import { ERROR_CODES } from "../../../lib/errors.js";
import { parseArgs } from "../src/cli.js";

function json(body, { status = 200 } = {}) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function sse(lines, { status = 200 } = {}) {
  const body = lines.map((l) => `${l}\n\n`).join("");
  return new Response(body, { status, headers: { "content-type": "text/event-stream" } });
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

function mintResponse(n = 2) {
  return {
    expiresAt: Math.floor(Date.now() / 1000) + 300,
    tokens: Array.from({ length: n }, (_, i) => ({ nonce: `nonce-${i}`, token: `jwt-${i}` })),
  };
}

test("mints an attestation pool and attaches tokens to inference", async () => {
  const fetchImpl = mockFetch((url, init) => {
    if (url.includes("/client_attestation/mint")) return json(mintResponse(2));
    if (url.includes("/api/inference/chat/agents/venice")) {
      return sse([
        `data: ${JSON.stringify({ type: "response.delta", delta: "PO" })}`,
        `data: ${JSON.stringify({ type: "response.delta", delta: "NG" })}`,
        "data: [DONE]",
      ]);
    }
    return json({}, { status: 404 });
  });

  const res = await veniceChat({ prompt: "Reply with exactly: PONG", fetchImpl });
  assert.equal(res.ok, true, JSON.stringify(res.errorInfo));
  assert.equal(res.answer, "PONG");
  assert.equal(res.rawFrames.length >= 2, true);

  const mintCall = fetchImpl.calls.find((c) => c.url.includes("/mint"));
  assert.ok(mintCall);
  const mintBody = JSON.parse(mintCall.init.body);
  assert.equal(mintBody.count, 5);
  assert.equal(mintBody.env.webdriver, false);

  const inferCall = fetchImpl.calls.find((c) => c.url.includes("/agents/venice"));
  assert.ok(inferCall);
  assert.equal(inferCall.init.headers["x-venice-client-attestation"], "jwt-0");
  assert.equal(inferCall.init.headers.accept, "text/event-stream");
  const inferBody = JSON.parse(inferCall.init.body);
  assert.deepEqual(inferBody.clientTools, []);
  assert.equal(inferBody.input.messages[0].role, "user");
  assert.equal(inferBody.input.messages[0].content[0].type, "output_text");
  assert.equal(inferBody.input.messages[0].content[0].text, "Reply with exactly: PONG");
});

test("401/403 triggers re-mint and retry", async () => {
  let inferCalls = 0;
  const fetchImpl = mockFetch((url) => {
    if (url.includes("/client_attestation/mint")) return json(mintResponse(2));
    if (url.includes("/agents/venice")) {
      inferCalls += 1;
      if (inferCalls === 1) return new Response("forbidden", { status: 403 });
      return sse([`data: ${JSON.stringify({ delta: "OK" })}`, "data: [DONE]"]);
    }
    return json({}, { status: 404 });
  });

  const client = new VeniceClient({ fetchImpl, retries: 1 });
  const res = await client.chat({ prompt: "hi" });
  assert.equal(res.ok, true, JSON.stringify(res.errorInfo));
  assert.equal(res.answer, "OK");
  assert.equal(inferCalls, 2);
  const mintCalls = fetchImpl.calls.filter((c) => c.url.includes("/mint"));
  assert.equal(mintCalls.length >= 2, true);
});

test("pool is consumed and replenished", async () => {
  let mintCount = 0;
  const fetchImpl = mockFetch((url) => {
    if (url.includes("/client_attestation/mint")) {
      mintCount += 1;
      return json(mintResponse(1));
    }
    return sse([`data: ${JSON.stringify({ delta: "x" })}`, "data: [DONE]"]);
  });
  const client = new VeniceClient({ fetchImpl });
  await client.chat({ prompt: "a" });
  await client.chat({ prompt: "b" });
  assert.equal(mintCount >= 2, true);
});

test("metadata endpoints are fetched as JSON", async () => {
  const fetchImpl = mockFetch((url) => {
    if (url.includes("/api/app/models")) return json({ models: ["m1"] });
    if (url.includes("/user_country")) return json({ country: "US" });
    if (url.includes("/rate-limits")) return json({ limits: {} });
    return json({}, { status: 404 });
  });
  const client = new VeniceClient({ fetchImpl });
  assert.deepEqual(await client.listModels(), { models: ["m1"] });
  assert.deepEqual(await client.userCountry(), { country: "US" });
  assert.deepEqual(await client.rateLimits(), { limits: {} });
});

test("inference errors are classified", async () => {
  const fetchImpl = mockFetch((url) => {
    if (url.includes("/client_attestation/mint")) return json(mintResponse(1));
    return new Response("blocked", { status: 403 });
  });
  const res = await veniceChat({ prompt: "hi", fetchImpl, retries: 0 });
  assert.equal(res.ok, false);
  assert.equal(res.errorInfo.code, ERROR_CODES.FORBIDDEN);
});

test("parseArgs handles flags and prompt", () => {
  const args = parseArgs(["hello", "--webdriver", "--retries", "2", "--models", "--json"]);
  assert.equal(args.prompt, "hello");
  assert.equal(args.webdriver, true);
  assert.equal(args.retries, 2);
  assert.equal(args.listModels, true);
  assert.equal(args.json, true);
  assert.throws(() => parseArgs(["--bogus"]), /unknown option/);
});
