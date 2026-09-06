import { PathSyntax, type CopyStatement, type EditStatement, type LineMarker, type MoveStatement, type PlurnkStatement } from "@plurnk/plurnk-contracts";
import { InvalidOperationResultError, MimetypeClassifier, type ResolvedEditStatement, type SchemeHandler } from "@plurnk/plurnk-schemes";
import type SchemeRegistry from "./SchemeRegistry.ts";
import type LiveSubscriptions from "./LiveSubscriptions.ts";
import type ProposalLifecycle from "./ProposalLifecycle.ts";
import type { ProposalSettlement } from "./ProposalLifecycle.ts";
import type { EntryData, ReadEntryResult, WriteEntryResult, DeleteEntryResult } from "../schemes/_entry-crud.ts";
import type { SchemeManifest, PlurnkSchemeContext } from "./scheme-types.ts";
import { assertResourceEffects, editReceipt, LineMarkerOps, MimetypeBinary, PathMimetype, type LineAnchorPrecondition } from "../content/index.ts";
import DbProjectionCaps from "./caps/DbProjectionCaps.ts";
import SchemeCtxImpl from "./caps/SchemeCtxImpl.ts";
import Results from "./results.ts";
import EntryAddressBinding from "./EntryAddressBinding.ts";
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
        // {§binary-parity} — a materialized binary destination's channel mimetype is its text projection
        // (the facts line); its real mimetype is the source projection, and that is what a transfer must
        // match and re-write. A text destination has no source projection, so this is its channel mimetype.
        const destProjection = (existing?.attributes as { sourceProjection?: { mimetype?: unknown } } | undefined)?.sourceProjection;
        const destRealMimetype = typeof destProjection?.mimetype === "string" ? destProjection.mimetype : destinationChannel?.mimetype;
        const expectedMimetype = destRealMimetype
            ?? await PathMimetype.resolveEntryMimetype(
                destination.pathname,
                destination.manifest.channels[destination.channel] ?? source.mimetype,
                ctx.mimetypes,
            );
        if (!MimetypeClassifier.isTransferCompatible(source.mimetype, expectedMimetype)) {
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
        let creationContent = source.content;
        let creationScopeNormalizations: ReturnType<typeof LineMarkerOps.applyLineMarkerEdit>["scopeNormalizations"];
        if (destination.lineMarker !== null && destinationChannel === undefined) {
            // {§fs-write-surface} {§empty-mutation-scope} — creation has an
            // ordinary empty pre-mutation value. Resolve and apply the authored
            // destination scope to that value; no source-length allowlist exists.
            const resolvedMarker = this.#selection.resolveResourceLineMarker(
                destination,
                "",
                statement.op,
            );
            if ("result" in resolvedMarker) return resolvedMarker.result;
            if (source.bytes !== undefined && resolvedMarker.selection.lineMarker!.marks.length > 2) {
                return LineMarkerOps.window(resolvedMarker.selection.lineMarker!, 0, "byte");
            }
            const created = LineMarkerOps.applyLineMarkerEdit(
                "",
                resolvedMarker.selection.lineMarker!,
                source.content,
            );
            if (created.status >= 400) return Results.assert(created);
            if (created.result === undefined) {
                throw new InvalidOperationResultError(
                    "A successful empty-destination mutation produced no resulting content.",
                );
            }
            creationContent = created.result;
            creationScopeNormalizations = created.scopeNormalizations;
        } else if (destination.lineMarker !== null && destinationChannel !== undefined) {
            if (source.bytes !== undefined) {
                // {§binary-parity} — a byte source into a destination region is a splice: the destination's
                // named byte window becomes exactly the source bytes, every other byte untouched. The whole
                // result is re-written. Coordinate = byte, as the source range is ({§read-bytes}).
                return this.#spliceBytes(
                    handler, storageAddress, destination, existing ?? null,
                    source.bytes, source.mimetype, destinationEffect, ctx,
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

        // {§binary-parity} — a binary source rides its bytes, not text; the destination channel carries
        // them and the receipt is the byte count, with no text diff or parse-issue transition.
        const isByteTransfer = source.bytes !== undefined;
        const channels = {
            ...(existing?.channels ?? {}),
            [destination.channel]: isByteTransfer
                ? { content: "", bytes: source.bytes, mimetype: source.mimetype }
                : {
                    content: creationContent,
                    mimetype: expectedMimetype,
                },
        };
        const written = await this.#writeEntry(
            destination.scheme,
            storageAddress,
            { channels },
            ctx,
        );
        const exactWritten = Results.assert(written);
        const parseIssues = !isByteTransfer && (exactWritten.status === 200 || exactWritten.status === 201)
            ? await new DbProjectionCaps(ctx).parseIssueTransition(null, creationContent, expectedMimetype)
            : undefined;
        const materialized = isByteTransfer || source.lineMarker === null
            || (exactWritten.status !== 200 && exactWritten.status !== 201 && exactWritten.status !== 202)
            ? exactWritten
            : MutationEffects.withEditMaterialization(
                exactWritten,
                editReceipt(
                    "",
                    creationContent,
                    [{
                        marker: { marks: [1, -1] },
                        body: creationContent,
                    }],
                    parseIssues,
                    // {§edit-receipt-anchored-context} — the destination's READ identity
                    destination.channel === destination.manifest.defaultChannel
                        ? EntryManifest.toPath(destination.scheme, storageAddress.authority, storageAddress.pathname)
                        : `${EntryManifest.toPath(destination.scheme, storageAddress.authority, storageAddress.pathname)}#${PathSyntax.escapeTarget(destination.channel)}`,
                ),
            );
        return MutationEffects.prependScopeNormalizations(
            MutationEffects.finalizeEffects(
                materialized,
                destination,
                [destinationEffect],
            ),
            creationScopeNormalizations,
        );
    }

    // {§binary-parity} — splice source bytes into the destination's named byte window and re-write the
    // whole resource. `<c,d>` replaces bytes c..d (1-indexed, inclusive); `<c>` inserts at byte c (before
    // it, or after it with a trailing position; `<-1>` appends). Every byte outside the window is kept.
    async #spliceBytes(
        handler: SchemeHandler,
        storageAddress: BoundEntryAddress,
        destination: AddressedResourceSelection,
        existing: EntryData | null,
        srcBytes: Uint8Array,
        mimetype: string,
        destinationEffect: ReturnType<typeof MutationEffects.pendingEffect>,
        ctx: PlurnkSchemeContext,
    ): Promise<DispatchResult> {
        const byteSource = (handler as SchemeHandler).byteSource?.(storageAddress, EntryAddressBinding.addressContext(ctx));
        if (byteSource === undefined) {
            return MutationEffects.failure(
                "binary-region-unsupported", 415,
                `Channel #${destination.channel} is binary and its scheme keeps no bytes to splice.`,
                {}, { channel: destination.channel, mimetype, retryable: false },
            );
        }
        const size = await byteSource.size();
        if (size === null) {
            return MutationEffects.failure(
                "entry-not-found", 404, `No bytes exist at ${MutationEffects.resourceAddress(destination)}.`,
                {}, { destination: MutationEffects.resourceAddress(destination), retryable: false },
            );
        }
        // A binary region is numeric byte coordinates; a textual anchor mark has no byte meaning.
        const marks = (destination.lineMarker?.marks ?? []).map((m) => typeof m === "number" ? m : Number.NaN);
        if (marks.some(Number.isNaN)) {
            return MutationEffects.failure(
                "range-not-satisfiable", 416, `A binary region is a numeric byte range; #${destination.channel} was given a textual anchor.`,
                {}, { channel: destination.channel, unit: "byte", available: size, retryable: false },
            );
        }
        let headEnd: number;
        let tailStart: number;
        if (marks.length >= 2) {
            const start = marks[0] === -1 ? size : marks[0]!;
            const end = marks[1] === -1 ? size : marks[1]!;
            if (!(start >= 1 && end >= start && end <= size)) {
                return MutationEffects.failure(
                    "range-not-satisfiable", 416, `Byte range <${start},${end}> is outside the available 1..${size}.`,
                    {}, { channel: destination.channel, unit: "byte", available: size, retryable: false },
                );
            }
            headEnd = start - 1;
            tailStart = end + 1;
        } else {
            const c = marks.length === 1 && marks[0] !== -1 ? marks[0]! : size + 1;
            if (!(c >= 1 && c <= size + 1)) {
                return MutationEffects.failure(
                    "range-not-satisfiable", 416, `Byte position <${c}> is outside the available 1..${size + 1}.`,
                    {}, { channel: destination.channel, unit: "byte", available: size, retryable: false },
                );
            }
            headEnd = c - 1;
            tailStart = c;
        }
        const head = headEnd >= 1 ? await byteSource.read(1, headEnd) : new Uint8Array(0);
        const tail = tailStart <= size ? await byteSource.read(tailStart, size) : new Uint8Array(0);
        const result = new Uint8Array(head.length + srcBytes.length + tail.length);
        result.set(head, 0);
        result.set(srcBytes, head.length);
        result.set(tail, head.length + srcBytes.length);

        const channels = {
            ...(existing?.channels ?? {}),
            [destination.channel]: { content: "", bytes: result, mimetype },
        };
        const written = await this.#writeEntry(destination.scheme, storageAddress, { channels }, ctx);
        return MutationEffects.finalizeEffects(Results.assert(written), destination, [destinationEffect]);
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
