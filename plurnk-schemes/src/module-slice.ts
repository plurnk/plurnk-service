// {§scheme-module-slice} — what a daemon module contributes to the scheme family: a scheme handler,
// or a scheme facet over a runtime's own resources. The base module contract is
// `@plurnk/plurnk-modules` ({§module-seam-slices}).
import type { FindStatement, KillStatement, SendStatement } from "@plurnk/plurnk-contracts";
import type { ProposalApplyRequest, SchemeCtx } from "./ctx.ts";
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
    // contract: whether the URI authority names the resource, their channels, and the one a
    // fragmentless address reads and a subscription publishes. `claims` always sees the authority
    // folded into the pathname.
    readonly manifest?: Partial<Pick<SchemeManifest, "authority" | "channels" | "defaultChannel">>;
    prepareRepresentation?(
        request: RepresentationPreparationRequest,
        ctx: SchemeCtx,
    ): Promise<RepresentationPreparationResult>;
    prepareFind?(statement: FindStatement, ctx: SchemeCtx): Promise<SchemeResult>;
    find?(statement: FindStatement, ctx: SchemeCtx): Promise<SchemeResult>;
    send?(statement: SendStatement, ctx: SchemeCtx): Promise<SchemeResult>;
    kill?(statement: KillStatement, ctx: SchemeCtx): Promise<SchemeResult>;
    // An operation the facet proposed is also the facet's to apply ({§http-outbound-proposes}).
    // Routed by the proposal's own `target`, the same claim that routed the operation itself, so
    // an executor-input proposal on an unclaimed coordinate still reaches the executor.
    applyResolution?(request: ProposalApplyRequest, ctx: SchemeCtx): Promise<SchemeResult>;
}

// The setup slice a module uses to add one process-wide addressable scheme.
export interface SchemeRegistrationSeam {
    registerScheme(name: string, handler: SchemeHandler): Promise<void>;
}
