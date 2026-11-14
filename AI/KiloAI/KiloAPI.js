#!/usr/bin/env node
/**
 * KiloAPI.js — compatibility entry point.
 *
 *   import { kiloChat } from "./AI/KiloAI/KiloAPI.js";
 *   node AI/KiloAI/KiloAPI.js "Explain how you work" --tor --stream
 *
 * See DOCS.md for the keyless gateway contract and the Tor rotation model.
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
