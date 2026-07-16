// Public API barrel for @plurnk/plurnk-schemes-http.
// The default export is the scheme class plurnk-service registers at boot
// (plugin discovery scans node_modules/@plurnk/* for `plurnk.kind === "scheme"`).
export { default } from "./Http.ts";
export { default as Http } from "./Http.ts";

// The WebSocket scheme (#468/#473) — this package's second first-class scheme,
// registered `wss` via package.json plurnk.schemes ({ export: "Ws" }); the `ws`
// prefix rides it (core's schemeNameOf, mirroring https → http).
export { default as Ws } from "./Ws.ts";

// Standalone render foundation — exported so a future plurnk browser-
// troubleshooting MCP package can sit on the same warm-Chromium pool.
export { default as Browser } from "./Browser.ts";
export type { ChromiumEngine, ChromiumFactory, RenderResult } from "./Browser.ts";

// The guarded fetch/render prefetch seam core's entrySink calls (#454):
// `new WebFetcher().fetch(url) → { body, mimetype } | null`.
export { default as WebFetcher } from "./WebFetcher.ts";
export { default as Guard, GuardBlockedError } from "./Guard.ts";
