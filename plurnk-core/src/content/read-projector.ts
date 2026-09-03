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

export interface AnchoredReadResult extends EntryReadResult {
    readonly lineAnchorIdentity?: string;
    readonly lineAnchors?: readonly string[];
    readonly lineNumberWidth?: number;
}

// {§universal-read-composition} Core's one exact-resource projection over a complete canonical
// representation. Storage adapters supply channels; this layer owns channel
// selection, binary admission, text coordinates, line-anchor projection, and
// composition of the selected producer's durable result.
export default class ReadProjector {
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

    static async project(opts: {
        readonly statement: ReadStatement;
        readonly manifest: SchemeManifest;
        readonly target: string;
        readonly identity: string;
        readonly representation: StoredEntryData;
        readonly mimetypes: Mimetypes | undefined;
        // {§read-bytes} — the scheme's byte supplier for this resource, when it has one.
        readonly bytes?: ByteSource;
    }): Promise<AnchoredReadResult> {
        const { statement, manifest, target, identity, representation, mimetypes, bytes } = opts;
        const fragment = statement.target?.kind === "url"
            ? statement.target.fragment
            : null;
        const selected = fragment ?? manifest.defaultChannel;
        const channel = selected === "" ? null : selected;
        const availableChannels = [...new Set([
            manifest.defaultChannel,
            ...Object.keys(manifest.channels),
        ])].filter((candidate) => candidate.length > 0);
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
        if (selected === ByteView.CHANNEL && !(selected in manifest.channels)) {
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
            return ReadProjector.#projectBytes(statement, target, bytes, sourceMimetype, ByteView.CHANNEL, failure);
        }
        if (selected !== manifest.defaultChannel && !(selected in manifest.channels)) {
            return failure(
                "channel-not-found",
                400,
                `Channel #${selected} does not exist at ${target}.`,
                { channel: null },
                {
                    requestedChannel: selected,
                    availableChannels,
                    ...(availableChannels.length === 0
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

        const selectedRepresentation = representation.channels[selected];
        if (selectedRepresentation === undefined) {
            return failure(
                "entry-not-found",
                404,
                `No entry exists at ${target}.`,
            );
        }
        if (await MimetypeBinary.isBinaryMimetype(selectedRepresentation.mimetype, mimetypes)) {
            // {§read-bytes} — a binary channel with no readable projection reads as its bytes.
            if (bytes !== undefined) {
                return ReadProjector.#projectBytes(statement, target, bytes, selectedRepresentation.mimetype, channel, failure);
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

        const publishesLineAnchors = manifest.lineAnchors === true
            || (manifest.textEditScopes === true && manifest.writableBy.includes("model"));
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

        const resolved = await ReadResolve.resolve({
            content: selectedRepresentation.content,
            mimetype: selectedRepresentation.mimetype,
            lineMarker,
        });
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

        const projected = { ...resolved, channel };
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
            || !publishesLineAnchors
            || typeof result.content !== "string"
        ) {
            return result;
        }
        const startLine = result.startLine ?? 1;
        return {
            ...result,
            lineAnchorIdentity: identity,
            lineAnchors: LineAnchors.project(
                identity,
                selectedRepresentation.content,
                result.content,
                startLine,
            ),
            lineNumberWidth: LineAnchors.lineNumberWidth(selectedRepresentation.content),
        };
    }
}
