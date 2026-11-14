/**
 * LLM tool-calling surface: OpenAI and Anthropic schemas plus a dispatcher that
 * accepts the argument shapes agents actually send.
 */

import { ERROR_CODES, classifyError } from "./errors.js";
import { braveLeoSearch } from "./search.js";
import { compactResult, formatResultAsText, makeToolPayload } from "./result.js";

export const TOOL_NAME = "brave_leo_search";

export const TOOL_DESCRIPTION =
  "Web search with an AI-grounded answer via Brave Leo / 'Answer with AI' (search.brave.com chatllm). " +
  "Use for up-to-date web questions, fact-finding, and cited answers. " +
  "Returns: answer, citations/sources (URLs, titles/snippets when available), follow-up questions, and usage. " +
  "Pass a natural-language 'query'. A known Brave 'conversation' id can be provided for direct streaming/resume, " +
  "but conversation creation is best-effort and may require browser/session cookies in some environments.";

export const TOOL_PARAMETERS = {
  type: "object",
  properties: {
    query: {
      type: "string",
      description:
        'The web search question or intent to answer (natural language). Example: "latest Node.js LTS version and release date".',
    },
    conversation: {
      type: "string",
      description:
        "Optional existing Brave chatllm conversation id (hex, 32-38 chars as observed). Prefer omitting unless resuming a known conversation.",
    },
    enableInlineEntities: {
      type: "boolean",
      description: "Request inline entities/enrichments/sources when available (default: true).",
      default: true,
    },
    compact: {
      type: "boolean",
      description: "Return a compact LLM-friendly payload without raw stream events (default: true for tool calls).",
      default: true,
    },
    format: {
      type: "string",
      enum: ["json", "text"],
      description: "Tool result content format: 'json' (structured, default) or 'text' (formatted answer + sources).",
      default: "json",
    },
  },
  required: ["query"],
  additionalProperties: false,
};

/** OpenAI-compatible tool/function schema. */
export const BRAVE_LEO_TOOL = {
  type: "function",
  function: { name: TOOL_NAME, description: TOOL_DESCRIPTION, parameters: TOOL_PARAMETERS },
};

/** Convenience: OpenAI `tools` array. */
export const BRAVE_LEO_TOOLS = [BRAVE_LEO_TOOL];

/** Anthropic-style tool schema (input_schema). */
export const BRAVE_LEO_TOOL_ANTHROPIC = {
  name: TOOL_NAME,
  description: TOOL_DESCRIPTION,
  input_schema: TOOL_PARAMETERS,
};

export function safeJsonParse(value) {
  if (value == null) return {};
  if (typeof value === "object") return value;
  if (typeof value !== "string") return {};
  try {
    return JSON.parse(value);
  } catch (_) {
    return { query: String(value) };
  }
}

/** Normalize tool-call argument shapes (string/object/OpenAI function.arguments). */
export function normalizeToolArgs(args) {
  if (args == null) return {};
  if (typeof args === "string") return safeJsonParse(args);
  if (typeof args !== "object") return {};
  // OpenAI chat tool_call: { function: { name, arguments } }
  if (args.function && (args.function.arguments || args.function.name)) return safeJsonParse(args.function.arguments);
  // Generic { name, arguments } / { arguments }
  if (typeof args.arguments === "string") return safeJsonParse(args.arguments);
  if (args.arguments && typeof args.arguments === "object") return { ...args.arguments };
  return { ...args };
}

/**
 * Tool-dispatch wrapper optimized for LLM tool calling.
 * Defaults: compact=true, includeEvents=false.
 */
export async function braveLeoSearchTool(args = {}, opts = {}) {
  const normalized = normalizeToolArgs(args);
  const compact = normalized.compact !== false;
  const format = normalized.format || "json";
  const res = await braveLeoSearch({
    ...(opts.defaults || {}),
    ...normalized,
    query: normalized.query,
    conversation: normalized.conversation,
    includeEvents: compact ? false : normalized.includeEvents !== false,
    includeCookies: false,
  });
  const payload = makeToolPayload(res);
  if (format !== "text") return payload;
  return {
    ok: payload.ok,
    conversation: payload.conversation,
    content: payload.content,
    answer: payload.answer,
    citations: payload.citations,
    sources: payload.sources,
    followups: payload.followups,
    usage: payload.usage,
    ...(payload.ok ? {} : { error: payload.error }),
  };
}

/**
 * Execute a tool call in common agent formats.
 * Accepts: raw args object, JSON args string, OpenAI {function:{name,arguments}},
 * {name, arguments}, or {tool, input}. Returns a JSON string (default) or object.
 */
export async function executeToolCall(toolCallOrArgs = {}, opts = {}) {
  try {
    const name =
      toolCallOrArgs && (toolCallOrArgs.name || toolCallOrArgs.tool || (toolCallOrArgs.function && toolCallOrArgs.function.name));
    if (name && name !== TOOL_NAME) {
      const err = {
        ok: false,
        error: `Unknown tool: ${name}`,
        errorInfo: { code: ERROR_CODES.UNKNOWN_TOOL, message: `Unknown tool: ${name}`, expected: TOOL_NAME },
        expected: TOOL_NAME,
      };
      return opts.asObject ? err : JSON.stringify(err);
    }
    const args = normalizeToolArgs(toolCallOrArgs);
    if (!args.query && toolCallOrArgs && typeof toolCallOrArgs.input === "string") args.query = toolCallOrArgs.input;

    const result = await braveLeoSearchTool({ ...(opts.defaults || {}), ...args });
    if (opts.asObject) return result;
    if (opts.format === "text" || args.format === "text") return result.content || "";
    return JSON.stringify(result);
  } catch (e) {
    const err = classifyError(e);
    const payload = {
      ok: false,
      error: err.message,
      errorInfo: err.toJSON(),
      answer: "",
      citations: [],
      sources: [],
      followups: [],
      usage: null,
      content: `Error: ${err.message}`,
    };
    if (opts.asObject) return payload;
    if (opts.format === "text") return payload.content;
    return JSON.stringify(payload);
  }
}

/** Create an OpenAI tool result message payload. */
export function toToolResultMessage(toolCall, result, opts = {}) {
  const toolCallId = (toolCall && (toolCall.id || toolCall.tool_call_id)) || opts.toolCallId || null;
  const content =
    typeof result === "string"
      ? result
      : JSON.stringify(result && result.ok !== undefined ? compactResult(result) : makeToolPayload(result || {}));
  return toolCallId
    ? { role: "tool", tool_call_id: toolCallId, name: TOOL_NAME, content }
    : { role: "tool", name: TOOL_NAME, content };
}

/** Suggested system hint for agents using this tool. */
export const TOOL_SYSTEM_HINT =
  `You can call \`${TOOL_NAME}\` for web-grounded answers. ` +
  `Use the returned \`answer\` as the primary response and cite \`citations\`/\`sources\` when relevant. ` +
  `If \`ok\` is false, report \`error\` and ask for a known conversation id or browser/session cookies if needed.`;
