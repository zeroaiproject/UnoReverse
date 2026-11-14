/**
 * Public surface of the Kilo AI client.
 */

export { KiloClient, kiloChat, kiloChatOrThrow, kiloMessages } from "./client.js";
export * from "./constants.js";
export { parseArgs, main, VERSION, HELP } from "./cli.js";
export { ERROR_CODES, ApiError } from "../../../lib/errors.js";
export { parseProxyUrl, createProxyFetch, torRenewIdentity } from "../../../lib/proxy.js";
