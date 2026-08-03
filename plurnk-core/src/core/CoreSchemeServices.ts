import type { Db } from "./Db.ts";
import type { Mimetypes } from "@plurnk/plurnk-mimetypes";
import type ExecutorRegistry from "./ExecutorRegistry.ts";
import type { InjectWorkerNotify, StreamEventNotify, WakeWorkerNotify } from "./ChannelWrite.ts";
import type { Notice } from "@plurnk/plurnk-contracts";
import type { PlurnkSchemeContext } from "./scheme-types.ts";
import type { SchemeCtx } from "@plurnk/plurnk-schemes";
import type LiveSubscriptions from "./LiveSubscriptions.ts";

export interface CoreSchemeServices {
    readonly db: Db;
    readonly mimetypes: Mimetypes;
    readonly executors: () => ExecutorRegistry | undefined;
    readonly tokenize: (text: string) => number;
    readonly streamEventNotify: StreamEventNotify | undefined;
    readonly wakeWorkerNotify: WakeWorkerNotify | undefined;
    readonly injectWorker: InjectWorkerNotify | undefined;
    readonly pushNotice: (workspaceId: number, loopId: number, notice: Notice) => void;
    readonly defaultChannelFor: (scheme: string) => string;
    readonly liveSubscriptions: LiveSubscriptions;
}

export interface CoreSchemeAdapter {
    bindCore(services: CoreSchemeServices): void;
}

// Core-owned adapters are also exercised directly by service integration tests.
// Production dispatch supplies SchemeCtx; direct core tests may supply the
// daemon's own context. This union is internal to plurnk-core and is not an
// extension contract.
export type CoreSchemeCallContext = SchemeCtx | PlurnkSchemeContext;

export abstract class CoreSchemeAdapterBase implements CoreSchemeAdapter {
    #services: CoreSchemeServices | undefined;

    bindCore(services: CoreSchemeServices): void {
        this.#services = services;
    }

    protected coreContext(ctx: CoreSchemeCallContext): PlurnkSchemeContext {
        if ("db" in ctx) return ctx;
        const services = this.#services;
        if (services === undefined) throw new Error(`${this.constructor.name}: core services are not bound`);
        return {
            db: services.db,
            workspaceId: ctx.workspaceId,
            workerId: ctx.workerId,
            loopId: ctx.loopId,
            turnId: ctx.turnId,
            writer: ctx.writer,
            signal: ctx.signal,
            streamEventNotify: services.streamEventNotify,
            wakeWorkerNotify: services.wakeWorkerNotify,
            injectWorker: services.injectWorker,
            mimetypes: services.mimetypes,
            executors: services.executors(),
            tokenize: services.tokenize,
            defaultChannelFor: services.defaultChannelFor,
            pushNotice: (notice) => services.pushNotice(ctx.workspaceId, ctx.loopId, notice),
        };
    }

    protected liveSubscriptions(): LiveSubscriptions {
        const services = this.#services;
        if (services === undefined) throw new Error(`${this.constructor.name}: core services are not bound`);
        return services.liveSubscriptions;
    }
}
