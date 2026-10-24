// The package export surface. Module is the daemon module the service discovers
// ({§acp-daemon-client}); AcpPort is the slice of ApplicationPort it consumes. The projection
// pieces (AcpPlus, Translator, SessionTranslator, EventRouter, ProposalHitl, Portal) export for
// the daemon's tests and clients.

export {
    default,
    default as Module,
    default as AcpModule,
    type AcpPort,
    type AcpSetupSeam,
    type ModuleOptions,
} from "./Module.ts";
export { resolveModuleOptions, type ResolvedModuleOptions } from "./config.ts";
export { default as Portal } from "./Portal.ts";
export { default as EventRouter } from "./EventRouter.ts";
export { default as ProposalHitl } from "./ProposalHitl.ts";
export * from "./AcpPlus.ts";
export { default as Translator } from "./Translator.ts";
export { default as SessionTranslator, type AcpSessionUpdate, type AcpToolKind, type AcpToolStatus } from "./SessionTranslator.ts";
export { default as MessageAddress } from "./MessageAddress.ts";
export { default as SessionAddress, HttpProblemError, acpProblem } from "./SessionAddress.ts";
export { default as ThreadAddress } from "./ThreadAddress.ts";
export { default as WebSocketConnection, type WebSocketHandlers } from "./WebSocketConnection.ts";
export type * from "./types.ts";
export {
    EventType,
    MessageSchema,
    MessagesSnapshotEventSchema,
    ReasoningEndEventSchema,
    ReasoningMessageContentEventSchema,
    ReasoningMessageEndEventSchema,
    ReasoningMessageStartEventSchema,
    ReasoningStartEventSchema,
    RunAgentInputSchema,
    RunErrorEventSchema,
    RunFinishedEventSchema,
    parseRunAgentInput,
} from "./types.ts";
export * from "./HttpAgent.ts";
