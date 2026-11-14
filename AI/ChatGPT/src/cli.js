/**
 * CLI for the ChatGPT web (unauth-mweb) client.
 *
 * Exit codes: 0 success, 1 request failed, 2 usage error.
 */

import { readFile } from "node:fs/promises";

import {
  EXIT_CODES,
  createLivePrinter,
  emitOutput,
  errorPayload,
  formatErrorLine,
  handleMeta,
  jsonView,
  parseNonNegativeInt,
  parsePositiveInt,
  readStdinText,
  takeValue,
} from "../../../lib/cli.js";
import {
  DEFAULT_STREAM_IDLE_TIMEOUT_MS,
  DEFAULT_TIMEOUT_MS,
  INITIAL_CONVERSATION_STATE,
  PROVIDER,
} from "./constants.js";
import { ChatGPTClient } from "./client.js";

export const VERSION = "0.1.0";

export const HELP = `Usage: chatgpt <prompt> [options]
       chatgpt - [options]                (read the prompt from stdin)

Unauthenticated web client (unauth-mweb). The anti-abuse tokens are generated
by browser code that was not reverse-engineered: pass them explicitly, or pass
--sentinel-p and let the client run prepare/finalize.

Options:
      --session-id <uuid>       oai-session-id (default: random; env: CHATGPT_SESSION_ID)
      --requirements-token <t>  chatRequirementsToken (env: CHATGPT_REQUIREMENTS_TOKEN)
      --proof-token <t>         proofToken (env: CHATGPT_PROOF_TOKEN)
      --turnstile-token <t>     turnstileToken (env: CHATGPT_TURNSTILE_TOKEN)
      --tokens <json|@file>     All three at once
      --sentinel-p <blob>       Obfuscated sentinel payload for prepare()
      --prepare-token <t>       Reuse a prepare_token (skips prepare)
      --conversation-state <json|@file>
                                Prior conversation state (default: first turn)
      --timezone <tz>           Timezone string (default: UTC)
      --no-prepare              Skip conversation/prepare
      --no-finalize             Run sentinel prepare but not finalize
      --allow-missing-tokens    Submit with empty token fields (debugging)
      --timeout <ms>            Header/request timeout (default: ${DEFAULT_TIMEOUT_MS})
      --idle-timeout <ms>       Abort a stalled stream (default: ${DEFAULT_STREAM_IDLE_TIMEOUT_MS})
      --retries <n>             Retries for the prepare request (default: 0)
      --json                    Print the structured result
      --stream                  Print assistant deltas live
      --out <path>              Write rendered output to a file
      --quiet                   Suppress diagnostics on stderr
  -v, --version                 Print version
  -h, --help                    Show this help

Environment:
  CHATGPT_SESSION_ID
  CHATGPT_REQUIREMENTS_TOKEN
  CHATGPT_PROOF_TOKEN
  CHATGPT_TURNSTILE_TOKEN`;

export function parseArgs(argv, env = {}) {
  const out = {
    promptParts: [],
    prompt: "",
    sessionId: env.CHATGPT_SESSION_ID || null,
    tokens: {
      chatRequirementsToken: env.CHATGPT_REQUIREMENTS_TOKEN || null,
      proofToken: env.CHATGPT_PROOF_TOKEN || null,
      turnstileToken: env.CHATGPT_TURNSTILE_TOKEN || null,
    },
    tokensFile: null,
    sentinelP: env.CHATGPT_SENTINEL_P || null,
    prepareToken: null,
    conversationState: null,
    timezone: env.CHATGPT_TIMEZONE || "UTC",
    prepare: true,
    finalize: true,
    allowMissingTokens: false,
    timeoutMs: env.CHATGPT_TIMEOUT_MS ? Number(env.CHATGPT_TIMEOUT_MS) || null : null,
    idleTimeoutMs: null,
    retries: 0,
    json: false,
    live: false,
    out: null,
    quiet: false,
    readStdin: false,
    help: false,
    version: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--session-id") out.sessionId = takeValue(argv, ++i, a);
    else if (a === "--requirements-token") out.tokens.chatRequirementsToken = takeValue(argv, ++i, a);
    else if (a === "--proof-token") out.tokens.proofToken = takeValue(argv, ++i, a);
    else if (a === "--turnstile-token") out.tokens.turnstileToken = takeValue(argv, ++i, a);
    else if (a === "--tokens") out.tokensFile = takeValue(argv, ++i, a);
    else if (a === "--sentinel-p") out.sentinelP = takeValue(argv, ++i, a);
    else if (a === "--prepare-token") out.prepareToken = takeValue(argv, ++i, a);
    else if (a === "--conversation-state") out.conversationState = takeValue(argv, ++i, a);
    else if (a === "--timezone") out.timezone = takeValue(argv, ++i, a);
    else if (a === "--no-prepare") out.prepare = false;
    else if (a === "--no-finalize") out.finalize = false;
    else if (a === "--allow-missing-tokens") out.allowMissingTokens = true;
    else if (a === "--timeout") out.timeoutMs = parsePositiveInt(takeValue(argv, ++i, a), a);
    else if (a === "--idle-timeout") out.idleTimeoutMs = parseNonNegativeInt(takeValue(argv, ++i, a), a);
    else if (a === "--retries") out.retries = parseNonNegativeInt(takeValue(argv, ++i, a), a);
    else if (a === "--json") out.json = true;
    else if (a === "--stream") out.live = true;
    else if (a === "--out") out.out = takeValue(argv, ++i, a);
    else if (a === "--quiet") out.quiet = true;
    else if (a === "-v" || a === "--version") out.version = true;
    else if (a === "-h" || a === "--help") out.help = true;
    else if (a === "-") out.readStdin = true;
    else if (a.startsWith("--")) throw new Error(`unknown option: ${a}`);
    else out.promptParts.push(a);
  }

  out.prompt = out.promptParts.join(" ").trim();
  return out;
}

async function loadJsonArg(value, flag) {
  if (!value) return null;
  const raw = value.startsWith("@") ? await readFile(value.slice(1), "utf8") : value;
  try {
    return JSON.parse(raw);
  } catch (e) {
    throw new Error(`${flag} expects JSON (${e.message})`);
  }
}

export async function main(argv = process.argv.slice(2), env = process.env) {
  let args;
  try {
    args = parseArgs(argv, env);
  } catch (e) {
    process.stderr.write(`${e.message}\n\n${HELP}\n`);
    return EXIT_CODES.USAGE;
  }

  const meta = handleMeta(args, {
    help: HELP,
    version: VERSION,
    hasInput: !!args.prompt || args.readStdin,
  });
  if (meta !== null) return meta;

  if (args.readStdin && !args.prompt) {
    try {
      args.prompt = await readStdinText();
    } catch (e) {
      process.stderr.write(`failed to read stdin: ${e.message}\n`);
      return EXIT_CODES.USAGE;
    }
  }

  const diagnostics = (line) => {
    if (!args.quiet) process.stderr.write(`${line}\n`);
  };

  let tokens = args.tokens;
  let conversationState = args.conversationState;
  try {
    if (args.tokensFile) tokens = { ...tokens, ...(await loadJsonArg(args.tokensFile, "--tokens")) };
    if (conversationState) conversationState = await loadJsonArg(conversationState, "--conversation-state");
  } catch (e) {
    process.stderr.write(`${e.message}\n`);
    return EXIT_CODES.USAGE;
  }

  const client = new ChatGPTClient({
    sessionId: args.sessionId || undefined,
    tokens,
    sentinelP: args.sentinelP || undefined,
    timezone: args.timezone,
    retries: args.retries,
    timeoutMs: args.timeoutMs || undefined,
    streamIdleTimeoutMs: args.idleTimeoutMs ?? DEFAULT_STREAM_IDLE_TIMEOUT_MS,
  });

  const printer = createLivePrinter(args.live && !args.json);
  let result;
  try {
    result = await client.chat({
      prompt: args.prompt,
      tokens,
      prepare: args.prepare,
      finalize: args.finalize,
      prepareToken: args.prepareToken || undefined,
      conversationState: conversationState || INITIAL_CONVERSATION_STATE,
      allowMissingTokens: args.allowMissingTokens,
      onEvent: (event) => {
        printer.onEvent(event);
        if (!args.quiet && event.type === "warning") diagnostics(`[warning] ${event.message}`);
      },
      retries: args.retries,
    });
  } catch (e) {
    process.stderr.write(`${args.json ? JSON.stringify(errorPayload(e), null, 2) : formatErrorLine(e)}\n`);
    return EXIT_CODES.FAILURE;
  }
  printer.end();

  if (args.json) {
    await emitOutput(JSON.stringify(jsonView(result), null, 2), { out: args.out, diagnostics });
    return result.ok ? EXIT_CODES.OK : EXIT_CODES.FAILURE;
  }

  if (args.live) {
    if (!printer.wrote && result.answer) process.stdout.write(result.answer.endsWith("\n") ? result.answer : `${result.answer}\n`);
    if (result.conversationId) diagnostics(`[conversation] ${result.conversationId}`);
    for (const w of result.warnings || []) diagnostics(`[warning] ${w}`);
    if (!result.ok) diagnostics(`[error] ${formatErrorLine(result.errorInfo || result.error)}`);
    return result.ok ? EXIT_CODES.OK : EXIT_CODES.FAILURE;
  }

  if (result.ok) {
    const lines = [result.answer || "(empty answer)"];
    if (result.conversationId) lines.push(`\n[conversation] ${result.conversationId}`);
    await emitOutput(lines.join("\n"), { out: args.out, diagnostics });
    return EXIT_CODES.OK;
  }

  process.stderr.write(`${JSON.stringify(errorPayload(result.errorInfo || result), null, 2)}\n`);
  return EXIT_CODES.FAILURE;
}

export { PROVIDER };
