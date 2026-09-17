// The single per-handler context. It exposes only the public SchemeCtx contract;
// daemon collaborators stay constructor-injected into core-owned adapters.

import type {
    SchemeAddressCtx, SchemeCtx, EntryCaps, ChannelCaps, NotifyCaps, ProjectionCaps, InteractionCaps, SubscriptionCaps, SchemeManifest, WriterTier, ResourceCaps, MessageCaps,
} from "@plurnk/plurnk-schemes";
import type { PlurnkSchemeContext } from "../scheme-types.ts";
import DbEntryCaps from "./DbEntryCaps.ts";
import DbMessageCaps from "./DbMessageCaps.ts";
import DbChannelCaps from "./DbChannelCaps.ts";
import DbNotifyCaps from "./DbNotifyCaps.ts";
import DbSubscriptionCaps from "./DbSubscriptionCaps.ts";
import DbProjectionCaps from "./DbProjectionCaps.ts";
import CoreInteractionCaps from "./CoreInteractionCaps.ts";
import AwaitedEvents from "../AwaitedEvents.ts";
import type LiveSubscriptions from "../LiveSubscriptions.ts";
import type { LineAnchorPrecondition } from "../../content/index.ts";

interface SchemeCtxOptions {
    readonly authority?: string;
    readonly publishedChannel?: string | null;
    readonly editPrecondition?: LineAnchorPrecondition | null;
}

export default class SchemeCtxImpl implements SchemeCtx {
    readonly #editPrecondition: LineAnchorPrecondition | null;
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
    readonly interactions: InteractionCaps;
    readonly subscriptions: SubscriptionCaps;
    readonly resources: ResourceCaps;
    readonly messages: MessageCaps;
    readonly awaitedEvents: import("@plurnk/plurnk-schemes").AwaitedEventCaps;
    constructor(
        ctx: PlurnkSchemeContext,
        scheme: string,
        manifest: SchemeManifest,
        liveSubscriptions: LiveSubscriptions,
        options: SchemeCtxOptions,
    ) {
        this.workspaceId = ctx.workspaceId;
        this.workerId = ctx.workerId;
        this.loopId = ctx.loopId;
        this.turnId = ctx.turnId;
        this.writer = ctx.writer;
        this.signal = ctx.signal;
        this.#editPrecondition = options.editPrecondition ?? null;
        const authority = options.authority ?? "";
        this.projection = new DbProjectionCaps(ctx);
        this.messages = new DbMessageCaps(ctx, scheme);
        this.awaitedEvents = new AwaitedEvents(ctx.db, ctx.awaitedEventNotify).operation(scheme, ctx);
        this.interactions = new CoreInteractionCaps(ctx);
        this.resources = ctx.resources ?? {
            capture: async (targets) => {
                if (targets.length > 0) throw new Error("Resource capture requires a dispatcher context.");
                return { attachments: [] };
            },
        };
        if (manifest.category === "data") {
            this.entries = new DbEntryCaps(ctx, scheme, manifest, authority, this.#editPrecondition);
            this.channels = new DbChannelCaps(ctx, scheme, authority);
            this.notify = new DbNotifyCaps(ctx, scheme, authority);
            this.subscriptions = new DbSubscriptionCaps(
                ctx,
                scheme,
                authority,
                liveSubscriptions,
                options.publishedChannel ?? null,
            );
        } else {
            this.entries = SchemeCtxImpl.#unavailable<EntryCaps>(scheme, "entries");
            this.channels = SchemeCtxImpl.#unavailable<ChannelCaps>(scheme, "channels");
            this.notify = SchemeCtxImpl.#unavailable<NotifyCaps>(scheme, "notify");
            this.subscriptions = SchemeCtxImpl.#unavailable<SubscriptionCaps>(scheme, "subscriptions");
        }
    }

    static #unavailable<T extends object>(scheme: string, capability: string): T {
        return new Proxy({}, {
            get() {
                throw new Error(`Non-data scheme '${scheme}' cannot use the '${capability}' capability.`);
            },
        }) as T;
    }

    static editPreconditionOf(ctx: SchemeAddressCtx | SchemeCtx | PlurnkSchemeContext): LineAnchorPrecondition | null {
        return ctx instanceof SchemeCtxImpl ? ctx.#editPrecondition : null;
    }
}
