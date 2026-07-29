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
export { default as SchemeResolver } from "./SchemeResolver.ts";
export { default as Manifest } from "./Manifest.ts";
export { default as MimetypeClassifier, TEXT_PRIMITIVE_MIMETYPE } from "./MimetypeClassifier.ts";
export { default as Slicer } from "./Slicer.ts";
export type {
    BatchEdit,
    EditResult as LineEditResult,
    JsonSliceResult,
    PageResult,
    RangeExtent,
    RangeUnit,
    SliceResult,
} from "./Slicer.ts";
export { default as PathMimetype } from "./PathMimetype.ts";
export { default as Matcher } from "./Matcher.ts";
export type { MatchResult } from "./Matcher.ts";
export { default as SchemeDiscovery } from "./SchemeDiscovery.ts";
export type { SchemeInfo, SchemeDiscoveryResult, DiscoverOptions } from "./SchemeDiscovery.ts";
export { default as Summarize } from "./Summarize.ts";
export type { OrientIndex } from "./Summarize.ts";
export { default as OutputScheme } from "./OutputScheme.ts";
export type { RuntimeDecl } from "./OutputScheme.ts";
export { default as DefaultRead } from "./DefaultRead.ts";
export type { ReadResolution } from "./DefaultRead.ts";
export { default as Results } from "./Results.ts";
export { InvalidOperationResultError } from "./Results.ts";
export type {
    EntryResult,
    PassthroughResult,
    ProposalResult,
    ProblemDetails,
    SchemeResult,
    SchemeResultBase,
} from "./Results.ts";

// ── Capability ctx — DB-free authoring surface for siblings (keystone PR-2,
// plurnk-service#180). Interfaces only; plurnk-service injects the impl.
export type {
    ChannelCaps,
    ChannelState,
    EntryCaps,
    EntryCatalogItem,
    EntryData,
    EntryEditResult,
    EntryFindResult,
    EntryMatch,
    EntryOperationCaps,
    EntryOwner,
    EntryReadResult,
    EntryStorageReadResult,
    EntryStorageWriteResult,
    ProjectionCaps,
    NotifyCaps,
    ProposalApplyRequest,
    ProposalApplyResult,
    ProposalAware,
    SchemeCtx,
    SubscriptionCaps,
    SubscriptionHandle,
    TagCaps,
    TagListResult,
} from "./ctx.ts";

// ── Behavior contract + the scheme-facing grammar types ──────────────────────
// SchemeHandler is the typed op surface a sibling `implements`. The per-op
// statement + path types are re-exported from grammar here so a sibling depends
// on and exact-pins ONLY this package; grammar is the framework's transitive pin
// (this repo already peers it). The engine speaks one grammar — keep it single.
export type { SchemeHandler } from "./handler.ts";
export type { PacketSection, PacketSectionTransformer } from "./packet.ts";
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
    WorkStatement,
    ForkStatement,
    KillStatement,
    PlanStatement,
    ParsedPath,
    LocalPath,
    UrlPath,
} from "@plurnk/plurnk-grammar";
