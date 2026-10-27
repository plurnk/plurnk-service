// The scheme BEHAVIOR contract — the typed counterpart to SchemeManifest
// (which types a scheme's declaration). A handler implements a method per op it
// supports, named for the lowercased op (SEND → send, FIND → find,
// …). Log curation is deliberately absent: core routes the log's KILL
// only to its log owner. Core owns every READ: stored schemes inherit it and
// other readable schemes provide a scope-blind representation first. FIND may
// still be candidate-store-specific.
// Every method is therefore OPTIONAL — a scheme implements only its distinct
// surface. Operation methods share `(statement, ctx) => Promise<SchemeResult>`;
// preparation hooks deliberately receive narrower inputs.
//
// `implements SchemeHandler` gives a sibling compile-time checking of its op
// signatures instead of the duck-typed `object` the engine falls back to. The
// per-op statement types are re-exported from the barrel, so a sibling depends
// on (and exact-pins) ONLY @plurnk/plurnk-schemes — grammar rides underneath as
// the framework's transitive pin, not a second pin every scheme tracks by hand.

// This interface contains only operations the engine delegates to one scheme.
// COPY and MOVE are engine-owned compositions over entry capabilities and
// editBatch, not overridable handler methods.
import type {
    FindStatement,
    SendStatement,
    ExecStatement,
    KillStatement,
    ParsedPath,
} from "@plurnk/plurnk-contracts";
import type { ExtensionAttributionSource } from "@plurnk/plurnk-meta";
import type { EntryAddress, ProposalApplyRequest, ProposalApplyResult, SchemeAddressCtx, SchemeCtx } from "./ctx.ts";
import type { WebMaterializer } from "./WebMaterialization.ts";
import type { EditBatchResult, ResolvedEditStatement } from "./edit-receipt.ts";
import type { RepresentationPreparationResult, SchemeResult } from "./Results.ts";
import type { SchemeManifest, EntryCoordinate } from "./types.ts";
import type { ByteSource } from "./ByteSource.ts";

export interface RepresentationPreparationRequest {
    readonly target: ParsedPath;
    readonly metadata: readonly string[] | null;
    readonly authority: string;
    readonly pathname: string;
}

export interface SchemeHandler extends ExtensionAttributionSource {
    // Per-instance manifest option. Every handler must expose either this or a
    // class-level `static manifest`; Manifest.of validates the resolved value at
    // registration. Per-tag executor schemes derive this instance value from
    // their runtime declaration ({§network-address}).
    readonly manifest?: SchemeManifest;

    // Optional process hooks under {§scheme-operation-dispatch}: readiness precedes
    // advertisement; shutdown follows dispatch drain and precedes store closure.
    // Both run once per unique handler object identity.
    ready?(): Promise<void>;
    close?(): Promise<void>;

    // {§scheme-operation-dispatch}: the handler that acquires and materializes web resources
    // publishes it here; the entry sink resolves it through the registry, never a package by name.
    readonly webMaterializer?: WebMaterializer;
    applyResolution?(request: ProposalApplyRequest, ctx: SchemeCtx): Promise<ProposalApplyResult>;

    // Resolve a client-visible address through the same pathname rules as this
    // scheme's model-facing operations. The capability-free address context
    // prevents storage access before Core binds the resource.
    // null means no resolvable resource. An expected protocol/authority refusal
    // returns its exact non-success result instead of losing it to a generic miss.
    // {§line-anchors}: READ also checks model write eligibility here;
    // resolution observes authority without mutation, acquisition, or proposals.
    resolveEntryAddress?(
        target: ParsedPath,
        ctx: SchemeAddressCtx,
        access?: "read" | "write",
    ): Promise<EntryAddress | SchemeResult | null>;

    // Entry-bearing schemes receive the standard resource-selection
    // implementation from the consumer. A scheme implements this hook only
    // when the requested target must be discovered or materialized before FIND
    // selects stored entries.
    prepareFind?(statement: FindStatement, ctx: SchemeCtx): Promise<SchemeResult>;
    // Exact-resource acquisition receives an already-resolved pathname and a
    // target stripped of channel selection. Operation-specific READ/FIND/COPY
    // intent and scope are never available. Core binds ctx capabilities to the
    // resolved owner, then owns selection and projection after readiness.
    prepareRepresentation?(
        request: RepresentationPreparationRequest,
        ctx: SchemeCtx,
    ): Promise<RepresentationPreparationResult>;
    byteSource?(address: EntryCoordinate, ctx: SchemeAddressCtx): ByteSource;
    find?(statement: FindStatement, ctx: SchemeCtx): Promise<SchemeResult>;
    editBatch?(statements: readonly ResolvedEditStatement[], ctx: SchemeCtx): Promise<EditBatchResult>;
    send?(statement: SendStatement, ctx: SchemeCtx): Promise<SchemeResult>;
    exec?(statement: ExecStatement, ctx: SchemeCtx): Promise<SchemeResult>;
    kill?(statement: KillStatement, ctx: SchemeCtx): Promise<SchemeResult>;
}

// {§resource-tree-scheme} — what a daemon module contributes to the scheme kind: a scheme handler,
// or a scheme facet over a runtime's own resources. The base module contract is
// `@plurnk/plurnk-modules` ({§module-seam-slices}).
//
// A module-owned runtime may expose protocol resources under the same scheme name as its output
// streams. The facet claims only its own path subtree, and there it is the scheme's whole live
// half: every operation it implements is its own. Unclaimed coordinates retain the standard
// executor-output behavior.
export interface RuntimeSchemeFacet {
    claims(pathname: string): boolean;
    // The representation of the claimed resources where it is not the executor's own output
    // contract: whether the URI authority names the resource, their channels, the one a
    // fragmentless address reads and a subscription publishes, and who may write them. `claims`
    // always sees the authority folded into the pathname.
    readonly manifest?: Partial<Pick<SchemeManifest, "authority" | "channels" | "defaultChannel" | "writableBy">>;
    prepareRepresentation?(
        request: RepresentationPreparationRequest,
        ctx: SchemeCtx,
    ): Promise<RepresentationPreparationResult>;
    prepareFind?(statement: FindStatement, ctx: SchemeCtx): Promise<SchemeResult>;
    find?(statement: FindStatement, ctx: SchemeCtx): Promise<SchemeResult>;
    editBatch?(statements: readonly ResolvedEditStatement[], ctx: SchemeCtx): Promise<EditBatchResult>;
    send?(statement: SendStatement, ctx: SchemeCtx): Promise<SchemeResult>;
    kill?(statement: KillStatement, ctx: SchemeCtx): Promise<SchemeResult>;
    // An operation the facet proposed is also the facet's to apply ({§http-manifest}),
    // routed by the proposal's own `target`.
    applyResolution?(request: ProposalApplyRequest, ctx: SchemeCtx): Promise<SchemeResult>;
}

// The setup slice a module uses to add one process-wide addressable scheme.
export interface SchemeRegistrationSeam {
    registerScheme(name: string, handler: SchemeHandler): Promise<void>;
}

// {§resource-tree-scheme} — source truth, without a storage or selection API.
export interface ResourceTree {
    list(): Promise<readonly string[]>;
    resource(relativePath: string): ByteSource;
}

export interface ResourceTreeSource {
    trees(workspaceId: number): ReadonlyMap<string, ResourceTree>;
    // Translate only recognized source failures. null leaves normal missing-file
    // handling or the original unexpected exception with the host.
    refusal?(cause: unknown, address: EntryCoordinate): RepresentationPreparationResult | null;
}

export interface ResourceTreeRegistrationSeam {
    registerResourceTreeScheme(name: string, source: ResourceTreeSource): Promise<void>;
}
