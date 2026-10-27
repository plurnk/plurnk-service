// Public API barrel for @plurnk/plurnk-schemes.

// ── Manifest types ────────────────────────────────────────────────────────
export type {
    EntryCoordinate,
    SchemeAuthority,
    SchemeManifest,
    WriterTier,
} from "./types.ts";

// ── Behavior classes ─────────────────────────────────────────────────────
export { default as Manifest } from "./Manifest.ts";
export { default as NetworkAddress } from "./NetworkAddress.ts";
export { default as EntryCoordinates } from "./EntryCoordinates.ts";
export { default as MimetypeClassifier, PathMimetype, TEXT_PRIMITIVE_MIMETYPE } from "./MimetypeClassifier.ts";
export { default as Slicer } from "./Slicer.ts";
export type {
    BatchEdit,
    EditResult as LineEditResult,
    PageResult,
    RangeUnit,
    SliceResult,
    TextReplacement,
    WindowResult,
} from "./Slicer.ts";
export { default as Matcher } from "./Matcher.ts";
export type { MatchResult } from "./Matcher.ts";
export { default as SchemeDiscovery } from "./SchemeDiscovery.ts";
export type { SchemeInfo, SchemeDiscoveryResult, DiscoverOptions } from "./SchemeDiscovery.ts";
export { default as Summarize } from "./Summarize.ts";
export type { OrientIndex } from "./Summarize.ts";
export { default as OutputScheme } from "./OutputScheme.ts";
export { default as ResourceNames } from "./ResourceNames.ts";
export type { RuntimeDecl } from "./OutputScheme.ts";
export { default as Results, InvalidOperationResultError } from "./Results.ts";
export { default as MetadataOptions } from "./MetadataOptions.ts";
export { default as MessageAttachments } from "./MessageAttachments.ts";
export { default as MessageScheme } from "./MessageScheme.ts";
export type { MetadataOptionsParsed } from "./MetadataOptions.ts";
export { default as PacketSections } from "./PacketSections.ts";
export type { PacketSectionDraft, PacketSectionTransformer } from "./PacketSections.ts";
export { PathSyntax } from "@plurnk/plurnk-contracts";
export { MimetypeInputLimitError as ProjectionInputLimitError } from "@plurnk/plurnk-mimetypes";
export type {
    AppliedEditBatchReceipt,
    AppliedEditReceipt,
    EditBatchReceipt,
    EditBatchResult,
    EditEffectReceipt,
    EditReceipt,
    EditReceiptUnit,
    ParseIssueTransition,
    ResolvedEditStatement,
    ReviewerReplacementEditBatchReceipt,
    SupersededEditReceipt,
} from "./edit-receipt.ts";
export type {
    ChannelProducerResult,
    EntryResult,
    MatchEvidence,
    PassthroughResult,
    ProposalResult,
    ProblemDetails,
    RepresentationPreparationResult,
    ScopeNormalization,
    SchemeResult,
    SchemeResultBase,
} from "./Results.ts";

// {§capability-ctx} Capability ctx — DB-free authoring surface for siblings.
// Interfaces only; plurnk-service injects the implementation.
export type {
    ChannelCaps,
    ChannelState,
    TerminalChannelState,
    EntryCaps,
    EntryCatalogChannel,
    EntryCatalogDefaultChannel,
    EntryCatalogItem,
    EntryCatalogScope,
    EntryCatalogScopeGroup,
    EntryData,
    EntryEditResult,
    EntryFindResult,
    EntryOperationCaps,
    EntryAddress,
    EntryReadResult,
    EntryStorageReadResult,
    EntryStreamLifecycle,
    EntryStorageWriteResult,
    StoredEntryData,
    StreamSubscription,
    ProjectionCaps,
    InteractionCaps,
    ProjectedText,
    ProjectedBinary,
    NotifyCaps,
    ProposalApplyRequest,
    ProposalApplyResult,
    ProposalAware,
    SchemeAddressCtx,
    SchemeCtx,
    ResourceCaps,
    MessageCaps,
    SubscriptionCaps,
    SubscriptionHandle,
} from "./ctx.ts";

// ── Behavior contract + the scheme-facing grammar types ──────────────────────
// SchemeHandler is the typed op surface a sibling `implements`. The per-op
// statement + path types are re-exported from grammar here so a sibling depends
// on and exact-pins ONLY this package; grammar is the framework's transitive pin
// (this repo already peers it). The engine speaks one grammar — keep it single.
export type {
    RepresentationPreparationRequest,
    ResourceTree,
    ResourceTreeRegistrationSeam,
    ResourceTreeSource,
    RuntimeSchemeFacet,
    SchemeHandler,
    SchemeRegistrationSeam,
} from "./handler.ts";
export type {
    ExtensionAttributionContext,
    ExtensionAttributionDeclaration,
    ExtensionAttributionSource,
} from "@plurnk/plurnk-meta";
export type {
    PlurnkStatement,
    FindStatement,
    ReadStatement,
    CopyStatement,
    MoveStatement,
    SendStatement,
    ExecStatement,
    WorkStatement,
    ForkStatement,
    KillStatement,
    DispositionStatement,
    ParsedPath,
    LocalPath,
    UrlPath,
} from "@plurnk/plurnk-contracts";
export { FileByteSource, GeneratedByteSource, type ByteSource } from "./ByteSource.ts";
export { WebMaterializationError } from "./WebMaterialization.ts";
export type {
    WebChannelFailure,
    WebChannelOutcome,
    WebFetchResult,
    WebMaterializationSource,
    WebMaterializedResult,
    WebMaterializer,
    WebResponseBody,
} from "./WebMaterialization.ts";
