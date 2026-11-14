#!/usr/bin/env node
/**
 * ObscurifyAPI.js — compatibility entry point.
 *
 *   import { obscurifyChat } from "./AI/Obscurify/ObscurifyAPI.js";
 *   node AI/Obscurify/ObscurifyAPI.js "Reply with exactly: PONG" --stream
 *
 * Protocol notes and the endpoint contract live in DOCS.md; the client itself
 * is implemented in ./src (constants, client, cli, index).
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
