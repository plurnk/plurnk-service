import type { StreamEventNotify, WakeWorkerNotify, InjectWorkerNotify, CancelWorkerNotify, NoticeNotify } from "./ChannelWrite.ts";
import type { ReasoningEventNotify } from "./ReasoningEvent.ts";
import type { OutsideEventNotify } from "./OutsideEvent.ts";
import type { LoopPacketNotify } from "./LoopPacket.ts";

export type OperationSettledNotify = (workspaceId: number, logEntryId: number) => Promise<void>;

// The daemon's observation callbacks, declared once. The Engine hands the bundle whole to each
// consumer, which reads the callbacks it uses; a new callback is declared here and read where it
// is used, and no constructor in between names it.
export interface EngineNotifications {
    readonly streamEventNotify?: StreamEventNotify;
    readonly reasoningEventNotify?: ReasoningEventNotify;
    readonly outsideEventNotify?: OutsideEventNotify;
    readonly loopPacketNotify?: LoopPacketNotify;
    readonly wakeWorkerNotify?: WakeWorkerNotify;
    readonly injectWorker?: InjectWorkerNotify;
    readonly cancelWorker?: CancelWorkerNotify;
    readonly operationSettledNotify?: OperationSettledNotify;
    readonly noticeNotify?: NoticeNotify;
}
