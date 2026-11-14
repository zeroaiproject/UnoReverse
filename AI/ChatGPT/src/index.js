/**
 * Public surface of the ChatGPT (unauth-mweb) client.
 */

export { ChatGPTClient, chatGPTChat, chatGPTChatOrThrow, contentText } from "./client.js";
export * from "./constants.js";
export { parseArgs, main, VERSION, HELP } from "./cli.js";
export { ERROR_CODES, ApiError } from "../../../lib/errors.js";
