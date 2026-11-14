#!/usr/bin/env node
/**
 * LumoAPI.js — compatibility entry point.
 *
 *   import { lumoChat } from "./AI/Lumo/LumoAPI.js";
 *   node AI/Lumo/LumoAPI.js "Reply with exactly: PONG" --json
 *
 * Guest session bootstrap and encrypted chat streaming are implemented in
 * ./src. Plaintext requires a browser-derived codec (see DOCS.md).
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
