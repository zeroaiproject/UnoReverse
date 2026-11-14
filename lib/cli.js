/**
 * CLI plumbing shared by every provider under `AI/`.
 *
 * Each provider keeps its own flag table (the protocols differ) but the
 * mechanics — stdin, message specs, numeric validation, output routing, exit
 * codes — live here so the five CLIs behave the same way.
 */

import { readFile, writeFile } from "node:fs/promises";
import { stdin as processStdin } from "node:process";

export const EXIT_CODES = Object.freeze({
  OK: 0,
  FAILURE: 1,
  USAGE: 2,
  INTERRUPTED: 130,
});

export const MESSAGE_ROLES = Object.freeze(["system", "user", "assistant", "tool"]);

/** Read all of stdin as trimmed UTF-8 (used by the `-` positional form). */
export async function readStdinText(stream = processStdin) {
  const chunks = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8").trim();
}

export function takeValue(argv, index, flag) {
  const value = argv[index];
  if (value === undefined) throw new Error(`missing value for ${flag}`);
  return value;
}

export function parsePositiveInt(raw, flag) {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) throw new Error(`${flag} expects a positive integer, got ${raw}`);
  return Math.floor(n);
}

export function parseNonNegativeInt(raw, flag) {
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) throw new Error(`${flag} expects a non-negative integer, got ${raw}`);
  return Math.floor(n);
}

export function parseFiniteNumber(raw, flag) {
  const n = Number(raw);
  if (!Number.isFinite(n)) throw new Error(`${flag} expects a number, got ${raw}`);
  return n;
}

/** `role=text` or `role:text` (first separator wins). */
export function parseMessageSpec(raw) {
  const spec = String(raw ?? "");
  const eq = spec.indexOf("=");
  const colon = spec.indexOf(":");
  let idx = -1;
  if (eq === -1) idx = colon;
  else if (colon === -1) idx = eq;
  else idx = Math.min(eq, colon);
  if (idx <= 0) throw new Error(`--message expects role=text, got ${spec}`);
  const role = spec.slice(0, idx).trim().toLowerCase();
  const content = spec.slice(idx + 1).trim();
  if (!MESSAGE_ROLES.includes(role)) {
    throw new Error(`unknown message role "${role}" (expected ${MESSAGE_ROLES.join(", ")})`);
  }
  if (!content) throw new Error(`empty message content for role ${role}`);
  return { role, content };
}

/**
 * Build the wire message list from `--message` specs plus an optional prompt.
 * A `--system` value is prepended once; a positional prompt becomes the last
 * user turn (after any explicit `user=` messages, which callers use for
 * conversation history).
 */
export function buildMessages({ messages = [], system, prompt } = {}) {
  const out = [];
  if (system != null && String(system).trim()) out.push({ role: "system", content: String(system) });
  for (const message of messages) {
    if (message && message.role && message.content != null) {
      out.push({ role: message.role, content: String(message.content) });
    }
  }
  if (prompt != null && String(prompt).trim()) out.push({ role: "user", content: String(prompt) });
  return out;
}

export function splitCsv(value) {
  if (!value) return [];
  return String(value)
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

export async function readTextFileOrNull(path, label = "file") {
  if (!path) return null;
  try {
    return (await readFile(path, "utf8")).trim();
  } catch (e) {
    throw new Error(`failed to read ${label} ${path}: ${e.message}`);
  }
}

/** JSON-safe error view; never leaks the stack. */
export function errorPayload(error) {
  if (!error) return { ok: false, error: "unknown error" };
  return {
    ok: false,
    error: error.message || String(error),
    code: error.code ?? null,
    status: error.status ?? null,
    retryable: error.retryable ?? null,
    hint: error.hint ?? null,
    details: error.details ?? null,
  };
}

export function formatErrorLine(error) {
  if (!error) return "error: unknown";
  const parts = [error.message || String(error)];
  if (error.code) parts.push(`(${error.code}${error.status ? `, HTTP ${error.status}` : ""})`);
  if (error.hint) parts.push(`— ${error.hint}`);
  return parts.join(" ");
}

/**
 * Live token printer for `--stream`. Only emits assistant text deltas; the
 * caller decides whether the final answer is printed again.
 */
export function createLivePrinter(enabled, out = process.stdout) {
  let wrote = false;
  return {
    get wrote() {
      return wrote;
    },
    onEvent(event) {
      if (!enabled || !event) return;
      if (event.type === "text_delta" && typeof event.delta === "string" && event.delta) {
        out.write(event.delta);
        wrote = true;
      }
    },
    end() {
      if (wrote) out.write("\n");
    },
  };
}

/** Write the rendered output, honouring `--out`, and report the write. */
export async function emitOutput(rendered, { out, diagnostics } = {}) {
  const text = String(rendered ?? "");
  if (!text) return;
  const withNewline = text.endsWith("\n") ? text : `${text}\n`;
  if (out) {
    await writeFile(out, withNewline, "utf8");
    diagnostics?.(`[out] wrote ${out}`);
    return;
  }
  process.stdout.write(withNewline);
}

export function formatBytes(n) {
  const value = Number(n) || 0;
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KiB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MiB`;
}

/** Common `--help`/`--version`/usage handling; returns an exit code or null. */
export function handleMeta(args, { help, version, hasInput }) {
  if (args.version) {
    process.stdout.write(`${version}\n`);
    return EXIT_CODES.OK;
  }
  if (args.help || !hasInput) {
    (args.help ? process.stdout : process.stderr).write(`${help}\n`);
    return args.help ? EXIT_CODES.OK : EXIT_CODES.USAGE;
  }
  return null;
}

/** Wrap `main` so Ctrl-C exits 130 without a stack trace. */
export function installSignalHandlers(controller) {
  const onSignal = () => {
    try {
      controller?.abort();
    } catch (_) {}
    process.exitCode = EXIT_CODES.INTERRUPTED;
  };
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);
  return () => {
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
  };
}

/**
 * Normalize a provider result into the CLI's JSON shape: the full result minus
 * fields the caller asked to hide (cookie headers, raw frames).
 */
export function jsonView(result, { includeEvents = false, includeRaw = false } = {}) {
  if (!result || typeof result !== "object") return result;
  const view = { ...result };
  if (!includeEvents) delete view.events;
  if (!includeRaw) {
    delete view.rawFrames;
    delete view.cookies;
    delete view.attestation;
  }
  if (view.meta && typeof view.meta === "object") {
    view.meta = { ...view.meta };
    if (!includeRaw) delete view.meta.cookies;
  }
  return view;
}
