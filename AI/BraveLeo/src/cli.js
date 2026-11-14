/**
 * CLI for BraveSearchAPI.js / `brave-leo`.
 *
 * Exit codes: 0 success, 1 request failed, 2 usage error.
 */

import { readFile, writeFile } from "node:fs/promises";
import { stdin as processStdin } from "node:process";

import { DEFAULT_STREAM_IDLE_TIMEOUT_MS } from "./constants.js";
import { compactResult, formatResultAsText } from "./result.js";
import { braveLeoSearch } from "./search.js";

export const VERSION = "0.2.0";

export const HELP = `Usage: brave-leo <query> [options]
       brave-leo --conversation <id> [options]
       brave-leo - [options]           (read the query from stdin)

Options:
  -c, --conversation <id>   Stream a known Brave chatllm conversation id
  -q, --query <text>        Query text (alternative to the positional form)
      --source <src>        Brave search source (default: web)
      --cookies <header>    Cookie header for session continuity (env: BRAVE_COOKIES)
      --cookie-file <path>  Read the cookie header from a file
      --timeout <ms>        Whole-request timeout in ms (default: 30000)
      --idle-timeout <ms>   Abort when a stream stalls for this long (default: 45000, 0 disables)
      --retries <n>         Retry transient/rate-limit failures (default: 0)
      --retry-delay <ms>    Base backoff delay in ms (default: 500)
      --no-inline-entities  Disable inline entity/enrichment request
      --stream              Print answer deltas live while streaming
      --text                Force plain-text output (default when not --json/--compact)
      --compact             Print compact LLM-friendly JSON
      --json                Print full structured JSON result
      --out <path>          Write the rendered output to a file instead of stdout
      --show-cookies        Include the session cookie header in JSON output (sensitive)
      --quiet               Suppress diagnostics on stderr
      --max-sources <n>     Max citations in text output (default: 10)
  -v, --version             Print version
  -h, --help                Show this help

Environment:
  BRAVE_CONVERSATION        Default conversation id
  BRAVE_COOKIES             Default cookie header
  BRAVE_TIMEOUT_MS          Default request timeout
  BRAVE_LEO_DEBUG           Set to 1 to dump retry diagnostics to stderr`;

/** Parse argv into an options object (exported for tests). */
export function parseArgs(argv, env = {}) {
  const out = {
    queryParts: [],
    query: "",
    conversation: env.BRAVE_CONVERSATION || null,
    source: "web",
    json: false,
    text: false,
    stream: false,
    compact: false,
    noEntities: false,
    cookies: env.BRAVE_COOKIES || null,
    cookieFile: null,
    timeoutMs: env.BRAVE_TIMEOUT_MS ? Number(env.BRAVE_TIMEOUT_MS) || null : null,
    idleTimeoutMs: null,
    retries: 0,
    retryDelayMs: null,
    out: null,
    showCookies: false,
    quiet: false,
    maxSources: 10,
    help: false,
    version: false,
    readStdin: false,
  };

  const value = (i, name) => {
    const v = argv[i];
    if (v === undefined) throw new Error(`missing value for ${name}`);
    return v;
  };

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--conversation" || a === "-c") out.conversation = value(++i, a);
    else if (a === "--query" || a === "-q") out.queryParts.push(value(++i, a));
    else if (a === "--json") out.json = true;
    else if (a === "--text") out.text = true;
    else if (a === "--stream") out.stream = true;
    else if (a === "--compact") out.compact = true;
    else if (a === "--no-inline-entities") out.noEntities = true;
    else if (a === "--source") out.source = value(++i, a) || "web";
    else if (a === "--cookies") out.cookies = value(++i, a);
    else if (a === "--cookie-file") out.cookieFile = value(++i, a);
    else if (a === "--timeout") out.timeoutMs = positiveInt(value(++i, a), a);
    else if (a === "--idle-timeout") out.idleTimeoutMs = nonNegativeInt(value(++i, a), a);
    else if (a === "--retries") out.retries = nonNegativeInt(value(++i, a), a);
    else if (a === "--retry-delay") out.retryDelayMs = positiveInt(value(++i, a), a);
    else if (a === "--out") out.out = value(++i, a);
    else if (a === "--show-cookies") out.showCookies = true;
    else if (a === "--quiet") out.quiet = true;
    else if (a === "--max-sources") out.maxSources = positiveInt(value(++i, a), a);
    else if (a === "--help" || a === "-h") out.help = true;
    else if (a === "--version" || a === "-v") out.version = true;
    else if (a === "-") out.readStdin = true;
    else if (a.startsWith("--")) throw new Error(`unknown option: ${a}`);
    else out.queryParts.push(a);
  }

  out.query = out.queryParts.join(" ").trim();
  return out;
}

function positiveInt(raw, flag) {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) throw new Error(`${flag} expects a positive integer, got ${raw}`);
  return Math.floor(n);
}

function nonNegativeInt(raw, flag) {
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) throw new Error(`${flag} expects a non-negative integer, got ${raw}`);
  return Math.floor(n);
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of processStdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8").trim();
}

/** Run the CLI. Returns the process exit code. */
export async function main(argv = process.argv.slice(2), env = process.env) {
  let args;
  try {
    args = parseArgs(argv, env);
  } catch (e) {
    process.stderr.write(`${e.message}\n\n${HELP}\n`);
    return 2;
  }

  if (args.version) {
    process.stdout.write(`${VERSION}\n`);
    return 0;
  }
  if (args.help || (!args.query && !args.conversation && !args.readStdin)) {
    process.stderr.write(`${HELP}\n`);
    return args.help ? 0 : 2;
  }

  if (args.readStdin && !args.query) {
    try {
      args.query = await readStdin();
    } catch (e) {
      process.stderr.write(`failed to read stdin: ${e.message}\n`);
      return 2;
    }
  }

  let cookies = args.cookies;
  if (!cookies && args.cookieFile) {
    try {
      cookies = (await readFile(args.cookieFile, "utf8")).trim();
    } catch (e) {
      process.stderr.write(`failed to read cookie file: ${e.message}\n`);
      return 2;
    }
  }

  const diagnostics = (line) => {
    if (!args.quiet) process.stderr.write(`${line}\n`);
  };
  const debug = env.BRAVE_LEO_DEBUG === "1";

  let live = "";
  const onEvent =
    args.stream && !args.json
      ? (ev) => {
          if (ev && ev.type === "text_delta" && typeof ev.delta === "string") {
            process.stdout.write(ev.delta);
            live += ev.delta;
          }
        }
      : undefined;

  let out;
  try {
    out = await braveLeoSearch({
      query: args.query || undefined,
      conversation: args.conversation || undefined,
      enableInlineEntities: !args.noEntities,
      source: args.source,
      cookies: cookies || undefined,
      timeoutMs: args.timeoutMs || undefined,
      streamIdleTimeoutMs: args.idleTimeoutMs ?? DEFAULT_STREAM_IDLE_TIMEOUT_MS,
      retries: args.retries,
      retryDelayMs: args.retryDelayMs || undefined,
      includeEvents: !args.compact,
      includeCookies: args.showCookies,
      onEvent,
      onRetry: debug
        ? ({ attempt, retries, waitMs, error }) =>
            diagnostics(`[retry ${attempt}/${retries}] ${error.code} in ${waitMs}ms — ${error.message}`)
        : undefined,
    });
  } catch (e) {
    process.stderr.write(`${JSON.stringify({ ok: false, error: e.message, code: e.code }, null, 2)}\n`);
    return 1;
  }

  const view = args.compact ? compactResult(out, { maxSources: args.maxSources }) : out;
  const chunks = [];
  const writeOut = (s) => chunks.push(s.endsWith("\n") ? s : `${s}\n`);

  if (args.json) {
    writeOut(JSON.stringify(view, null, 2));
  } else if (args.stream) {
    if (!live && (view.answer || out.answer)) process.stdout.write(view.answer || out.answer);
    process.stdout.write("\n");
    if (out.conversation) diagnostics(`[conversation] ${out.conversation}`);
    if (out.followups && out.followups.length) diagnostics(`[followups] ${JSON.stringify(out.followups)}`);
    const sources = (view.sources || out.sources?.all_urls || []).slice(0, args.maxSources);
    if (sources.length) diagnostics(`[sources] ${JSON.stringify(sources)}`);
    for (const w of out.warnings || []) diagnostics(`[warning] ${w}`);
    if (!out.ok) diagnostics(`[error] ${out.error}`);
  } else if (out.ok) {
    if (args.compact) writeOut(JSON.stringify(view, null, 2));
    else {
      writeOut(formatResultAsText(out, { maxSources: args.maxSources }));
      if (out.conversation) diagnostics(`[conversation] ${out.conversation}`);
    }
  } else {
    process.stderr.write(`${JSON.stringify(view, null, 2)}\n`);
  }

  const rendered = chunks.join("");
  if (args.out && rendered) {
    try {
      await writeFile(args.out, rendered, "utf8");
      diagnostics(`[out] wrote ${args.out}`);
    } catch (e) {
      process.stderr.write(`failed to write ${args.out}: ${e.message}\n`);
      return 1;
    }
  } else if (rendered) {
    process.stdout.write(rendered);
  }

  return out.ok ? 0 : 1;
}
