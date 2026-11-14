/**
 * CLI for the Kilo AI anonymous gateway.
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
  parseFiniteNumber,
  parseMessageSpec,
  parseNonNegativeInt,
  parsePositiveInt,
  readStdinText,
  takeValue,
} from "../../../lib/cli.js";
import {
  DEFAULT_MODEL,
  DEFAULT_SOCKS_PROXY,
  DEFAULT_STREAM_IDLE_TIMEOUT_MS,
  DEFAULT_TIMEOUT_MS,
  PROVIDER,
} from "./constants.js";
import { KiloClient } from "./client.js";

export const VERSION = "0.1.0";

export const HELP = `Usage: kilo <prompt> [options]
       kilo - [options]                   (read the prompt from stdin)
       kilo --models

Keyless OpenAI-compatible gateway. For the documented Tor workflow pass --tor.

Options:
  -m, --model <id>        Model id (default: ${DEFAULT_MODEL})
  -s, --system <text>     System prompt
      --message <role=text> Add a turn before the prompt (repeatable)
  -t, --temperature <n>   Sampling temperature
      --top-p <n>         Nucleus sampling
      --max-tokens <n>    Output cap
      --reasoning <effort> Reasoning effort (none|low|medium|high)
      --extra <json|@file> Extra body fields (merged last)
      --no-stream         Ask for a single JSON response
      --timeout <ms>      Header/request timeout (default: ${DEFAULT_TIMEOUT_MS})
      --idle-timeout <ms> Abort a stalled stream (default: ${DEFAULT_STREAM_IDLE_TIMEOUT_MS})
      --retries <n>       Retry transient/rate-limit failures (default: 0)
      --retry-delay <ms>  Base backoff delay (default: 500)

Proxy / Tor:
      --proxy <url>       SOCKS5/HTTP proxy (default: none; env: KILO_PROXY)
      --tor               Use ${DEFAULT_SOCKS_PROXY} + rotate on 429/403
      --no-rotate         Keep the proxy but do not renew the Tor circuit
      --tor-host <host>   Tor control host (default: 127.0.0.1)
      --tor-port <port>   Tor control port (default: 9051)
      --tor-password <pw> Tor control password
      --tor-cookie <path> Tor cookie auth file

Output:
      --json              Print the structured result
      --stream            Print assistant deltas live
      --out <path>        Write rendered output to a file
      --quiet             Suppress diagnostics on stderr
  -v, --version           Print version
  -h, --help              Show this help

Environment:
  KILO_MODEL              Default model id
  KILO_PROXY              Default proxy URL
  KILO_TOR_CONTROL        Default Tor control endpoint (host:port)`;

export function parseArgs(argv, env = {}) {
  const out = {
    promptParts: [],
    prompt: "",
    messages: [],
    model: env.KILO_MODEL || DEFAULT_MODEL,
    system: null,
    temperature: undefined,
    topP: undefined,
    maxTokens: undefined,
    reasoningEffort: undefined,
    extra: null,
    stream: true,
    timeoutMs: env.KILO_TIMEOUT_MS ? Number(env.KILO_TIMEOUT_MS) || null : null,
    idleTimeoutMs: null,
    retries: 0,
    retryDelayMs: null,
    proxy: env.KILO_PROXY || null,
    tor: false,
    rotate: null,
    torHost: null,
    torPort: null,
    torPassword: env.KILO_TOR_PASSWORD || null,
    torCookie: env.KILO_TOR_COOKIE || null,
    listModels: false,
    json: false,
    live: false,
    out: null,
    quiet: false,
    readStdin: false,
    help: false,
    version: false,
  };

  if (env.KILO_TOR_CONTROL) {
    const [host, port] = String(env.KILO_TOR_CONTROL).split(":");
    out.torHost = host || null;
    out.torPort = port ? Number(port) : null;
  }

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "-m" || a === "--model") out.model = takeValue(argv, ++i, a);
    else if (a === "-s" || a === "--system") out.system = takeValue(argv, ++i, a);
    else if (a === "--message") out.messages.push(parseMessageSpec(takeValue(argv, ++i, a)));
    else if (a === "-t" || a === "--temperature") out.temperature = parseFiniteNumber(takeValue(argv, ++i, a), a);
    else if (a === "--top-p") out.topP = parseFiniteNumber(takeValue(argv, ++i, a), a);
    else if (a === "--max-tokens") out.maxTokens = parsePositiveInt(takeValue(argv, ++i, a), a);
    else if (a === "--reasoning") out.reasoningEffort = takeValue(argv, ++i, a);
    else if (a === "--extra") out.extra = takeValue(argv, ++i, a);
    else if (a === "--no-stream") out.stream = false;
    else if (a === "--timeout") out.timeoutMs = parsePositiveInt(takeValue(argv, ++i, a), a);
    else if (a === "--idle-timeout") out.idleTimeoutMs = parseNonNegativeInt(takeValue(argv, ++i, a), a);
    else if (a === "--retries") out.retries = parseNonNegativeInt(takeValue(argv, ++i, a), a);
    else if (a === "--retry-delay") out.retryDelayMs = parsePositiveInt(takeValue(argv, ++i, a), a);
    else if (a === "--proxy") out.proxy = takeValue(argv, ++i, a);
    else if (a === "--tor") {
      out.tor = true;
      out.proxy = out.proxy || DEFAULT_SOCKS_PROXY;
    } else if (a === "--no-rotate") out.rotate = false;
    else if (a === "--tor-host") out.torHost = takeValue(argv, ++i, a);
    else if (a === "--tor-port") out.torPort = parsePositiveInt(takeValue(argv, ++i, a), a);
    else if (a === "--tor-password") out.torPassword = takeValue(argv, ++i, a);
    else if (a === "--tor-cookie") out.torCookie = takeValue(argv, ++i, a);
    else if (a === "--models") out.listModels = true;
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
    hasInput: !!args.prompt || args.readStdin || args.listModels,
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

  const tor =
    args.tor || args.torHost || args.torPort
      ? {
          host: args.torHost || undefined,
          port: args.torPort || undefined,
          password: args.torPassword || undefined,
          cookiePath: args.torCookie || undefined,
        }
      : null;

  const client = new KiloClient({
    model: args.model,
    proxy: args.proxy,
    tor,
    rotateOnRateLimit: args.rotate === false ? false : undefined,
    timeoutMs: args.timeoutMs || undefined,
    streamIdleTimeoutMs: args.idleTimeoutMs ?? DEFAULT_STREAM_IDLE_TIMEOUT_MS,
    retries: args.retries,
    retryDelayMs: args.retryDelayMs || undefined,
  });

  if (args.listModels) {
    try {
      const models = await client.listModels();
      await emitOutput(JSON.stringify(models, null, 2), { out: args.out, diagnostics });
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
  if (!messages.length) {
    process.stderr.write(`nothing to send\n\n${HELP}\n`);
    return EXIT_CODES.USAGE;
  }

  const printer = createLivePrinter(args.live && !args.json);
  let result;
  try {
    result = await client.chat({
      messages,
      model: args.model,
      temperature: args.temperature,
      topP: args.topP,
      maxTokens: args.maxTokens,
      reasoningEffort: args.reasoningEffort,
      extra: extra || undefined,
      stream: args.stream,
      onEvent: (event) => printer.onEvent(event),
      onRetry: args.quiet
        ? undefined
        : ({ attempt, retries, waitMs, error }) =>
            diagnostics(`[retry ${attempt}/${retries}] ${error.code} in ${waitMs}ms — ${error.message}`),
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
    if (result.meta?.proxy) diagnostics(`[proxy] ${result.meta.proxy} (rotations: ${result.meta.torRotations})`);
    if (result.usage?.total_tokens) diagnostics(`[usage] ${JSON.stringify(result.usage)}`);
    for (const w of result.warnings || []) diagnostics(`[warning] ${w}`);
    if (!result.ok) diagnostics(`[error] ${formatErrorLine(result.errorInfo || result.error)}`);
    return result.ok ? EXIT_CODES.OK : EXIT_CODES.FAILURE;
  }

  if (result.ok) {
    await emitOutput(result.answer || "(empty answer)", { out: args.out, diagnostics });
    if (!args.quiet) {
      if (result.meta?.proxy) diagnostics(`[proxy] ${result.meta.proxy} (rotations: ${result.meta.torRotations})`);
      if (result.usage?.total_tokens) {
        diagnostics(`[usage] prompt=${result.usage.prompt_tokens} completion=${result.usage.completion_tokens}`);
      }
    }
    return EXIT_CODES.OK;
  }

  process.stderr.write(`${JSON.stringify(errorPayload(result.errorInfo || result), null, 2)}\n`);
  return EXIT_CODES.FAILURE;
}

export { PROVIDER };
