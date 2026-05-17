// Shared CRUD primitives for entry-bearing schemes (Known, Unknown, Skill).
// Per SPEC §3.2 — uniform read/write/delete that the engine drives for
// cross-scheme orchestration of COPY/MOVE/SEND[410].

import type { DatabaseSync } from "node:sqlite";

export interface EntryData {
    channels: Record<string, { content: string; mimetype: string }>;
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

interface ReadCtx {
    db: DatabaseSync;
    sessionId: number;
    scheme: string;
    pathname: string;
}

interface WriteCtx {
    db: DatabaseSync;
    sessionId: number;
    scheme: string;
    pathname: string;
    entry: EntryData;
    runId: number;
}

interface DeleteCtx {
    db: DatabaseSync;
    sessionId: number;
    scheme: string;
    pathname: string;
}

export const readEntry = ({ db, sessionId, scheme, pathname }: ReadCtx): ReadEntryResult => {
    const entry = db
        .prepare("SELECT id FROM entries WHERE scope = 'session' AND session_id = ? AND scheme = ? AND pathname = ?")
        .get(sessionId, scheme, pathname) as { id: number } | undefined;
    if (entry === undefined) return { status: 404, entry: null };

    const channelRows = db
        .prepare("SELECT name, content, mimetype FROM entry_channels WHERE entry_id = ?")
        .all(entry.id) as Array<{ name: string; content: string; mimetype: string }>;
    const channels: EntryData["channels"] = {};
    for (const row of channelRows) {
        channels[row.name] = { content: row.content, mimetype: row.mimetype };
    }

    const tagRows = db
        .prepare("SELECT tag FROM entry_tags WHERE entry_id = ? ORDER BY tag")
        .all(entry.id) as Array<{ tag: string }>;
    const tags = tagRows.map((r) => r.tag);

    return { status: 200, entry: { channels, tags } };
};

export const writeEntry = ({ db, sessionId, scheme, pathname, entry, runId }: WriteCtx): WriteEntryResult => {
    const existing = db
        .prepare("SELECT id FROM entries WHERE scope = 'session' AND session_id = ? AND scheme = ? AND pathname = ?")
        .get(sessionId, scheme, pathname) as { id: number } | undefined;

    let entryId: number;
    let created: boolean;
    if (existing === undefined) {
        const row = db
            .prepare("INSERT INTO entries (scope, session_id, scheme, pathname) VALUES ('session', ?, ?, ?) RETURNING id")
            .get(sessionId, scheme, pathname) as { id: number };
        entryId = row.id;
        created = true;
    } else {
        entryId = existing.id;
        created = false;
        // Clear existing channels + tags before re-writing
        db.prepare("DELETE FROM entry_channels WHERE entry_id = ?").run(entryId);
        db.prepare("DELETE FROM entry_tags WHERE entry_id = ?").run(entryId);
    }

    const writeChannel = db.prepare(
        "INSERT INTO entry_channels (entry_id, name, content, mimetype, tokens, state) VALUES (?, ?, ?, ?, 0, 'static')",
    );
    const writeVisibility = db.prepare(
        "INSERT OR IGNORE INTO visibility (run_id, entry_id, channel, indexed) VALUES (?, ?, ?, 1)",
    );
    for (const [channelName, channelData] of Object.entries(entry.channels)) {
        writeChannel.run(entryId, channelName, channelData.content, channelData.mimetype);
        writeVisibility.run(runId, entryId, channelName);
    }

    const insertTag = db.prepare("INSERT OR IGNORE INTO entry_tags (entry_id, tag) VALUES (?, ?)");
    for (const tag of entry.tags) insertTag.run(entryId, tag);

    return { status: created ? 201 : 200, created, entryId };
};

export const deleteEntry = ({ db, sessionId, scheme, pathname }: DeleteCtx): DeleteEntryResult => {
    const existing = db
        .prepare("SELECT id FROM entries WHERE scope = 'session' AND session_id = ? AND scheme = ? AND pathname = ?")
        .get(sessionId, scheme, pathname) as { id: number } | undefined;
    if (existing === undefined) return { status: 404 };
    db.prepare("DELETE FROM entries WHERE id = ?").run(existing.id);
    // CASCADE on entry_channels, entry_tags, visibility per FK constraints.
    return { status: 200 };
};
