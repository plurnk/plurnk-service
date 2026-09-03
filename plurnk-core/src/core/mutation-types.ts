// Shapes shared by the resource mutation classes (edit preparation, selection, transfers, effects).
import { type LineMarker, type ParsedPath, type ReadStatement, type ResourceSelection, type SchemeMetadataOrNull, type TextLineMarker } from "@plurnk/plurnk-contracts";
import { type ScopeNormalization, type SchemeHandler, type SchemeResult } from "@plurnk/plurnk-schemes";
import type { SchemeManifest, WriterTier, PlurnkSchemeContext } from "./scheme-types.ts";
import { type EditBatchReceipt, type LineAnchorPrecondition, type ResourceEffect } from "../content/index.ts";
import type { BoundEntryAddress, EntryAddressResolution } from "./EntryAddressBinding.ts";

export type DispatchResult = SchemeResult;

export type EditPreparationContext = {
    readonly workspaceId: number;
    readonly workerId: number;
    readonly loopId: number;
    readonly origin: WriterTier;
};

export type PreparedEditBatch = {
    readonly initial: DispatchResult;
    readonly settled: Promise<DispatchResult>;
    aggregate: EditBatchReceipt | undefined;
    settle(result: DispatchResult): void;
};

// {§edit-batch-merges} — a resolution the engine applied to this statement, reported on its row.
export type EditMergeFact = { readonly rule: string } & Record<string, unknown>;

export type PreparedEdit = {
    readonly first: boolean;
    readonly index: number;
    readonly normalizationIndex: number | null;
    readonly projection: DispatchResult | null;
    readonly batch: PreparedEditBatch;
    // Index into the applied-edits receipt; null when this statement was a dropped duplicate.
    readonly receiptIndex: number | null;
    readonly merged: readonly EditMergeFact[];
};

export type ResolvedDataEntryAddress = BoundEntryAddress;
export type PreparedRepresentation = EntryAddressResolution;
export type MetadataResourceSelection = ResourceSelection & {
    readonly metadata: SchemeMetadataOrNull;
};

export type ResourceAddress = {
    readonly target: ParsedPath;
    readonly metadata: SchemeMetadataOrNull;
    readonly scheme: string;
    readonly authority: string;
    readonly pathname: string;
    readonly identityPathname: string;
    readonly channel: string;
    readonly manifest: SchemeManifest;
};

export type AddressedResourceSelection = ResourceAddress & {
    readonly lineMarker: TextLineMarker | null;
};

export type ResolvedResourceSelection = ResourceAddress & {
    readonly lineMarker: LineMarker | null;
};

export type SelectedSource = ResolvedResourceSelection & {
    readonly storageAddress: ResolvedDataEntryAddress;
    readonly content: string;
    readonly completeContent: string;
    // {§binary-parity} — a binary source carries its selected bytes here (whole resource, or the byte
    // range the marker names); `content` is then "". The destination writes them verbatim.
    readonly bytes?: Uint8Array;
    readonly mimetype: string;
    readonly lineAnchorPrecondition: LineAnchorPrecondition | null;
    readonly scopeNormalizations?: ReadonlyArray<ScopeNormalization>;
};

export type DeferredMoveSource = {
    readonly target: ParsedPath;
    readonly metadata: SchemeMetadataOrNull;
    readonly lineMarker: LineMarker | null;
    readonly scheme: string;
    readonly authority: string;
    readonly pathname: string;
    readonly channel: string;
    readonly destination: string;
    readonly lineAnchorPrecondition: LineAnchorPrecondition | null;
};

export type PendingResourceEffect = Pick<ResourceEffect, "target" | "action">;

export type OrchestrationProposalAttrs = {
    readonly proposalScheme?: string;
    readonly proposalTarget?: {
        readonly scheme: string;
        readonly authority: string;
        readonly pathname: string;
    };
    readonly proposalEffects?: readonly PendingResourceEffect[];
    readonly moveSource?: DeferredMoveSource;
    readonly moveDestinationWritten?: string;
    readonly moveDestinationEffects?: readonly ResourceEffect[];
};

export type RunOperation = (
    schemeName: string | null,
    statement: ReadStatement,
    ctx: PlurnkSchemeContext,
) => Promise<DispatchResult>;

export type PrepareDataRepresentation = (args: {
    target: ParsedPath;
    metadata: SchemeMetadataOrNull;
    routedScheme: string;
    handler: SchemeHandler;
    manifest: SchemeManifest;
    ctx: PlurnkSchemeContext;
    publishedChannel: string | null;
}) => Promise<PreparedRepresentation>;

export type ProposalIds = {
    workspaceId: number;
    workerId: number;
    functionalityWorkerId: number;
    loopId: number;
    turnId: number;
};

