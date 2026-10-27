import { isRecord } from "@plurnk/plurnk-contracts";
import LineAnchors from "../content/line-anchors.ts";
import type { CopyStatement, EditStatement, LineMarker, MoveStatement, PlurnkStatement } from "@plurnk/plurnk-contracts";
import { InvalidOperationResultError, MimetypeClassifier, type ResolvedEditStatement, type SchemeHandler } from "@plurnk/plurnk-schemes";
import type SchemeRegistry from "./SchemeRegistry.ts";
import { missDetail, missExtensions } from "./plurnk-uri.ts";
import type LiveSubscriptions from "./LiveSubscriptions.ts";
import type ProposalLifecycle from "./ProposalLifecycle.ts";
import type { ProposalSettlement } from "./ProposalLifecycle.ts";
import type { EntryData, ReadEntryResult, WriteEntryResult, DeleteEntryResult } from "../schemes/_entry-crud.ts";
import type { SchemeManifest, PlurnkSchemeContext } from "./scheme-types.ts";
import { assertResourceEffects, editReceipt, EditCollision, LineMarkerOps, MimetypeBinary, PathMimetype, type LineAnchorPrecondition, type ResourceEffect } from "../content/index.ts";
import ByteView from "../content/byte-view.ts";
import EntryCrud from "../schemes/_entry-crud.ts";
import { contentHash } from "./content-hash.ts";
import DbProjectionCaps from "./caps/DbProjectionCaps.ts";
import SchemeCtxImpl from "./caps/SchemeCtxImpl.ts";
import Results from "./results.ts";
import EntryAddressBinding from "./EntryAddressBinding.ts";
import type { BoundEntryAddress } from "./EntryAddressBinding.ts";
import EntryManifest from "../schemes/_entry-manifest.ts";
import EntryReadable from "../schemes/_entry-readable.ts";
import FileSnapshot from "./FileSnapshot.ts";
import FileMaterialization from "./file-materialization.ts";
import type { DispatchResult, MetadataResourceSelection, AddressedResourceSelection, ResolvedResourceSelection, SelectedSource, OrchestrationProposalAttrs, ProposalIds, DeferredMoveSource, PendingResourceEffect } from "./mutation-types.ts";
import MutationEffects from "./MutationEffects.ts";
import type ResourceSelector from "./ResourceSelector.ts";

// COPY and MOVE orchestration: source selection, destination writes, move settlement.
type ScopeNormalizations = ReturnType<typeof LineMarkerOps.applyLineMarkerEdit>["scopeNormalizations"];
type EntryChannel = EntryData["channels"][string];

// A transfer's destination as writeDestination binds it: handler, storage address, the entry as it stands (none
// at 404), and the context carrying the file revision that read observed.
type DestinationBinding = {
    handler: SchemeHandler;
    storageAddress: BoundEntryAddress;
    existing: EntryData | null;
    ctx: PlurnkSchemeContext;
};

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
    readonly #applyProposal: ProposalLifecycle["sessionApply"];
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
        applyProposal: ProposalLifecycle["sessionApply"];
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
                // the authored marker as operation evidence. {§move}
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
        const resolvedSource = await this.#selection.resolveResourceSelection(source, ctx, "read");
        if (MutationEffects.isDispatchResult(resolvedSource)) return resolvedSource;
        const resolvedDestination = await this.#selection.resolveResourceSelection(destination, ctx);
        if (MutationEffects.isDispatchResult(resolvedDestination)) return resolvedDestination;
        const selected = await this.#selection.selectSource(resolvedSource, ctx, "COPY");
        if (MutationEffects.isDispatchResult(selected)) return selected;
        const result = await this.writeDestination(statement, selected, resolvedDestination, ctx);
        return ResourceTransfers.#withMatched(MutationEffects.prependScopeNormalizations(result, selected.scopeNormalizations), selected);
    }

    // {§copy} — a pattern transfer reports how many spans it selected.
    static #withMatched(result: DispatchResult, selected: SelectedSource): DispatchResult {
        if (selected.matchedScopes === undefined || result.status >= 300) return result;
        return Results.assert({ ...result, matched: selected.matchedScopes.length });
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
        // {§move} — a MOVE reads its source exactly as COPY does and then retires
        // it with the source scheme's own KILL: an entry scheme deletes or edits the entry, the
        // log curates its projection. The recorded evidence is never a write target.
        const resolvedSource = await this.#selection.resolveResourceSelection(source, ctx, "read");
        if (MutationEffects.isDispatchResult(resolvedSource)) return resolvedSource;
        const resolvedDestination = await this.#selection.resolveResourceSelection(destination, ctx);
        if (MutationEffects.isDispatchResult(resolvedDestination)) return resolvedDestination;
        const selected = await this.#selection.selectSource(resolvedSource, ctx, "MOVE");
        if (MutationEffects.isDispatchResult(selected)) return selected;

        const handler = this.#schemes.get(resolvedSource.scheme, ctx.workspaceId);
        if (handler === undefined) throw new InvalidOperationResultError(`Resolved MOVE source scheme '${resolvedSource.scheme}' is no longer registered.`);
        // {§channel-selection} — a derived projection cannot be moved out of its entry.
        if (EntryReadable.isDerived(resolvedSource.channel)) {
            return MutationEffects.failure(
                "channel-derived", 400,
                `#${resolvedSource.channel} is derived from its source channel and cannot be moved.`,
                {}, { scheme: resolvedSource.scheme, channel: resolvedSource.channel, operation: "MOVE", retryable: false },
            );
        }
        // {§copy} — a curated source retires rows, not lines of its projection.
        if (selected.matchedScopes !== undefined && ResourceTransfers.#curatedSource(resolvedSource)) {
            return MutationEffects.failure(
                "pattern-unsupported", 400,
                `MOVE cannot retire lines of the '${resolvedSource.scheme}' projection by pattern.`,
                {}, { scheme: resolvedSource.scheme, operation: "MOVE", retryable: false },
            );
        }
        if (!ResourceTransfers.#curatedSource(resolvedSource)) {
            const sourceBinding = await this.#resolveDataEntryAddress({
                target: resolvedSource.target,
                routedScheme: resolvedSource.scheme,
                handler,
                manifest: resolvedSource.manifest,
                ctx,
                access: "write",
            });
            if (sourceBinding.result !== null) return sourceBinding.result;
            if (sourceBinding.address === null) return MutationEffects.failure(
                "entry-not-found", 404, "The MOVE source could not be resolved for deletion.",
            );
        }

        if (MutationEffects.sameChannel(resolvedSource, resolvedDestination)) {
            const result = await this.moveWithinChannel(
                statement,
                selected,
                resolvedDestination,
                ctx,
            );
            return ResourceTransfers.#withMatched(resolvedDestination.lineMarker === null
                ? MutationEffects.prependScopeNormalizations(result, selected.scopeNormalizations)
                : result, selected);
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
                    ...(isRecord(destinationResult.attrs) ? destinationResult.attrs : {}),
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
            return MutationEffects.moveSourceProposal({
                ...sourceResult,
                ...(destinationResult.scopeNormalizations === undefined
                    ? {}
                    : { scopeNormalizations: destinationResult.scopeNormalizations }),
            }, destinationAddress, destinationEffects);
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
        return ResourceTransfers.#withMatched(MutationEffects.withCombinedEffects(
            base,
            MutationEffects.effectsOf(sourceResult),
        ), selected);
    }


    async moveWithinChannel(
        statement: MoveStatement,
        source: SelectedSource,
        destination: AddressedResourceSelection,
        ctx: PlurnkSchemeContext,
    ): Promise<DispatchResult> {
        if (source.fileRevision !== undefined) ctx = { ...ctx, fileRevision: source.fileRevision };
        if (source.lineMarker === null && source.matchedScopes === undefined) {
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
        if (source.bytes !== undefined) {
            return this.#moveBytes(source, destination, ctx);
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
        const removals = ResourceTransfers.#sourceRemovals(source, statement.position);
        const moved = await this.invokeEditBatch(
            resolvedDestination.selection,
            [
                {
                    marker: resolvedDestination.selection.lineMarker!,
                    body: source.content,
                    position: statement.position,
                },
                ...removals,
            ],
            ctx,
            precondition,
        );
        const effect = MutationEffects.pendingEffect(resolvedDestination.selection, "update");
        return MutationEffects.finalizeEffects(moved, resolvedDestination.selection, [effect, ...removals.map(() => effect)]);
    }

    // The edits that take a scoped source out of its channel: the scope itself, or each span a
    // pattern selected ({§copy}).
    static #sourceRemovals(
        source: ResolvedResourceSelection & { readonly matchedScopes?: readonly LineMarker[] },
        position: EditStatement["position"],
    ): Array<{ readonly marker: LineMarker; readonly body: string; readonly position: EditStatement["position"] }> {
        if (source.matchedScopes !== undefined) {
            return source.matchedScopes.map((marker) => ({ marker, body: "", position }));
        }
        if (source.lineMarker === null) throw new InvalidOperationResultError("A whole-channel MOVE source has no removal edits.");
        return [{ marker: source.lineMarker, body: "", position }];
    }


    // {§move} — a logging scheme's KILL is content curation (the projection trims,
    // the row is retired, the evidence stays), so it is a MOVE's source removal. A stream's KILL
    // is process control and is not.
    static #curatedSource(source: { readonly manifest: SchemeManifest }): boolean {
        return source.manifest.category === "logging";
    }

    async removeMoveSource(
        statement: MoveStatement,
        source: ResolvedResourceSelection & Pick<SelectedSource, "matchedScopes" | "bytePrecondition" | "fileRevision">,
        ctx: PlurnkSchemeContext,
        lineAnchorPrecondition: LineAnchorPrecondition | null = null,
    ): Promise<DispatchResult> {
        if (source.fileRevision !== undefined) ctx = { ...ctx, fileRevision: source.fileRevision };
        if (source.bytePrecondition !== undefined) {
            const current = await this.#selection.selectSource({ ...source, lineMarker: null, matcher: null }, ctx, "COPY");
            if (MutationEffects.isDispatchResult(current)) return current;
            if (current.bytes === undefined || contentHash(current.bytes) !== source.bytePrecondition) {
                return EditCollision.result(MutationEffects.resourceAddress(source));
            }
            if (source.lineMarker !== null || source.matchedScopes !== undefined) {
                return this.#moveBytes({ ...current, ...source }, null, ctx);
            }
        }
        const effect = MutationEffects.pendingEffect(
            source,
            source.lineMarker === null && source.matchedScopes === undefined ? "delete" : "update",
        );
        if (source.matchedScopes !== undefined) {
            const removals = ResourceTransfers.#sourceRemovals(source, statement.position);
            const edited = await this.invokeEditBatch(source, removals, ctx, lineAnchorPrecondition);
            return MutationEffects.finalizeEffects(edited, source, removals.map(() => effect));
        }
        if (ResourceTransfers.#curatedSource(source)) {
            const handler = this.#schemes.get(source.scheme, ctx.workspaceId);
            if (handler?.kill === undefined) {
                throw new InvalidOperationResultError(`Resolved MOVE source scheme '${source.scheme}' curates nothing.`);
            }
            const curated = await handler.kill(
                { op: "KILL", target: source.target, lineMarker: source.lineMarker, metadata: source.metadata,
                    matcher: null, body: null, aside: statement.aside, position: statement.position },
                new SchemeCtxImpl(ctx, source.scheme, source.manifest, this.#liveSubscriptions, { authority: source.authority }),
            );
            return MutationEffects.finalizeEffects(Results.assert(curated), source, [effect]);
        }
        if (source.lineMarker === null) {
            const handler = this.#schemes.get(source.scheme, ctx.workspaceId);
            if (handler === undefined) {
                throw new InvalidOperationResultError(
                    `Resolved MOVE source scheme '${source.scheme}' is no longer registered.`,
                );
            }
            const binding = await this.#resolveDataEntryAddress({
                target: source.target,
                routedScheme: source.scheme,
                handler,
                manifest: source.manifest,
                ctx,
                access: "write",
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


    // {§copy} {§fs-write-surface} The destination half of a transfer: bound and read as it
    // stands, its channel type agreed with the source, then written — a scoped creation, a region of an existing
    // channel, or the whole channel — with the effect and the receipt the row carries.
    async writeDestination(
        statement: CopyStatement | MoveStatement,
        source: SelectedSource,
        destination: AddressedResourceSelection,
        ctx: PlurnkSchemeContext,
    ): Promise<DispatchResult> {
        const bound = await this.#bindDestination(destination, ctx);
        if ("status" in bound) return bound;
        const { handler, storageAddress, existing } = bound;
        ctx = bound.ctx;
        const destinationChannel = existing?.channels[destination.channel];
        const expectedMimetype = await ResourceTransfers.#destinationMimetype(source, destination, existing, ctx);
        if (typeof expectedMimetype !== "string") return expectedMimetype;

        const destinationEffect = MutationEffects.pendingEffect(
            destination,
            destinationChannel === undefined ? "create" : "update",
        );
        let creationContent = source.content;
        let creationScopeNormalizations: ScopeNormalizations;
        if (destination.lineMarker !== null && destinationChannel === undefined) {
            const created = this.#scopedCreation(statement, source, destination);
            if ("status" in created) return created;
            creationContent = created.content;
            creationScopeNormalizations = created.scopeNormalizations;
        } else if (destination.lineMarker !== null && destinationChannel !== undefined) {
            return this.#writeIntoRegion({ statement, source, destination, destinationChannel, handler, storageAddress, existing, destinationEffect, ctx });
        }
        return this.#writeWholeChannel({
            source, destination, destinationChannel, existing, storageAddress, expectedMimetype, destinationEffect,
            creationContent, creationScopeNormalizations, ctx,
        });
    }

    // The destination bound for writing and read as it stands: its handler, its storage address, the existing entry
    // (none at 404), and the context carrying the file revision that read observed.
    async #bindDestination(destination: AddressedResourceSelection, ctx: PlurnkSchemeContext): Promise<DestinationBinding | DispatchResult> {
        const handler = this.#schemes.get(destination.scheme, ctx.workspaceId);
        if (handler === undefined) {
            throw new InvalidOperationResultError(
                `Resolved COPY/MOVE destination scheme '${destination.scheme}' is no longer registered.`,
            );
        }
        const binding = await this.#resolveDataEntryAddress({
            target: destination.target,
            routedScheme: destination.scheme,
            handler,
            manifest: destination.manifest,
            ctx,
            access: "write",
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
        if (existingResult.fileRevision !== undefined) ctx = { ...ctx, fileRevision: existingResult.fileRevision };
        const existing = existingResult.status === 200
            ? existingResult.entry
            : null;
        if (existingResult.status === 200 && existing === null) {
            throw new InvalidOperationResultError(
                `The '${destination.scheme}' scheme returned 200 without a destination entry.`,
            );
        }
        return { handler, storageAddress, existing, ctx };
    }

    // The channel type a transfer writes, which the source must be transfer-compatible with.
    static async #destinationMimetype(
        source: SelectedSource,
        destination: AddressedResourceSelection,
        existing: EntryData | null,
        ctx: PlurnkSchemeContext,
    ): Promise<string | DispatchResult> {
        const destinationChannel = existing?.channels[destination.channel];
        // {§binary-parity} — a materialized binary destination's channel mimetype is its text projection
        // (the facts line); its real mimetype is the source projection, and that is what a transfer must
        // match and re-write. A text destination has no source projection, so this is its channel mimetype.
        const destProjection = (existing?.attributes as { sourceProjection?: { mimetype?: unknown } } | undefined)?.sourceProjection;
        const destRealMimetype = typeof destProjection?.mimetype === "string" ? destProjection.mimetype : destinationChannel?.mimetype;
        // {§copy}: a transfer supplies the absent channel's type;
        // a recognized destination suffix still participates in compatibility checking.
        const expectedMimetype = destRealMimetype
            ?? await PathMimetype.resolveEntryMimetype(
                destination.pathname,
                destination.manifest.channels[destination.channel] ?? MimetypeClassifier.normalizeAutoText(source.mimetype),
                ctx.mimetypes,
            );
        if (!MimetypeClassifier.isTransferCompatible(source.mimetype, expectedMimetype, {
            binary: source.bytes !== undefined,
        })) {
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
        return expectedMimetype;
    }

    // {§fs-write-surface} {§empty-mutation-scope} A scoped transfer into a channel that does not exist yet: the
    // authored scope applied to an ordinary empty pre-mutation value.
    #scopedCreation(
        statement: CopyStatement | MoveStatement,
        source: SelectedSource,
        destination: AddressedResourceSelection,
    ): { content: string; scopeNormalizations: ScopeNormalizations } | DispatchResult {
        if (source.bytes !== undefined) {
            const marker = ByteView.marker(destination.lineMarker);
            if ("result" in marker) return marker.result;
        }
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
        return { content: created.result, scopeNormalizations: created.scopeNormalizations };
    }

    // A transfer into a region of an existing channel: bytes splice the destination's byte window
    // ({§binary-parity}); text edits the resolved region through the ordinary edit batch.
    async #writeIntoRegion(args: {
        statement: CopyStatement | MoveStatement;
        source: SelectedSource;
        destination: AddressedResourceSelection;
        destinationChannel: EntryChannel;
        handler: SchemeHandler;
        storageAddress: BoundEntryAddress;
        existing: EntryData | null;
        destinationEffect: PendingResourceEffect;
        ctx: PlurnkSchemeContext;
    }): Promise<DispatchResult> {
        const { statement, source, destination, destinationChannel, handler, storageAddress, existing, destinationEffect, ctx } = args;
        if (source.bytes !== undefined) {
            // {§binary-parity} — a byte source into a destination region is a splice: the destination's
            // named byte window becomes exactly the source bytes, every other byte untouched. The whole
            // result is re-written. Coordinate = byte, as the source range is ({§binary-parity}).
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

    // The whole channel: unchanged content is 304, different content is 409, and an absent channel is written — bytes
    // as bytes ({§binary-parity}), text with its parse-issue transition and, for a scoped source, an edit receipt.
    async #writeWholeChannel(args: {
        source: SelectedSource;
        destination: AddressedResourceSelection;
        destinationChannel: EntryChannel | undefined;
        existing: EntryData | null;
        storageAddress: BoundEntryAddress;
        expectedMimetype: string;
        destinationEffect: PendingResourceEffect;
        creationContent: string;
        creationScopeNormalizations: ScopeNormalizations;
        ctx: PlurnkSchemeContext;
    }): Promise<DispatchResult> {
        const {
            source, destination, destinationChannel, existing, storageAddress, expectedMimetype, destinationEffect,
            creationContent, creationScopeNormalizations, ctx,
        } = args;
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
            ...existing?.channels,
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
                    // {§edit-result-receipt-projection} — the destination's READ identity
                    EntryManifest.channelPath(storageAddress, destination.channel, destination.manifest.defaultChannel, destination.projectRoot),
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
        removals: readonly LineMarker[] = [],
        expectedHash?: string,
    ): Promise<DispatchResult> {
        let byteSource = handler.byteSource?.(storageAddress, EntryAddressBinding.addressContext(ctx))
            ?? (existing === null ? undefined : await EntryCrud.storedByteSource(existing, destination.channel, ctx.mimetypes));
        if (destination.scheme === "file") {
            const baseline = FileSnapshot.decode(ctx.fileRevision ?? null);
            const snapshot = baseline === null ? null : await FileSnapshot.acquire(baseline.canonical, FileMaterialization.maximumBytes());
            if (baseline === null || snapshot === null || snapshot.bytes === null || !FileSnapshot.matches(baseline, snapshot.revision)) {
                return EditCollision.result(MutationEffects.resourceAddress(destination));
            }
            const bytes = snapshot.bytes;
            byteSource = { size: async () => bytes.length, read: async (start, end) => bytes.subarray(start - 1, end) };
        }
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
        const marker = ByteView.marker(destination.lineMarker);
        if ("result" in marker) return marker.result;
        if (marker.marker === null) throw new InvalidOperationResultError("A byte splice requires destination coordinates.");
        const original = size === 0 ? new Uint8Array() : await byteSource.read(1, size);
        if (expectedHash !== undefined && contentHash(original) !== expectedHash) return EditCollision.result(MutationEffects.resourceAddress(destination));
        const result = ByteView.splice(original, [
            { marker: marker.marker, bytes: srcBytes },
            ...removals.map((removal) => ({ marker: removal, bytes: new Uint8Array() })),
        ]);
        if ("result" in result) return result.result;
        if (Buffer.from(original).equals(result.bytes)) return { status: 304 };

        const channels = {
            ...existing?.channels,
            [destination.channel]: { content: "", bytes: result.bytes, mimetype },
        };
        const written = await this.#writeEntry(destination.scheme, storageAddress, { channels }, ctx);
        return MutationEffects.finalizeEffects(Results.assert(written), destination, [destinationEffect]);
    }

    // {§binary-parity}: source removal is a byte splice, not an empty text EDIT.
    async #moveBytes(source: SelectedSource, destination: AddressedResourceSelection | null, ctx: PlurnkSchemeContext): Promise<DispatchResult> {
        const removals = source.matchedScopes ?? (source.lineMarker === null ? [] : [source.lineMarker]);
        if (removals.length === 0) throw new InvalidOperationResultError("A scoped byte MOVE has no removal coordinates.");
        const target = destination ?? { ...source, matcher: null, lineMarker: removals[0] };
        const handler = this.#schemes.get(source.scheme, ctx.workspaceId);
        if (handler === undefined) throw new InvalidOperationResultError(`Resolved MOVE source scheme '${source.scheme}' is not registered.`);
        const binding = await this.#resolveDataEntryAddress({ target: source.target, routedScheme: source.scheme, handler,
            manifest: source.manifest, ctx, access: "write" });
        if (binding.result !== null) return binding.result;
        if (binding.address === null) return MutationEffects.failure("entry-not-found", 404, "The MOVE source could not be resolved for deletion.");
        const read = await this.#readEntry(source.scheme, binding.address, ctx);
        if (read.status >= 400) return read;
        return this.#spliceBytes(handler, binding.address, target, read.entry, destination === null ? new Uint8Array() : source.bytes!,
            source.mimetype, MutationEffects.pendingEffect(target, "update"), ctx, destination === null ? removals.slice(1) : removals, source.bytePrecondition);
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
        const handler = this.#schemes.get(selection.scheme, ctx.workspaceId);
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
            aside: null,
            signal: null,
            target: selection.target,
            metadata: selection.metadata,
            lineMarker: marker,
            matcher: null,
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
                manifest: selection.manifest,
                ctx,
                access: "write",
            });
            if (binding.result !== null) return binding.result;
            if (binding.address === null) {
                return MutationEffects.failure(
                    "entry-not-found",
                    404,
                    missDetail(selection.scheme, MutationEffects.resourceAddress(selection)),
                    {},
                    missExtensions(selection.scheme, MutationEffects.resourceAddress(selection)),
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


    // {§move} A MOVE settles in two halves under one row. When the destination was written before
    // the proposal, the proposal was the source's own KILL; when the source was deferred, the proposal was the
    // destination's write and an accepted one retires the source now. Either way a settlement carries the
    // destination's effects, and a refusal after the destination was written says so.
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
        // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- {§move}: a MOVE's proposal attrs are the orchestration attrs this module wrote when it decomposed the MOVE
        const attrs = result.attrs as OrchestrationProposalAttrs | undefined;
        if (attrs?.moveDestinationWritten !== undefined) {
            const destinationEffects = attrs.moveDestinationEffects === undefined
                ? []
                : assertResourceEffects(attrs.moveDestinationEffects);
            return ResourceTransfers.#settleSourceAfterDestination(settlement, attrs.moveDestinationWritten, destinationEffects);
        }
        const deferred = attrs?.moveSource;
        if (
            deferred === undefined
            || settlement.resolution.decision !== "accept"
            || (settlement.applied?.status ?? 200) >= 400
        ) {
            return settlement;
        }
        return this.#retireDeferredMoveSource(statement, settlement, deferred, ctx, ids);
    }

    // The source half of a MOVE whose destination was already written: the settlement carries the destination's
    // effects, or names the destination as written beside a removal that was rejected, cancelled or never applied.
    static #settleSourceAfterDestination(
        settlement: ProposalSettlement,
        destinationWritten: string,
        destinationEffects: readonly ResourceEffect[],
    ): ProposalSettlement {
        const failed = (applied: DispatchResult): ProposalSettlement => ({
            resolution: settlement.resolution,
            applied: MutationEffects.moveFailureAfterDestination(applied, destinationWritten, destinationEffects),
        });
        if (settlement.resolution.decision !== "accept") {
            const decision = settlement.resolution.decision;
            return failed(MutationEffects.failure(
                "move-source-not-applied",
                decision === "cancel" ? 499 : 409,
                `The MOVE destination was written, but source removal was ${decision === "cancel" ? "cancelled" : "rejected"}.`,
                {},
                {
                    retryable: false,
                },
            ));
        }
        if (settlement.applied === undefined) return failed(ResourceTransfers.#applyMissing("source"));
        if (settlement.applied.status >= 400) return failed(settlement.applied);
        return MutationEffects.withSettlementEffects(
            settlement,
            [
                ...destinationEffects,
                ...MutationEffects.settlementEffects(settlement),
            ],
        );
    }

    // The deferred source half of a MOVE whose destination the accepted proposal has just written: the source is
    // resolved again against its recorded identity and removed — through its own accepted proposal when the
    // removal proposes — and a refusal anywhere names the destination as written.
    async #retireDeferredMoveSource(
        statement: MoveStatement,
        settlement: ProposalSettlement,
        deferred: DeferredMoveSource,
        ctx: PlurnkSchemeContext,
        ids: ProposalIds,
    ): Promise<ProposalSettlement> {
        if (settlement.applied === undefined) {
            return { resolution: settlement.resolution, applied: ResourceTransfers.#applyMissing("destination") };
        }
        const destinationEffects = MutationEffects.settlementEffects(settlement);
        const failed = (applied: DispatchResult): ProposalSettlement => ({
            resolution: settlement.resolution,
            applied: MutationEffects.moveFailureAfterDestination(applied, deferred.destination, destinationEffects),
        });

        const resolvedSource = await this.#selection.resolveResourceSelection(
            {
                target: deferred.target,
                metadata: deferred.metadata,
                lineMarker: deferred.lineMarker,
                matcher: null,
            },
            ctx,
            "read",
        );
        if (MutationEffects.isDispatchResult(resolvedSource)) return failed(resolvedSource);
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

        const { lineMarker } = resolvedSource;
        if (!LineAnchors.isResolvedMarker(lineMarker)) {
            throw new InvalidOperationResultError("A deferred MOVE source's resolved line scope names an anchor.");
        }
        const removed = await this.removeMoveSource(
            statement,
            {
                ...resolvedSource,
                lineMarker,
                ...(deferred.matchedScopes === undefined ? {} : { matchedScopes: deferred.matchedScopes }),
                ...(deferred.bytePrecondition === undefined ? {} : { bytePrecondition: deferred.bytePrecondition }),
                ...(deferred.fileRevision === undefined ? {} : { fileRevision: deferred.fileRevision }),
            },
            ctx,
            deferred.lineAnchorPrecondition,
        );
        if (removed.status >= 400) return failed(removed);
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
            MutationEffects.moveSourceProposal(removed, deferred.destination, destinationEffects),
            { decision: "accept" },
            ids,
        );
        const sourceSettlement = MutationEffects.settleProposalEffects(
            removed,
            initialSourceSettlement,
        );
        if (sourceSettlement.applied === undefined) return failed(ResourceTransfers.#applyMissing("source"));
        if (sourceSettlement.applied.status >= 400) return failed(sourceSettlement.applied);
        return MutationEffects.withSettlementEffects(
            settlement,
            [
                ...destinationEffects,
                ...MutationEffects.settlementEffects(sourceSettlement),
            ],
        );
    }

    // An accepted MOVE proposal whose scheme applied nothing is the settlement's 500.
    static #applyMissing(scheme: "source" | "destination"): DispatchResult {
        return MutationEffects.failure(
            "proposal-apply-missing",
            500,
            `The ${scheme} scheme accepted its MOVE proposal without applying the ${scheme} mutation.`,
            {},
            {
                stage: "proposal-application",
                retryable: false,
            },
        );
    }

}
