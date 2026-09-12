// Shared CRUD primitives for entry-bearing schemes.
// Per SPEC {§crud} — uniform read/write/delete that the engine drives for
// cross-scheme orchestration of COPY/MOVE/KILL.

import { contentHash } from "../core/content-hash.ts";
import EntryReadable from "./_entry-readable.ts";
import type { PlurnkSchemeContext } from "../core/scheme-types.ts";
import type { ByteSource } from "../content/byte-view.ts";
import type { ChannelProducerResult, ChannelState, EntryCoordinate, EntryData, StoredEntryData } from "@plurnk/plurnk-schemes";
export type { EntryData } from "@plurnk/plurnk-schemes";
import { renderAddress } from "../core/plurnk-uri.ts";
import Results, { type SchemeResultBase } from "../core/results.ts";
import type { Mimetypes } from "@plurnk/plurnk-mimetypes";
import MimetypeBinary from "../content/mimetype-binary.ts";


export interface ReadEntryResult extends SchemeResultBase {
    entry: StoredEntryData | null;
}

export interface WriteEntryResult extends SchemeResultBase {
    created: boolean;
    entryId: number | null;
    // 202 proposal: a write INTO file:/// is a disk write under {§membership} review —
    // carries the udiff for the client + the applyResolution inputs. Absent for
    // synchronous entry schemes.
    body?: string;
    attrs?: object;
}

export interface DeleteEntryResult extends SchemeResultBase {
    // A host-effecting delete (file) returns 202 to PROPOSE for review; attrs carry the target so
    // applyResolution can unlink on accept. Internal entry deletes execute inline (200).
    attrs?: object;
}

export default class EntryCrud {
    // {§entry-identity-no-null} — the non-null identity scheme persisted by a manifest.
    static identityScheme(manifest: { name: string; storedScheme?: string }): string {
        return manifest.storedScheme ?? manifest.name;
    }

    // {§binary-parity} — a DB entry stores a binary channel's bytes base64 in its TEXT content
    // ({§read-bytes}); this turns that stored content back into the byte supplier the read projector and
    // COPY/MOVE source-select consume exactly as they consume a File member's on-disk bytes. Decoded once.
    static contentByteSource(content: string): ByteSource {
        const bytes = Buffer.from(content, "base64");
        return {
            size: async () => bytes.byteLength,
            read: async (start, end) => bytes.subarray(start - 1, end),
        };
    }

    static async storedByteSource(entry: StoredEntryData, channel: string, mimetypes: Mimetypes | undefined): Promise<ByteSource | undefined> {
        const selected = entry.channels[channel];
        // {§binary-parity} A typed empty marker is not a stored byte payload.
        return selected !== undefined && selected.content !== "" && await MimetypeBinary.isBinaryMimetype(selected.mimetype, mimetypes)
            ? EntryCrud.contentByteSource(selected.content)
            : undefined;
    }

    static async readEntry(coordinate: EntryCoordinate, ctx: PlurnkSchemeContext, scheme: string): Promise<ReadEntryResult> {
        const { db, workspaceId } = ctx;
        const { authority, pathname } = coordinate;
        const rows = await db.crud_read_entry.all<{
            id: number; attributes: string; name: string | null; content: string;
            mimetype: string; state: ChannelState; producer_result: string | null;
        }>({ workspace_id: workspaceId, scheme, authority, pathname });
        const entry = rows[0];
        if (entry === undefined) {
            const target = renderAddress({ scheme, authority, pathname });
            return Results.failure(
                `scheme:${scheme}`,
                "entry-not-found",
                404,
                `No entry exists at ${target}.`,
                { entry: null },
                { target },
            ) as ReadEntryResult;
        }

        const channels: StoredEntryData["channels"] = {};
        for (const row of rows) {
            if (row.name === null) continue;
            channels[row.name] = {
                content: row.content,
                mimetype: row.mimetype,
                state: row.state,
                ...(row.producer_result === null
                    ? {}
                    : {
                        producerResult: Results.assertChannelProducerResult(
                            JSON.parse(row.producer_result) as ChannelProducerResult,
                        ),
                    }),
            };
        }

        const attributes = JSON.parse(entry.attributes) as unknown;
        if (typeof attributes !== "object" || attributes === null || Array.isArray(attributes)) {
            throw new TypeError(`Entry ${entry.id} contains invalid attributes.`);
        }
        return {
            status: 200,
            entry: {
                channels,
                ...(Object.keys(attributes).length === 0
                    ? {}
                    : { attributes: attributes as Readonly<Record<string, unknown>> }),
            },
        };
    }

    static async writeEntry(coordinate: EntryCoordinate, entry: EntryData, ctx: PlurnkSchemeContext, scheme: string, representation: { defaultChannel?: string; output?: boolean; createOnly?: boolean } = {}): Promise<WriteEntryResult> {
        const { db, workspaceId, weigh } = ctx;
        const { authority, pathname } = coordinate;
        if (weigh === undefined) throw new Error("writeEntry: ctx.weigh is required for curation-weight accounting");
        const defaultChannel = representation.defaultChannel ?? ctx.defaultChannelFor?.(scheme) ?? "body";
        if (defaultChannel.length === 0) {
            throw new Error(`writeEntry: ${scheme} representation has no default channel ${JSON.stringify(defaultChannel)}`);
        }
        const output = representation.output === true ? 1 : 0;
        const channels = await Promise.all(Object.entries(entry.channels).map(async ([name, data]) => ({
            name,
            data,
            producerResult: data.producerResult === undefined ? null : JSON.stringify(Results.assertChannelProducerResult(data.producerResult)),
            content: data.bytes === undefined ? data.content
                : await MimetypeBinary.isBinaryMimetype(data.mimetype, ctx.mimetypes)
                    ? Buffer.from(data.bytes).toString("base64")
                    : new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(data.bytes),
        })));
        const published = await db.crud_publish_entry.get<{ id: number; created: 0 | 1 }>({
            workspace_id: workspaceId, scheme, authority, pathname,
            attributes: entry.attributes === undefined ? null : JSON.stringify(entry.attributes),
            default_channel: defaultChannel, output,
            create_only: representation.createOnly === true ? 1 : 0,
            channels: JSON.stringify(Object.fromEntries(channels.map(({ name, data, content, producerResult }) => [name, {
                content, mimetype: data.mimetype, weight: weigh(content), content_hash: contentHash(content),
                state: data.state ?? "static", producer_result: producerResult,
            }]))),
        });
        if (published === undefined) {
            if (representation.createOnly === true) return Results.failure(
                `scheme:${scheme}`, "entry-exists", 409,
                `An entry already exists at ${renderAddress({ scheme, authority, pathname })}.`,
                { created: false, entryId: null },
            ) as WriteEntryResult;
            throw new Error("writeEntry: publication returned no row");
        }
        const created = published.created === 1;
        // {§readable-channel} — a text source channel lands with its projection beside it.
        const source = channels.find(({ name }) => name === defaultChannel);
        if (source !== undefined && source.data.bytes === undefined && ctx.mimetypes !== undefined
            && !await MimetypeBinary.isBinaryMimetype(source.data.mimetype, ctx.mimetypes)) {
            await EntryReadable.sync(ctx, published.id, source.name, defaultChannel, source.content, source.data.mimetype);
        }
        return { status: created ? 201 : 200, created, entryId: published.id };
    }

    static async deleteEntry(coordinate: EntryCoordinate, ctx: PlurnkSchemeContext, scheme: string): Promise<DeleteEntryResult> {
        const { db, workspaceId } = ctx;
        const { authority, pathname } = coordinate;
        const existing = await db.crud_find_workspace_entry.get<{ id: number }>({ workspace_id: workspaceId, scheme, authority, pathname });
        if (existing === undefined) {
            const target = renderAddress({ scheme, authority, pathname });
            return Results.failure(
                `scheme:${scheme}`,
                "entry-not-found",
                404,
                `No entry exists at ${target}.`,
                {},
                { target },
            ) as DeleteEntryResult;
        }
        await db.crud_delete_entry.run({ entry_id: existing.id });
        // CASCADE on entry_channels per FK constraints.
        return { status: 200 };
    }

    static async deleteChannel(
        coordinate: EntryCoordinate,
        channel: string,
        ctx: PlurnkSchemeContext,
        scheme: string,
    ): Promise<DeleteEntryResult> {
        const { db, workspaceId } = ctx;
        const { authority, pathname } = coordinate;
        const existing = await db.crud_find_workspace_entry.get<{ id: number }>({
            workspace_id: workspaceId,

            scheme,
            authority,
            pathname,
        });
        if (existing === undefined) {
            const target = renderAddress({ scheme, authority, pathname });
            return Results.failure(
                `scheme:${scheme}`,
                "entry-not-found",
                404,
                `No entry exists at ${target}.`,
                {},
                { target },
            ) as DeleteEntryResult;
        }
        const deleted = await db.crud_delete_channel.get<{ name: string }>({
            entry_id: existing.id,
            name: channel,
        });
        // {§readable-channel} — a projection cannot outlive its source.
        if (deleted !== undefined && !EntryReadable.isDerived(channel)) {
            const defaultChannel = ctx.defaultChannelFor?.(scheme) ?? "body";
            if (channel === defaultChannel) await db.crud_delete_readable_channel.run({ entry_id: existing.id });
        }
        if (deleted === undefined) {
            const target = renderAddress({ scheme, authority, pathname });
            return Results.failure(
                `scheme:${scheme}`,
                "channel-not-found",
                404,
                `No channel named #${channel} exists at ${target}.`,
                {},
                {
                    target,
                    channel,
                },
            ) as DeleteEntryResult;
        }
        const remaining = await db.crud_read_channels.all<{ name: string }>({ entry_id: existing.id });
        if (remaining.length === 0) await db.crud_delete_entry.run({ entry_id: existing.id });
        return { status: 200 };
    }
}
