// The package export surface. Module is the daemon module the service discovers
// ({§agui-daemon-client}); AguiPort is the slice of ApplicationPort it consumes. The projection
// pieces (AguiPlus, Translator, EventRouter, ProposalHitl, Portal) export for the daemon's tests
// and future transports.

export { default as Module } from "./Module.ts";
export type { AguiPort, ModuleOptions } from "./Module.ts";
export { default as Portal } from "./Portal.ts";
export { default as EventRouter } from "./EventRouter.ts";
export { default as ProposalHitl } from "./ProposalHitl.ts";
export * from "./AguiPlus.ts";
export { default as Translator } from "./Translator.ts";
export type * from "./types.ts";
