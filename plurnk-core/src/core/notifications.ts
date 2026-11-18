import type { StreamEventNotify, WakeSessionNotify, InjectSessionNotify, CancelSessionNotify, NoticeNotify, SpawnGenerationOverride } from "./ChannelWrite.ts";
import type { ReasoningEventNotify } from "./ReasoningEvent.ts";
import type { LoopPacketNotify } from "./LoopPacket.ts";
import type { ApplicationPersonaProjection } from "@plurnk/plurnk-contracts";

type OperationSettledNotify = (workspaceId: number, logEntryId: number) => Promise<void>;

// The daemon's observation callbacks, declared once. The Engine hands the bundle whole to each
// consumer, which reads the callbacks it uses; a new callback is declared here and read where it
// is used, and no constructor in between names it.
// {§membership-auto-add} — admit files as the dispatching Session's own member definitions; the keys
// admitted come back (none when the model's members scope refuses).
type AdmitMembersNotify = (identity: { readonly workspaceId: number; readonly sessionId: number }, files: readonly string[]) => Promise<readonly string[]>;

export interface EngineNotifications {
    readonly admitMembers?: AdmitMembersNotify;
    readonly resolvePersona?: (workspaceId: number, personaName: string) => Promise<ApplicationPersonaProjection | null>;
    readonly preflightSpawn?: (args: {
        readonly workspaceId: number;
        readonly sourceLoopId: number;
        readonly spawn: boolean;
        readonly override: SpawnGenerationOverride;
    }) => Promise<void>;
    readonly streamEventNotify?: StreamEventNotify;
    readonly reasoningEventNotify?: ReasoningEventNotify;
    readonly loopPacketNotify?: LoopPacketNotify;
    readonly wakeSessionNotify?: WakeSessionNotify;
    readonly injectSession?: InjectSessionNotify;
    readonly cancelSession?: CancelSessionNotify;
    readonly operationSettledNotify?: OperationSettledNotify;
    readonly noticeNotify?: NoticeNotify;
}
