// Standard wire shapes come from the protocol package. PLURNK-specific richness
// rides CUSTOM events under the `plurnk.` namespace.
//
// Plurnk-specific richness the core vocabulary can't hold (curation metadata, coordinates, tags,
// proposals) rides CUSTOM events under the `plurnk.` namespace — generic frontends skip them,
// plurnk-aware frontends render them richly ({§agui-custom-namespace}).

export { EventType } from "@ag-ui/core";
export type {
    AGUIEvent as AguiEvent,
    AssistantMessage,
    ReasoningMessage,
    RunAgentInput,
    ToolMessage,
    UserMessage,
} from "@ag-ui/core";
export {
    isLogEntryNotification,
    type LogEntryNotification,
    type OutsideEventNotification,
    type ProposalNotification,
    type ReasoningEventNotification,
    type TerminatedNotification,
} from "@plurnk/plurnk-contracts";
