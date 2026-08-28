// The scheme BEHAVIOR contract — the typed counterpart to SchemeManifest
// (which types a scheme's declaration). A handler implements a method per op it
// supports, named for the lowercased op (SEND → send, FIND → find,
// …). OPEN/FOLD are deliberately absent: core routes those curation operations
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
// editBatch, not overridable handler methods. LOOK/BUFF are deliberately absent:
// they are client operations the engine never dispatches to a scheme.
import type {
    FindStatement,
    SendStatement,
    ExecStatement,
    KillStatement,
    ParsedPath,
} from "@plurnk/plurnk-contracts";
import type { PluginAttributionSource } from "@plurnk/plurnk-meta";
import type { EntryAddress, ProposalApplyRequest, ProposalApplyResult, SchemeAddressCtx, SchemeCtx } from "./ctx.ts";
import type { EditBatchResult } from "./edit-receipt.ts";
import type { RepresentationPreparationResult, SchemeResult } from "./Results.ts";
import type { SchemeManifest } from "./types.ts";
import type { ResolvedEditStatement } from "./edit-statement.ts";

export interface RepresentationPreparationRequest {
    readonly target: ParsedPath;
    readonly metadata: readonly string[] | null;
    readonly authority: string;
    readonly pathname: string;
}

export interface SchemeHandler extends PluginAttributionSource {
    // Per-instance manifest option. Every handler must expose either this or a
    // class-level `static manifest`; Manifest.of validates the resolved value at
    // registration. Per-tag executor schemes derive this instance value from
    // their runtime declaration ({§executor-scheme-output}).
    readonly manifest?: SchemeManifest;

    // Optional process hooks under {§handler-lifecycle}: readiness precedes
    // advertisement; shutdown follows dispatch drain and precedes store closure.
    // Both run once per unique handler object identity.
    ready?(): Promise<void>;
    close?(): Promise<void>;
    applyResolution?(request: ProposalApplyRequest, ctx: SchemeCtx): Promise<ProposalApplyResult>;

    // Resolve a client-visible address through the same pathname and ownership
    // rules as this scheme's model-facing operations. The capability-free
    // address context prevents storage access before Core binds the principal.
    // null means no resolvable resource. An expected protocol/authority refusal
    // returns its exact non-success result instead of losing it to a generic miss.
    resolveEntryAddress?(
        target: ParsedPath,
        ctx: SchemeAddressCtx,
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
    find?(statement: FindStatement, ctx: SchemeCtx): Promise<SchemeResult>;
    editBatch?(statements: readonly ResolvedEditStatement[], ctx: SchemeCtx): Promise<EditBatchResult>;
    send?(statement: SendStatement, ctx: SchemeCtx): Promise<SchemeResult>;
    exec?(statement: ExecStatement, ctx: SchemeCtx): Promise<SchemeResult>;
    kill?(statement: KillStatement, ctx: SchemeCtx): Promise<SchemeResult>;
}
