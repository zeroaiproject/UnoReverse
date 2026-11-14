#!/usr/bin/env node
/**
 * BraveSearchAPI.js — compatibility entry point.
 *
 * The implementation now lives in ./src (constants, errors, http, conversation,
 * stream, search, client, result, tools, cli). This file keeps the historical
 * import path and the `node BraveSearchAPI.js "<query>"` CLI working:
 *
 *   import { braveLeoSearch } from "./AI/BraveLeo/BraveSearchAPI.js";
 *   node AI/BraveLeo/BraveSearchAPI.js "latest Node.js LTS" --stream
 *
 * See DOCS.md for the observed protocol and the options reference.
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
  // No top-level await: keeping this module synchronous lets CJS `require()` it.
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
