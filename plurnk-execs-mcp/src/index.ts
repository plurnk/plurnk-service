export { default as Mcp } from "./Mcp.ts";
export { default } from "./Mcp.ts";
export { installServer } from "./Mcp.ts";
export type { HotloadRegistration } from "./Mcp.ts";
// Shared executor connection and live-catalog layer:
export { closeAll, install, catalog } from "./client.ts";
export type { Catalog } from "./client.ts";
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
export { authorize, poll, OAuthProblemError } from "./oauth.ts";
export type { AuthDevice, PollStatus } from "./oauth.ts";
