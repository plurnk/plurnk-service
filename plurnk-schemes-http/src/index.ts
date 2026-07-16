// Public API barrel for @plurnk/plurnk-schemes-http.
// The default export is the scheme class plurnk-service registers at boot
// (plugin discovery scans node_modules/@plurnk/* for `plurnk.kind === "scheme"`).
export { default } from "./Http.ts";
export { default as Http } from "./Http.ts";

// The WebSocket engine (#468) — Http delegates ws/wss targets here (core routes
// all four prefixes to the http handler, #470). schemes owns the WebSocket
// interface; exported standalone for direct testing.
export { default as Ws } from "./Ws.ts";

// Standalone render foundation — exported so a future plurnk browser-
// troubleshooting MCP package can sit on the same warm-Chromium pool.
export { default as Browser } from "./Browser.ts";
export type { ChromiumEngine, ChromiumFactory, RenderResult } from "./Browser.ts";

// The guarded fetch/render prefetch seam core's entrySink calls (#454):
// `new WebFetcher().fetch(url) → { body, mimetype } | null`.
export { default as WebFetcher } from "./WebFetcher.ts";
export { default as Guard, GuardBlockedError } from "./Guard.ts";
