// Public package surface. package.json owns plugin registration {§http-manifest}.
export { default } from "./Http.ts";
export { default as Http } from "./Http.ts";

// The registered WebSocket handler {§ws}.
export { default as Ws } from "./Ws.ts";

// Automatic entry-acquisition primitive {§prefetch} and its URL check.
export { default as WebFetcher } from "./WebFetcher.ts";
export { default as MaterializerRegistry, type HttpMaterializer, type MaterializerResult } from "./Materializer.ts";
export { PROJECTION_ID_HEADER, WebMaterializationError } from "./WebFetcher.ts";
export type { WebFetchResult, WebMaterializedResult } from "./WebFetcher.ts";
export { default as Guard, GuardBlockedError } from "./Guard.ts";
