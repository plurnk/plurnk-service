export { default as A2a, type A2aClientResolver } from "./A2a.ts";
export { default as A2aMessage, type A2aMessageIdentity } from "./A2aMessage.ts";
export { default as A2aProjection, type A2aTaskContent } from "./A2aProjection.ts";
export { connectHttpJsonAgent } from "./HttpJsonClient.ts";
export { default as Module, type A2aModuleOptions, type A2aModuleRegistration } from "./Module.ts";
export type { A2aWorkspaceConfiguration } from "./WorkspaceBinding.ts";
export {
    connectTimeoutMs,
    hostedAgentConfiguration,
    outboundAgentDefinition,
    outboundAgentNames,
    outboundDefinitions,
    requestTimeoutMs,
    serviceEnabledNames,
    type HostedAgentConfiguration,
    type OutboundAgentDefinition,
} from "./config.ts";
