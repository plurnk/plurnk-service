// db-backed SchemeCtx (@plurnk/plurnk-schemes) — keystone PR-2 (#180). Assembles
// the capability surface a third-party @plurnk/plurnk-schemes-* sibling receives:
// identity fields lifted off the PlurnkSchemeContext, the five db-backed caps,
// and the deferred crossScheme stub. A sibling reaches the substrate ONLY through
// this — never the raw ctx.db (schemes SPEC §channels). `visibility` is absent: entry
// visibility is gone post-teardown, so schemes dropped the cap (0.4.3).

import type {
    SchemeCtx, EntryCaps, ChannelCaps, TagCaps, NotifyCaps, SubscriptionCaps, CrossSchemeCaps, WriterTier,
} from "@plurnk/plurnk-schemes";
import type { PlurnkSchemeContext } from "../scheme-types.ts";
import DbEntryCaps from "./DbEntryCaps.ts";
import DbChannelCaps from "./DbChannelCaps.ts";
import DbTagCaps from "./DbTagCaps.ts";
import DbNotifyCaps from "./DbNotifyCaps.ts";
import DbSubscriptionCaps from "./DbSubscriptionCaps.ts";

const CROSS_SCHEME_STUB: CrossSchemeCaps = {
    _deferred: "see plurnk-service#180 — designed when first cross-scheme COPY/MOVE forces the FROM/TO shape",
};

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
    readonly subscriptions: SubscriptionCaps;
    readonly crossScheme: CrossSchemeCaps = CROSS_SCHEME_STUB;

    constructor(ctx: PlurnkSchemeContext, scheme: string | null) {
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
        this.subscriptions = new DbSubscriptionCaps(ctx, scheme);
    }
}
