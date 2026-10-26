import type { StreamEventNotify, WakeSessionNotify, InjectSessionNotify, CancelSessionNotify, NoticeNotify } from "./ChannelWrite.ts";
import type { ReasoningEventNotify } from "./ReasoningEvent.ts";
import type { OutsideEventNotify } from "./OutsideEvent.ts";
import type { LoopPacketNotify } from "./LoopPacket.ts";
import type { ApplicationOperationEvent } from "@plurnk/plurnk-contracts";

export type OperationSettledNotify = (workspaceId: number, logEntryId: number) => Promise<void>;

// The daemon's observation callbacks, declared once. The Engine hands the bundle whole to each
// consumer, which reads the callbacks it uses; a new callback is declared here and read where it
// is used, and no constructor in between names it.
// {§membership-auto-add} — admit files as the dispatching Session's own member definitions; the keys
// admitted come back (none when the model's members scope refuses).
export type AdmitMembersNotify = (identity: { readonly workspaceId: number; readonly sessionId: number }, files: readonly string[]) => Promise<readonly string[]>;

export interface EngineNotifications {
    readonly admitMembers?: AdmitMembersNotify;
    readonly streamEventNotify?: StreamEventNotify;
    readonly reasoningEventNotify?: ReasoningEventNotify;
    readonly outsideEventNotify?: OutsideEventNotify;
    readonly loopPacketNotify?: LoopPacketNotify;
    readonly wakeSessionNotify?: WakeSessionNotify;
    readonly injectSession?: InjectSessionNotify;
    readonly cancelSession?: CancelSessionNotify;
    readonly operationSettledNotify?: OperationSettledNotify;
    readonly operationEventNotify?: (workspaceId: number, event: ApplicationOperationEvent) => void;
    readonly noticeNotify?: NoticeNotify;
}
