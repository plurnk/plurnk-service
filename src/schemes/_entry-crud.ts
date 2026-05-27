// Shared CRUD primitives for entry-bearing schemes (Known, Unknown, Skill).
// Per SPEC §3.2 — uniform read/write/delete that the engine drives for
// cross-scheme orchestration of COPY/MOVE/SEND[410].

import type { PrepMethod } from "../core/Db.ts";
import type { PlurnkSchemeContext } from "../core/scheme-types.ts";

export type ChannelState = "static" | "active" | "closed" | "errored";

export interface EntryData {
    channels: Record<string, { content: string; mimetype: string; state?: ChannelState }>;
    tags: string[];
}

export interface ReadEntryResult {
    status: number;
    entry: EntryData | null;
}

export interface WriteEntryResult {
    status: number;
    created: boolean;
    entryId: number | null;
}

export interface DeleteEntryResult {
    status: number;
}

export const readEntry = async (pathname: string, ctx: PlurnkSchemeContext, scheme: string | null): Promise<ReadEntryResult> => {
    const { db, sessionId } = ctx;
    const entry = await (db.crud_find_session_entry as PrepMethod).get<{ id: number }>({ session_id: sessionId, scheme, pathname });
    if (entry === undefined) return { status: 404, entry: null };

    const channelRows = await (db.crud_read_channels as PrepMethod).all<{ name: string; content: string; mimetype: string }>({ entry_id: entry.id });
    const channels: EntryData["channels"] = {};
    for (const row of channelRows) {
        channels[row.name] = { content: row.content, mimetype: row.mimetype };
    }

    const tagRows = await (db.crud_read_tags as PrepMethod).all<{ tag: string }>({ entry_id: entry.id });
    const tags = tagRows.map((r) => r.tag);

    return { status: 200, entry: { channels, tags } };
};

export const writeEntry = async (pathname: string, entry: EntryData, ctx: PlurnkSchemeContext, scheme: string | null): Promise<WriteEntryResult> => {
    const { db, sessionId, runId } = ctx;
    const existing = await (db.crud_find_session_entry as PrepMethod).get<{ id: number }>({ session_id: sessionId, scheme, pathname });

    let entryId: number;
    let created: boolean;
    if (existing === undefined) {
        const row = await (db.crud_insert_session_entry as PrepMethod).get<{ id: number }>({ session_id: sessionId, scheme, pathname });
        if (row === undefined) throw new Error("writeEntry: insert returned no row");
        entryId = row.id;
        created = true;
    } else {
        entryId = existing.id;
        created = false;
        await (db.crud_delete_channels as PrepMethod).run({ entry_id: entryId });
        await (db.crud_delete_tags as PrepMethod).run({ entry_id: entryId });
    }

    for (const [channelName, channelData] of Object.entries(entry.channels)) {
        await (db.crud_write_channel as PrepMethod).run({
            entry_id: entryId, name: channelName, content: channelData.content, mimetype: channelData.mimetype,
            state: channelData.state ?? "static",
        });
        await (db.crud_write_visibility as PrepMethod).run({ run_id: runId, entry_id: entryId, channel: channelName });
    }
    for (const tag of entry.tags) {
        await (db.crud_write_tag as PrepMethod).run({ entry_id: entryId, tag });
    }

    return { status: created ? 201 : 200, created, entryId };
};

export const deleteEntry = async (pathname: string, ctx: PlurnkSchemeContext, scheme: string | null): Promise<DeleteEntryResult> => {
    const { db, sessionId } = ctx;
    const existing = await (db.crud_find_session_entry as PrepMethod).get<{ id: number }>({ session_id: sessionId, scheme, pathname });
    if (existing === undefined) return { status: 404 };
    await (db.crud_delete_entry as PrepMethod).run({ entry_id: existing.id });
    // CASCADE on entry_channels, entry_tags, visibility per FK constraints.
    return { status: 200 };
};
