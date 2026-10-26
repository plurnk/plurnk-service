import type { Db } from "./Db.ts";
import type HostPaths from "./HostPaths.ts";
import type { Mimetypes } from "@plurnk/plurnk-mimetypes";
import type ExecutorRegistry from "./ExecutorRegistry.ts";
import type { InjectSessionNotify, StreamEventNotify, WakeSessionNotify } from "./ChannelWrite.ts";
import type {
    ClientInteractionRequest,
    ClientInteractionResolution,
    Notice,
    ParsedPath,
    PlurnkStatement,
    ReadStatement,
} from "@plurnk/plurnk-contracts";
import type { PlurnkSchemeContext } from "./scheme-types.ts";
import type { SchemeAddressCtx, SchemeCtx, SchemeResult, StoredEntryData } from "@plurnk/plurnk-schemes";
import type LiveSubscriptions from "./LiveSubscriptions.ts";
import type { EntryAddressResolution } from "./EntryAddressBinding.ts";
import SchemeCtxImpl from "./caps/SchemeCtxImpl.ts";

export interface ExecSource {
    readonly result: SchemeResult;
    readonly nativePath: string | null;
}

export interface CoreSchemeServices {
    readonly db: Db;
    readonly mimetypes: Mimetypes;
    readonly executors: () => ExecutorRegistry | undefined;
    readonly weigh: (text: string) => number;
    readonly streamEventNotify: StreamEventNotify | undefined;
    readonly wakeSessionNotify: WakeSessionNotify | undefined;
    readonly injectSession: InjectSessionNotify | undefined;
    readonly pushNotice: (workspaceId: number, sessionId: number, loopId: number, notice: Notice) => void;
    readonly defaultChannelFor: (scheme: string, workspaceId: number) => string;
    readonly settleDerivations: (context: PlurnkSchemeContext) => Promise<void>;
    readonly resolveEntryAddress: (
        target: ParsedPath,
        ctx: PlurnkSchemeContext,
    ) => Promise<EntryAddressResolution | null>;
    readonly readExecSource: (statement: ReadStatement, ctx: PlurnkSchemeContext) => Promise<ExecSource>;
    readonly capabilityDenial: (statement: PlurnkStatement, ctx: PlurnkSchemeContext) => Promise<SchemeResult | null>;
    readonly referenceVisibility: (ctx: PlurnkSchemeContext) => Promise<(pathname: string) => boolean>;
    readonly requestInteraction: (
        request: ClientInteractionRequest,
        ids: { workspaceId: number; sessionId: number; loopId: number; turnId: number },
        signal?: AbortSignal,
    ) => Promise<ClientInteractionResolution>;
    readonly liveSubscriptions: LiveSubscriptions;
    readonly hostPaths?: HostPaths;
}

export interface CoreSchemeAdapter {
    bindCore(services: CoreSchemeServices): void;
}

// Core-owned stores that cannot use `entries` expose one complete canonical
// representation here. This is deliberately not part of SchemeHandler: public
// protocol extensions materialize through prepareRepresentation + EntryCaps.
export type CoreRepresentationResolution =
    | {
        readonly representation: StoredEntryData;
        readonly identity?: string;
        readonly visibleLines?: Readonly<Record<string, readonly number[]>>;
    }
    | { readonly result: SchemeResult };

export interface CoreRepresentationProvider {
    resolveCoreRepresentation(
        target: ParsedPath | null,
        ctx: CoreSchemeCallContext,
    ): Promise<CoreRepresentationResolution>;
}

// A core adapter that resolves its own representation: the one hook, read where it is consumed.
const providesCoreRepresentation = (handler: unknown): handler is CoreSchemeAdapterBase & CoreRepresentationProvider =>
    handler instanceof CoreSchemeAdapterBase
    && "resolveCoreRepresentation" in handler && typeof handler.resolveCoreRepresentation === "function";

export const coreRepresentationProvider = (handler: unknown): CoreRepresentationProvider | null =>
    providesCoreRepresentation(handler) ? handler : null;

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
        if ("db" in ctx) {
            return ctx.hostPaths === undefined && this.#services?.hostPaths !== undefined
                ? { ...ctx, hostPaths: this.#services.hostPaths }
                : ctx;
        }
        const services = this.#services;
        if (services === undefined) throw new Error(`${this.constructor.name}: core services are not bound`);
        const client = SchemeCtxImpl.clientOf(ctx);
        const sequence = SchemeCtxImpl.sequenceOf(ctx);
        const ambientMembers = SchemeCtxImpl.ambientMembersOf(ctx);
        return {
            db: services.db,
            ...(services.hostPaths === undefined ? {} : { hostPaths: services.hostPaths }),
            workspaceId: ctx.workspaceId,
            sessionId: ctx.sessionId,
            loopId: ctx.loopId,
            turnId: ctx.turnId,
            ...(sequence === undefined ? {} : { sequence }),
            writer: ctx.writer,
            signal: ctx.signal,
            ...(ctx.logEntryId === undefined ? {} : { logEntryId: ctx.logEntryId }),
            ...(client === undefined ? {} : { client }),
            ...(ambientMembers === undefined ? {} : { ambientMembers }),
            resources: "resources" in ctx ? ctx.resources : undefined,
            streamEventNotify: services.streamEventNotify,
            wakeSessionNotify: services.wakeSessionNotify,
            injectSession: services.injectSession,
            mimetypes: services.mimetypes,
            executors: services.executors(),
            weigh: services.weigh,
            defaultChannelFor: (scheme) => services.defaultChannelFor(scheme, ctx.workspaceId),
            settleDerivations: () => services.settleDerivations(this.coreContext(ctx)),
            pushNotice: (notice) => services.pushNotice(ctx.workspaceId, ctx.sessionId, ctx.loopId, notice),
            referenceVisibility: () => services.referenceVisibility(this.coreContext(ctx)),
            requestInteraction: (request, signal = ctx.signal) => services.requestInteraction(request, {
                workspaceId: ctx.workspaceId,
                sessionId: ctx.sessionId,
                loopId: ctx.loopId,
                turnId: ctx.turnId,
            }, signal),
        };
    }

    protected liveSubscriptions(): LiveSubscriptions {
        const services = this.#services;
        if (services === undefined) throw new Error(`${this.constructor.name}: core services are not bound`);
        return services.liveSubscriptions;
    }

    protected capabilityDenial(statement: PlurnkStatement, ctx: CoreSchemeCallContext): Promise<SchemeResult | null> {
        const services = this.#services;
        if (services === undefined) throw new Error(`${this.constructor.name}: core services are not bound`);
        return services.capabilityDenial(statement, this.coreContext(ctx));
    }

    protected readExecSource(statement: ReadStatement, ctx: CoreSchemeCallContext): Promise<ExecSource> {
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
