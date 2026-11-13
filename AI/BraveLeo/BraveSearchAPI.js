/**
 * BraveSearchAPI.js
 *
 * Agent/tool-calling friendly web-search & answer proxy for Brave Leo / "Answer with AI"
 * (search.brave.com chatllm).
 *
 * Based on observed protocol (UnoReverse, 2026-11-13):
 *   GET https://search.brave.com/api/chatllm/with_ask?conversation=<id>&enable_inline_entities=true
 *   -> 200 text/event-stream; charset=utf-8 (x-stream-format: tap)
 *   -> line-delimited JSON events:
 *        text_start | text_delta{delta} | text_stop{text} | usage{...} | followups{followups} | enrichments{enrichments}
 *
 * Notes / gaps (from DOCS):
 * - The exact conversation-creation/initiation request was not isolated in capture.
 * - This proxy can (a) consume a known `conversation` id, or (b) attempt to resolve one
 *   from a Brave Search results page for a query (best-effort HTML/URL extraction).
 * - Interface is unofficial and may change; use responsibly and per applicable terms.
 */

const BRAVE_ORIGIN = "https://search.brave.com";
const WITH_ASK_PATH = "/api/chatllm/with_ask";

const DEFAULT_HEADERS = {
  accept: "application/json",
  "accept-language": "en-US,en;q=0.9",
  "user-agent":
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  "sec-fetch-dest": "empty",
  "sec-fetch-mode": "cors",
  "sec-fetch-site": "same-origin",
};

/**
 * Best-effort: resolve a Brave chatllm conversation id for a search query by fetching
 * the search results page and extracting `conversation=<id>` from the final URL or HTML.
 * This is heuristic (initiation flow was not fully captured) and may require cookies,
 * a browser-like environment, or may fail if Brave does not surface a conversation.
 *
 * @param {string} query
 * @param {{ source?: string, fetchImpl?: typeof fetch, headers?: Record<string,string>, signal?: AbortSignal }} [opts]
 * @returns {Promise<{conversation: string|null, finalUrl: string, html?: string}>}
 */
async function resolveConversation(query, opts = {}) {
  const fetchImpl = opts.fetchImpl || globalThis.fetch;
  if (!fetchImpl) throw new Error("fetch is not available in this environment");
  if (!query || !String(query).trim()) throw new Error("query is required");

  const url = new URL("/search", BRAVE_ORIGIN);
  url.searchParams.set("q", String(query));
  url.searchParams.set("source", opts.source || "web");

  const headers = {
    ...DEFAULT_HEADERS,
    accept:
      "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "sec-fetch-dest": "document",
    "sec-fetch-mode": "navigate",
    "sec-fetch-site": "none",
    ...(opts.headers || {}),
  };

  const res = await fetchImpl(url.toString(), {
    method: "GET",
    headers,
    redirect: "follow",
    signal: opts.signal,
  });

  const finalUrl = res.url || url.toString();
  let conversation = extractConversationId(finalUrl);

  let html;
  try {
    html = await res.text();
  } catch (_) {
    html = undefined;
  }

  if (!conversation && html) {
    // Try common locations: query params in embedded links/scripts, data attributes, JSON blobs.
    conversation =
      extractConversationId(html) ||
      matchFirst(html, /["']conversation["']\s*[:=]\s*["']([a-f0-9]{16,64})["']/i) ||
      matchFirst(html, /[?&]conversation=([a-f0-9]{16,64})/i) ||
      matchFirst(html, /data-conversation=["']([a-f0-9]{16,64})["']/i);
  }

  return { conversation: conversation || null, finalUrl, html };
}

function extractConversationId(text) {
  if (!text) return null;
  const m = String(text).match(/[?&]conversation=([a-f0-9]{16,64})/i);
  return m ? m[1] : null;
}

function matchFirst(text, re) {
  const m = String(text || "").match(re);
  return m ? m[1] : null;
}

/**
 * Fetch and parse the Brave chatllm `with_ask` event stream for a conversation.
 *
 * @param {string} conversation
 * @param {{
 *   enableInlineEntities?: boolean,
 *   fetchImpl?: typeof fetch,
 *   headers?: Record<string,string>,
 *   referer?: string,
 *   signal?: AbortSignal,
 *   onEvent?: (event: any) => void
 * }} [opts]
 * @returns {Promise<{
 *   conversation: string,
 *   answer: string,
 *   usage: any|null,
 *   followups: any[],
 *   enrichments: any|null,
 *   events: any[],
 *   status: number,
 *   headers: Record<string,string>
 * }>}
 */
async function streamWithAsk(conversation, opts = {}) {
  const fetchImpl = opts.fetchImpl || globalThis.fetch;
  if (!fetchImpl) throw new Error("fetch is not available in this environment");
  if (!conversation || !String(conversation).trim()) {
    throw new Error("conversation id is required");
  }

  const url = new URL(WITH_ASK_PATH, BRAVE_ORIGIN);
  url.searchParams.set("conversation", String(conversation));
  url.searchParams.set(
    "enable_inline_entities",
    String(opts.enableInlineEntities !== false)
  );

  const headers = {
    ...DEFAULT_HEADERS,
    ...(opts.referer ? { referer: opts.referer } : {}),
    ...(opts.headers || {}),
  };

  const res = await fetchImpl(url.toString(), {
    method: "GET",
    headers,
    signal: opts.signal,
  });

  const resHeaders = {};
  try {
    res.headers.forEach((v, k) => {
      resHeaders[k.toLowerCase()] = v;
    });
  } catch (_) {}

  if (!res.ok) {
    const bodyText = await safeReadText(res);
    const err = new Error(
      `with_ask request failed: ${res.status} ${res.statusText || ""}`.trim()
    );
    err.status = res.status;
    err.headers = resHeaders;
    err.body = bodyText;
    throw err;
  }

  const contentType = (resHeaders["content-type"] || "").toLowerCase();
  const bodyText = await safeReadText(res);
  const events = parseEventStream(bodyText);

  for (const ev of events) {
    if (typeof opts.onEvent === "function") {
      try {
        opts.onEvent(ev);
      } catch (_) {}
    }
  }

  const reduced = reduceEvents(events);
  return {
    conversation: String(conversation),
    answer: reduced.answer,
    usage: reduced.usage,
    followups: reduced.followups,
    enrichments: reduced.enrichments,
    events,
    status: res.status,
    headers: resHeaders,
    contentType,
  };
}

async function safeReadText(res) {
  try {
    return await res.text();
  } catch (e) {
    return "";
  }
}

/**
 * Parse Brave `x-stream-format: tap` body: line-delimited JSON event objects.
 * (Tolerant of blank lines and occasional non-JSON lines.)
 * @param {string} body
 * @returns {any[]}
 */
function parseEventStream(body) {
  const events = [];
  const lines = String(body || "").split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    // Some SSE variants prefix with "data:"; strip if present.
    const payload = trimmed.startsWith("data:")
      ? trimmed.slice(5).trim()
      : trimmed;
    if (!payload || payload === "[DONE]") continue;
    try {
      events.push(JSON.parse(payload));
    } catch (_) {
      events.push({ type: "unparsed", raw: payload });
    }
  }
  return events;
}

/**
 * Reduce parsed events into a structured agent-friendly result.
 * @param {any[]} events
 */
function reduceEvents(events) {
  let deltaText = "";
  let stopText = null;
  let usage = null;
  let followups = [];
  let enrichments = null;

  for (const ev of events || []) {
    if (!ev || typeof ev !== "object") continue;
    switch (ev.type) {
      case "text_delta":
        if (typeof ev.delta === "string") deltaText += ev.delta;
        break;
      case "text_stop":
        if (typeof ev.text === "string") stopText = ev.text;
        break;
      case "usage":
        usage = ev;
        break;
      case "followups":
        if (Array.isArray(ev.followups)) followups = ev.followups;
        break;
      case "enrichments":
        if (ev.enrichments && typeof ev.enrichments === "object") {
          enrichments = ev.enrichments;
        }
        break;
      default:
        break;
    }
  }

  const answer =
    (enrichments && typeof enrichments.raw_response === "string"
      ? enrichments.raw_response
      : null) ??
    stopText ??
    deltaText ??
    "";

  return { answer, usage, followups, enrichments };
}

/**
 * High-level agent/tool function: get a Brave Leo web-search answer for a query.
 *
 * - If `conversation` is provided, streams that conversation directly.
 * - Otherwise attempts to resolve a conversation id from Brave Search for `query`
 *   (best-effort; may not succeed in all environments).
 *
 * @param {{
 *   query?: string,
 *   conversation?: string,
 *   enableInlineEntities?: boolean,
 *   source?: string,
 *   fetchImpl?: typeof fetch,
 *   headers?: Record<string,string>,
 *   signal?: AbortSignal,
 *   onEvent?: (event:any)=>void
 * }} input
 * @returns {Promise<object>} structured result suitable for tool/agent consumption
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
  } = input;

  let conversation = input.conversation || null;
  let resolution = null;

  if (!conversation) {
    if (!query) {
      throw new Error("Either 'conversation' or 'query' must be provided");
    }
    resolution = await resolveConversation(query, {
      source,
      fetchImpl,
      headers,
      signal,
    });
    conversation = resolution.conversation;
  }

  if (!conversation) {
    return {
      ok: false,
      error:
        "Could not resolve a Brave chatllm conversation id for the query. " +
        "Conversation initiation was not captured; provide a known 'conversation' id " +
        "or run in an environment where Brave Search returns a conversation-backed answer.",
      query: query || null,
      conversation: null,
      resolution: resolution
        ? { finalUrl: resolution.finalUrl, conversation: resolution.conversation }
        : null,
    };
  }

  const referer = query
    ? `${BRAVE_ORIGIN}/search?${new URLSearchParams({ q: query, source }).toString()}&conversation=${conversation}`
    : undefined;

  const result = await streamWithAsk(conversation, {
    enableInlineEntities,
    fetchImpl,
    headers,
    referer,
    signal,
    onEvent,
  });

  return {
    ok: true,
    query: query || null,
    ...result,
    resolution: resolution
      ? { finalUrl: resolution.finalUrl, conversation: resolution.conversation }
      : null,
  };
}

/**
 * OpenAI-compatible tool/function schema for agent tool-calling integrations.
 */
const BRAVE_LEO_TOOL = {
  type: "function",
  function: {
    name: "brave_leo_search",
    description:
      "Web search and AI-grounded answer via Brave Leo / Answer with AI (search.brave.com chatllm). " +
      "Returns a structured answer with follow-up suggestions and enrichments (references/URLs/entities/context when available). " +
      "Provide either a search query (best-effort conversation resolution) or a known Brave conversation id.",
    parameters: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description:
            "The search/query to answer using Brave's web-grounded AI (e.g. a question or search intent).",
        },
        conversation: {
          type: "string",
          description:
            "Optional existing Brave chatllm conversation id (32-hex as observed). If omitted, the proxy attempts to resolve one for the query.",
        },
        enableInlineEntities: {
          type: "boolean",
          description:
            "Whether to request inline entities/enrichments (default: true).",
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

/**
 * Convenience wrapper matching common tool-dispatch signatures: (args) => result
 */
async function braveLeoSearchTool(args = {}) {
  return braveLeoSearch(args);
}

// --- ESM exports ---
export {
  BRAVE_ORIGIN,
  WITH_ASK_PATH,
  BRAVE_LEO_TOOL,
  resolveConversation,
  streamWithAsk,
  parseEventStream,
  reduceEvents,
  braveLeoSearch,
  braveLeoSearchTool,
};

// --- CommonJS compatibility (best-effort) ---
try {
  // eslint-disable-next-line no-undef
  if (typeof module !== "undefined" && module.exports) {
    // eslint-disable-next-line no-undef
    module.exports = {
      BRAVE_ORIGIN,
      WITH_ASK_PATH,
      BRAVE_LEO_TOOL,
      resolveConversation,
      streamWithAsk,
      parseEventStream,
      reduceEvents,
      braveLeoSearch,
      braveLeoSearchTool,
      default: {
        BRAVE_ORIGIN,
        WITH_ASK_PATH,
        BRAVE_LEO_TOOL,
        resolveConversation,
        streamWithAsk,
        parseEventStream,
        reduceEvents,
        braveLeoSearch,
        braveLeoSearchTool,
      },
    };
  }
} catch (_) {}

// --- CLI (node BraveSearchAPI.js "your query") ---
const isDirectRun = (() => {
  try {
    if (typeof process === "undefined" || !process.argv) return false;
    const argv1 = process.argv[1] || "";
    return /BraveSearchAPI\.js$/.test(argv1);
  } catch (_) {
    return false;
  }
})();

if (isDirectRun) {
  (async () => {
    const query = process.argv.slice(2).join(" ").trim();
    if (!query) {
      console.error(
        "Usage: node BraveSearchAPI.js <query> [--conversation <id>]"
      );
      process.exit(2);
    }
    let conversation = null;
    const idx = process.argv.indexOf("--conversation");
    if (idx !== -1 && process.argv[idx + 1]) conversation = process.argv[idx + 1];

    try {
      const out = await braveLeoSearch({ query, conversation });
      console.log(JSON.stringify(out, null, 2));
      if (!out.ok) process.exit(1);
    } catch (e) {
      console.error(
        JSON.stringify({ ok: false, error: e.message, status: e.status, body: e.body }, null, 2)
      );
      process.exit(1);
    }
  })();
}
