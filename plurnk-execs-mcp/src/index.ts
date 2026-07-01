export { default as Mcp } from "./Mcp.ts";
export { default } from "./Mcp.ts";
export { closeAll, install } from "./Mcp.ts";
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
// OAuth mechanics — the executor owns the protocol (discovery/DCR/PKCE/exchange);
// the consumer proposes the URL, the client hosts the loopback redirect.
export { authorize, completeAuth } from "./oauth.ts";
export type { AuthPkce } from "./oauth.ts";
