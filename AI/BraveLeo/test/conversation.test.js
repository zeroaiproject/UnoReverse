import assert from "node:assert/strict";
import test from "node:test";

import {
  buildAskUrl,
  buildFollowupUrl,
  buildSearchUrl,
  buildWithAskUrl,
  extractConversationId,
  normalizeConversationId,
  resolveConversation,
} from "../src/conversation.js";
import { CONVERSATION, hangUntilAborted, mockFetch, searchPageHtml, textResponse } from "./helpers.js";

test("URL builders produce the observed shapes", () => {
  assert.equal(
    buildSearchUrl("node lts", { source: "web" }),
    "https://search.brave.com/search?q=node+lts&source=web"
  );
  assert.equal(
    buildWithAskUrl(CONVERSATION),
    `https://search.brave.com/api/chatllm/with_ask?conversation=${CONVERSATION}&enable_inline_entities=true`
  );
  assert.equal(
    buildWithAskUrl(CONVERSATION, false),
    `https://search.brave.com/api/chatllm/with_ask?conversation=${CONVERSATION}&enable_inline_entities=false`
  );
  assert.equal(buildAskUrl("q", { source: "web" }), "https://search.brave.com/ask?q=q&source=web");
  assert.equal(
    buildFollowupUrl("more", CONVERSATION),
    `https://search.brave.com/ask?q=more&source=chatllm-elaborate&conversation=${CONVERSATION}&query_type=answer_with_ai_follow_up`
  );
});

test("normalizeConversationId accepts hex ids and rejects anything else", () => {
  assert.equal(normalizeConversationId(CONVERSATION), CONVERSATION);
  assert.equal(normalizeConversationId("  " + CONVERSATION + " "), CONVERSATION);
  assert.equal(normalizeConversationId("not-a-conversation"), null);
  assert.equal(normalizeConversationId("abc"), null);
  assert.equal(normalizeConversationId(null), null);
});

test("extractConversationId finds ids in URLs, JSON, HTML and escaped payloads", () => {
  assert.equal(extractConversationId(`https://search.brave.com/search?q=x&conversation=${CONVERSATION}`), CONVERSATION);
  assert.equal(extractConversationId(`{"conversation":"${CONVERSATION}"}`), CONVERSATION);
  assert.equal(extractConversationId(`data-conversation='${CONVERSATION}'`), CONVERSATION);
  assert.equal(extractConversationId(`u\\u0026conversation=${CONVERSATION}`), CONVERSATION);
  assert.equal(extractConversationId("no id here"), null);
});

test("resolveConversation returns the id and per-attempt diagnostics", async () => {
  const fetchImpl = mockFetch((url) =>
    url.includes("/search") ? textResponse(searchPageHtml()) : textResponse("", { status: 404 })
  );
  const res = await resolveConversation("hello", { fetchImpl });
  assert.equal(res.conversation, CONVERSATION);
  assert.equal(res.strategy, "search");
  assert.equal(res.attempts.length, 1);
  assert.equal(res.attempts[0].status, 200);
  assert.equal(fetchImpl.calls.length, 1);
  assert.match(fetchImpl.calls[0].headers["user-agent"], /Chrome/);
});

test("resolveConversation reports why every attempt failed", async () => {
  const fetchImpl = mockFetch(() => textResponse("<html>unusual traffic</html>", { status: 429 }));
  const res = await resolveConversation("hello", { fetchImpl });
  assert.equal(res.conversation, null);
  assert.equal(res.attempts.length, 3);
  for (const attempt of res.attempts) {
    assert.equal(attempt.status, 429);
    assert.equal(attempt.code, "RATE_LIMITED");
    assert.match(attempt.hint, /anti-bot/i);
  }
});

test("resolveConversation stops early when the caller aborts", async () => {
  const ctrl = new AbortController();
  ctrl.abort();
  const fetchImpl = hangUntilAborted;
  await assert.rejects(() => resolveConversation("hello", { fetchImpl, signal: ctrl.signal }), /abort/i);
});

test("resolveConversation validates input and fetch availability", async () => {
  await assert.rejects(() => resolveConversation(""), /query is required/);
  await assert.rejects(() => resolveConversation("x", { fetchImpl: 123 }), /fetch is not available/);
});
