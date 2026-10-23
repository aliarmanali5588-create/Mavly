/**
 * Registers the TypeScript-aware resolver used by `npm test`.
 *
 * The tests run on Node's built-in runner against the real source files
 * (Node 22.6+ strips the types; there is no build step). `npm test` therefore
 * needs Node 22.6 or newer — the app itself still runs on Node 20.
 */
import { register } from "node:module";

register("./ts-resolver.mjs", import.meta.url);
