/**
 * BraveSearchAPI.js
 *
 * Agent/tool-calling friendly web-search & AI-grounded answer proxy for
 * Brave Leo / "Answer with AI" (search.brave.com chatllm).
 *
 * Observed protocol (UnoReverse, 2026-11-13, see DOCS.md):
 *   GET https://search.brave.com/api/chatllm/with_ask?conversation=<id>&enable_inline_entities=true
 *   -> 200 text/event-stream; charset=utf-8  (x-stream-format: tap)
 *   -> line-delimited JSON events:
 *        text_start
 *        text_delta { delta }
 *        text_stop  { text }
 *        usage      { prompt_tokens, completion_tokens, reasoning_tokens }
 *        followups  { followups: [...] }
 *        enrichments{ enrichments: { raw_response, references, urls, reference_urls,
 *                                    images, qa, entities, main_entity, main_entity_infobox,
 *                                    predicate, context, context_urls, context_results } }
 *
 * Gaps / notes:
 * - Conversation initiation trigger was not fully isolated in capture. This proxy can
 *   (a) consume a known `conversation` id, or (b) best-effort resolve one from a Brave
 *   Search results page for a query (heuristic; may require browser-like cookies/session).
 * - Unofficial, versioned interface. Use responsibly and per applicable terms/law.
 */

const BRAVE_ORIGIN = "https://search.brave.com";
const WITH_ASK_PATH = "/api/chatllm/with_ask";

const DEFAULT_UA =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

const BASE_HEADERS = {
  "accept-language": "en-US,en;q=0.9",
  "user-agent": DEFAULT_UA,
};

const STREAM_REQUEST_HEADERS = {
  ...BASE_HEADERS,
  accept: "application/json",
  "sec-fetch-dest": "empty",
  "sec-fetch-mode": "cors",
  "sec-fetch-site": "same-origin",
};

const NAVIGATE_HEADERS = {
  ...BASE_HEADERS,
  accept:
    "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
  "upgrade-insecure-requests": "1",
  "sec-fetch-dest": "document",
  "sec-fetch-mode": "navigate",
  "sec-fetch-site": "none",
  "sec-fetch-user": "?1",
};

// --- Utilities ---

function assertFetch(fetchImpl) {
  if (!fetchImpl) throw new Error("fetch is not available in this environment");
  return fetchImpl;
}

function normalizeConversationId(id) {
  if (id == null) return null;
  const s = String(id).trim();
  if (!s) return null;
  // Observed: 32 hex chars; accept broader hex token defensively.
  if (!/^[a-f0-9]{16,64}$/i.test(s)) return null;
  return s;
}

function extractConversationId(text) {
  if (!text) return null;
  const s = String(text);
  const patterns = [
    /[?&]conversation=([a-f0-9]{16,64})/i,
    /["']conversation["']\s*[:=]\s*["']([a-f0-9]{16,64})["']/i,
    /data-conversation=["']([a-f0-9]{16,64})["']/i,
    /\\u0026conversation=([a-f0-9]{16,64})/i,
  ];
  for (const re of patterns) {
    const m = s.match(re);
    if (m) return m[1];
  }
  return null;
}

function headersToObject(headers) {
  const out = {};
  if (!headers) return out;
  try {
    if (typeof headers.forEach === "function") {
      headers.forEach((v, k) => {
        out[String(k).toLowerCase()] = v;
      });
      return out;
    }
  } catch (_) {}
  try {
    for (const [k, v] of headers.entries ? headers.entries() : Object.entries(headers)) {
      out[String(k).toLowerCase()] = v;
    }
  } catch (_) {}
  return out;
}

function mergeHeaders(...parts) {
  const out = {};
  for (const p of parts) {
    if (!p) continue;
    const obj = typeof p.forEach === "function" || p.entries ? headersToObject(p) : p;
    for (const [k, v] of Object.entries(obj)) {
      if (v === undefined || v === null) continue;
      out[String(k).toLowerCase()] = v;
    }
  }
  return out;
}

/** Minimal cookie accumulator (Set-Cookie -> Cookie) for session reuse. */
class CookieJar {
  constructor(initial) {
    this.map = new Map();
    if (typeof initial === "string" && initial.trim()) this.addCookieHeader(initial);
    else if (initial && typeof initial === "object") {
      for (const [k, v] of Object.entries(initial)) this.map.set(k, String(v));
    }
  }
  addSetCookie(setCookie) {
    if (!setCookie) return;
    const values = Array.isArray(setCookie) ? setCookie : [setCookie];
    for (const raw of values) {
      if (!raw) continue;
      const first = String(raw).split(";")[0];
      const idx = first.indexOf("=");
      if (idx <= 0) continue;
      const name = first.slice(0, idx).trim();
      const value = first.slice(idx + 1).trim();
      if (name) this.map.set(name, value);
    }
  }
  ingestResponse(res) {
    try {
      // Node/undici: getSetCookie(); browsers may expose only combined header.
      if (typeof res.headers.getSetCookie === "function") {
        this.addSetCookie(res.headers.getSetCookie());
      } else {
        const sc = res.headers.get("set-cookie");
        if (sc) this.addSetCookie(sc);
      }
    } catch (_) {}
  }
  addCookieHeader(cookieHeader) {
    for (const part of String(cookieHeader).split(";")) {
      const idx = part.indexOf("=");
      if (idx <= 0) continue;
      this.map.set(part.slice(0, idx).trim(), part.slice(idx + 1).trim());
    }
  }
  toString() {
    if (!this.map.size) return "";
    return Array.from(this.map.entries())
      .map(([k, v]) => `${k}=${v}`)
      .join("; ");
  }
  get size() {
    return this.map.size;
  }
}

function buildSearchUrl(query, opts = {}) {
  const url = new URL("/search", BRAVE_ORIGIN);
  url.searchParams.set("q", String(query ?? ""));
  url.searchParams.set("source", opts.source || "web");
  if (opts.conversation) url.searchParams.set("conversation", String(opts.conversation));
  if (opts.extraParams && typeof opts.extraParams === "object") {
    for (const [k, v] of Object.entries(opts.extraParams)) {
      if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
    }
  }
  return url.toString();
}

function buildFollowupUrl(query, conversation, opts = {}) {
  // Observed pattern: /ask?q=...&source=chatllm-elaborate&conversation=<id>&query_type=answer_with_ai_follow_up
  const url = new URL("/ask", BRAVE_ORIGIN);
  url.searchParams.set("q", String(query ?? ""));
  url.searchParams.set("source", opts.source || "chatllm-elaborate");
  if (conversation) url.searchParams.set("conversation", String(conversation));
  url.searchParams.set("query_type", opts.queryType || "answer_with_ai_follow_up");
  return url.toString();
}

function buildWithAskUrl(conversation, enableInlineEntities = true) {
  const url = new URL(WITH_ASK_PATH, BRAVE_ORIGIN);
  url.searchParams.set("conversation", String(conversation));
  url.searchParams.set("enable_inline_entities", String(enableInlineEntities !== false));
  return url.toString();
}

// --- Conversation resolution ---

/**
 * Best-effort: resolve a Brave chatllm conversation id for a query.
 * Tries the search page and extracts `conversation=<id>` from the final URL or HTML.
 * Heuristic (initiation not fully captured); pass cookies/session for better odds.
 */
async function resolveConversation(query, opts = {}) {
  const fetchImpl = assertFetch(opts.fetchImpl || globalThis.fetch);
  if (!query || !String(query).trim()) throw new Error("query is required");

  const jar = opts.cookieJar instanceof CookieJar ? opts.cookieJar : new CookieJar(opts.cookies);
  const strategies = [
    { extraParams: null }, // plain search
    // speculative hints sometimes used by AI-answer surfaces (best-effort, harmless if ignored)
    { extraParams: { summary: "1" } },
  ];

  let last = null;
  for (const strat of strategies) {
    const url = buildSearchUrl(query, { source: opts.source || "web", extraParams: strat.extraParams });
    const headers = mergeHeaders(NAVIGATE_HEADERS, opts.headers, jar.toString() ? { cookie: jar.toString() } : null);

    const res = await fetchImpl(url, {
      method: "GET",
      headers,
      redirect: "follow",
      signal: opts.signal,
    });
    jar.ingestResponse(res);

    const finalUrl = res.url || url;
    let conversation = extractConversationId(finalUrl);
    let html = "";
    try {
      html = await res.text();
    } catch (_) {
      html = "";
    }
    if (!conversation && html) conversation = extractConversationId(html);

    last = {
      conversation: conversation || null,
      finalUrl,
      status: res.status,
      strategy: strat.extraParams ? "search+params" : "search",
      cookies: jar.toString() || null,
    };
    if (conversation) return last;
  }

  return last || { conversation: null, finalUrl: null, status: null, strategy: null, cookies: jar.toString() || null };
}

// --- Stream parsing / consumption ---

async function safeReadText(res) {
  try {
    return await res.text();
  } catch (_) {
    return "";
  }
}

/**
 * Parse Brave `x-stream-format: tap` body (line-delimited JSON event objects).
 * Tolerant of blank lines, `data:` prefixes, and non-JSON lines.
 */
function parseEventStream(body) {
  const events = [];
  const text = String(body || "");
  const lines = text.split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const payload = trimmed.startsWith("data:") ? trimmed.slice(5).trim() : trimmed;
    if (!payload || payload === "[DONE]") continue;
    try {
      events.push(JSON.parse(payload));
    } catch (_) {
      events.push({ type: "unparsed", raw: payload });
    }
  }
  return events;
}

function applyEvent(state, ev) {
  if (!ev || typeof ev !== "object") return;
  switch (ev.type) {
    case "text_start":
      state.started = true;
      break;
    case "text_delta":
      if (typeof ev.delta === "string") state.deltaText += ev.delta;
      break;
    case "text_stop":
      if (typeof ev.text === "string") state.stopText = ev.text;
      state.stopped = true;
      break;
    case "usage":
      state.usage = ev;
      break;
    case "followups":
      state.followups = Array.isArray(ev.followups) ? ev.followups : [];
      break;
    case "enrichments":
      if (ev.enrichments && typeof ev.enrichments === "object") state.enrichments = ev.enrichments;
      break;
    default:
      break;
  }
}

function finalizeState(state) {
  const enrichments = state.enrichments || null;
  const answer =
    (enrichments && typeof enrichments.raw_response === "string" ? enrichments.raw_response : null) ??
    state.stopText ??
    state.deltaText ??
    "";
  return {
    answer,
    text: answer,
    usage: state.usage || null,
    followups: state.followups || [],
    enrichments,
    sources: extractSources(enrichments),
  };
}

function extractSources(enrichments) {
  if (!enrichments || typeof enrichments !== "object") {
    return { references: [], urls: [], reference_urls: [], context_urls: [], images: [], entities: [], context_results: [] };
  }
  const arr = (v) => (Array.isArray(v) ? v : []);
  return {
    references: arr(enrichments.references),
    urls: arr(enrichments.urls),
    reference_urls: arr(enrichments.reference_urls),
    context_urls: arr(enrichments.context_urls),
    images: arr(enrichments.images),
    entities: arr(enrichments.entities),
    context: arr(enrichments.context),
    context_results: arr(enrichments.context_results),
    main_entity: enrichments.main_entity ?? null,
    main_entity_infobox: enrichments.main_entity_infobox ?? null,
  };
}

/** Reduce parsed events into a structured result (buffered). */
function reduceEvents(events) {
  const state = { deltaText: "", stopText: null, usage: null, followups: [], enrichments: null, started: false, stopped: false };
  for (const ev of events || []) applyEvent(state, ev);
  return finalizeState(state);
}

async function* iterateNdjsonStream(response, onEvent) {
  const body = response && response.body;
  if (!body) return;
  const decoder = new TextDecoder();
  let buffer = "";

  // Web ReadableStream (Node 18+ / browsers)
  if (typeof body.getReader === "function") {
    const reader = body.getReader();
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = buffer.search(/\r?\n/)) !== -1) {
        const line = buffer.slice(0, idx);
        buffer = buffer.slice(idx + (buffer[idx] === "\r" && buffer[idx + 1] === "\n" ? 2 : 1));
        const ev = parseLine(line);
        if (!ev) continue;
        if (onEvent) try { onEvent(ev); } catch (_) {}
        yield ev;
      }
    }
    buffer += decoder.decode();
  } else if (typeof body[Symbol.asyncIterator] === "function") {
    // Node stream async iterable
    for await (const chunk of body) {
      buffer += typeof chunk === "string" ? chunk : decoder.decode(chunk, { stream: true });
      let idx;
      while ((idx = buffer.search(/\r?\n/)) !== -1) {
        const line = buffer.slice(0, idx);
        buffer = buffer.slice(idx + (buffer[idx] === "\r" && buffer[idx + 1] === "\n" ? 2 : 1));
        const ev = parseLine(line);
        if (!ev) continue;
        if (onEvent) try { onEvent(ev); } catch (_) {}
        yield ev;
      }
    }
  } else {
    const text = await safeReadText(response);
    for (const ev of parseEventStream(text)) {
      if (onEvent) try { onEvent(ev); } catch (_) {}
      yield ev;
    }
    return;
  }

  if (buffer.trim()) {
    const ev = parseLine(buffer);
    if (ev) {
      if (onEvent) try { onEvent(ev); } catch (_) {}
      yield ev;
    }
  }
}

function parseLine(line) {
  const trimmed = String(line || "").trim();
  if (!trimmed) return null;
  const payload = trimmed.startsWith("data:") ? trimmed.slice(5).trim() : trimmed;
  if (!payload || payload === "[DONE]") return null;
  try {
    return JSON.parse(payload);
  } catch (_) {
    return { type: "unparsed", raw: payload };
  }
}

/**
 * Fetch and consume the `with_ask` stream for a conversation.
 * If `incremental` is true, reads via streaming reader and emits `onEvent` live;
 * otherwise buffers the full body then parses.
 */
async function streamWithAsk(conversation, opts = {}) {
  const fetchImpl = assertFetch(opts.fetchImpl || globalThis.fetch);
  const conv = normalizeConversationId(conversation) || String(conversation || "").trim();
  if (!conv) throw new Error("conversation id is required");

  const jar = opts.cookieJar instanceof CookieJar ? opts.cookieJar : new CookieJar(opts.cookies);
  const url = buildWithAskUrl(conv, opts.enableInlineEntities !== false);
  const headers = mergeHeaders(
    STREAM_REQUEST_HEADERS,
    opts.referer ? { referer: opts.referer } : null,
    jar.toString() ? { cookie: jar.toString() } : null,
    opts.headers
  );

  const res = await fetchImpl(url, { method: "GET", headers, signal: opts.signal });
  jar.ingestResponse(res);

  const resHeaders = headersToObject(res.headers);
  if (!res.ok) {
    const bodyText = await safeReadText(res);
    const err = new Error(`with_ask request failed: ${res.status} ${res.statusText || ""}`.trim());
    err.status = res.status;
    err.headers = resHeaders;
    err.body = bodyText;
    err.conversation = conv;
    throw err;
  }

  const state = { deltaText: "", stopText: null, usage: null, followups: [], enrichments: null, started: false, stopped: false };
  const events = [];
  const onEvent = typeof opts.onEvent === "function" ? opts.onEvent : null;
  const wantIncremental = opts.incremental !== false && !!res.body; // default: stream-read when possible

  if (wantIncremental) {
    for await (const ev of iterateNdjsonStream(res, null)) {
      events.push(ev);
      applyEvent(state, ev);
      if (onEvent) try { onEvent(ev, { ...finalizeState(state), partial: true }); } catch (_) {}
    }
  } else {
    const bodyText = await safeReadText(res);
    const parsed = parseEventStream(bodyText);
    for (const ev of parsed) {
      events.push(ev);
      applyEvent(state, ev);
      if (onEvent) try { onEvent(ev, { ...finalizeState(state), partial: true }); } catch (_) {}
    }
  }

  const reduced = finalizeState(state);
  return {
    ok: true,
    conversation: conv,
    answer: reduced.answer,
    text: reduced.text,
    usage: reduced.usage,
    followups: reduced.followups,
    enrichments: reduced.enrichments,
    sources: reduced.sources,
    events,
    status: res.status,
    headers: resHeaders,
    contentType: (resHeaders["content-type"] || "").toLowerCase(),
    streamFormat: resHeaders["x-stream-format"] || null,
  };
}

// --- High-level tool/agent API ---

function buildAgentResult({ ok, query, conversation, resolution, stream, error }) {
  if (!ok) {
    return {
      ok: false,
      query: query || null,
      conversation: conversation || null,
      answer: "",
      text: "",
      usage: null,
      followups: [],
      enrichments: null,
      sources: extractSources(null),
      error: error || "Unknown error",
      resolution: resolution || null,
    };
  }
  return {
    ok: true,
    query: query || null,
    conversation: stream.conversation,
    answer: stream.answer,
    text: stream.text,
    usage: stream.usage,
    followups: stream.followups,
    enrichments: stream.enrichments,
    sources: stream.sources,
    events: stream.events,
    meta: {
      status: stream.status,
      contentType: stream.contentType,
      streamFormat: stream.streamFormat,
      resolution: resolution || null,
    },
  };
}

/**
 * Get a Brave Leo / Answer with AI web-grounded answer.
 *
 * - If `conversation` is provided, streams that conversation directly.
 * - Otherwise best-effort resolves a conversation id from Brave Search for `query`.
 */
async function braveLeoSearch(input = {}) {
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
  } = input;

  let conversation = normalizeConversationId(input.conversation) || (input.conversation ? String(input.conversation).trim() : null);
  const jar = new CookieJar(cookies);
  let resolution = null;

  try {
    if (!conversation) {
      if (!query || !String(query).trim()) {
        throw new Error("Either 'conversation' or 'query' must be provided");
      }
      resolution = await resolveConversation(query, { source, fetchImpl, headers, signal, cookieJar: jar });
      conversation = normalizeConversationId(resolution.conversation);
    }

    if (!conversation) {
      return buildAgentResult({
        ok: false,
        query,
        conversation: null,
        resolution,
        error:
          "Could not resolve a Brave chatllm conversation id for the query. " +
          "Conversation initiation was not fully captured; provide a known 'conversation' id, " +
          "or pass browser/session cookies in an environment where Brave Search returns a conversation-backed answer.",
      });
    }

    const referer = query
      ? `${BRAVE_ORIGIN}/search?${new URLSearchParams({ q: String(query), source }).toString()}&conversation=${conversation}`
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
    });

    // attach cookie state for callers that want session continuity
    stream.cookies = jar.toString() || null;
    const result = buildAgentResult({ ok: true, query, conversation, resolution, stream });
    result.meta.cookies = stream.cookies;
    return result;
  } catch (e) {
    return {
      ok: false,
      query: query || null,
      conversation: conversation || null,
      answer: "",
      text: "",
      usage: null,
      followups: [],
      enrichments: null,
      sources: extractSources(null),
      error: e && e.message ? e.message : String(e),
      status: e && e.status,
      body: e && e.body,
      resolution,
    };
  }
}

/** Convenience wrapper: throw on failure, return structured result on success. */
async function braveLeoSearchOrThrow(input = {}) {
  const out = await braveLeoSearch(input);
  if (!out.ok) {
    const err = new Error(out.error || "braveLeoSearch failed");
    err.result = out;
    throw err;
  }
  return out;
}

/** OpenAI-compatible tool/function schema for agent tool-calling. */
const BRAVE_LEO_TOOL = {
  type: "function",
  function: {
    name: "brave_leo_search",
    description:
      "Web search and AI-grounded answer via Brave Leo / 'Answer with AI' (search.brave.com chatllm). " +
      "Returns {answer, followups, sources/enrichments (references, urls, entities, context), usage}. " +
      "Provide 'query' to best-effort resolve a conversation, or a known Brave 'conversation' id for direct streaming.",
    parameters: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Search/question to answer with Brave's web-grounded AI.",
        },
        conversation: {
          type: "string",
          description:
            "Existing Brave chatllm conversation id (hex, ~32 chars as observed). If omitted, proxy attempts best-effort resolution for the query.",
        },
        enableInlineEntities: {
          type: "boolean",
          description: "Request inline entities/enrichments (default: true).",
          default: true,
        },
        source: {
          type: "string",
          description: "Brave search source parameter (default: 'web').",
          default: "web",
        },
      },
      additionalProperties: false,
      anyOf: [{ required: ["query"] }, { required: ["conversation"] }],
    },
  },
};

/** Tool-dispatch friendly wrapper: (args) => Promise<result> */
async function braveLeoSearchTool(args = {}) {
  return braveLeoSearch(args);
}

// --- ESM exports ---
export {
  BRAVE_ORIGIN,
  WITH_ASK_PATH,
  BRAVE_LEO_TOOL,
  CookieJar,
  buildSearchUrl,
  buildFollowupUrl,
  buildWithAskUrl,
  normalizeConversationId,
  extractConversationId,
  parseEventStream,
  reduceEvents,
  extractSources,
  resolveConversation,
  streamWithAsk,
  braveLeoSearch,
  braveLeoSearchOrThrow,
  braveLeoSearchTool,
};

// --- CommonJS compatibility (best-effort) ---
try {
  // eslint-disable-next-line no-undef
  if (typeof module !== "undefined" && module.exports) {
    const api = {
      BRAVE_ORIGIN,
      WITH_ASK_PATH,
      BRAVE_LEO_TOOL,
      CookieJar,
      buildSearchUrl,
      buildFollowupUrl,
      buildWithAskUrl,
      normalizeConversationId,
      extractConversationId,
      parseEventStream,
      reduceEvents,
      extractSources,
      resolveConversation,
      streamWithAsk,
      braveLeoSearch,
      braveLeoSearchOrThrow,
      braveLeoSearchTool,
    };
    // eslint-disable-next-line no-undef
    module.exports = { ...api, default: api };
  }
} catch (_) {}

// --- CLI ---
const isDirectRun = (() => {
  try {
    if (typeof process === "undefined" || !process.argv) return false;
    const argv1 = process.argv[1] || "";
    return /BraveSearchAPI\.js$/.test(argv1);
  } catch (_) {
    return false;
  }
})();

function parseArgs(argv) {
  const out = { queryParts: [], conversation: null, json: false, stream: false, noEntities: false, source: "web" };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--conversation" || a === "-c") out.conversation = argv[++i] || null;
    else if (a === "--json") out.json = true;
    else if (a === "--stream") out.stream = true;
    else if (a === "--no-inline-entities") out.noEntities = true;
    else if (a === "--source") out.source = argv[++i] || "web";
    else if (a === "--help" || a === "-h") out.help = true;
    else out.queryParts.push(a);
  }
  out.query = out.queryParts.join(" ").trim();
  return out;
}

if (isDirectRun) {
  (async () => {
    const args = parseArgs(process.argv.slice(2));
    if (args.help || (!args.query && !args.conversation)) {
      console.error(
        "Usage: node BraveSearchAPI.js <query> [--conversation <id>] [--source web] [--no-inline-entities] [--stream] [--json]\n" +
          "  --stream  print answer deltas live (stderr shows meta on completion)\n" +
          "  --json    print full structured JSON result"
      );
      process.exit(args.help ? 0 : 2);
    }

    try {
      let live = "";
      const onEvent = args.stream && !args.json
        ? (ev) => {
            if (ev && ev.type === "text_delta" && typeof ev.delta === "string") {
              process.stdout.write(ev.delta);
              live += ev.delta;
            }
          }
        : undefined;

      const out = await braveLeoSearch({
        query: args.query || undefined,
        conversation: args.conversation || undefined,
        enableInlineEntities: !args.noEntities,
        source: args.source,
        onEvent,
      });

      if (args.json) {
        console.log(JSON.stringify(out, null, 2));
      } else if (args.stream) {
        if (!live && out.answer) process.stdout.write(out.answer);
        process.stdout.write("\n");
        if (out.followups && out.followups.length) {
          console.error("\nFollow-ups: " + JSON.stringify(out.followups));
        }
        if (out.sources) {
          const refs = [...(out.sources.references || []), ...(out.sources.urls || []), ...(out.sources.reference_urls || [])];
          if (refs.length) console.error("Sources: " + JSON.stringify(refs.slice(0, 10)));
        }
        if (!out.ok) console.error("Error: " + out.error);
      } else {
        if (out.ok) {
          console.log(out.answer || "");
          if (out.followups && out.followups.length) console.log("\nFollow-ups:\n" + JSON.stringify(out.followups, null, 2));
          const refs = out.sources ? [...(out.sources.references || []), ...(out.sources.urls || []), ...(out.sources.reference_urls || []), ...(out.sources.context_urls || [])] : [];
          if (refs.length) console.log("\nSources:\n" + JSON.stringify(refs, null, 2));
        } else {
          console.error(JSON.stringify(out, null, 2));
        }
      }
      process.exit(out.ok ? 0 : 1);
    } catch (e) {
      console.error(JSON.stringify({ ok: false, error: e.message, status: e.status, body: e.body }, null, 2));
      process.exit(1);
    }
  })();
}
