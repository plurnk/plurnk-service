import { type LineMarker, type MatcherBody } from "@plurnk/plurnk-contracts";
import { InvalidOperationResultError, type ScopeNormalization, type SchemeHandler, type StoredEntryData } from "@plurnk/plurnk-schemes";
import type SchemeRegistry from "./SchemeRegistry.ts";
import ResourceBindings from "./ResourceBindings.ts";
import { entryCoordinateOf, schemeNameOf } from "./plurnk-uri.ts";
import EntryAddressBinding, { type BoundEntryAddress } from "./EntryAddressBinding.ts";
import type { PlurnkSchemeContext } from "./scheme-types.ts";
import { LineAnchors, LineMarkerOps, MimetypeBinary, type LineAnchorPrecondition } from "../content/index.ts";
import EntryCrud from "../schemes/_entry-crud.ts";
import Results from "./results.ts";
import type { DispatchResult, MetadataResourceSelection, AddressedResourceSelection, ResolvedResourceSelection, SelectedSource, PrepareDataRepresentation } from "./mutation-types.ts";
import MutationEffects from "./MutationEffects.ts";
import { coreRepresentationProvider } from "./CoreSchemeServices.ts";
import LineSelection from "../content/line-selection.ts";
import PatternEdits from "../content/pattern-edits.ts";
import PatternSelection from "./PatternSelection.ts";

// Resource selection for COPY and MOVE: which entry, channel, and line range a statement names.
export default class ResourceSelector {
    readonly #schemes: SchemeRegistry;
    readonly #canonicalFilePath: (pathname: string, workspaceId: number) => Promise<string | null>;
    readonly #prepareDataRepresentation: PrepareDataRepresentation;

    constructor({ schemes, canonicalFilePath, prepareDataRepresentation }: {
        schemes: SchemeRegistry;
        canonicalFilePath: (pathname: string, workspaceId: number) => Promise<string | null>;
        prepareDataRepresentation: PrepareDataRepresentation;
    }) {
        this.#schemes = schemes;
        this.#canonicalFilePath = canonicalFilePath;
        this.#prepareDataRepresentation = prepareDataRepresentation;
    }

    async resolveResourceSelection(
        selection: MetadataResourceSelection,
        ctx: PlurnkSchemeContext,
        access: "read" | "write" = "write",
    ): Promise<AddressedResourceSelection | DispatchResult> {
        const { target, metadata, lineMarker, matcher } = selection;
        const scheme = schemeNameOf(target);
        if (scheme === null) {
            return MutationEffects.failure(
                "resource-scheme-required",
                400,
                "COPY and MOVE resources require a scheme.",
                {},
                { retryable: false },
            );
        }
        // {§copy-move-pattern} — a pattern selects the lines a source gives; a destination is a
        // place, named by its scope.
        if (access === "write" && matcher !== null) {
            return MutationEffects.failure(
                "pattern-destination-unsupported",
                400,
                "A pattern selects source lines; a COPY or MOVE destination is a place. Name where the lines land with a scope.",
                {},
                { scheme, retryable: false },
            );
        }
        const binding = access === "read" ? await ResourceBindings.resolve(target, ctx) : undefined;
        const handler = access === "read" ? binding?.handler : this.#schemes.get(scheme, ctx.workspaceId);
        const manifest = access === "read" ? binding?.manifest : this.#schemes.manifestFor(scheme, ctx.workspaceId);
        if (handler === undefined || manifest === undefined) {
            return MutationEffects.failure(
                "scheme-not-found",
                501,
                `COPY or MOVE addressed the unregistered scheme '${scheme}'.`,
                {},
                {
                    scheme,
                    retryable: false,
                },
            );
        }
        const readableProjection = access === "read" && coreRepresentationProvider(handler) !== null;
        if (manifest.category !== "data" && !readableProjection) {
            return MutationEffects.failure(
                "entry-operation-unsupported",
                400,
                `This ${access} target requires entry storage; '${scheme}' is a ${manifest.category} scheme.`,
                {},
                {
                    scheme,
                    category: manifest.category,
                    retryable: false,
                },
            );
        }
        const fragment = target.kind === "url" ? target.fragment : null;
        const channel = fragment ?? manifest.defaultChannel;
        if (channel.length === 0 && !readableProjection) {
            return MutationEffects.failure(
                "channel-required",
                400,
                `The '${scheme}' scheme has no default channel.`,
                {},
                {
                    scheme,
                    recovery: "Address a named channel with a URI fragment.",
                    retryable: false,
                },
            );
        }
        if (
            fragment !== null
            && fragment !== manifest.defaultChannel
            && !Object.hasOwn(manifest.channels, fragment)
        ) {
            const availableChannels = [
                ...new Set([manifest.defaultChannel, ...Object.keys(manifest.channels)]),
            ].filter((candidate) => candidate.length > 0);
            return MutationEffects.failure(
                "channel-not-found",
                404,
                `Channel #${fragment} is not declared by the '${scheme}' scheme.`,
                {},
                {
                    requestedChannel: fragment,
                    availableChannels,
                    retryable: false,
                },
            );
        }
        const coordinate = entryCoordinateOf(target, manifest.authority ?? "namespace");
        const { authority, pathname } = coordinate;
        const canonicalFilePath = scheme === "file"
            ? await this.#canonicalFilePath(pathname, ctx.workspaceId)
            : pathname;
        return {
            target,
            metadata,
            lineMarker,
            matcher,
            scheme,
            authority,
            pathname,
            identityPathname: canonicalFilePath ?? pathname,
            channel,
            manifest,
        };
    }


    async selectSource(
        selection: AddressedResourceSelection,
        ctx: PlurnkSchemeContext,
        operation: "COPY" | "MOVE",
    ): Promise<SelectedSource | DispatchResult> {
        const handler = (await ResourceBindings.resolve(selection.target, ctx))?.handler as SchemeHandler | undefined;
        if (handler === undefined) {
            throw new InvalidOperationResultError(
                `Resolved COPY/MOVE source scheme '${selection.scheme}' is no longer registered.`,
            );
        }
        const acquired = await this.#sourceRepresentation(selection, handler, ctx);
        if ("result" in acquired) return acquired.result;
        const { representation, storageAddress, visibleLines, identity } = acquired;
        const target = MutationEffects.resourceAddress(selection);
        const selected = representation.channels[selection.channel];
        if (selected === undefined) {
            return MutationEffects.failure(
                "channel-not-found",
                404,
                `No channel named #${selection.channel} exists at ${target}.`,
                {},
                {
                    target,
                    requestedChannel: selection.channel,
                    availableChannels: Object.keys(representation.channels),
                    retryable: false,
                },
            );
        }
        const resolvedMarker = this.resolveResourceLineMarker(selection, selected.content, operation, identity);
        if ("result" in resolvedMarker) return resolvedMarker.result;
        let content = selected.content;
        let startLine = 1;
        let scopeNormalizations: ReadonlyArray<ScopeNormalization> | undefined;
        // {§binary-parity} — bytes and the destination mimetype come from the source,
        // not its readable text projection.
        const sourceProjection = (representation.attributes as { sourceProjection?: { mimetype?: unknown } } | undefined)?.sourceProjection;
        const sourceMimetype = typeof sourceProjection?.mimetype === "string" ? sourceProjection.mimetype : selected.mimetype;
        if (await MimetypeBinary.isBinaryMimetype(sourceMimetype, ctx.mimetypes)) {
            if (selection.matcher !== null) {
                return PatternSelection.refuse("pattern-unsupported", 400, `Channel #${selection.channel} is binary; bytes have no lines for a pattern to select.`, selection.scheme, operation);
            }
            const byteSource = (storageAddress === undefined ? undefined : handler.byteSource?.(storageAddress, EntryAddressBinding.addressContext(ctx)))
                ?? await EntryCrud.storedByteSource(representation, selection.channel, ctx.mimetypes);
            if (byteSource === undefined) {
                return MutationEffects.failure(
                    "binary-source-unsupported", 415,
                    `Channel #${selection.channel} is binary and its scheme keeps no bytes to transfer.`,
                    {}, { channel: selection.channel, mimetype: selected.mimetype, retryable: false },
                );
            }
            const size = await byteSource.size();
            if (size === null || size === 0) {
                return MutationEffects.failure(
                    "entry-not-found", 404, `No bytes exist at ${target}.`,
                    {}, { target, retryable: false },
                );
            }
            const marks = resolvedMarker.selection.lineMarker?.marks ?? [];
            const start = marks.length >= 1 ? marks[0]! : 1;
            const end = marks.length >= 2 ? (marks[1] === -1 ? size : marks[1]!) : (marks.length === 1 ? marks[0]! : size);
            if (!(start >= 1 && end >= start && end <= size)) {
                return MutationEffects.failure(
                    "range-not-satisfiable", 416, `Byte range <${start},${end}> is outside the available 1..${size}.`,
                    {}, { channel: selection.channel, unit: "byte", available: size, retryable: false },
                );
            }
            const bytes = await byteSource.read(start, end);
            return {
                ...resolvedMarker.selection,
                content: "",
                completeContent: "",
                bytes,
                mimetype: sourceMimetype,
                lineAnchorPrecondition: resolvedMarker.precondition,
            };
        }
        if (resolvedMarker.selection.lineMarker !== null) {
            const sliced = LineMarkerOps.sliceLinesRaw(content, resolvedMarker.selection.lineMarker);
            if (sliced.status !== 200) return Results.assert(sliced) as DispatchResult;
            content = sliced.text ?? "";
            startLine = sliced.startLine ?? 1;
            scopeNormalizations = sliced.scopeNormalizations;
        }
        if (selected.producerResult !== undefined && selected.producerResult.status >= 400) {
            return Results.assert(selected.producerResult) as DispatchResult;
        }
        const retained = visibleLines?.[selection.channel];
        if (selection.matcher !== null) {
            const matched = await this.#matchedLines(selection.matcher, resolvedMarker, selected, retained, operation, ctx, identity);
            if ("result" in matched) return matched.result;
            return {
                ...resolvedMarker.selection,
                content: LineSelection.retain(selected.content, matched.lines).content,
                completeContent: selected.content,
                matchedLines: matched.lines,
                mimetype: selected.mimetype,
                lineAnchorPrecondition: MutationEffects.mergeLineAnchorPreconditions(resolvedMarker.precondition, matched.precondition),
                ...(scopeNormalizations === undefined ? {} : { scopeNormalizations }),
            };
        }
        return {
            ...resolvedMarker.selection,
            content: retained === undefined ? content : LineSelection.retain(content, retained, startLine).content,
            completeContent: selected.content,
            mimetype: selected.mimetype,
            lineAnchorPrecondition: resolvedMarker.precondition,
            ...(scopeNormalizations === undefined ? {} : { scopeNormalizations }),
        };
    }

    // {§copy-move-pattern} — the whole lines a source pattern selects, bounded by the scope and by
    // what the source shows; their anchors guard a MOVE's removal exactly as an anchored scope would.
    async #matchedLines(
        matcher: MatcherBody,
        resolvedMarker: { readonly selection: ResolvedResourceSelection; readonly precondition: LineAnchorPrecondition | null },
        selected: { readonly content: string; readonly mimetype: string },
        retained: readonly number[] | undefined,
        operation: "COPY" | "MOVE",
        ctx: PlurnkSchemeContext,
        identity: string | undefined,
    ): Promise<{ lines: number[]; precondition: LineAnchorPrecondition | null } | { result: DispatchResult }> {
        const { selection } = resolvedMarker;
        const dialect = PatternSelection.refuseDialect(matcher, selection.scheme, operation);
        if (dialect !== null) return { result: dialect };
        const matched = await PatternSelection.match({
            matcher, content: selected.content, mimetype: selected.mimetype,
            marks: selection.lineMarker?.marks, ctx, scheme: selection.scheme, operation,
        });
        if ("result" in matched) return matched;
        const shown = retained === undefined ? null : new Set(retained);
        const lines = PatternEdits.lines(matched.evidence, matched.bounds).filter((line) => shown === null || shown.has(line));
        if (lines.length === 0) {
            return { result: Results.assert({ status: 204, matched: 0, detail: `No line matched the pattern; nothing to ${operation === "COPY" ? "copy" : "move"}.` }) };
        }
        if (selection.manifest.textEditScopes !== true) return { lines, precondition: null };
        const target = identity ?? MutationEffects.resourceAddress(selection);
        const tokens = LineAnchors.tokens(target, selected.content);
        return {
            lines,
            precondition: { identity: target, checks: lines.flatMap((line) => tokens[line - 1] === undefined ? [] : [{ anchor: tokens[line - 1]!, line }]) },
        };
    }

    async #sourceRepresentation(
        selection: AddressedResourceSelection,
        handler: SchemeHandler,
        ctx: PlurnkSchemeContext,
    ): Promise<{
        representation: StoredEntryData;
        storageAddress?: BoundEntryAddress;
        identity?: string;
        visibleLines?: Readonly<Record<string, readonly number[]>>;
    } | { result: DispatchResult }> {
        const provider = coreRepresentationProvider(handler);
        if (provider !== null) return provider.resolveCoreRepresentation(selection.target, ctx);
        const prepared = await this.#prepareDataRepresentation({
            target: selection.target,
            metadata: selection.metadata,
            routedScheme: selection.scheme,
            handler,
            manifest: selection.manifest,
            ctx,
            publishedChannel: selection.channel,
        });
        if (prepared.result !== null) return { result: prepared.result };
        if (prepared.address === null) {
            return { result: MutationEffects.failure(
                "entry-not-found",
                404,
                `No entry exists at ${MutationEffects.resourceAddress(selection)}.`,
                {},
                { target: MutationEffects.resourceAddress(selection) },
            ) };
        }
        const storageAddress = prepared.address;
        const read = await EntryCrud.readEntry(
            storageAddress,
            ctx,
            storageAddress.scheme,
        );
        if (read.status >= 400) return { result: read };
        if (read.status !== 200 || read.entry === null) {
            throw new InvalidOperationResultError(
                `The '${selection.scheme}' scheme returned status ${read.status} without a COPY/MOVE source entry.`,
            );
        }
        return { representation: read.entry, storageAddress };
    }


    resolveResourceLineMarker(
        selection: AddressedResourceSelection,
        content: string,
        operation: "COPY" | "MOVE",
        identity?: string,
    ): { readonly selection: ResolvedResourceSelection; readonly precondition: LineAnchorPrecondition | null }
        | { readonly result: DispatchResult } {
        if (!LineAnchors.hasAnchor(selection.lineMarker)) {
            return {
                selection: {
                    ...selection,
                    lineMarker: selection.lineMarker as LineMarker | null,
                },
                precondition: null,
            };
        }
        const target = identity ?? MutationEffects.resourceAddress(selection);
        if (selection.manifest.textEditScopes !== true || !selection.manifest.writableBy.includes("model")) {
            return {
                result: MutationEffects.failure(
                    "line-anchor-unsupported",
                    400,
                    `The representation at ${target} does not publish line anchors.`,
                    {},
                    {
                        operation,
                        target,
                        recovery: "Use numeric text coordinates.",
                        retryable: false,
                    },
                ),
            };
        }
        const resolution = LineAnchors.resolve(LineAnchors.tokens(target, content), selection.lineMarker);
        if (!resolution.ok) {
            if (resolution.failure.kind === "invalid") {
                return {
                    result: MutationEffects.failure(
                        "line-anchor-invalid",
                        400,
                        LineAnchors.invalidCoordinateDetail,
                        {},
                        {
                            operation,
                            target,
                            recovery: LineAnchors.invalidCoordinateRecovery,
                            retryable: false,
                        },
                    ),
                };
            }
            return {
                result: MutationEffects.failure(
                    "line-anchor-collision",
                    409,
                    `${operation} coordinates collided with current content at ${target}.`,
                    {},
                    {
                        operation,
                        target,
                        recovery: `READ ${target} again and retry against its current coordinates.`,
                        retryable: false,
                    },
                ),
            };
        }
        return {
            selection: { ...selection, lineMarker: resolution.marker },
            precondition: {
                identity: target,
                checks: LineAnchors.checks(selection.lineMarker, resolution.marker),
            },
        };
    }

}
