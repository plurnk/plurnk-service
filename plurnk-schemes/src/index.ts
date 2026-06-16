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
export { default as SchemeDiscovery } from "./SchemeDiscovery.ts";
export type { SchemeInfo, SchemeDiscoveryResult, DiscoverOptions } from "./SchemeDiscovery.ts";
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
} from "./ctx.ts";

// ── Behavior contract + the scheme-facing grammar types ──────────────────────
// SchemeHandler is the typed op surface a sibling `implements`. The per-op
// statement + path types are re-exported from grammar here so a sibling depends
// on and exact-pins ONLY this package; grammar is the framework's transitive pin
// (this repo already peers it). The engine speaks one grammar — keep it single.
export type { SchemeHandler } from "./handler.ts";
export type {
    PlurnkStatement,
    FindStatement,
    ReadStatement,
    OpenStatement,
    FoldStatement,
    EditStatement,
    CopyStatement,
    MoveStatement,
    SendStatement,
    ExecStatement,
    KillStatement,
    PlanStatement,
    ParsedPath,
    LocalPath,
    UrlPath,
} from "@plurnk/plurnk-grammar";
