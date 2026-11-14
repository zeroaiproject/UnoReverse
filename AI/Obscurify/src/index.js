/**
 * Public surface of the Obscurify client.
 */

export {
  ObscurifyClient,
  obscurifyChat,
  obscurifyChatOrThrow,
  buildMessagesFromPrompt,
  toWireMessages,
} from "./client.js";
export * from "./constants.js";
export { parseArgs, main, VERSION, HELP } from "./cli.js";
export { ERROR_CODES, ApiError } from "../../../lib/errors.js";
