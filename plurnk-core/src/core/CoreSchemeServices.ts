import type { Db } from "./Db.ts";
import type { Mimetypes } from "@plurnk/plurnk-mimetypes";
import type ExecutorRegistry from "./ExecutorRegistry.ts";
import type { InjectWorkerNotify, StreamEventNotify, WakeWorkerNotify } from "./ChannelWrite.ts";
import type { TelemetryEvent } from "./results.ts";

export interface CoreSchemeServices {
    readonly db: Db;
    readonly mimetypes: Mimetypes;
    readonly executors: () => ExecutorRegistry | undefined;
    readonly tokenize: (text: string) => number;
    readonly streamEventNotify: StreamEventNotify | undefined;
    readonly wakeWorkerNotify: WakeWorkerNotify | undefined;
    readonly injectWorker: InjectWorkerNotify | undefined;
    readonly pushTelemetry: (workspaceId: number, loopId: number, event: TelemetryEvent) => void;
}

export interface CoreSchemeAdapter {
    bindCore(services: CoreSchemeServices): void;
}
