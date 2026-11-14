/**
 * Public surface of the Proton Lumo guest client.
 */

export { LumoClient, lumoChat, lumoChatOrThrow, lumoMessages, PASSTHROUGH_CODEC } from "./client.js";
export * from "./constants.js";
export { parseArgs, main, VERSION, HELP } from "./cli.js";
export { ERROR_CODES, ApiError } from "../../../lib/errors.js";
