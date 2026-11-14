/**
 * CLI for the Venice.ai web-agent client.
 *
 * Exit codes: 0 success, 1 request failed, 2 usage error.
 */

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
  DEFAULT_FRONTEND_VERSION,
  DEFAULT_MIDDLEFACE_VERSION,
  DEFAULT_STREAM_IDLE_TIMEOUT_MS,
  DEFAULT_TIMEOUT_MS,
  PROVIDER,
} from "./constants.js";
import { VeniceClient } from "./client.js";

export const VERSION = "0.1.0";

export const HELP = `Usage: venice <prompt> [options]
       venice - [options]                 (read the prompt from stdin)
       venice --models | --rate-limits

Venice agent inference via client attestation. Automated/webdriver runtimes
are typically rejected (DOCS.md); successful SSE schemas are not yet fully
captured, so raw frames are preserved in --json output.

Options:
      --frontend-version <v>  x-venice-version (default: ${DEFAULT_FRONTEND_VERSION})
      --middleface <v>        x-venice-middleface-version (default: ${DEFAULT_MIDDLEFACE_VERSION})
      --locale <code>         x-venice-locale (default: en)
      --distinct-id <id>      x-venice-distinct-id
      --webdriver             Set env.webdriver true (for testing attestation rejection)
      --timeout <ms>          Header/request timeout (default: ${DEFAULT_TIMEOUT_MS})
      --idle-timeout <ms>     Abort a stalled stream (default: ${DEFAULT_STREAM_IDLE_TIMEOUT_MS})
      --retries <n>           Retry/re-mint on 401/403 or empty stream (default: 0)
      --models                Print the app model catalog
      --rate-limits           Print inference rate limits
      --json                  Print the structured result (includes rawFrames)
      --stream                Print extracted text deltas live
      --out <path>            Write rendered output to a file
      --quiet                 Suppress diagnostics on stderr
  -v, --version               Print version
  -h, --help                  Show this help`;

export function parseArgs(argv) {
  const out = {
    promptParts: [],
    prompt: "",
    frontendVersion: DEFAULT_FRONTEND_VERSION,
    middlefaceVersion: DEFAULT_MIDDLEFACE_VERSION,
    locale: "en",
    distinctId: null,
    webdriver: false,
    timeoutMs: null,
    idleTimeoutMs: null,
    retries: 0,
    listModels: false,
    rateLimits: false,
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
    if (a === "--frontend-version") out.frontendVersion = takeValue(argv, ++i, a);
    else if (a === "--middleface") out.middlefaceVersion = takeValue(argv, ++i, a);
    else if (a === "--locale") out.locale = takeValue(argv, ++i, a);
    else if (a === "--distinct-id") out.distinctId = takeValue(argv, ++i, a);
    else if (a === "--webdriver") out.webdriver = true;
    else if (a === "--timeout") out.timeoutMs = parsePositiveInt(takeValue(argv, ++i, a), a);
    else if (a === "--idle-timeout") out.idleTimeoutMs = parseNonNegativeInt(takeValue(argv, ++i, a), a);
    else if (a === "--retries") out.retries = parseNonNegativeInt(takeValue(argv, ++i, a), a);
    else if (a === "--models") out.listModels = true;
    else if (a === "--rate-limits") out.rateLimits = true;
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
    hasInput: !!args.prompt || args.readStdin || args.listModels || args.rateLimits,
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

  const client = new VeniceClient({
    frontendVersion: args.frontendVersion,
    middlefaceVersion: args.middlefaceVersion,
    locale: args.locale,
    distinctId: args.distinctId,
    env: { webdriver: args.webdriver },
    timeoutMs: args.timeoutMs || undefined,
    streamIdleTimeoutMs: args.idleTimeoutMs ?? DEFAULT_STREAM_IDLE_TIMEOUT_MS,
    retries: args.retries,
  });

  if (args.listModels || args.rateLimits) {
    try {
      const data = args.listModels ? await client.listModels() : await client.rateLimits();
      await emitOutput(JSON.stringify(data, null, 2), { out: args.out, diagnostics });
      return EXIT_CODES.OK;
    } catch (e) {
      process.stderr.write(`${args.json ? JSON.stringify(errorPayload(e), null, 2) : formatErrorLine(e)}\n`);
      return EXIT_CODES.FAILURE;
    }
  }

  const printer = createLivePrinter(args.live && !args.json);
  let result;
  try {
    result = await client.chat({
      prompt: args.prompt,
      onEvent: (event) => printer.onEvent(event),
      onRetry: args.quiet
        ? undefined
        : ({ attempt, retries, error }) =>
            diagnostics(`[retry ${attempt}/${retries}] ${error.code} — ${error.message}`),
    });
  } catch (e) {
    process.stderr.write(`${args.json ? JSON.stringify(errorPayload(e), null, 2) : formatErrorLine(e)}\n`);
    return EXIT_CODES.FAILURE;
  }
  printer.end();

  if (args.json) {
    await emitOutput(JSON.stringify(jsonView(result, { includeRaw: true }), null, 2), { out: args.out, diagnostics });
    return result.ok ? EXIT_CODES.OK : EXIT_CODES.FAILURE;
  }

  if (args.live) {
    if (!printer.wrote && result.answer) process.stdout.write(result.answer.endsWith("\n") ? result.answer : `${result.answer}\n`);
    for (const w of result.warnings || []) diagnostics(`[warning] ${w}`);
    if (!result.ok) diagnostics(`[error] ${formatErrorLine(result.errorInfo || result.error)}`);
    return result.ok ? EXIT_CODES.OK : EXIT_CODES.FAILURE;
  }

  if (result.ok) {
    await emitOutput(result.answer || "(no text extracted — try --json for raw frames)", { out: args.out, diagnostics });
    for (const w of result.warnings || []) diagnostics(`[warning] ${w}`);
    return EXIT_CODES.OK;
  }

  process.stderr.write(`${JSON.stringify(errorPayload(result.errorInfo || result), null, 2)}\n`);
  return EXIT_CODES.FAILURE;
}

export { PROVIDER };
