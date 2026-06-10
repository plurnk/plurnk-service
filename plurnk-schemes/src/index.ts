// Public API barrel for @plurnk/plurnk-schemes.
//
// Behavior ships as `export default class` (one class per file, static
// methods) per the ecosystem class paradigm. Type-only modules (types.ts,
// ctx.ts), the frozen constant (DEFAULT_LOOP_FLAGS), and this barrel are
// the only non-class files.

// ── Manifest / flag types + frozen constant ──────────────────────────────
export type {
    LoopFlags,
    SchemeFlagAffinity,
    SchemeManifest,
    WriterTier,
} from "./types.ts";
export { DEFAULT_LOOP_FLAGS } from "./types.ts";

// ── Behavior classes ─────────────────────────────────────────────────────
export { default as SchemeResolver } from "./resolveForLoop.ts";
export { default as MimetypeClassifier, TEXT_PRIMITIVE_MIMETYPE } from "./mimetype-binary.ts";
export { default as Slicer } from "./line-marker.ts";
export type { EditResult as LineEditResult, JsonSliceResult, SliceResult } from "./line-marker.ts";
export { default as PathMimetype } from "./path-mimetype.ts";
export { default as Matcher } from "./matcher.ts";
export type { MatchResult } from "./matcher.ts";
export { default as Results } from "./results.ts";
export type {
    EntryResult,
    PassthroughResult,
    ProposalResult,
    SchemeResult,
    SchemeResultBase,
    TelemetryEvent,
} from "./results.ts";

// ── Capability ctx — DB-free authoring surface for siblings (keystone PR-2,
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
