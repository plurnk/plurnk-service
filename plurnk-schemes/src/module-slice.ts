// {§scheme-module-slice} — what a daemon module contributes to the scheme kind: a scheme handler,
// or a scheme facet over a runtime's own resources. The base module contract is
// `@plurnk/plurnk-modules` ({§module-seam-slices}).
import type { FindStatement, KillStatement, SendStatement } from "@plurnk/plurnk-contracts";
import type { ProposalApplyRequest, SchemeCtx } from "./ctx.ts";
import type { EditBatchResult } from "./edit-receipt.ts";
import type { ResolvedEditStatement } from "./edit-statement.ts";
import type { RepresentationPreparationRequest, SchemeHandler } from "./handler.ts";
import type { RepresentationPreparationResult, SchemeResult } from "./Results.ts";
import type { SchemeManifest } from "./types.ts";

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
    // An operation the facet proposed is also the facet's to apply ({§http-outbound-proposes}),
    // routed by the proposal's own `target`.
    applyResolution?(request: ProposalApplyRequest, ctx: SchemeCtx): Promise<SchemeResult>;
}

// The setup slice a module uses to add one process-wide addressable scheme.
export interface SchemeRegistrationSeam {
    registerScheme(name: string, handler: SchemeHandler): Promise<void>;
}
