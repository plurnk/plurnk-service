// The single per-handler context. Its public surface implements SchemeCtx.
// Private fields remain while bundled schemes migrate off PlurnkSchemeContext;
// they are compatibility internals, not part of the plugin contract.

import type {
    SchemeCtx, EntryCaps, ChannelCaps, TagCaps, NotifyCaps, ProjectionCaps, SubscriptionCaps, SchemeManifest, WriterTier,
} from "@plurnk/plurnk-schemes";
import type { PlurnkSchemeContext } from "../scheme-types.ts";
import type { Db } from "../Db.ts";
import type { Mimetypes } from "@plurnk/plurnk-mimetypes";
import type ExecutorRegistry from "../ExecutorRegistry.ts";
import type { InjectWorkerNotify, StreamEventNotify, WakeWorkerNotify } from "../ChannelWrite.ts";
import type { TelemetryEvent } from "../results.ts";
import DbEntryCaps from "./DbEntryCaps.ts";
import DbChannelCaps from "./DbChannelCaps.ts";
import DbTagCaps from "./DbTagCaps.ts";
import DbNotifyCaps from "./DbNotifyCaps.ts";
import DbSubscriptionCaps from "./DbSubscriptionCaps.ts";
import DbProjectionCaps from "./DbProjectionCaps.ts";

export default class SchemeCtxImpl implements SchemeCtx, PlurnkSchemeContext {
    readonly db: Db;
    readonly workspaceId: number;
    readonly workerId: number;
    readonly loopId: number;
    readonly turnId: number;
    readonly writer: WriterTier;
    readonly signal: AbortSignal | undefined;
    readonly streamEventNotify: StreamEventNotify | undefined;
    readonly wakeWorkerNotify: WakeWorkerNotify | undefined;
    readonly injectWorker: InjectWorkerNotify | undefined;
    readonly mimetypes: Mimetypes | undefined;
    readonly executors: ExecutorRegistry | undefined;
    readonly tokenize: ((text: string) => number) | undefined;
    readonly defaultChannelFor: ((scheme: string | null) => string) | undefined;
    readonly pushTelemetry: ((event: TelemetryEvent) => void) | undefined;
    readonly entries: EntryCaps;
    readonly channels: ChannelCaps;
    readonly tags: TagCaps;
    readonly notify: NotifyCaps;
    readonly projection: ProjectionCaps;
    readonly subscriptions: SubscriptionCaps;
    constructor(ctx: PlurnkSchemeContext, scheme: string, manifest: SchemeManifest) {
        this.db = ctx.db;
        this.workspaceId = ctx.workspaceId;
        this.workerId = ctx.workerId;
        this.loopId = ctx.loopId;
        this.turnId = ctx.turnId;
        this.writer = ctx.writer;
        this.signal = ctx.signal;
        this.streamEventNotify = ctx.streamEventNotify;
        this.wakeWorkerNotify = ctx.wakeWorkerNotify;
        this.injectWorker = ctx.injectWorker;
        this.mimetypes = ctx.mimetypes;
        this.executors = ctx.executors;
        this.tokenize = ctx.tokenize;
        this.defaultChannelFor = ctx.defaultChannelFor;
        this.pushTelemetry = ctx.pushTelemetry;
        this.entries = new DbEntryCaps(ctx, scheme, manifest);
        this.channels = new DbChannelCaps(ctx, scheme);
        this.tags = new DbTagCaps(ctx, scheme);
        this.notify = new DbNotifyCaps(ctx, scheme);
        this.projection = new DbProjectionCaps(ctx);
        this.subscriptions = new DbSubscriptionCaps(ctx, scheme);
    }
}
