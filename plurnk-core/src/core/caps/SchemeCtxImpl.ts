// The single per-handler context. It exposes only the public SchemeCtx contract;
// daemon collaborators stay constructor-injected into core-owned adapters.

import type {
    SchemeCtx, EntryCaps, ChannelCaps, NotifyCaps, ProjectionCaps, SubscriptionCaps, SchemeManifest, WriterTier,
} from "@plurnk/plurnk-schemes";
import type { PlurnkSchemeContext } from "../scheme-types.ts";
import DbEntryCaps from "./DbEntryCaps.ts";
import DbChannelCaps from "./DbChannelCaps.ts";
import DbNotifyCaps from "./DbNotifyCaps.ts";
import DbSubscriptionCaps from "./DbSubscriptionCaps.ts";
import DbProjectionCaps from "./DbProjectionCaps.ts";
import type LiveSubscriptions from "../LiveSubscriptions.ts";

interface SchemeCtxOptions {
    readonly ownerId?: number;
    readonly publishedChannel?: string | null;
}

export default class SchemeCtxImpl implements SchemeCtx {
    readonly workspaceId: number;
    readonly workerId: number;
    readonly loopId: number;
    readonly turnId: number;
    readonly writer: WriterTier;
    readonly signal: AbortSignal | undefined;
    readonly entries: EntryCaps;
    readonly channels: ChannelCaps;
    readonly notify: NotifyCaps;
    readonly projection: ProjectionCaps;
    readonly subscriptions: SubscriptionCaps;
    constructor(
        ctx: PlurnkSchemeContext,
        scheme: string,
        manifest: SchemeManifest,
        liveSubscriptions: LiveSubscriptions,
        options: SchemeCtxOptions = {},
    ) {
        this.workspaceId = ctx.workspaceId;
        this.workerId = ctx.workerId;
        this.loopId = ctx.loopId;
        this.turnId = ctx.turnId;
        this.writer = ctx.writer;
        this.signal = ctx.signal;
        this.entries = new DbEntryCaps(ctx, scheme, manifest, options.ownerId);
        this.channels = new DbChannelCaps(ctx, scheme, options.ownerId);
        this.notify = new DbNotifyCaps(ctx, scheme, options.ownerId);
        this.projection = new DbProjectionCaps(ctx);
        this.subscriptions = new DbSubscriptionCaps(
            ctx,
            scheme,
            liveSubscriptions,
            options.publishedChannel ?? null,
            options.ownerId,
        );
    }
}
