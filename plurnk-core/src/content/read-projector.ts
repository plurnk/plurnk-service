import type { ReadStatement } from "@plurnk/plurnk-contracts";
import type { Mimetypes } from "@plurnk/plurnk-mimetypes";
import type {
    EntryReadResult,
    StoredEntryData,
} from "@plurnk/plurnk-schemes";
import type { SchemeManifest } from "../core/scheme-types.ts";
import Results from "../core/results.ts";
import MimetypeBinary from "./mimetype-binary.ts";
import ReadResolve from "./read-resolve.ts";

// {§universal-read-composition} Core's one exact-resource projection over a complete canonical
// representation. Storage adapters supply channels; this layer owns channel
// selection, binary admission, text coordinates, and
// composition of the selected producer's durable result.
export default class ReadProjector {
    static async project(opts: {
        readonly statement: ReadStatement;
        readonly manifest: SchemeManifest;
        readonly target: string;
        readonly representation: StoredEntryData;
        readonly mimetypes: Mimetypes | undefined;
    }): Promise<EntryReadResult> {
        const { statement, manifest, target, representation, mimetypes } = opts;
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

        const resolved = await ReadResolve.resolve({
            content: selectedRepresentation.content,
            mimetype: selectedRepresentation.mimetype,
            lineMarker: statement.lineMarker,
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
        return producerResult === undefined
            ? projected
            : Results.assertReadResult({
                ...producerResult,
                ...projected,
                status: producerResult.status,
            }) as EntryReadResult;
    }
}
