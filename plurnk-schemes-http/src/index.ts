// Public package surface. package.json owns extension registration {§http-manifest}.
export { default } from "./Http.ts";
export { default as Http } from "./Http.ts";

// The registered WebSocket handler {§ws-lifecycle}.
export { default as Ws } from "./Ws.ts";

// Automatic entry-acquisition primitive {§prefetch}.
export { default as WebFetcher } from "./WebFetcher.ts";
