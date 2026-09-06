import { type LineMarker } from "@plurnk/plurnk-contracts";
import { InvalidOperationResultError, type ScopeNormalization, type SchemeHandler } from "@plurnk/plurnk-schemes";
import type SchemeRegistry from "./SchemeRegistry.ts";
import { entryCoordinateOf, renderAddress, schemeNameOf } from "./plurnk-uri.ts";
import EntryAddressBinding from "./EntryAddressBinding.ts";
import type { PlurnkSchemeContext } from "./scheme-types.ts";
import { LineAnchors, LineMarkerOps, MimetypeBinary, type LineAnchorPrecondition } from "../content/index.ts";
import EntryCrud from "../schemes/_entry-crud.ts";
import Results from "./results.ts";
import type { DispatchResult, MetadataResourceSelection, AddressedResourceSelection, ResolvedResourceSelection, SelectedSource, PrepareDataRepresentation } from "./mutation-types.ts";
import MutationEffects from "./MutationEffects.ts";

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
    ): Promise<AddressedResourceSelection | DispatchResult> {
        const { target, metadata, lineMarker } = selection;
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
        // `~` is the caller's own space ({§worker-authority-carving}), not a name:
        // COPY and MOVE reach the commons and the private space, never another worker's.
        const workerAuthority = target.kind === "url" && target.scheme === "worker" ? target.hostname ?? "" : "";
        if (workerAuthority !== "" && workerAuthority !== "~") {
            return MutationEffects.failure(
                "worker-copy-address-invalid",
                400,
                "COPY and MOVE do not address named worker spaces.",
                {},
                {
                    recovery: "Move worker-space content with READ and EDIT.",
                    retryable: false,
                },
            );
        }
        const handler = this.#schemes.get(scheme, ctx.functionalityWorkerId);
        const manifest = this.#schemes.manifestFor(scheme, ctx.functionalityWorkerId);
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
        if (manifest.category !== "data") {
            return MutationEffects.failure(
                "entry-operation-unsupported",
                400,
                `COPY and MOVE require entry-bearing resources; '${scheme}' is a ${manifest.category} scheme.`,
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
        if (channel.length === 0) {
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
        const handler = this.#schemes.get(selection.scheme, ctx.functionalityWorkerId) as SchemeHandler | undefined;
        if (handler === undefined) {
            throw new InvalidOperationResultError(
                `Resolved COPY/MOVE source scheme '${selection.scheme}' is no longer registered.`,
            );
        }
        const prepared = await this.#prepareDataRepresentation({
            target: selection.target,
            metadata: selection.metadata,
            routedScheme: selection.scheme,
            handler,
            manifest: selection.manifest,
            ctx,
            publishedChannel: selection.channel,
        });
        if (prepared.result !== null) return prepared.result;
        if (prepared.address === null) {
            return MutationEffects.failure(
                "entry-not-found",
                404,
                `No entry exists at ${MutationEffects.resourceAddress(selection)}.`,
                {},
                { target: MutationEffects.resourceAddress(selection) },
            );
        }
        const storageAddress = prepared.address;
        const read = await EntryCrud.readEntry(
            storageAddress,
            ctx,
            storageAddress.scheme,
            storageAddress.ownerId,
        );
        if (read.status >= 400) return read;
        if (read.status !== 200 || read.entry === null) {
            throw new InvalidOperationResultError(
                `The '${selection.scheme}' scheme returned status ${read.status} without a COPY/MOVE source entry.`,
            );
        }
        const selected = read.entry.channels[selection.channel];
        if (selected === undefined) {
            return MutationEffects.failure(
                "channel-not-found",
                404,
                `No channel named #${selection.channel} exists at ${renderAddress(storageAddress)}.`,
                {},
                {
                    target: renderAddress(storageAddress),
                    requestedChannel: selection.channel,
                    availableChannels: Object.keys(read.entry.channels),
                    retryable: false,
                },
            );
        }
        const resolvedMarker = this.resolveResourceLineMarker(selection, selected.content, operation);
        if ("result" in resolvedMarker) return resolvedMarker.result;
        let content = selected.content;
        let scopeNormalizations: ReadonlyArray<ScopeNormalization> | undefined;
        // {§binary-parity} — a materialized binary member's channel mimetype is its text projection
        // (the facts line, text/markdown); its real mimetype is the source projection. Binariness and
        // the transfer's destination mimetype both come from the source, not the projection.
        const sourceProjection = (read.entry.attributes as { sourceProjection?: { mimetype?: unknown } } | undefined)?.sourceProjection;
        const sourceMimetype = typeof sourceProjection?.mimetype === "string" ? sourceProjection.mimetype : selected.mimetype;
        if (await MimetypeBinary.isBinaryMimetype(sourceMimetype, ctx.mimetypes)) {
            // A binary source transfers its bytes, not its text projection: the whole resource, or the
            // byte range the marker names (coordinate = byte, as {§read-bytes}). Only a source whose
            // scheme keeps no bytes cannot.
            // A File hands its bytes from disk; a DB entry keeps them base64 in the channel content
            // ({§binary-parity}), recovered here. A scheme with neither keeps no bytes to transfer.
            const byteSource = (handler as SchemeHandler).byteSource?.(storageAddress, EntryAddressBinding.addressContext(ctx))
                ?? (selected.content !== "" ? EntryCrud.contentByteSource(selected.content) : undefined);
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
                    "entry-not-found", 404, `No bytes exist at ${renderAddress(storageAddress)}.`,
                    {}, { target: renderAddress(storageAddress), retryable: false },
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
                storageAddress,
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
            scopeNormalizations = sliced.scopeNormalizations;
        }
        if (selected.producerResult !== undefined && selected.producerResult.status >= 400) {
            return Results.assert(selected.producerResult) as DispatchResult;
        }
        return {
            ...resolvedMarker.selection,
            storageAddress,
            content,
            completeContent: selected.content,
            mimetype: selected.mimetype,
            lineAnchorPrecondition: resolvedMarker.precondition,
            ...(scopeNormalizations === undefined ? {} : { scopeNormalizations }),
        };
    }


    resolveResourceLineMarker(
        selection: AddressedResourceSelection,
        content: string,
        operation: "COPY" | "MOVE",
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
        const target = MutationEffects.resourceAddress(selection);
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
