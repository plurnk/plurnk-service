// Public API barrel for @plurnk/plurnk-schemes-http.
// The default export is the scheme class plurnk-service registers at boot
// (plugin discovery scans node_modules/@plurnk/* for `plurnk.kind === "scheme"`).
export { default } from "./Http.ts";
export { default as Http } from "./Http.ts";

// Standalone render foundation — exported so a future plurnk browser-
// troubleshooting MCP package can sit on the same warm-Chromium pool.
export { default as Browser } from "./Browser.ts";
export type { ChromiumEngine, ChromiumFactory, RenderResult } from "./Browser.ts";
