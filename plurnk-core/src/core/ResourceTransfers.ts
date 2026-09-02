import { PathSyntax, type CopyStatement, type EditStatement, type LineMarker, type MoveStatement, type PlurnkStatement } from "@plurnk/plurnk-contracts";
import { InvalidOperationResultError, type ResolvedEditStatement, type SchemeHandler } from "@plurnk/plurnk-schemes";
import type SchemeRegistry from "./SchemeRegistry.ts";
import type LiveSubscriptions from "./LiveSubscriptions.ts";
import type ProposalLifecycle from "./ProposalLifecycle.ts";
import type { ProposalSettlement } from "./ProposalLifecycle.ts";
import type { EntryData, ReadEntryResult, WriteEntryResult, DeleteEntryResult } from "../schemes/_entry-crud.ts";
import type { SchemeManifest, PlurnkSchemeContext } from "./scheme-types.ts";
import { assertResourceEffects, editReceipt, MimetypeBinary, PathMimetype, type LineAnchorPrecondition } from "../content/index.ts";
import DbProjectionCaps from "./caps/DbProjectionCaps.ts";
import SchemeCtxImpl from "./caps/SchemeCtxImpl.ts";
import Results from "./results.ts";
import type EntryAddressBinding from "./EntryAddressBinding.ts";
import type { BoundEntryAddress } from "./EntryAddressBinding.ts";
import EntryManifest from "../schemes/_entry-manifest.ts";
import type { DispatchResult, MetadataResourceSelection, AddressedResourceSelection, ResolvedResourceSelection, SelectedSource, OrchestrationProposalAttrs, ProposalIds } from "./mutation-types.ts";
import MutationEffects from "./MutationEffects.ts";
import type ResourceSelector from "./ResourceSelector.ts";

// COPY and MOVE orchestration: source selection, destination writes, move settlement.
export default class ResourceTransfers {
    readonly #schemes: SchemeRegistry;
    readonly #liveSubscriptions: LiveSubscriptions;
    readonly #resolveDataEntryAddress: EntryAddressBinding["resolve"];
    readonly #readEntry: (scheme: string, address: BoundEntryAddress, ctx: PlurnkSchemeContext) => Promise<ReadEntryResult>;
    readonly #writeEntry: (scheme: string, address: BoundEntryAddress, entry: EntryData, ctx: PlurnkSchemeContext) => Promise<WriteEntryResult>;
    readonly #deleteChannel: (
        scheme: string,
        address: BoundEntryAddress,
        channel: string,
        ctx: PlurnkSchemeContext,
    ) => Promise<DeleteEntryResult>;
    readonly #applyProposal: ProposalLifecycle["workerApply"];
    readonly #selection: ResourceSelector;

    constructor({ schemes, liveSubscriptions, resolveDataEntryAddress, readEntry, writeEntry, deleteChannel, applyProposal, selection }: {
        schemes: SchemeRegistry;
        liveSubscriptions: LiveSubscriptions;
        resolveDataEntryAddress: EntryAddressBinding["resolve"];
        readEntry: (scheme: string, address: BoundEntryAddress, ctx: PlurnkSchemeContext) => Promise<ReadEntryResult>;
        writeEntry: (scheme: string, address: BoundEntryAddress, entry: EntryData, ctx: PlurnkSchemeContext) => Promise<WriteEntryResult>;
        deleteChannel: (
        scheme: string,
        address: BoundEntryAddress,
        channel: string,
        ctx: PlurnkSchemeContext,
    ) => Promise<DeleteEntryResult>;
        applyProposal: ProposalLifecycle["workerApply"];
        selection: ResourceSelector;
    }) {
        this.#schemes = schemes;
        this.#liveSubscriptions = liveSubscriptions;
        this.#resolveDataEntryAddress = resolveDataEntryAddress;
        this.#readEntry = readEntry;
        this.#writeEntry = writeEntry;
        this.#deleteChannel = deleteChannel;
        this.#applyProposal = applyProposal;
        this.#selection = selection;
    }

    async handleCopy(statement: CopyStatement, ctx: PlurnkSchemeContext): Promise<DispatchResult> {
        return this.copyOrchestration({
            statement,
            source: statement.source,
            destination: statement.destination,
            ctx,
        });
    }


    async handleMove(statement: MoveStatement, ctx: PlurnkSchemeContext): Promise<DispatchResult> {
        const sourceMarks = statement.source.lineMarker?.marks;
        const sourceLineMarker = sourceMarks?.length === 2
            && sourceMarks[0] === 1
            && sourceMarks[1] === -1
            ? null
            : statement.source.lineMarker;
        return this.moveOrchestration({
            statement,
            source: {
                ...statement.source,
                // Canonicalize only the execution selection. #writeLog retains
                // the authored marker as operation evidence. {§move-canonical-whole-source}
                lineMarker: sourceLineMarker,
            },
            destination: statement.destination,
            ctx,
        });
    }


    async copyOrchestration({
        statement,
        source,
        destination,
        ctx,
    }: {
        statement: CopyStatement;
        source: MetadataResourceSelection;
        destination: MetadataResourceSelection;
        ctx: PlurnkSchemeContext;
    }): Promise<DispatchResult> {
        const resolvedSource = await this.#selection.resolveResourceSelection(source, ctx);
        if (MutationEffects.isDispatchResult(resolvedSource)) return resolvedSource;
        const resolvedDestination = await this.#selection.resolveResourceSelection(destination, ctx);
        if (MutationEffects.isDispatchResult(resolvedDestination)) return resolvedDestination;
        const selected = await this.#selection.selectSource(resolvedSource, ctx, "COPY");
        if (MutationEffects.isDispatchResult(selected)) return selected;
        const result = await this.writeDestination(statement, selected, resolvedDestination, ctx);
        return MutationEffects.prependScopeNormalizations(result, selected.scopeNormalizations);
    }


    async moveOrchestration({
        statement,
        source,
        destination,
        ctx,
    }: {
        statement: MoveStatement;
        source: MetadataResourceSelection;
        destination: MetadataResourceSelection;
        ctx: PlurnkSchemeContext;
    }): Promise<DispatchResult> {
        const resolvedSource = await this.#selection.resolveResourceSelection(source, ctx);
        if (MutationEffects.isDispatchResult(resolvedSource)) return resolvedSource;
        const resolvedDestination = await this.#selection.resolveResourceSelection(destination, ctx);
        if (MutationEffects.isDispatchResult(resolvedDestination)) return resolvedDestination;
        const selected = await this.#selection.selectSource(resolvedSource, ctx, "MOVE");
        if (MutationEffects.isDispatchResult(selected)) return selected;

        if (MutationEffects.sameChannel(resolvedSource, resolvedDestination)) {
            const result = await this.moveWithinChannel(
                statement,
                selected,
                resolvedDestination,
                ctx,
            );
            return resolvedDestination.lineMarker === null
                ? MutationEffects.prependScopeNormalizations(result, selected.scopeNormalizations)
                : result;
        }

        const destinationResult = MutationEffects.prependScopeNormalizations(
            await this.writeDestination(
                statement,
                selected,
                resolvedDestination,
                ctx,
            ),
            selected.scopeNormalizations,
        );
        if (destinationResult.status >= 400) return destinationResult;
        const destinationAddress = MutationEffects.resourceAddress(resolvedDestination);
        const destinationEffects = MutationEffects.effectsOf(destinationResult);
        if (destinationResult.status === 202) {
            return {
                ...destinationResult,
                attrs: {
                    ...(destinationResult.attrs as Record<string, unknown> | undefined),
                    moveSource: MutationEffects.deferredMoveSource(
                        selected,
                        resolvedDestination,
                        selected.lineAnchorPrecondition,
                    ),
                },
            };
        }

        const sourceResult = await this.removeMoveSource(
            statement,
            selected,
            ctx,
            selected.lineAnchorPrecondition,
        );
        if (sourceResult.status === 202) {
            return {
                ...sourceResult,
                ...(destinationResult.scopeNormalizations === undefined
                    ? {}
                    : { scopeNormalizations: destinationResult.scopeNormalizations }),
                attrs: {
                    ...(sourceResult.attrs as Record<string, unknown> | undefined),
                    moveDestinationWritten: destinationAddress,
                    moveDestinationEffects: destinationEffects,
                },
            };
        }
        if (sourceResult.status >= 400) {
            return MutationEffects.moveFailureAfterDestination(
                destinationResult.scopeNormalizations === undefined
                    ? sourceResult
                    : Results.assert({
                        ...sourceResult,
                        scopeNormalizations: destinationResult.scopeNormalizations,
                    }),
                destinationAddress,
                destinationEffects,
            );
        }
        const base = destinationResult.status === 304
            ? { ...destinationResult, status: 200 }
            : destinationResult;
        return MutationEffects.withCombinedEffects(
            base,
            MutationEffects.effectsOf(sourceResult),
        );
    }


    async moveWithinChannel(
        statement: MoveStatement,
        source: SelectedSource,
        destination: AddressedResourceSelection,
        ctx: PlurnkSchemeContext,
    ): Promise<DispatchResult> {
        if (source.lineMarker === null) {
            if (destination.lineMarker !== null) {
                return MutationEffects.failure(
                    "move-region-overlap",
                    409,
                    "MOVE cannot insert a whole channel into itself and then remove that channel.",
                    {},
                    {
                        source: MutationEffects.resourceAddress(source),
                        destination: MutationEffects.resourceAddress(destination),
                        retryable: false,
                    },
                );
            }
            return this.writeDestination(statement, source, destination, ctx);
        }
        if (destination.lineMarker === null) {
            return this.writeDestination(statement, source, destination, ctx);
        }
        const resolvedDestination = this.#selection.resolveResourceLineMarker(
            destination,
            source.completeContent,
            "MOVE",
        );
        if ("result" in resolvedDestination) return resolvedDestination.result;
        const precondition = MutationEffects.mergeLineAnchorPreconditions(
            source.lineAnchorPrecondition,
            resolvedDestination.precondition,
        );
        const moved = await this.invokeEditBatch(
            resolvedDestination.selection,
            [
                {
                    marker: resolvedDestination.selection.lineMarker!,
                    body: source.content,
                    position: statement.position,
                },
                {
                    marker: source.lineMarker,
                    body: "",
                    position: statement.position,
                },
            ],
            ctx,
            precondition,
        );
        const effect = MutationEffects.pendingEffect(resolvedDestination.selection, "update");
        return MutationEffects.finalizeEffects(moved, resolvedDestination.selection, [effect, effect]);
    }


    async removeMoveSource(
        statement: MoveStatement,
        source: ResolvedResourceSelection,
        ctx: PlurnkSchemeContext,
        lineAnchorPrecondition: LineAnchorPrecondition | null = null,
    ): Promise<DispatchResult> {
        const effect = MutationEffects.pendingEffect(
            source,
            source.lineMarker === null ? "delete" : "update",
        );
        if (source.lineMarker === null) {
            const handler = this.#schemes.get(source.scheme, ctx.functionalityWorkerId) as SchemeHandler | undefined;
            if (handler === undefined) {
                throw new InvalidOperationResultError(
                    `Resolved MOVE source scheme '${source.scheme}' is no longer registered.`,
                );
            }
            const binding = await this.#resolveDataEntryAddress({
                target: source.target,
                routedScheme: source.scheme,
                handler,
                manifest: source.manifest as SchemeManifest & { readonly category: "data" },
                ctx,
            });
            if (binding.result !== null) return binding.result;
            if (binding.address === null) {
                return MutationEffects.failure(
                    "entry-not-found",
                    404,
                    `No MOVE source entry exists at ${MutationEffects.resourceAddress(source)}.`,
                );
            }
            const deleted = await this.#deleteChannel(
                source.scheme,
                binding.address,
                source.channel,
                ctx,
            );
            return MutationEffects.finalizeEffects(Results.assert(deleted), source, [effect]);
        }
        const edited = await this.invokeEditBatch(
            source,
            [{
                marker: source.lineMarker,
                body: "",
                position: statement.position,
            }],
            ctx,
            lineAnchorPrecondition,
        );
        return MutationEffects.finalizeEffects(edited, source, [effect]);
    }


    async writeDestination(
        statement: CopyStatement | MoveStatement,
        source: SelectedSource,
        destination: AddressedResourceSelection,
        ctx: PlurnkSchemeContext,
    ): Promise<DispatchResult> {
        const handler = this.#schemes.get(destination.scheme, ctx.functionalityWorkerId) as SchemeHandler | undefined;
        if (handler === undefined) {
            throw new InvalidOperationResultError(
                `Resolved COPY/MOVE destination scheme '${destination.scheme}' is no longer registered.`,
            );
        }
        const binding = await this.#resolveDataEntryAddress({
            target: destination.target,
            routedScheme: destination.scheme,
            handler,
            manifest: destination.manifest as SchemeManifest & { readonly category: "data" },
            ctx,
        });
        if (binding.result !== null) return binding.result;
        if (binding.address === null) {
            return MutationEffects.failure(
                "entry-not-found",
                404,
                `No destination entry address exists at ${MutationEffects.resourceAddress(destination)}.`,
            );
        }
        const storageAddress = binding.address;
        const existingResult = await this.#readEntry(
            destination.scheme,
            storageAddress,
            ctx,
        );
        if (existingResult.status >= 400 && existingResult.status !== 404) {
            return existingResult;
        }
        const existing = existingResult.status === 200
            ? existingResult.entry
            : null;
        if (existingResult.status === 200 && existing === null) {
            throw new InvalidOperationResultError(
                `The '${destination.scheme}' scheme returned 200 without a destination entry.`,
            );
        }
        const destinationChannel = existing?.channels[destination.channel];
        const expectedMimetype = destinationChannel?.mimetype
            ?? await PathMimetype.resolveEntryMimetype(
                destination.pathname,
                destination.manifest.channels[destination.channel] ?? source.mimetype,
                ctx.mimetypes,
            );
        if (source.mimetype !== expectedMimetype) {
            return MutationEffects.failure(
                "mimetype-mismatch",
                415,
                `COPY or MOVE cannot write '${source.mimetype}' into a '${expectedMimetype}' channel.`,
                {},
                {
                    channel: destination.channel,
                    sourceMimetype: source.mimetype,
                    destinationMimetype: expectedMimetype,
                    retryable: false,
                },
            );
        }

        const destinationEffect = MutationEffects.pendingEffect(
            destination,
            destinationChannel === undefined ? "create" : "update",
        );
        // {§fs-write-surface} — a scope that describes the complete resulting
        // value on an absent destination is creation, so the create path below
        // writes the source content. Any partial region needs existing lines.
        const scopedCreation = destination.lineMarker !== null
            && destinationChannel === undefined
            && (
                MutationEffects.isAppendMarker(destination.lineMarker)
                || MutationEffects.isCompleteAbsentDestinationMarker(
                    destination.lineMarker,
                    source.content,
                )
            );
        if (destination.lineMarker !== null && !scopedCreation) {
            if (destinationChannel === undefined) {
                const address = MutationEffects.resourceAddress(destination);
                return MutationEffects.failure(
                    "destination-region-not-found",
                    404,
                    `A destination region requires an existing #${destination.channel} channel at ${address}.`,
                    {},
                    {
                        destination: address,
                        recovery: `Use \`<-1>\`, \`<1,-1>\`, or the exact whole-value \`<1,N>\` extent to create ${address}; partial regions require an existing resource.`,
                        retryable: false,
                    },
                );
            }
            if (await MimetypeBinary.isBinaryMimetype(destinationChannel.mimetype, ctx.mimetypes)) {
                return MutationEffects.failure(
                    "binary-region-unsupported",
                    415,
                    `Channel #${destination.channel} is binary and cannot receive a textual region.`,
                    {},
                    {
                        channel: destination.channel,
                        mimetype: destinationChannel.mimetype,
                        retryable: false,
                    },
                );
            }
            const resolvedMarker = this.#selection.resolveResourceLineMarker(
                destination,
                destinationChannel.content,
                statement.op,
            );
            if ("result" in resolvedMarker) return resolvedMarker.result;
            const edited = await this.invokeEditBatch(
                resolvedMarker.selection,
                [{
                    marker: resolvedMarker.selection.lineMarker!,
                    body: source.content,
                    position: statement.position,
                }],
                ctx,
                resolvedMarker.precondition,
            );
            return MutationEffects.finalizeEffects(edited, resolvedMarker.selection, [destinationEffect]);
        }

        if (
            destinationChannel !== undefined
            && destinationChannel.content !== source.content
        ) {
            return MutationEffects.failure(
                "copy-destination-exists",
                409,
                `COPY or MOVE destination ${MutationEffects.resourceAddress(destination)} already contains different content.`,
                {},
                {
                    destination: MutationEffects.resourceAddress(destination),
                    retryable: false,
                },
            );
        }
        if (destinationChannel !== undefined) return { status: 304 };

        const channels = {
            ...(existing?.channels ?? {}),
            [destination.channel]: {
                content: source.content,
                mimetype: source.mimetype,
            },
        };
        const written = await this.#writeEntry(
            destination.scheme,
            storageAddress,
            { channels },
            ctx,
        );
        const exactWritten = Results.assert(written);
        const parseIssues = exactWritten.status === 200 || exactWritten.status === 201
            ? await new DbProjectionCaps(ctx).parseIssueTransition(null, source.content, source.mimetype)
            : undefined;
        const materialized = source.lineMarker === null
            || (exactWritten.status !== 200 && exactWritten.status !== 201 && exactWritten.status !== 202)
            ? exactWritten
            : MutationEffects.withEditMaterialization(
                exactWritten,
                editReceipt(
                    "",
                    source.content,
                    [{
                        marker: { marks: [1, -1] },
                        body: source.content,
                    }],
                    parseIssues,
                    // {§edit-receipt-anchored-context} — the destination's READ identity
                    destination.channel === destination.manifest.defaultChannel
                        ? EntryManifest.toPath(destination.scheme, storageAddress.authority, storageAddress.pathname)
                        : `${EntryManifest.toPath(destination.scheme, storageAddress.authority, storageAddress.pathname)}#${PathSyntax.escapeTarget(destination.channel)}`,
                ),
            );
        return MutationEffects.finalizeEffects(
            materialized,
            destination,
            [destinationEffect],
        );
    }


    async invokeEditBatch(
        selection: ResolvedResourceSelection,
        edits: ReadonlyArray<{
            readonly marker: LineMarker;
            readonly body: string;
            readonly position: EditStatement["position"];
        }>,
        ctx: PlurnkSchemeContext,
        precondition: LineAnchorPrecondition | null = null,
    ): Promise<DispatchResult> {
        const handler = this.#schemes.get(selection.scheme, ctx.functionalityWorkerId) as SchemeHandler | undefined;
        if (typeof handler?.editBatch !== "function") {
            return MutationEffects.failure(
                "operation-not-implemented",
                501,
                `Scheme '${selection.scheme}' does not implement EDIT batches.`,
                {},
                {
                    scheme: selection.scheme,
                    operation: "EDIT",
                    retryable: false,
                },
            );
        }
        const statements: ResolvedEditStatement[] = edits.map(({ marker, body, position }) => ({
            op: "EDIT",
            delimiter: "",
            annotation: null,
            signal: null,
            target: selection.target,
            metadata: selection.metadata,
            lineMarker: marker,
            body,
            position,
        }));
        const addressedScheme = selection.target.kind === "url"
            ? selection.target.scheme
            : selection.scheme;
        try {
            const binding = await this.#resolveDataEntryAddress({
                target: selection.target,
                routedScheme: selection.scheme,
                handler,
                manifest: selection.manifest as SchemeManifest & { readonly category: "data" },
                ctx,
            });
            if (binding.result !== null) return binding.result;
            if (binding.address === null) {
                return MutationEffects.failure(
                    "entry-not-found",
                    404,
                    `No entry exists at ${MutationEffects.resourceAddress(selection)}.`,
                );
            }
            const result = Results.assert(await handler.editBatch(
                statements,
                new SchemeCtxImpl(
                    ctx,
                    addressedScheme,
                    selection.manifest,
                    this.#liveSubscriptions,
                    {
                        authority: binding.address.authority,
                        ownerId: binding.address.ownerId,
                        publishedChannel: selection.channel,
                        editPrecondition: precondition,
                    },
                ),
            ));
            return MutationEffects.withProposalRoute(result, selection);
        } catch (err) {
            if (err instanceof InvalidOperationResultError) throw err;
            console.error(
                `Scheme '${selection.scheme}' COPY/MOVE edit threw outside its operation result contract:`,
                err,
            );
            return MutationEffects.failure(
                "scheme-handler-threw",
                500,
                `The '${selection.scheme}' scheme did not produce a COPY/MOVE edit result.`,
                {},
                {
                    stage: "scheme-dispatch",
                    scheme: selection.scheme,
                    operation: "EDIT",
                },
            );
        }
    }


    async settleMoveProposal({
        statement,
        result,
        settlement,
        ctx,
        ids,
    }: {
        statement: PlurnkStatement;
        result: DispatchResult;
        settlement: ProposalSettlement;
        ctx: PlurnkSchemeContext;
        ids: ProposalIds;
    }): Promise<ProposalSettlement> {
        if (statement.op !== "MOVE") return settlement;
        const attrs = result.attrs as OrchestrationProposalAttrs | undefined;
        const destinationWritten = attrs?.moveDestinationWritten;
        if (destinationWritten !== undefined) {
            const destinationEffects = attrs?.moveDestinationEffects === undefined
                ? []
                : assertResourceEffects(attrs.moveDestinationEffects);
            if (settlement.resolution.decision !== "accept") {
                const decision = settlement.resolution.decision;
                return {
                    resolution: settlement.resolution,
                    applied: MutationEffects.moveFailureAfterDestination(
                        MutationEffects.failure(
                            "move-source-not-applied",
                            decision === "cancel" ? 499 : 409,
                            `The MOVE destination was written, but source removal was ${decision === "cancel" ? "cancelled" : "rejected"}.`,
                            {},
                            {
                                retryable: false,
                            },
                        ),
                        destinationWritten,
                        destinationEffects,
                    ),
                };
            }
            if (settlement.applied === undefined) {
                return {
                    resolution: settlement.resolution,
                    applied: MutationEffects.moveFailureAfterDestination(
                        MutationEffects.failure(
                            "proposal-apply-missing",
                            500,
                            "The source scheme accepted its MOVE proposal without applying the source mutation.",
                            {},
                            {
                                stage: "proposal-application",
                                retryable: false,
                            },
                        ),
                        destinationWritten,
                        destinationEffects,
                    ),
                };
            }
            if (settlement.applied.status >= 400) {
                return {
                    resolution: settlement.resolution,
                    applied: MutationEffects.moveFailureAfterDestination(
                        settlement.applied,
                        destinationWritten,
                        destinationEffects,
                    ),
                };
            }
            return MutationEffects.withSettlementEffects(
                settlement,
                [
                    ...destinationEffects,
                    ...MutationEffects.settlementEffects(settlement),
                ],
            );
        }

        const deferred = attrs?.moveSource;
        if (
            deferred === undefined
            || settlement.resolution.decision !== "accept"
            || (settlement.applied?.status ?? 200) >= 400
        ) {
            return settlement;
        }
        if (settlement.applied === undefined) {
            return {
                resolution: settlement.resolution,
                applied: MutationEffects.failure(
                    "proposal-apply-missing",
                    500,
                    "The destination scheme accepted its MOVE proposal without applying the destination mutation.",
                    {},
                    {
                        stage: "proposal-application",
                        retryable: false,
                    },
                ),
            };
        }
        const destinationEffects = MutationEffects.settlementEffects(settlement);

        const resolvedSource = await this.#selection.resolveResourceSelection(
            {
                target: deferred.target,
                metadata: deferred.metadata,
                lineMarker: deferred.lineMarker,
            },
            ctx,
        );
        if (MutationEffects.isDispatchResult(resolvedSource)) {
            return {
                resolution: settlement.resolution,
                applied: MutationEffects.moveFailureAfterDestination(
                    resolvedSource,
                    deferred.destination,
                    destinationEffects,
                ),
            };
        }
        if (
            resolvedSource.scheme !== deferred.scheme
            || resolvedSource.authority !== deferred.authority
            || resolvedSource.pathname !== deferred.pathname
            || resolvedSource.channel !== deferred.channel
        ) {
            throw new InvalidOperationResultError(
                "A deferred MOVE source no longer resolves to its recorded identity.",
            );
        }

        const removed = await this.removeMoveSource(
            statement,
            {
                ...resolvedSource,
                lineMarker: resolvedSource.lineMarker as LineMarker | null,
            },
            ctx,
            deferred.lineAnchorPrecondition,
        );
        if (removed.status >= 400) {
            return {
                resolution: settlement.resolution,
                applied: MutationEffects.moveFailureAfterDestination(
                    removed,
                    deferred.destination,
                    destinationEffects,
                ),
            };
        }
        if (removed.status !== 202) {
            return MutationEffects.withSettlementEffects(
                settlement,
                [
                    ...destinationEffects,
                    ...MutationEffects.effectsOf(removed),
                ],
            );
        }

        const initialSourceSettlement = await this.#applyProposal(
            statement,
            removed,
            { decision: "accept" },
            ids,
        );
        const sourceSettlement = MutationEffects.settleProposalEffects(
            removed,
            initialSourceSettlement,
        );
        if (sourceSettlement.applied === undefined) {
            return {
                resolution: settlement.resolution,
                applied: MutationEffects.moveFailureAfterDestination(
                    MutationEffects.failure(
                        "proposal-apply-missing",
                        500,
                        "The source scheme accepted its MOVE proposal without applying the source mutation.",
                        {},
                        {
                            stage: "proposal-application",
                            retryable: false,
                        },
                    ),
                    deferred.destination,
                    destinationEffects,
                ),
            };
        }
        if (sourceSettlement.applied.status >= 400) {
            return {
                resolution: settlement.resolution,
                applied: MutationEffects.moveFailureAfterDestination(
                    sourceSettlement.applied,
                    deferred.destination,
                    destinationEffects,
                ),
            };
        }
        return MutationEffects.withSettlementEffects(
            settlement,
            [
                ...destinationEffects,
                ...MutationEffects.settlementEffects(sourceSettlement),
            ],
        );
    }

}
