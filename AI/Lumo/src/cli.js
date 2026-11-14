/**
 * CLI for the Proton Lumo guest client.
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
  readStdinText,
  takeValue,
} from "../../../lib/cli.js";
import {
  DEFAULT_MODEL,
  DEFAULT_STREAM_IDLE_TIMEOUT_MS,
  DEFAULT_TIMEOUT_MS,
  PROVIDER,
} from "./constants.js";
import { LumoClient } from "./client.js";

export const VERSION = "0.1.0";

export const HELP = `Usage: lumo <prompt> [options]
       lumo - [options]                  (read the prompt from stdin)
       lumo --models | --limits

Guest Proton Lumo client. Completions are E2E-encrypted on the wire; without a
browser-derived codec this tool can bootstrap a session and exercise the
protocol, but plaintext answers require --codec/codec hook in code.

Options:
  -m, --model <id>        Model id (default: ${DEFAULT_MODEL})
  -s, --system <text>     System prompt
      --message <role=text> Add a turn before the prompt (repeatable)
      --reasoning <effort>  Reasoning effort (e.g. high)
      --target <name>       Lumo target (default: chat)
      --extra <json|@file>  Extra body fields (merged last)
      --no-stream           Ask for a single JSON response
      --timeout <ms>        Header/request timeout (default: ${DEFAULT_TIMEOUT_MS})
      --idle-timeout <ms>   Abort a stalled stream (default: ${DEFAULT_STREAM_IDLE_TIMEOUT_MS})
      --retries <n>         Retry transient failures (default: 0)
      --models              Print the model catalog
      --limits              Print session limits/quotas
      --json                Print the structured result
      --stream              Print assistant deltas live
      --out <path>          Write rendered output to a file
      --quiet               Suppress diagnostics on stderr
  -v, --version             Print version
  -h, --help                Show this help`;

export function parseArgs(argv) {
  const out = {
    promptParts: [],
    prompt: "",
    messages: [],
    model: DEFAULT_MODEL,
    system: null,
    reasoningEffort: null,
    target: "chat",
    extra: null,
    stream: true,
    timeoutMs: null,
    idleTimeoutMs: null,
    retries: 0,
    listModels: false,
    limits: false,
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
    if (a === "-m" || a === "--model") out.model = takeValue(argv, ++i, a);
    else if (a === "-s" || a === "--system") out.system = takeValue(argv, ++i, a);
    else if (a === "--message") out.messages.push(parseMessageSpec(takeValue(argv, ++i, a)));
    else if (a === "--reasoning") out.reasoningEffort = takeValue(argv, ++i, a);
    else if (a === "--target") out.target = takeValue(argv, ++i, a);
    else if (a === "--extra") out.extra = takeValue(argv, ++i, a);
    else if (a === "--no-stream") out.stream = false;
    else if (a === "--timeout") out.timeoutMs = parsePositiveInt(takeValue(argv, ++i, a), a);
    else if (a === "--idle-timeout") out.idleTimeoutMs = parseNonNegativeInt(takeValue(argv, ++i, a), a);
    else if (a === "--retries") out.retries = parseNonNegativeInt(takeValue(argv, ++i, a), a);
    else if (a === "--models") out.listModels = true;
    else if (a === "--limits") out.limits = true;
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

export async function main(argv = process.argv.slice(2)) {
  let args;
  try {
    args = parseArgs(argv);
  } catch (e) {
    process.stderr.write(`${e.message}\n\n${HELP}\n`);
    return EXIT_CODES.USAGE;
  }

  const meta = handleMeta(args, {
    help: HELP,
    version: VERSION,
    hasInput: !!args.prompt || args.readStdin || args.listModels || args.limits,
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

  const client = new LumoClient({
    timeoutMs: args.timeoutMs || undefined,
    streamIdleTimeoutMs: args.idleTimeoutMs ?? DEFAULT_STREAM_IDLE_TIMEOUT_MS,
    retries: args.retries,
  });

  if (args.listModels || args.limits) {
    try {
      const data = args.listModels ? await client.listModels() : await client.limits();
      await emitOutput(JSON.stringify(data, null, 2), { out: args.out, diagnostics });
      return EXIT_CODES.OK;
    } catch (e) {
      process.stderr.write(`${args.json ? JSON.stringify(errorPayload(e), null, 2) : formatErrorLine(e)}\n`);
      return EXIT_CODES.FAILURE;
    }
  }

  let extra;
  try {
    extra = await loadJsonArg(args.extra, "--extra");
  } catch (e) {
    process.stderr.write(`${e.message}\n`);
    return EXIT_CODES.USAGE;
  }

  const messages = buildMessages({ messages: args.messages, system: args.system, prompt: args.prompt });
  const printer = createLivePrinter(args.live && !args.json);
  let result;
  try {
    result = await client.chat({
      messages,
      model: args.model,
      reasoningEffort: args.reasoningEffort,
      target: args.target,
      extra: extra || undefined,
      stream: args.stream,
      onEvent: (event) => printer.onEvent(event),
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
    if (result.usage?.remaining_limits) diagnostics(`[limits] ${JSON.stringify(result.usage.remaining_limits)}`);
    for (const w of result.warnings || []) diagnostics(`[warning] ${w}`);
    if (!result.ok) diagnostics(`[error] ${formatErrorLine(result.errorInfo || result.error)}`);
    return result.ok ? EXIT_CODES.OK : EXIT_CODES.FAILURE;
  }

  if (result.ok) {
    await emitOutput(result.answer || "(empty answer)", { out: args.out, diagnostics });
    for (const w of result.warnings || []) diagnostics(`[warning] ${w}`);
    if (result.usage?.remaining_limits) diagnostics(`[limits] ${JSON.stringify(result.usage.remaining_limits)}`);
    return EXIT_CODES.OK;
  }

  process.stderr.write(`${JSON.stringify(errorPayload(result.errorInfo || result), null, 2)}\n`);
  return EXIT_CODES.FAILURE;
}

export { PROVIDER };
