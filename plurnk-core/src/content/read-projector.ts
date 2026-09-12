import { DEFAULT_RETRIEVAL_LIMIT, type LineMarker, type ReadStatement } from "@plurnk/plurnk-contracts";
import type { Mimetypes } from "@plurnk/plurnk-mimetypes";
import type {
    EntryReadResult,
    StoredEntryData,
} from "@plurnk/plurnk-schemes";
import type { SchemeManifest } from "../core/scheme-types.ts";
import Results from "../core/results.ts";
import LineAnchors from "./line-anchors.ts";
import LineMarkerOps from "./line-marker.ts";
import ByteView, { type ByteSource } from "./byte-view.ts";
import MimetypeBinary from "./mimetype-binary.ts";
import ReadResolve from "./read-resolve.ts";
import Matcher from "./matcher.ts";
import PatternEdits from "./pattern-edits.ts";

// {§packet-attachment-parts} — a projected image member names its picture: source mimetype and
// the handler's dimensions, read from the member's projection facts, never from the bytes.
const imageOf = (attributes: StoredEntryData["attributes"]): { mimetype: string; width: number; height: number; bytes: number } | null => {
    const projection = attributes?.sourceProjection as { mimetype?: unknown; facts?: { width?: unknown; height?: unknown; bytes?: unknown } } | undefined;
    if (projection === undefined || typeof projection.mimetype !== "string" || !projection.mimetype.startsWith("image/")) return null;
    const facts = projection.facts;
    if (facts === undefined || !Number.isSafeInteger(facts.width) || !Number.isSafeInteger(facts.height) || !Number.isSafeInteger(facts.bytes)) return null;
    return { mimetype: projection.mimetype, width: facts.width as number, height: facts.height as number, bytes: facts.bytes as number };
};

// {§packet-attachment-parts} — a projected PDF member names its document: source mimetype, the
// handler's page count when the page tree is readable ({§mimetype-pdf-facts}), and its size.
// {§log-channel-miss-names-stream} — the stream address a log EXEC item recorded, when the scheme supplied it.
const streamOf = (attributes: StoredEntryData["attributes"]): string | null => {
    const stream = attributes?.stream;
    return typeof stream === "string" ? stream : null;
};

const documentOf = (attributes: StoredEntryData["attributes"]): { mimetype: string; pages: number | null; bytes: number } | null => {
    const projection = attributes?.sourceProjection as { mimetype?: unknown; facts?: { pages?: unknown; bytes?: unknown } } | undefined;
    if (projection === undefined || projection.mimetype !== "application/pdf") return null;
    const facts = projection.facts;
    if (facts === undefined || !Number.isSafeInteger(facts.bytes)) return null;
    const pages = Number.isSafeInteger(facts.pages) ? facts.pages as number : null;
    return { mimetype: projection.mimetype, pages, bytes: facts.bytes as number };
};

export interface AnchoredReadResult extends EntryReadResult {
    // {§read-selection-projection} — a positional slice reads as the text primitive; the channel's
    // own mimetype rides beside it so a consumer can still run the channel's handlers.
    readonly sourceMimetype?: string;
    readonly lineOrdinals?: readonly number[];
    readonly lineAnchorIdentity?: string;
    readonly lineAnchors?: readonly string[];
    readonly lineNumberWidth?: number;
    readonly nativeContentHash?: string;
}

interface ReadProjectionOptions {
    readonly statement: ReadStatement;
    readonly manifest: SchemeManifest;
    readonly publishesLineAnchors: boolean;
    readonly target: string;
    readonly identity: string;
    readonly representation: StoredEntryData;
    readonly mimetypes: Mimetypes | undefined;
    readonly bytes?: ByteSource;
    readonly visibleLines?: Readonly<Record<string, readonly number[]>>;
    readonly retainNative?: (bytes: Uint8Array) => Promise<string>;
    // {§channel-selection-visibility} — the curation ruler the catalog weighed channels with, so a
    // READ receipt names the resource's other channels with the same `tokens` FIND shows.
    readonly weigh?: (text: string) => number;
}

// {§universal-read-composition} Core's one exact-resource projection over a complete canonical
// representation. Storage adapters supply channels; this layer owns channel
// selection, binary admission, text coordinates, line-anchor projection, and
// composition of the selected producer's durable result.
export default class ReadProjector {
    static async *#chunks(source: ByteSource): AsyncIterable<Uint8Array> {
        const size = await source.size();
        if (size === null) return;
        const chunkSize = 64 * 1024;
        for (let start = 1; start <= size; start += chunkSize) {
            yield await source.read(start, Math.min(size, start + chunkSize - 1));
        }
    }

    // {§read-bytes} — one hexadecimal octet per line under the text coordinate algebra: the
    // markerless default is the same `<1,16>`, `<a,b>` selects bytes, `<1,-1>` is everything.
    // The source is sized, then only the window is read; the source mimetype is never relabelled.
    static async #projectBytes(
        statement: ReadStatement,
        target: string,
        source: ByteSource,
        sourceMimetype: string,
        channel: string | null,
        failure: (code: string, status: number, detail: string, fields?: Readonly<Record<string, unknown>>, extensions?: Readonly<Record<string, unknown>>) => EntryReadResult,
    ): Promise<AnchoredReadResult> {
        if (LineAnchors.hasAnchor(statement.lineMarker)) {
            return failure(
                "line-anchor-unsupported",
                400,
                `The byte view of ${target} publishes no anchors.`,
                {},
                { target, recovery: "Use byte coordinates: `<first,last>`.", retryable: false },
            );
        }
        const total = await source.size();
        if (total === null) return failure("entry-not-found", 404, `No bytes exist at ${target}.`);
        const marker: LineMarker = statement.lineMarker ?? { marks: [1, DEFAULT_RETRIEVAL_LIMIT] };
        const window = LineMarkerOps.window(marker, total, "byte");
        if (window.status !== 200) {
            return {
                ...window,
                content: null,
                mimetype: sourceMimetype,
                channel,
            } as AnchoredReadResult;
        }
        if (window.start === null || window.start === undefined || window.end === null || window.end === undefined) {
            return { status: 204, content: "", mimetype: sourceMimetype, channel, range: window.range } as AnchoredReadResult;
        }
        const content = ByteView.hexLines(await source.read(window.start, window.end));
        return {
            status: content === "" ? 204 : 200,
            content,
            mimetype: sourceMimetype,
            channel,
            startLine: window.start,
            range: window.range,
            projection: ByteView.PROJECTION,
        } as AnchoredReadResult;
    }

    static async project(opts: ReadProjectionOptions): Promise<AnchoredReadResult> {
        const attributes = opts.representation.attributes;
        const sourceProjection = attributes?.sourceProjection as { mimetype?: string } | undefined;
        const mimetype = sourceProjection?.mimetype ?? opts.representation.channels[opts.manifest.defaultChannel]?.mimetype;
        const native = mimetype?.startsWith("image/") || mimetype === "application/pdf";
        let content: Uint8Array | null = null;
        let bytes = opts.bytes;
        if (native && bytes !== undefined) {
            const size = await bytes.size();
            if (size !== null) {
                content = Buffer.from(await bytes.read(1, size));
                const snapshot = content;
                bytes = { size: async () => snapshot.byteLength, read: async (start, end) => snapshot.subarray(start - 1, end) };
            }
        }
        const result = await ReadProjector.#project({ ...opts, ...(bytes === undefined ? {} : { bytes }) });
        if (result.status >= 300 || !("image" in result || "document" in result)) return result;
        const hash = content !== null && opts.retainNative !== undefined
            ? await opts.retainNative(content)
            : attributes?.nativeContentHash;
        return typeof hash === "string" ? { ...result, nativeContentHash: hash } : result;
    }

    static async #project(opts: ReadProjectionOptions): Promise<AnchoredReadResult> {
        const { statement, manifest, target, identity, representation, mimetypes, bytes } = opts;
        const fragment = statement.target?.kind === "url"
            ? statement.target.fragment
            : null;
        const selected = fragment ?? manifest.defaultChannel;
        const channel = selected === "" ? null : selected;
        const availableChannels = [...new Set([manifest.defaultChannel, ...Object.keys(manifest.channels)])].filter((candidate) =>
            candidate.length > 0 && Object.hasOwn(representation.channels, candidate));
        const defaultRepresentation = representation.channels[manifest.defaultChannel];
        const binary = mimetypes !== undefined && defaultRepresentation !== undefined
            && await MimetypeBinary.isBinaryMimetype(defaultRepresentation.mimetype, mimetypes);
        const projection = binary && bytes !== undefined && (selected === manifest.defaultChannel || selected === ByteView.CHANNEL)
            ? await mimetypes!.projectReadableStream(ReadProjector.#chunks(bytes), defaultRepresentation.mimetype)
            : null;
        const attributes = projection === null ? representation.attributes
            : { sourceProjection: { mimetype: projection.sourceMimetype, facts: projection.facts } };
        const image = imageOf(attributes);
        const document = documentOf(attributes);
        const withAttachmentFacts = (result: AnchoredReadResult): AnchoredReadResult => ({
            ...result,
            ...(image === null ? {} : { image }),
            ...(document === null ? {} : { document }),
        });
        const failure = (
            code: string,
            status: number,
            detail: string,
            fields: Readonly<Record<string, unknown>> = {},
            extensions: Readonly<Record<string, unknown>> = {},
        ): EntryReadResult => Results.failure(
            `scheme:${manifest.name}`,
            code,
            status,
            detail,
            { content: null, mimetype: null, channel, ...fields },
            extensions,
        ) as EntryReadResult;

        // {§read-bytes} — `#bytes` is the raw view of any resource whose scheme supplies bytes.
        if (selected === ByteView.CHANNEL && !Object.hasOwn(manifest.channels, selected)) {
            if (bytes === undefined) {
                return failure(
                    "bytes-unavailable",
                    501,
                    `The representation at ${target} supplies no bytes.`,
                    {},
                    { target, retryable: false },
                );
            }
            const sourceMimetype = representation.channels[manifest.defaultChannel]?.mimetype ?? "application/octet-stream";
            return withAttachmentFacts(await ReadProjector.#projectBytes(
                statement,
                target,
                bytes,
                sourceMimetype,
                ByteView.CHANNEL,
                failure,
            ));
        }
        const selectedRepresentation = Object.hasOwn(representation.channels, selected) ? representation.channels[selected] : undefined;
        if ((selected !== manifest.defaultChannel && !Object.hasOwn(manifest.channels, selected)) || selectedRepresentation === undefined) {
            // {§log-channel-miss-names-stream} (#502) — a representation that names the stream its
            // item produced (a log EXEC item) points the miss at `<stream>#<channel>`, the way a
            // range miss names the available range; the model conflates the two addresses because
            // they share their coordinate.
            const stream = streamOf(representation.attributes);
            const pointer = stream !== null && selected !== "" ? `${stream}#${selected}` : null;
            return failure(
                "channel-not-found",
                404,
                `${selected === "" ? "The default channel" : `Channel #${selected}`} does not exist at ${target}${
                    pointer === null ? "." : `; the command's streams live at ${pointer}.`}`,
                { channel: null },
                {
                    requestedChannel: selected,
                    availableChannels,
                    ...(pointer !== null
                        ? { stream, recovery: `READ ${pointer} for the command's ${selected} stream.` }
                        : availableChannels.length === 0
                            ? {}
                            : {
                                recovery: `Use one of the available channels: ${availableChannels
                                    .map((candidate) => `#${candidate}`)
                                    .join(", ")}.`,
                            }),
                    retryable: false,
                },
            );
        }

        if (await MimetypeBinary.isBinaryMimetype(selectedRepresentation.mimetype, mimetypes)) {
            // {§read-bytes} — a binary channel with no readable projection reads as its bytes.
            if (bytes !== undefined) {
                return withAttachmentFacts(await ReadProjector.#projectBytes(
                    statement,
                    target,
                    bytes,
                    selectedRepresentation.mimetype,
                    channel,
                    failure,
                ));
            }
            return failure(
                "binary-read-unsupported",
                415,
                channel === null
                    ? `The representation at ${target} is binary and cannot be rendered.`
                    : `The #${channel} channel is binary and cannot be rendered.`,
                { mimetype: selectedRepresentation.mimetype },
            );
        }

        const { publishesLineAnchors } = opts;
        let lineMarker: LineMarker | null;
        if (LineAnchors.hasAnchor(statement.lineMarker)) {
            if (!publishesLineAnchors) {
                return failure(
                    "line-anchor-unsupported",
                    400,
                    `The representation at ${target} does not publish line anchors.`,
                    {},
                    {
                        target,
                        recovery: "Use numeric text coordinates.",
                        retryable: false,
                    },
                );
            }
            const anchorResolution = LineAnchors.resolve(
                LineAnchors.tokens(identity, selectedRepresentation.content),
                statement.lineMarker,
            );
            if (!anchorResolution.ok) {
                if (anchorResolution.failure.kind === "invalid") {
                    return failure(
                        "line-anchor-invalid",
                        400,
                        LineAnchors.invalidCoordinateDetail,
                        {},
                        {
                            target,
                            recovery: LineAnchors.invalidCoordinateRecovery,
                            retryable: false,
                        },
                    );
                }
                return failure(
                    "line-anchor-collision",
                    409,
                    `READ coordinates collided with current content at ${target}.`,
                    {},
                    {
                        target,
                        recovery: `READ ${target} again with numeric coordinates before reusing its anchors.`,
                        retryable: false,
                    },
                );
            }
            lineMarker = anchorResolution.marker;
        } else {
            lineMarker = statement.lineMarker as LineMarker | null;
        }

        // {§read-pattern} — a matcher selects the lines the READ renders: every line a match
        // touches, in source order, inside the scope, with its ordinary anchors. Zero matches is
        // an empty read, never a failure; `matched` counts the selected lines inside the scope.
        let visibleLines = opts.visibleLines?.[selected];
        if (statement.matcher !== null) {
            if (statement.matcher.dialect === "fts" || statement.matcher.dialect === "graph") {
                return failure(
                    "pattern-dialect-unsupported",
                    400,
                    `READ selects lines with a text matcher; a ${statement.matcher.dialect === "fts" ? "~full-text" : "&graph"} pattern selects resources through FIND.`,
                    {},
                    { target, retryable: false },
                );
            }
            if (mimetypes === undefined) throw new Error("ReadProjector: a READ pattern requires the mimetypes capability");
            const match = await Matcher.matchAgainstContent(PatternEdits.lineLimited(statement.matcher), selectedRepresentation.content, selectedRepresentation.mimetype, mimetypes);
            if (match.status >= 400 || match.status === 203) {
                return Results.assertReadResult({
                    ...(match.problem === undefined
                        ? failure("pattern-unapplicable", 422, match.reason ?? `The pattern could not be applied to ${target}.`, {}, { target, retryable: false })
                        : { status: match.status >= 400 ? match.status : 422, problem: match.problem }),
                    content: null,
                    mimetype: null,
                    channel,
                }) as EntryReadResult;
            }
            const ordered = PatternEdits.lines(match.matches ?? [], null);
            visibleLines = visibleLines === undefined ? ordered : ordered.filter((line) => visibleLines!.includes(line));
        }
        const resolved = await ReadResolve.resolve({
            content: selectedRepresentation.content,
            mimetype: selectedRepresentation.mimetype,
            lineMarker,
            ...(visibleLines === undefined ? {} : { visibleLines }),
        });
        // A whole-resource pattern READ pages through every selected line; a scoped one renders
        // exactly the selected lines the scope holds.
        const matched = statement.matcher === null || visibleLines === undefined
            ? undefined
            : lineMarker === null ? visibleLines.length : (resolved.lineOrdinals?.length ?? 0);
        if (resolved.status >= 400) {
            if (resolved.problem !== undefined) {
                return Results.assertReadResult({
                    ...resolved,
                    content: null,
                    channel,
                }) as EntryReadResult;
            }
            if (resolved.reason === undefined) {
                throw new Error(
                    `ReadProjector: text projection returned status ${resolved.status} without Problem Details or a diagnostic`,
                );
            }
            return failure(
                resolved.status === 416
                    ? "range-not-satisfiable"
                    : "read-resolution-failed",
                resolved.status,
                resolved.reason,
                { mimetype: resolved.mimetype },
                {
                    ...(resolved.range === undefined
                        ? {}
                        : { range: resolved.range, stage: "projection" }),
                },
            );
        }

        // {§channel-selection-visibility} — first contact carries the choice: a READ of a resource
        // with other channels names them with their tokens, exactly as a FIND listing does, keyed
        // by the `#channel` the model appends to the path.
        const siblings = Object.entries(representation.channels)
            .filter(([name]) => name !== selected)
            .map(([name, data]) => [`#${name}`, opts.weigh!(data.content)] as const);
        const projected = {
            ...resolved,
            channel,
            ...(opts.weigh === undefined || siblings.length === 0 ? {} : { channels: Object.fromEntries(siblings) }),
            ...(resolved.mimetype === selectedRepresentation.mimetype ? {} : { sourceMimetype: selectedRepresentation.mimetype }),
            ...(matched === undefined ? {} : { matched }),
            ...(image === null ? {} : { image }),
            ...(document === null ? {} : { document }),
        };
        const producerResult = selectedRepresentation.producerResult;
        // {§read-content-wins} — a channel that delivered content reads as that content; the
        // producer's failure projects onto a READ only when there is nothing to read.
        const contentDelivered = channel !== null && manifest.channels[channel] === "text/stream"
            && typeof projected.content === "string" && projected.content.length > 0;
        const result = producerResult === undefined || (producerResult.status >= 400 && contentDelivered)
            ? projected
            : Results.assertReadResult({
                ...producerResult,
                ...projected,
                status: producerResult.status,
            }) as EntryReadResult;
        if (
            result.status !== 200
            || typeof result.content !== "string"
        ) {
            return result;
        }
        if (!publishesLineAnchors) return { ...result, lineAnchorIdentity: identity };
        const startLine = result.startLine ?? 1;
        const sourceAnchors = resolved.lineOrdinals === undefined ? undefined : LineAnchors.tokens(identity, selectedRepresentation.content);
        return {
            ...result,
            lineAnchorIdentity: identity,
            lineAnchors: resolved.lineOrdinals === undefined ? LineAnchors.project(
                identity,
                selectedRepresentation.content,
                result.content,
                startLine,
            ) : resolved.lineOrdinals.map((ordinal) => sourceAnchors![ordinal - 1]!),
            lineNumberWidth: LineAnchors.lineNumberWidth(selectedRepresentation.content),
        };
    }
}
