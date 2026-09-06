// Stateless helpers of the resource mutations: failure results, effect projection, address and marker facts.
import { PathSyntax } from "@plurnk/plurnk-contracts";
import { InvalidOperationResultError, type ScopeNormalization } from "@plurnk/plurnk-schemes";
import type { ProposalSettlement } from "./ProposalLifecycle.ts";
import { renderAddress, renderTarget } from "./plurnk-uri.ts";
import { assertEditBatchReceipt, assertEditReceipt, assertResourceEffects, projectEditReceipt, type EditBatchReceipt, type LineAnchorPrecondition, type ResourceEffect, type ResourceEffectAction } from "../content/index.ts";
import Results from "./results.ts";
import type { DispatchResult, ResourceAddress, AddressedResourceSelection, ResolvedResourceSelection, SelectedSource, DeferredMoveSource, PendingResourceEffect, OrchestrationProposalAttrs } from "./mutation-types.ts";

export default class MutationEffects {
    static failure(
        code: string,
        status: number,
        detail: string,
        fields: Readonly<Record<string, unknown>> = {},
        extensions: Readonly<Record<string, unknown>> = {},
    ): DispatchResult {
        return Results.failure("engine:dispatcher", code, status, detail, fields, extensions);
    }

    static isDispatchResult(
        value: AddressedResourceSelection | SelectedSource | DispatchResult,
    ): value is DispatchResult {
        return "status" in value;
    }


    static prependScopeNormalizations(
        result: DispatchResult,
        scopeNormalizations: ReadonlyArray<ScopeNormalization> | undefined,
    ): DispatchResult {
        if (scopeNormalizations === undefined) return result;
        return Results.assert({
            ...result,
            scopeNormalizations: [
                ...scopeNormalizations,
                ...(result.scopeNormalizations ?? []),
            ],
        });
    }


    static mergeLineAnchorPreconditions(
        ...values: ReadonlyArray<LineAnchorPrecondition | null>
    ): LineAnchorPrecondition | null {
        const present = values.filter((value): value is LineAnchorPrecondition => value !== null);
        if (present.length === 0) return null;
        const identity = present[0]!.identity;
        if (present.some((value) => value.identity !== identity)) {
            throw new TypeError("Line-anchor preconditions for one edit batch must share a resource identity.");
        }
        const checks = [...new Map(
            present.flatMap(({ checks: valueChecks }) => valueChecks)
                .map((check) => [`${check.anchor}:${check.line}`, check]),
        ).values()];
        return { identity, checks };
    }


    static appliedEffects(
        result: DispatchResult,
        pending: readonly PendingResourceEffect[],
    ): DispatchResult {
        // {§edit-result-copy-move-effects} — only an applied mutation earns
        // engine-composed effects; native scheme receipts remain internal input.
        const exact = Results.assert(result);
        if (exact.status === 304 || exact.status === 202 || exact.status >= 300) return exact;
        if (exact.effects !== undefined) {
            throw new InvalidOperationResultError(
                "A COPY/MOVE mutation result supplied effects before engine composition.",
            );
        }
        const batch = exact.editReceipt === undefined
            ? undefined
            : assertEditBatchReceipt(exact.editReceipt);
        const single = batch === undefined && exact.receipt !== undefined
            ? assertEditReceipt(exact.receipt)
            : undefined;
        const batchSize = batch === undefined
            ? undefined
            : "disposition" in batch
                ? batch.superseded.length
                : batch.effects.length;
        if (batchSize !== undefined && batchSize !== pending.length) {
            throw new InvalidOperationResultError(
                `COPY/MOVE expected ${pending.length} receipt projections, got ${batchSize}.`,
            );
        }
        if (single !== undefined && pending.length !== 1) {
            throw new InvalidOperationResultError(
                `COPY/MOVE received one receipt for ${pending.length} resource effects.`,
            );
        }
        let effects: ResourceEffect[];
        if (batch !== undefined && "disposition" in batch) {
            const replacement = pending[0];
            if (replacement === undefined) {
                throw new InvalidOperationResultError(
                    "A reviewer-replaced COPY/MOVE batch has no resource effect.",
                );
            }
            if (pending.some(({ target, action }) =>
                target !== replacement.target || action !== replacement.action
            )) {
                throw new InvalidOperationResultError(
                    "A reviewer-replaced COPY/MOVE batch spans incompatible resource effects.",
                );
            }
            effects = [{
                ...replacement,
                receipt: projectEditReceipt(batch, 0),
            }];
        } else {
            effects = pending.map((effect, index): ResourceEffect => ({
                ...effect,
                ...(batch !== undefined
                    ? { receipt: projectEditReceipt(batch, index) }
                    : single !== undefined
                        ? { receipt: single }
                        : {}),
            }));
        }
        assertResourceEffects(effects);
        const {
            editReceipt: _editReceipt,
            receipt: _receipt,
            ...withoutInternalReceipts
        } = exact;
        return {
            ...withoutInternalReceipts,
            effects,
        };
    }


    // {§copy-move-observation} {§edit-result-copy-move-effects} — scoped
    // COPY/MOVE into an unscoped channel is a text materialization even when
    // CRUD creates the channel wholesale. Carry the receipt through synchronous
    // writes and proposals; the destination scheme owns reviewed output.
    static withEditMaterialization(
        result: DispatchResult,
        receipt: EditBatchReceipt,
    ): DispatchResult {
        const exact = Results.assert(result);
        if (exact.status !== 200 && exact.status !== 201 && exact.status !== 202) return exact;
        const materialized = exact.editReceipt === undefined
            ? assertEditBatchReceipt(receipt)
            : assertEditBatchReceipt(exact.editReceipt);
        return {
            ...exact,
            editReceipt: materialized,
            ...(exact.status === 202
                ? {
                    attrs: {
                        ...(exact.attrs as Record<string, unknown> | undefined),
                        editReceipt: materialized,
                    },
                }
                : {}),
        };
    }


    static effectsOf(result: DispatchResult): readonly ResourceEffect[] {
        return result.effects === undefined
            ? []
            : assertResourceEffects(result.effects);
    }


    static withCombinedEffects(
        result: DispatchResult,
        ...additional: ReadonlyArray<readonly ResourceEffect[]>
    ): DispatchResult {
        const existing = MutationEffects.effectsOf(result);
        const effects = [...existing, ...additional.flat()];
        const { effects: _effects, ...withoutEffects } = result;
        return effects.length === 0
            ? withoutEffects
            : { ...withoutEffects, effects: assertResourceEffects(effects) };
    }


    static settleProposalEffects(
        original: DispatchResult,
        settlement: ProposalSettlement,
    ): ProposalSettlement {
        const pending = (original.attrs as OrchestrationProposalAttrs | undefined)
            ?.proposalEffects;
        if (
            pending === undefined
            || settlement.resolution.decision !== "accept"
            || settlement.applied === undefined
            || settlement.applied.status >= 300
        ) {
            return settlement;
        }
        const projected = settlement.resolution.result ?? {};
        const aggregate = settlement.applied.editReceipt;
        const applied = MutationEffects.appliedEffects(
            {
                ...projected,
                status: settlement.applied.status,
                ...(aggregate === undefined ? {} : { editReceipt: aggregate }),
            },
            pending,
        );
        const {
            status: _status,
            body: _body,
            ...result
        } = applied;
        const {
            body: _resolutionBody,
            ...resolution
        } = settlement.resolution;
        return {
            ...settlement,
            resolution: {
                ...resolution,
                result,
            },
        };
    }


    static settlementEffects(settlement: ProposalSettlement): readonly ResourceEffect[] {
        const effects = (settlement.resolution.result as Record<string, unknown> | undefined)
            ?.effects;
        return effects === undefined ? [] : assertResourceEffects(effects);
    }


    static withSettlementEffects(
        settlement: ProposalSettlement,
        effects: readonly ResourceEffect[],
    ): ProposalSettlement {
        const projected = (settlement.resolution.result ?? {}) as Record<string, unknown>;
        const { effects: _effects, ...withoutEffects } = projected;
        const result = effects.length === 0
            ? withoutEffects
            : {
                ...withoutEffects,
                effects: assertResourceEffects(effects),
            };
        return {
            ...settlement,
            resolution: {
                ...settlement.resolution,
                result,
            },
        };
    }


    static resourceAddress(selection: ResourceAddress): string {
        const address = selection.scheme === "file"
            ? renderTarget({
                scheme: null,
                pathname: selection.identityPathname.replace(/^\//, ""),
            })
            : renderAddress({
                scheme: selection.scheme,
                // {§worker-authority-carving} — storage keys the owner, so the
                // address the model typed (`~`) is re-applied for it to recognize.
                authority: selection.scheme === "worker" && selection.target.kind === "url"
                    ? selection.target.hostname ?? ""
                    : selection.authority,
                pathname: selection.identityPathname,
            });
        if (address === null) throw new Error("resolved resource selection has no renderable address");
        return selection.channel === selection.manifest.defaultChannel
            ? address
            : `${address}#${PathSyntax.escapeTarget(selection.channel)}`;
    }


    static pendingEffect(
        selection: ResourceAddress,
        action: ResourceEffectAction,
    ): PendingResourceEffect {
        return {
            target: MutationEffects.resourceAddress(selection),
            action,
        };
    }


    static withProposalRoute(
        result: DispatchResult,
        selection: ResourceAddress,
    ): DispatchResult {
        if (result.status !== 202) return result;
        return {
            ...result,
            attrs: {
                ...(result.attrs as Record<string, unknown> | undefined),
                proposalScheme: selection.scheme,
                proposalTarget: {
                    scheme: selection.scheme,
                    authority: selection.authority,
                    pathname: selection.identityPathname,
                },
            },
        };
    }


    static projectEdit(result: DispatchResult): DispatchResult {
        const { editReceipt, merges: _merges, applied: _applied, ...fields } = result as DispatchResult & { merges?: unknown; applied?: unknown };
        if (editReceipt === undefined || editReceipt === null) return fields;
        const receipt = assertEditBatchReceipt(editReceipt);
        if (("disposition" in receipt ? receipt.superseded : receipt.effects).length !== 1) {
            throw new InvalidOperationResultError("An individual EDIT returned multiple effects.");
        }
        return { ...fields, receipt: projectEditReceipt(receipt, 0) };
    }

    static finalizeEffects(
        result: DispatchResult,
        selection: ResourceAddress,
        pending: readonly PendingResourceEffect[],
    ): DispatchResult {
        const routed = MutationEffects.withProposalRoute(result, selection);
        if (routed.status !== 202) return MutationEffects.appliedEffects(routed, pending);
        return {
            ...routed,
            attrs: {
                ...(routed.attrs as Record<string, unknown> | undefined),
                proposalEffects: pending,
            },
        };
    }


    static sameChannel(
        left: ResourceAddress,
        right: ResourceAddress,
    ): boolean {
        return left.scheme === right.scheme
            && left.authority === right.authority
            && left.identityPathname === right.identityPathname
            && left.channel === right.channel;
    }


    static moveFailureAfterDestination(
        result: DispatchResult,
        destination: string,
        destinationEffects: readonly ResourceEffect[],
    ): DispatchResult {
        const exact = Results.assert(result);
        if (exact.status < 400) {
            throw new InvalidOperationResultError(
                "A successful MOVE source result was classified as a partial failure.",
            );
        }
        if (exact.problem === undefined) {
            throw new InvalidOperationResultError(
                "A failed MOVE source mutation has no Problem Details.",
            );
        }
        const failed = Results.assert({
            ...exact,
            problem: {
                ...exact.problem,
                operation: "MOVE",
                destinationWritten: true,
                destination,
            },
        });
        return MutationEffects.withCombinedEffects(failed, destinationEffects);
    }


    static deferredMoveSource(
        source: ResolvedResourceSelection,
        destination: ResourceAddress,
        lineAnchorPrecondition: LineAnchorPrecondition | null,
    ): DeferredMoveSource {
        return {
            target: source.target,
            metadata: source.metadata,
            lineMarker: source.lineMarker,
            scheme: source.scheme,
            authority: source.authority,
            pathname: source.pathname,
            channel: source.channel,
            destination: MutationEffects.resourceAddress(destination),
            lineAnchorPrecondition,
        };
    }

}
