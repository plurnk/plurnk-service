export { default as Mcp } from "./Mcp.ts";
export { default } from "./Mcp.ts";
export { closeAll } from "./Mcp.ts";
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
