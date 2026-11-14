/**
 * Public surface of the Venice.ai web-agent client.
 */

export { VeniceClient, veniceChat, veniceChatOrThrow } from "./client.js";
export * from "./constants.js";
export { parseArgs, main, VERSION, HELP } from "./cli.js";
export { ERROR_CODES, ApiError } from "../../../lib/errors.js";
