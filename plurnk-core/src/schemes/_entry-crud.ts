// Shared CRUD primitives for entry-bearing schemes.
// Per SPEC {§crud} — uniform read/write/delete that the engine drives for
// cross-scheme orchestration of COPY/MOVE/SEND signal 410.

import { contentHash } from "../core/content-hash.ts";
import type { PlurnkSchemeContext } from "../core/scheme-types.ts";
import type { ByteSource } from "../content/byte-view.ts";
import type { ChannelProducerResult, ChannelState, EntryCoordinate, StoredEntryData } from "@plurnk/plurnk-schemes";
import { renderAddress } from "../core/plurnk-uri.ts";
import Results, { type SchemeResultBase } from "../core/results.ts";


// {§channels-channels-append-only}: channels are content stores keyed by (entry_id, name)
export interface EntryData {
    channels: Record<string, {
        content: string;
        // {§binary-parity} — a binary channel carries its bytes here; `content` is then the empty
        // string (a File member keeps its bytes on disk; a DB entry stores them base64 in `content`).
        // The write side branches on `bytes`; every text reader keeps reading `content` unchanged.
        bytes?: Uint8Array;
        mimetype: string;
        state?: ChannelState;
        producerResult?: ChannelProducerResult;
    }>;
    attributes?: Readonly<Record<string, unknown>>;
}

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

    static async readEntry(coordinate: EntryCoordinate, ctx: PlurnkSchemeContext, scheme: string, ownerId: number): Promise<ReadEntryResult> {
        const { db, workspaceId } = ctx;
        const { authority, pathname } = coordinate;
        const owner_id = ownerId;
        const entry = await db.crud_find_workspace_entry.get<{ id: number; attributes: string }>({ workspace_id: workspaceId, owner_id, scheme, authority, pathname });
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

        const channelRows = await db.crud_read_channels.all<{
            name: string;
            content: string;
            mimetype: string;
            state: ChannelState;
            producer_result: string | null;
        }>({ entry_id: entry.id });
        const channels: StoredEntryData["channels"] = {};
        for (const row of channelRows) {
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

    static async writeEntry(coordinate: EntryCoordinate, entry: EntryData, ctx: PlurnkSchemeContext, scheme: string, ownerId: number): Promise<WriteEntryResult> {
        const { db, workspaceId, weigh } = ctx;
        const { authority, pathname } = coordinate;
        if (weigh === undefined) throw new Error("writeEntry: ctx.weigh is required for curation-weight accounting");
        const owner_id = ownerId;
        const existing = await db.crud_find_workspace_entry.get<{ id: number }>({ workspace_id: workspaceId, owner_id, scheme, authority, pathname });

        let entryId: number;
        let created: boolean;
        if (existing === undefined) {
            const row = entry.attributes === undefined
                ? await db.crud_insert_workspace_entry.get<{ id: number }>({ workspace_id: workspaceId, owner_id, scheme, authority, pathname })
                : await db.crud_insert_workspace_entry_with_attributes.get<{ id: number }>({
                    workspace_id: workspaceId,
                    owner_id,
                    scheme,
                    authority,
                    pathname,
                    attributes: JSON.stringify(entry.attributes),
                });
            if (row === undefined) throw new Error("writeEntry: insert returned no row");
            entryId = row.id;
            created = true;
        } else {
            entryId = existing.id;
            created = false;
            if (entry.attributes !== undefined) {
                await db.crud_set_entry_attributes.run({
                    entry_id: entryId,
                    attributes: JSON.stringify(entry.attributes),
                });
            }
            await db.crud_delete_channels.run({ entry_id: entryId });
        }

        // Writes are VERBATIM — the scheme never transforms what it's handed. Web-page projection
        // (raw html → decisive markdown body + raw `html` archive) lives at the web-fetch entry point
        // (the exec sink), NOT here: an authored/workspace html file is DATA whose attributes are the
        // payload (a `<user email=…>` roster), and a reader-view projection would strip it.
        for (const [channelName, channelData] of Object.entries(entry.channels)) {
            const producerResult = channelData.producerResult === undefined
                ? null
                : JSON.stringify(Results.assertChannelProducerResult(channelData.producerResult));
            // {§binary-parity} — a binary channel arrives as bytes; a DB entry keeps them base64 in its
            // TEXT content, and READ/COPY recover them through EntryCrud.contentByteSource.
            const storedContent = channelData.bytes === undefined
                ? channelData.content
                : Buffer.from(channelData.bytes).toString("base64");
            await db.crud_write_channel.run({
                entry_id: entryId, name: channelName, content: storedContent, mimetype: channelData.mimetype,
                weight: weigh(storedContent), // stable curation weight ({§tokenomics-agnostic-ruler}, {§tokenomics-weight-stored-at-write})
                content_hash: contentHash(storedContent),
                state: channelData.state ?? "static",
                producer_result: producerResult,
            });
        }
        return { status: created ? 201 : 200, created, entryId };
    }

    static async deleteEntry(coordinate: EntryCoordinate, ctx: PlurnkSchemeContext, scheme: string, ownerId: number): Promise<DeleteEntryResult> {
        const { db, workspaceId } = ctx;
        const { authority, pathname } = coordinate;
        const owner_id = ownerId;
        const existing = await db.crud_find_workspace_entry.get<{ id: number }>({ workspace_id: workspaceId, owner_id, scheme, authority, pathname });
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
        ownerId: number,
    ): Promise<DeleteEntryResult> {
        const { db, workspaceId } = ctx;
        const { authority, pathname } = coordinate;
        const owner_id = ownerId;
        const existing = await db.crud_find_workspace_entry.get<{ id: number }>({
            workspace_id: workspaceId,
            owner_id,
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
