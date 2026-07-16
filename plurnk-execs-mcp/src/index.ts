export { default as Mcp } from "./Mcp.ts";
export { default } from "./Mcp.ts";
export { installServer } from "./Mcp.ts";
export type { HotloadRegistration } from "./Mcp.ts";
// Shared connection layer (both faces) — closeAll/install keep their contract:
export { closeAll, install, catalog } from "./client.ts";
export type { Catalog } from "./client.ts";
// The mcp:// scheme face — server-side state (catalog/resources/prompts), #484.
// Registration rides the dual-kind manifest (#483); the handler is agnostic.
export { default as McpScheme } from "./McpScheme.ts";
export { runtimes, runtimeDecl } from "./runtimes.ts";
// Runtime surface for the consumer's `/mcp` hotload route + boot config:
export {
    installAllowed,
    registerServer,
    isInjected,
    parseTarget,
    serverConfig,
    serverNames,
} from "./config.ts";
export type { ServerConfig } from "./config.ts";
// OAuth mechanics — the executor owns the protocol (discovery/DCR + RFC 8628
// device grant); the consumer relays, the client shows the code and drives the
// poll. No redirect, no local server (plurnk-execs-mcp#2).
export { authorize, poll } from "./oauth.ts";
export type { AuthDevice, PollStatus } from "./oauth.ts";
