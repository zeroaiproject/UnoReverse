/**
 * CLI for the anonymous Obscurify gateway.
 *
 * Exit codes: 0 success, 1 request failed, 2 usage error.
 */

import { readFile } from "node:fs/promises";

import {
  EXIT_CODES,
  buildMessages,
  createLivePrinter,
  emitOutput,
  errorPayload,
  formatErrorLine,
  handleMeta,
  jsonView,
  parseMessageSpec,
  parseNonNegativeInt,
  parsePositiveInt,
  parseFiniteNumber,
  readStdinText,
  takeValue,
} from "../../../lib/cli.js";
import {
  DEFAULT_MODEL,
  DEFAULT_STREAM_IDLE_TIMEOUT_MS,
  DEFAULT_TIMEOUT_MS,
  PROVIDER,
} from "./constants.js";
import { ObscurifyClient, obscurifyChat } from "./client.js";

export const VERSION = "0.1.0";

export const HELP = `Usage: obscurify <prompt> [options]
       obscurify - [options]              (read the prompt from stdin)
       obscurify --models [--kind all|frontier|uncensored]
       obscurify --code-mode

Anonymous (guest) chat against obscurify.ai. No account, no API key.

Options:
  -m, --model <id>          Model id (default: ${DEFAULT_MODEL})
  -s, --system <text>       System prompt
      --message <role=text>  Add a turn before the prompt (repeatable)
      --thread <id>         Reuse an x-obscurify-thread id
  -t, --temperature <n>     Sampling temperature
      --top-p <n>           Nucleus sampling
      --max-tokens <n>      Output cap
      --tools <json|@file>  JSON array of tool declarations
      --extra <json|@file>  Extra body fields (merged last)
      --no-structured       Send string content instead of [{type:"text"}]
      --no-stream           Ask for a single JSON response
      --timeout <ms>        Header/request timeout (default: ${DEFAULT_TIMEOUT_MS})
      --idle-timeout <ms>   Abort a stalled stream (default: ${DEFAULT_STREAM_IDLE_TIMEOUT_MS}, 0 disables)
      --retries <n>         Retry transient/rate-limit failures (default: 0)
      --retry-delay <ms>    Base backoff delay (default: 500)
      --models              Print the model catalog
      --kind <all|frontier|uncensored>
      --code-mode           Print the tools/code-mode config
      --json                Print the structured result
      --stream              Print assistant deltas live
      --out <path>          Write rendered output to a file
      --show-thread         Include the thread id in text output
      --quiet               Suppress diagnostics on stderr
  -v, --version             Print version
  -h, --help                Show this help

Environment:
  OBSCURIFY_MODEL           Default model id
  OBSCURIFY_THREAD          Default thread id
  OBSCURIFY_TIMEOUT_MS      Default request timeout`;

export function parseArgs(argv, env = {}) {
  const out = {
    promptParts: [],
    prompt: "",
    messages: [],
    model: env.OBSCURIFY_MODEL || DEFAULT_MODEL,
    system: null,
    thread: env.OBSCURIFY_THREAD || null,
    temperature: undefined,
    topP: undefined,
    maxTokens: undefined,
    tools: null,
    extra: null,
    structuredContent: true,
    stream: true,
    timeoutMs: env.OBSCURIFY_TIMEOUT_MS ? Number(env.OBSCURIFY_TIMEOUT_MS) || null : null,
    idleTimeoutMs: null,
    retries: 0,
    retryDelayMs: null,
    listModels: false,
    kind: "all",
    codeMode: false,
    json: false,
    live: false,
    out: null,
    showThread: false,
    quiet: false,
    readStdin: false,
    help: false,
    version: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "-m" || a === "--model") out.model = takeValue(argv, ++i, a);
    else if (a === "-s" || a === "--system") out.system = takeValue(argv, ++i, a);
    else if (a === "--message") out.messages.push(parseMessageSpec(takeValue(argv, ++i, a)));
    else if (a === "--thread") out.thread = takeValue(argv, ++i, a);
    else if (a === "-t" || a === "--temperature") out.temperature = parseFiniteNumber(takeValue(argv, ++i, a), a);
    else if (a === "--top-p") out.topP = parseFiniteNumber(takeValue(argv, ++i, a), a);
    else if (a === "--max-tokens") out.maxTokens = parsePositiveInt(takeValue(argv, ++i, a), a);
    else if (a === "--tools") out.tools = takeValue(argv, ++i, a);
    else if (a === "--extra") out.extra = takeValue(argv, ++i, a);
    else if (a === "--no-structured") out.structuredContent = false;
    else if (a === "--no-stream") out.stream = false;
    else if (a === "--timeout") out.timeoutMs = parsePositiveInt(takeValue(argv, ++i, a), a);
    else if (a === "--idle-timeout") out.idleTimeoutMs = parseNonNegativeInt(takeValue(argv, ++i, a), a);
    else if (a === "--retries") out.retries = parseNonNegativeInt(takeValue(argv, ++i, a), a);
    else if (a === "--retry-delay") out.retryDelayMs = parsePositiveInt(takeValue(argv, ++i, a), a);
    else if (a === "--models") out.listModels = true;
    else if (a === "--kind") out.kind = takeValue(argv, ++i, a);
    else if (a === "--code-mode") out.codeMode = true;
    else if (a === "--json") out.json = true;
    else if (a === "--stream") out.live = true;
    else if (a === "--out") out.out = takeValue(argv, ++i, a);
    else if (a === "--show-thread") out.showThread = true;
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
    hasInput: !!args.prompt || args.readStdin || args.listModels || args.codeMode,
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

  const client = new ObscurifyClient({
    model: args.model,
    timeoutMs: args.timeoutMs || undefined,
    streamIdleTimeoutMs: args.idleTimeoutMs ?? DEFAULT_STREAM_IDLE_TIMEOUT_MS,
    retries: args.retries,
    retryDelayMs: args.retryDelayMs || undefined,
    structuredContent: args.structuredContent,
  });

  if (args.listModels || args.codeMode) {
    try {
      const data = args.codeMode ? await client.codeMode() : await client.listModels({ kind: args.kind });
      await emitOutput(JSON.stringify(data, null, 2), { out: args.out, diagnostics });
      return EXIT_CODES.OK;
    } catch (e) {
      process.stderr.write(`${args.json ? JSON.stringify(errorPayload(e), null, 2) : formatErrorLine(e)}\n`);
      return EXIT_CODES.FAILURE;
    }
  }

  let tools;
  let extra;
  try {
    tools = await loadJsonArg(args.tools, "--tools");
    extra = await loadJsonArg(args.extra, "--extra");
  } catch (e) {
    process.stderr.write(`${e.message}\n`);
    return EXIT_CODES.USAGE;
  }

  const messages = buildMessages({ messages: args.messages, system: args.system, prompt: args.prompt });
  if (!messages.length) {
    process.stderr.write(`nothing to send\n\n${HELP}\n`);
    return EXIT_CODES.USAGE;
  }

  const printer = createLivePrinter(args.live && !args.json);
  let result;
  try {
    result = await obscurifyChat({
      client,
      messages,
      model: args.model,
      thread: args.thread,
      tools: tools || undefined,
      extra: extra || undefined,
      temperature: args.temperature,
      topP: args.topP,
      maxTokens: args.maxTokens,
      stream: args.stream,
      onEvent: (event) => printer.onEvent(event),
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
    if (result.thread) diagnostics(`[thread] ${result.thread}`);
    if (result.usage?.total_tokens) diagnostics(`[usage] ${JSON.stringify(result.usage)}`);
    for (const w of result.warnings || []) diagnostics(`[warning] ${w}`);
    if (!result.ok) diagnostics(`[error] ${formatErrorLine(result.errorInfo || result.error)}`);
    return result.ok ? EXIT_CODES.OK : EXIT_CODES.FAILURE;
  }

  if (result.ok) {
    const lines = [result.answer || "(empty answer)"];
    if (args.showThread && result.thread) lines.push(`\n[thread] ${result.thread}`);
    await emitOutput(lines.join("\n"), { out: args.out, diagnostics });
    if (!args.quiet && result.usage?.total_tokens) {
      diagnostics(`[usage] prompt=${result.usage.prompt_tokens} completion=${result.usage.completion_tokens}`);
    }
    return EXIT_CODES.OK;
  }

  process.stderr.write(`${JSON.stringify(errorPayload(result.errorInfo || result), null, 2)}\n`);
  return EXIT_CODES.FAILURE;
}

export { PROVIDER };
