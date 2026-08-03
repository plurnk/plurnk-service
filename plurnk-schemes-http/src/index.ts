// Public package surface. package.json owns plugin registration {§http-manifest}.
export { default } from "./Http.ts";
export { default as Http } from "./Http.ts";

// The registered WebSocket handler {§ws}.
export { default as Ws } from "./Ws.ts";

// Standalone render foundation {§render-lifecycle}.
export { default as Browser } from "./Browser.ts";
export type { ChromiumEngine, ChromiumFactory, RenderResult } from "./Browser.ts";

// Guarded entry-acquisition primitive {§prefetch} and network boundary.
export { default as WebFetcher } from "./WebFetcher.ts";
export type { WebFetchResult } from "./WebFetcher.ts";
export { default as Guard, GuardBlockedError } from "./Guard.ts";
