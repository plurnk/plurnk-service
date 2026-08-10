// The scheme BEHAVIOR contract — the typed counterpart to SchemeManifest
// (which types a scheme's declaration). A handler implements a method per op it
// supports, named for the lowercased op (READ → read, SEND → send, FIND → find,
// …). OPEN/FOLD are deliberately absent: core routes those curation operations
// only to its log owner. Entry-bearing data schemes inherit standard READ and
// FIND when the corresponding operation method is absent; optional preparation
// hooks may materialize the requested representation first.
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
    ReadStatement,
    EditStatement,
    SendStatement,
    ExecStatement,
    WorkStatement,
    ForkStatement,
    KillStatement,
    PlanStatement,
    ParsedPath,
} from "@plurnk/plurnk-contracts";
import type { PluginAttributionSource } from "@plurnk/plurnk-meta";
import type { EntryAddress, ProposalApplyRequest, ProposalApplyResult, SchemeCtx } from "./ctx.ts";
import type { EditBatchResult } from "./edit-receipt.ts";
import type { SchemeResult } from "./Results.ts";
import type { SchemeManifest } from "./types.ts";

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
    // rules as this scheme's model-facing operations. Absent means commons.
    resolveEntryAddress?(target: ParsedPath, ctx: SchemeCtx): Promise<EntryAddress | null>;

    // Entry-bearing schemes receive the standard resource-selection
    // implementation from the consumer. A scheme implements this hook only
    // when the requested target must be discovered or materialized before FIND
    // selects stored entries.
    prepareFind?(statement: FindStatement, ctx: SchemeCtx): Promise<SchemeResult>;
    // READ preparation receives only the exact target, never its text scope.
    // A successful preparation leaves the readable representation in entries;
    // the consumer then owns channel selection and text projection.
    prepareRead?(target: ParsedPath, ctx: SchemeCtx): Promise<SchemeResult>;
    read?(statement: ReadStatement, ctx: SchemeCtx): Promise<SchemeResult>;
    find?(statement: FindStatement, ctx: SchemeCtx): Promise<SchemeResult>;
    editBatch?(statements: readonly EditStatement[], ctx: SchemeCtx): Promise<EditBatchResult>;
    send?(statement: SendStatement, ctx: SchemeCtx): Promise<SchemeResult>;
    exec?(statement: ExecStatement, ctx: SchemeCtx): Promise<SchemeResult>;
    work?(statement: WorkStatement, ctx: SchemeCtx): Promise<SchemeResult>;
    fork?(statement: ForkStatement, ctx: SchemeCtx): Promise<SchemeResult>;
    kill?(statement: KillStatement, ctx: SchemeCtx): Promise<SchemeResult>;
    plan?(statement: PlanStatement, ctx: SchemeCtx): Promise<SchemeResult>;
}
