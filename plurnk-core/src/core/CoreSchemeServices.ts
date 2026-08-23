import type { Db } from "./Db.ts";
import type { Mimetypes } from "@plurnk/plurnk-mimetypes";
import type ExecutorRegistry from "./ExecutorRegistry.ts";
import type { InjectWorkerNotify, StreamEventNotify, WakeWorkerNotify } from "./ChannelWrite.ts";
import type {
    ClientInteractionRequest,
    ClientInteractionResolution,
    Notice,
    ParsedPath,
    ReadStatement,
} from "@plurnk/plurnk-contracts";
import type { PlurnkSchemeContext } from "./scheme-types.ts";
import type { SchemeAddressCtx, SchemeCtx, SchemeResult, StoredEntryData } from "@plurnk/plurnk-schemes";
import type LiveSubscriptions from "./LiveSubscriptions.ts";
import type { EntryAddressResolution } from "./EntryAddressBinding.ts";

export interface CoreSchemeServices {
    readonly db: Db;
    readonly mimetypes: Mimetypes;
    readonly executors: () => ExecutorRegistry | undefined;
    readonly weigh: (text: string) => number;
    readonly streamEventNotify: StreamEventNotify | undefined;
    readonly wakeWorkerNotify: WakeWorkerNotify | undefined;
    readonly injectWorker: InjectWorkerNotify | undefined;
    readonly pushNotice: (workspaceId: number, loopId: number, notice: Notice) => void;
    readonly defaultChannelFor: (scheme: string, workerId: number) => string;
    readonly resolveEntryAddress: (
        target: ParsedPath,
        ctx: PlurnkSchemeContext,
    ) => Promise<EntryAddressResolution | null>;
    readonly readExecSource: (statement: ReadStatement, ctx: PlurnkSchemeContext) => Promise<SchemeResult>;
    readonly requestInteraction: (
        request: ClientInteractionRequest,
        ids: { workspaceId: number; workerId: number; loopId: number; turnId: number },
        signal?: AbortSignal,
    ) => Promise<ClientInteractionResolution>;
    readonly liveSubscriptions: LiveSubscriptions;
}

export interface CoreSchemeAdapter {
    bindCore(services: CoreSchemeServices): void;
}

// Core-owned schemes may resolve authorities that name a principal other than
// the caller. This storage-key form never crosses the public scheme contract.
export interface CoreEntryAddress {
    readonly authority: string;
    readonly pathname: string;
    readonly ownerId: number;
}

// Core-owned stores that cannot use `entries` expose one complete canonical
// representation here. This is deliberately not part of SchemeHandler: public
// protocol plugins materialize through prepareRepresentation + EntryCaps.
export type CoreRepresentationResolution =
    | { readonly representation: StoredEntryData }
    | { readonly result: SchemeResult };

export interface CoreRepresentationProvider {
    resolveCoreRepresentation(
        target: ParsedPath | null,
        ctx: CoreSchemeCallContext,
    ): Promise<CoreRepresentationResolution>;
}

// Core-owned adapters are also exercised directly by service integration tests.
// Production dispatch supplies SchemeCtx; direct core tests may supply the
// daemon's own context. This union is internal to plurnk-core and is not an
// extension contract.
export type CoreSchemeCallContext = SchemeAddressCtx | SchemeCtx | PlurnkSchemeContext;

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
            weigh: services.weigh,
            defaultChannelFor: (scheme) => services.defaultChannelFor(scheme, ctx.workerId),
            pushNotice: (notice) => services.pushNotice(ctx.workspaceId, ctx.loopId, notice),
            requestInteraction: (request) => services.requestInteraction(request, {
                workspaceId: ctx.workspaceId,
                workerId: ctx.workerId,
                loopId: ctx.loopId,
                turnId: ctx.turnId,
            }, ctx.signal),
        };
    }

    protected liveSubscriptions(): LiveSubscriptions {
        const services = this.#services;
        if (services === undefined) throw new Error(`${this.constructor.name}: core services are not bound`);
        return services.liveSubscriptions;
    }

    protected readExecSource(statement: ReadStatement, ctx: CoreSchemeCallContext): Promise<SchemeResult> {
        const services = this.#services;
        if (services === undefined) throw new Error(`${this.constructor.name}: core services are not bound`);
        return services.readExecSource(statement, this.coreContext(ctx));
    }

    protected bindEntryAddress(
        target: ParsedPath,
        ctx: CoreSchemeCallContext,
    ): Promise<EntryAddressResolution | null> {
        const services = this.#services;
        if (services === undefined) throw new Error(`${this.constructor.name}: core services are not bound`);
        return services.resolveEntryAddress(target, this.coreContext(ctx));
    }
}
