// Shared CRUD primitives for entry-bearing schemes (Known, Unknown, Skill).
// Per SPEC {§crud} — uniform read/write/delete that the engine drives for
// cross-scheme orchestration of COPY/MOVE/SEND[410].

import { contentHash } from "../core/content-hash.ts";
import type { PlurnkSchemeContext } from "../core/scheme-types.ts";
import Owner from "../core/Owner.ts";
import { renderAddress } from "../core/plurnk-uri.ts";
import Results, { type SchemeResultBase } from "../core/results.ts";

export type ChannelState = "static" | "active" | "closed" | "errored";

// {§channels-channels-append-only}: channels are content stores keyed by (entry_id, name)
export interface EntryData {
    channels: Record<string, { content: string; mimetype: string; state?: ChannelState }>;
    tags: string[];
}

export interface ReadEntryResult extends SchemeResultBase {
    entry: EntryData | null;
}

export interface WriteEntryResult extends SchemeResultBase {
    created: boolean;
    entryId: number | null;
    // 202 proposal: a write INTO file:/// is a disk write under {§membership} review —
    // carries the udiff for the client + the applyResolution inputs. Absent for
    // synchronous entry schemes (known/unknown/skill write directly).
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

    static async readEntry(pathname: string, ctx: PlurnkSchemeContext, scheme: string, ownerId?: number): Promise<ReadEntryResult> {
        const { db, workspaceId } = ctx;
        const owner_id = ownerId ?? await Owner.commonsId(db, workspaceId);
        const entry = await db.crud_find_workspace_entry.get<{ id: number }>({ workspace_id: workspaceId, owner_id, scheme, pathname });
        if (entry === undefined) {
            const target = renderAddress(scheme, pathname);
            return Results.failure(
                `scheme:${scheme}`,
                "entry-not-found",
                404,
                `No entry exists at ${target}.`,
                { entry: null },
                { target },
            ) as ReadEntryResult;
        }

        const channelRows = await db.crud_read_channels.all<{ name: string; content: string; mimetype: string }>({ entry_id: entry.id });
        const channels: EntryData["channels"] = {};
        for (const row of channelRows) {
            channels[row.name] = { content: row.content, mimetype: row.mimetype };
        }

        const tagRows = await db.crud_read_tags.all<{ tag: string }>({ entry_id: entry.id });
        const tags = tagRows.map((r) => r.tag);

        return { status: 200, entry: { channels, tags } };
    }

    static async writeEntry(pathname: string, entry: EntryData, ctx: PlurnkSchemeContext, scheme: string, ownerId?: number): Promise<WriteEntryResult> {
        const { db, workspaceId, tokenize } = ctx;
        if (tokenize === undefined) throw new Error("writeEntry: ctx.tokenize is required for token accounting");
        const owner_id = ownerId ?? await Owner.commonsId(db, workspaceId);
        const existing = await db.crud_find_workspace_entry.get<{ id: number }>({ workspace_id: workspaceId, owner_id, scheme, pathname });

        let entryId: number;
        let created: boolean;
        if (existing === undefined) {
            const row = await db.crud_insert_workspace_entry.get<{ id: number }>({ workspace_id: workspaceId, owner_id, scheme, pathname });
            if (row === undefined) throw new Error("writeEntry: insert returned no row");
            entryId = row.id;
            created = true;
        } else {
            entryId = existing.id;
            created = false;
            await db.crud_delete_channels.run({ entry_id: entryId });
            await db.crud_delete_tags.run({ entry_id: entryId });
        }

        // Writes are VERBATIM — the scheme never transforms what it's handed. Web-page projection
        // (raw html → decisive markdown body + raw `html` archive) lives at the web-fetch entry point
        // (the exec sink), NOT here: an authored/workspace html file is DATA whose attributes are the
        // payload (a `<user email=…>` roster), and a reader-view projection would strip it.
        for (const [channelName, channelData] of Object.entries(entry.channels)) {
            await db.crud_write_channel.run({
                entry_id: entryId, name: channelName, content: channelData.content, mimetype: channelData.mimetype,
                tokens: tokenize(channelData.content), // the model-agnostic ruler stamp ({§tokenomics-agnostic-ruler}, {§tokenomics-tokens-stored-at-write})
                content_hash: contentHash(channelData.content),
                state: channelData.state ?? "static",
            });
        }
        for (const tag of entry.tags) {
            await db.crud_write_tag.run({ entry_id: entryId, tag });
        }
        return { status: created ? 201 : 200, created, entryId };
    }

    static async deleteEntry(pathname: string, ctx: PlurnkSchemeContext, scheme: string, ownerId?: number): Promise<DeleteEntryResult> {
        const { db, workspaceId } = ctx;
        const owner_id = ownerId ?? await Owner.commonsId(db, workspaceId);
        const existing = await db.crud_find_workspace_entry.get<{ id: number }>({ workspace_id: workspaceId, owner_id, scheme, pathname });
        if (existing === undefined) {
            const target = renderAddress(scheme, pathname);
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
        // CASCADE on entry_channels, entry_tags per FK constraints.
        return { status: 200 };
    }

    static async deleteChannel(
        pathname: string,
        channel: string,
        ctx: PlurnkSchemeContext,
        scheme: string,
        ownerId?: number,
    ): Promise<DeleteEntryResult> {
        const { db, workspaceId } = ctx;
        const owner_id = ownerId ?? await Owner.commonsId(db, workspaceId);
        const existing = await db.crud_find_workspace_entry.get<{ id: number }>({
            workspace_id: workspaceId,
            owner_id,
            scheme,
            pathname,
        });
        if (existing === undefined) {
            const target = renderAddress(scheme, pathname);
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
            const target = renderAddress(scheme, pathname);
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
