/**
 * Result shaping: the full agent result, a compact variant for LLM context, and
 * plain-text formatting.
 */

import { emptySources, extractSources, uniqStrings } from "./stream.js";
import { redactResolution } from "./conversation.js";

/**
 * Build the normalized result object returned by `braveLeoSearch`.
 * Session cookies are never copied into the result unless `includeCookies` is
 * set — results end up in logs, transcripts and tool messages.
 */
export function buildAgentResult({
  ok,
  query,
  conversation,
  resolution,
  stream,
  error,
  includeEvents = true,
  includeCookies = false,
  warnings = [],
}) {
  const base = {
    answer: (stream && stream.answer) || "",
    text: (stream && (stream.text || stream.answer)) || "",
    answerSource: (stream && stream.answerSource) ?? null,
    usage: (stream && stream.usage) || null,
    followups: (stream && stream.followups) || [],
    enrichments: (stream && stream.enrichments) || null,
    sources: (stream && stream.sources) || emptySources(),
    ...(includeEvents && stream && stream.events ? { events: stream.events } : {}),
  };
  const safeResolution = includeCookies ? resolution : redactResolution(resolution);
  const meta = {
    resolution: safeResolution || null,
    ...(stream
      ? {
          status: stream.status,
          contentType: stream.contentType,
          streamFormat: stream.streamFormat,
        }
      : {}),
    ...(includeCookies ? { cookies: (stream && stream.cookies) || null } : {}),
  };

  if (!ok) {
    const errObj = typeof error === "object" && error ? error : null;
    return {
      ok: false,
      query: query || null,
      conversation: (stream && stream.conversation) || conversation || null,
      ...base,
      error: errObj ? errObj.message || "Unknown error" : error || "Unknown error",
      errorInfo: errObj && errObj.code ? errObj : (stream && stream.errorInfo) || (errObj && errObj.errorInfo) || null,
      resolution: safeResolution || null,
      warnings,
      meta,
    };
  }

  return {
    ok: true,
    query: query || null,
    conversation: stream.conversation,
    ...base,
    resolution: safeResolution || null,
    warnings,
    meta,
  };
}

/** Compact result for LLM/tool context: no raw events, headers or cookies. */
export function compactResult(result, opts = {}) {
  if (!result || typeof result !== "object") return result;
  const maxSources = Number.isFinite(opts.maxSources) ? opts.maxSources : 10;
  const maxFollowups = Number.isFinite(opts.maxFollowups) ? opts.maxFollowups : 5;
  const src = result.sources || extractSources(result.enrichments);
  const citations = (src.citations || []).slice(0, maxSources);
  const sourceUrls = uniqStrings([...(src.all_urls || []), ...citations.map((c) => c && c.url).filter(Boolean)]).slice(
    0,
    maxSources
  );

  const compact = {
    ok: !!result.ok,
    query: result.query || null,
    conversation: result.conversation || null,
    answer: result.answer || result.text || "",
    followups: Array.isArray(result.followups) ? result.followups.slice(0, maxFollowups) : [],
    citations,
    sources: sourceUrls,
    usage: result.usage || null,
  };
  if (!result.ok) compact.error = result.error || "Unknown error";
  if (result.errorInfo) compact.errorInfo = result.errorInfo;
  if (result.status != null) compact.status = result.status;
  if (result.meta && result.meta.status != null) compact.status = result.meta.status;
  if (result.partial) compact.partial = true;
  if (src.main_entity) compact.main_entity = src.main_entity;
  if (Array.isArray(result.warnings) && result.warnings.length) compact.warnings = result.warnings;
  return compact;
}

/** Format a result as concise text for agent consumption. */
export function formatResultAsText(result, opts = {}) {
  if (!result) return "";
  if (!result.ok) return `Error: ${result.error || "request failed"}`;
  const parts = [];
  if (result.answer) parts.push(String(result.answer));
  const compact = compactResult(result, opts);

  if (compact.citations.length) {
    parts.push(
      "\nSources:\n" +
        compact.citations
          .map((c, i) => {
            const label = c.title ? `${c.title} — ${c.url || ""}` : c.url || c.text || JSON.stringify(c);
            const snippet = c.snippet ? `\n   ${String(c.snippet).slice(0, 180)}` : "";
            return `${i + 1}. ${label}${snippet}`;
          })
          .join("\n")
    );
  } else if (compact.sources.length) {
    parts.push(
      "\nSources:\n" +
        compact.sources.map((s, i) => `${i + 1}. ${typeof s === "string" ? s : JSON.stringify(s)}`).join("\n")
    );
  }

  if (compact.followups.length) {
    parts.push(
      "\nFollow-ups:\n" + compact.followups.map((f) => `- ${typeof f === "string" ? f : JSON.stringify(f)}`).join("\n")
    );
  }
  if (compact.warnings && compact.warnings.length) {
    parts.push("\nWarnings:\n" + compact.warnings.map((w) => `- ${w}`).join("\n"));
  }
  if (compact.partial) parts.push("\n[partial result — stream ended early]");
  return parts.join("\n");
}

/** Tool payload: compact fields plus a ready-to-send `content` string. */
export function makeToolPayload(result, opts = {}) {
  const compact = compactResult(result, opts);
  return { ...compact, content: formatResultAsText(result, opts) };
}
