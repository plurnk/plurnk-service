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
import type LiveSubscriptions from "../LiveSubscriptions.ts";
import type { LineAnchorPrecondition } from "../../content/index.ts";

interface SchemeCtxOptions {
    readonly authority?: string;
    readonly publishedChannel?: string | null;
    readonly editPrecondition?: LineAnchorPrecondition | null;
}

export default class SchemeCtxImpl implements SchemeCtx {
    readonly #coreCtx: PlurnkSchemeContext;
    readonly #editPrecondition: LineAnchorPrecondition | null;
    readonly workspaceId: number;
    readonly sessionId: number;
    readonly loopId: number;
    readonly turnId: number;
    readonly writer: WriterTier;
    readonly signal: AbortSignal | undefined;
    readonly logEntryId: number | undefined;
    readonly entries: EntryCaps;
    readonly channels: ChannelCaps;
    readonly notify: NotifyCaps;
    readonly projection: ProjectionCaps;
    readonly interactions: InteractionCaps;
    readonly subscriptions: SubscriptionCaps;
    readonly resources: ResourceCaps;
    readonly messages: MessageCaps;
    constructor(
        ctx: PlurnkSchemeContext,
        scheme: string,
        manifest: SchemeManifest,
        liveSubscriptions: LiveSubscriptions,
        options: SchemeCtxOptions,
    ) {
        this.#coreCtx = ctx;
        this.workspaceId = ctx.workspaceId;
        this.sessionId = ctx.sessionId;
        this.loopId = ctx.loopId;
        this.turnId = ctx.turnId;
        this.writer = ctx.writer;
        this.signal = ctx.signal;
        this.logEntryId = ctx.logEntryId;
        this.#editPrecondition = options.editPrecondition ?? null;
        const authority = options.authority ?? "";
        this.projection = new DbProjectionCaps(ctx);
        this.messages = new DbMessageCaps(ctx, scheme);
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
            this.entries = SchemeCtxImpl.#unavailable(scheme, "entries");
            this.channels = SchemeCtxImpl.#unavailable(scheme, "channels");
            this.notify = SchemeCtxImpl.#unavailable(scheme, "notify");
            this.subscriptions = SchemeCtxImpl.#unavailable(scheme, "subscriptions");
        }
    }

    // A capability a non-data scheme lacks: an object every member read of which throws.
    static #unavailable(scheme: string, capability: string): never {
        const unavailable = new Proxy({}, {
            get() {
                throw new Error(`Non-data scheme '${scheme}' cannot use the '${capability}' capability.`);
            },
        });
        // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- every member read throws, so the stand-in is never observed as the capability it fills
        return unavailable as never;
    }

    static coreContextOf(ctx: SchemeAddressCtx | SchemeCtx | PlurnkSchemeContext): PlurnkSchemeContext | undefined {
        return ctx instanceof SchemeCtxImpl ? ctx.#coreCtx : "db" in ctx ? ctx : undefined;
    }

    static editPreconditionOf(ctx: SchemeAddressCtx | SchemeCtx | PlurnkSchemeContext): LineAnchorPrecondition | null {
        return ctx instanceof SchemeCtxImpl ? ctx.#editPrecondition : null;
    }

    static fileRevisionOf(ctx: SchemeAddressCtx | SchemeCtx | PlurnkSchemeContext): string | undefined {
        return SchemeCtxImpl.coreContextOf(ctx)?.fileRevision;
    }
}
