/**
 * OpenAI-compatible payload helpers (`chat.completion[.chunk]`).
 *
 * Obscurify, Kilo and Lumo all speak this shape; the differences live in the
 * request envelope and in whether deltas are encrypted, not in the frame
 * layout. Keeping extraction in one place makes the provider clients read as
 * protocol, not as parsing boilerplate.
 */

export function reasonText(value) {
  if (value == null) return "";
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    return value
      .map((part) => (typeof part === "string" ? part : typeof part?.text === "string" ? part.text : ""))
      .join("");
  }
  return String(value);
}

export function normalizeUsage(usage) {
  if (!usage || typeof usage !== "object") return null;
  const prompt = Number(usage.prompt_tokens) || 0;
  const completion = Number(usage.completion_tokens) || 0;
  const reasoning =
    Number(usage.completion_tokens_details?.reasoning_tokens ?? usage.reasoning_tokens) || 0;
  return {
    prompt_tokens: prompt,
    completion_tokens: completion,
    reasoning_tokens: reasoning,
    total_tokens: Number(usage.total_tokens) || prompt + completion,
    raw: usage,
  };
}

/** Fields common to both a `message` and a `delta` object. */
function extract(node = {}) {
  const reasoningDetails = Array.isArray(node.reasoning_details)
    ? node.reasoning_details.map((d) => (typeof d?.text === "string" ? d.text : "")).join("")
    : "";
  return {
    content: reasonText(node.content),
    reasoning: reasonText(node.reasoning) || reasoningDetails,
    toolCalls: Array.isArray(node.tool_calls) ? node.tool_calls : null,
  };
}

/** Decode one streamed chunk. */
export function extractChunk(payload) {
  if (!payload || typeof payload !== "object") return null;
  if (payload.error) {
    return {
      error: payload.error,
      message: payload.error.message || payload.error.detail || JSON.stringify(payload.error),
    };
  }
  const choice = payload.choices?.[0] || {};
  return {
    ...extract(choice.delta || {}),
    finishReason: choice.finish_reason ?? null,
    usage: normalizeUsage(payload.usage),
    model: payload.model ?? null,
    id: payload.id ?? null,
  };
}

/** Decode a non-streamed completion. */
export function extractCompletion(payload) {
  if (!payload || typeof payload !== "object") return null;
  if (payload.error) {
    return {
      error: payload.error,
      message: payload.error.message || payload.error.detail || JSON.stringify(payload.error),
    };
  }
  const choice = payload.choices?.[0] || {};
  return {
    ...extract(choice.message || {}),
    finishReason: choice.finish_reason ?? null,
    usage: normalizeUsage(payload.usage),
    model: payload.model ?? null,
    id: payload.id ?? null,
  };
}
