// The daughter's export surface. Module is what the daemon's boot plug-point
// activates (registerModule(Module.init(opts))); DaemonSeam is the contract it
// consumes. The projection pieces (AguiPlus, Translator, EventRouter, ProposalHitl,
// Portal) export for the daemon's tests and future transports.

export { default as Module } from "./Module.ts";
export type { ModuleOptions } from "./Module.ts";
export type { DaemonSeam, ClientEnvelope, PendingProposal, ProposalResolution, PlurnkStatement, LogEntryWire } from "./DaemonSeam.ts";
export { default as Portal } from "./Portal.ts";
export { default as EventRouter } from "./EventRouter.ts";
export { default as ProposalHitl } from "./ProposalHitl.ts";
export * from "./AguiPlus.ts";
export { default as Translator } from "./Translator.ts";
export type * from "./types.ts";
