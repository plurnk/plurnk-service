import type { LineMarker, ReadStatement } from "@plurnk/plurnk-contracts";
import type { Mimetypes } from "@plurnk/plurnk-mimetypes";
import type {
    EntryReadResult,
    StoredEntryData,
} from "@plurnk/plurnk-schemes";
import type { SchemeManifest } from "../core/scheme-types.ts";
import Results from "../core/results.ts";
import LineAnchors from "./line-anchors.ts";
import MimetypeBinary from "./mimetype-binary.ts";
import ReadResolve from "./read-resolve.ts";

export interface AnchoredReadResult extends EntryReadResult {
    readonly lineAnchorIdentity?: string;
    readonly lineAnchors?: readonly string[];
}

// {§universal-read-composition} Core's one exact-resource projection over a complete canonical
// representation. Storage adapters supply channels; this layer owns channel
// selection, binary admission, text coordinates, line-anchor projection, and
// composition of the selected producer's durable result.
export default class ReadProjector {
    static async project(opts: {
        readonly statement: ReadStatement;
        readonly manifest: SchemeManifest;
        readonly target: string;
        readonly identity: string;
        readonly representation: StoredEntryData;
        readonly mimetypes: Mimetypes | undefined;
    }): Promise<AnchoredReadResult> {
        const { statement, manifest, target, identity, representation, mimetypes } = opts;
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
            return failure(
                "binary-read-unsupported",
                415,
                channel === null
                    ? `The representation at ${target} is binary and cannot be rendered.`
                    : `The #${channel} channel is binary and cannot be rendered.`,
                { mimetype: selectedRepresentation.mimetype },
            );
        }

        let lineMarker: LineMarker | null;
        if (LineAnchors.hasAnchor(statement.lineMarker)) {
            if (manifest.textEditScopes !== true || !manifest.writableBy.includes("model")) {
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
                        "A line anchor appeared outside a line-coordinate position.",
                        {},
                        {
                            target,
                            recovery: "Use anchors only for L, SL, or EL; columns remain numeric.",
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
                        retryable: true,
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
        const result = producerResult === undefined
            ? projected
            : Results.assertReadResult({
                ...producerResult,
                ...projected,
                status: producerResult.status,
            }) as EntryReadResult;
        if (
            result.status !== 200
            || manifest.textEditScopes !== true
            || !manifest.writableBy.includes("model")
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
        };
    }
}
