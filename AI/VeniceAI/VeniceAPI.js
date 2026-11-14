#!/usr/bin/env node
/**
 * VeniceAPI.js — compatibility entry point.
 *
 *   import { veniceChat } from "./AI/VeniceAI/VeniceAPI.js";
 *   node AI/VeniceAI/VeniceAPI.js "Reply with exactly: PONG" --json
 *
 * Attestation minting and agent inference are implemented in ./src.
 * See DOCS.md: automated environments may be rejected; raw frames are exposed.
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
