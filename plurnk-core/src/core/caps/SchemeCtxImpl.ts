// db-backed SchemeCtx (@plurnk/plurnk-schemes) — keystone PR-2 (#180). Assembles
// the capability surface a third-party @plurnk/plurnk-schemes-* sibling receives:
// identity fields lifted off the PlurnkSchemeContext and the consumer-backed caps.
// A sibling reaches the substrate ONLY through
// this — never the raw ctx.db (schemes SPEC §channels). `visibility` is absent: entry
// visibility is gone post-teardown, so schemes dropped the cap (0.4.3).

import type {
    SchemeCtx, EntryCaps, ChannelCaps, TagCaps, NotifyCaps, ProjectionCaps, SubscriptionCaps, WriterTier,
} from "@plurnk/plurnk-schemes";
import type { PlurnkSchemeContext } from "../scheme-types.ts";
import DbEntryCaps from "./DbEntryCaps.ts";
import DbChannelCaps from "./DbChannelCaps.ts";
import DbTagCaps from "./DbTagCaps.ts";
import DbNotifyCaps from "./DbNotifyCaps.ts";
import DbSubscriptionCaps from "./DbSubscriptionCaps.ts";
import DbProjectionCaps from "./DbProjectionCaps.ts";

export default class SchemeCtxImpl implements SchemeCtx {
    readonly workspaceId: number;
    readonly workerId: number;
    readonly loopId: number;
    readonly turnId: number;
    readonly writer: WriterTier;
    readonly signal: AbortSignal | undefined;
    readonly entries: EntryCaps;
    readonly channels: ChannelCaps;
    readonly tags: TagCaps;
    readonly notify: NotifyCaps;
    readonly projection: ProjectionCaps;
    readonly subscriptions: SubscriptionCaps;
    constructor(ctx: PlurnkSchemeContext, scheme: string) {
        this.workspaceId = ctx.workspaceId;
        this.workerId = ctx.workerId;
        this.loopId = ctx.loopId;
        this.turnId = ctx.turnId;
        this.writer = ctx.writer;
        this.signal = ctx.signal;
        this.entries = new DbEntryCaps(ctx, scheme);
        this.channels = new DbChannelCaps(ctx, scheme);
        this.tags = new DbTagCaps(ctx, scheme);
        this.notify = new DbNotifyCaps(ctx, scheme);
        this.projection = new DbProjectionCaps(ctx);
        this.subscriptions = new DbSubscriptionCaps(ctx, scheme);
    }
}
