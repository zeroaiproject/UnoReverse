#!/usr/bin/env node
/**
 * ChatGPTAPI.js — compatibility entry point.
 *
 *   import { chatGPTChat } from "./AI/ChatGPT/ChatGPTAPI.js";
 *   node AI/ChatGPT/ChatGPTAPI.js "Reply with exactly: PONG" --json
 *
 * The unauth-mweb protocol (sentinel, prepare, NDJSON stream) is documented in
 * DOCS.md. Anti-abuse tokens are browser-generated and must be supplied via
 * the `tokens` option or the `getRequirements` hook.
 */

import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";

import * as api from "./src/index.js";

export * from "./src/index.js";
export default api;

const isDirectRun = (() => {
  try {
    if (typeof process === "undefined" || !process.argv || !process.argv[1]) return false;
    return import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
  } catch (_) {
    return false;
  }
})();

if (isDirectRun) {
  import("./src/cli.js")
    .then(({ main }) => main(process.argv.slice(2)))
    .then((code) => {
      process.exitCode = code;
    })
    .catch((err) => {
      process.stderr.write(`${err && err.stack ? err.stack : err}\n`);
      process.exitCode = 1;
    });
}
