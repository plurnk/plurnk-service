export type {
    LoopFlags,
    SchemeFlagAffinity,
    SchemeManifest,
    WriterTier,
} from "./types.ts";
export { DEFAULT_LOOP_FLAGS } from "./types.ts";

export { resolveForLoop } from "./resolveForLoop.ts";

export {
    isBinaryMimetype,
    isJsonMimetype,
    isLineNavigableMimetype,
    normalizeAutoTextMimetype,
    TEXT_PRIMITIVE_MIMETYPE,
} from "./mimetype-binary.ts";

export {
    applyJsonItemEdit,
    applyLineMarkerEdit,
    sliceJsonItems,
    sliceLines,
    sliceLinesRaw,
} from "./line-marker.ts";
export type { EditResult as LineEditResult, JsonSliceResult, SliceResult } from "./line-marker.ts";

export { resolveEntryMimetype } from "./path-mimetype.ts";

export { matchAgainstContent } from "./matcher.ts";
export type { MatchResult } from "./matcher.ts";

export {
    isEntryResult,
    isErrorStatus,
    isPassthroughResult,
    isProposalResult,
    logCoordinate,
    schemeError,
} from "./results.ts";
export type {
    EntryResult,
    PassthroughResult,
    ProposalResult,
    SchemeResult,
    SchemeResultBase,
    TelemetryEvent,
} from "./results.ts";

// Capability ctx — DB-free authoring surface for siblings (keystone PR-2,
// plurnk-service#180). Interfaces only; plurnk-service injects the impl.
export type {
    ChannelCaps,
    ChannelState,
    CrossSchemeCaps,
    EntryCaps,
    EntryData,
    NotifyCaps,
    ProposalAware,
    SchemeCtx,
    SubscriptionCaps,
    SubscriptionHandle,
    TagCaps,
    VisibilityCaps,
} from "./ctx.ts";
