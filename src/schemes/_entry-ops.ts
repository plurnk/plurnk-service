import type { DatabaseSync } from "node:sqlite";
import type { EditStatement, HideStatement, ReadStatement, ShowStatement } from "@plurnk/plurnk-grammar";

// Shared free functions for session-scope entry-bearing schemes
// (Known, Unknown, Skill). Each scheme passes its `channels` manifest
// and `defaultChannel` per SPEC §3.1. Channel routing follows §5.5:
// path.fragment ?? scheme.defaultChannel.

type ChannelManifest = Record<string, string>;

type Common = {
    db: DatabaseSync;
    sessionId: number;
    scheme: string;
    channels: ChannelManifest;
    defaultChannel: string;
};
type EditCtx = Common & { statement: EditStatement; runId: number };
type ReadCtx = Common & { statement: ReadStatement };
type ShowHideCtx = Common & { statement: ShowStatement | HideStatement; runId: number };

export type EditResult = { status: number; entryId: number | null; channel: string | null };
export type ReadResult = { status: number; content: string | null; mimetype: string | null; channel: string | null };
export type ShowHideResult = { status: number };

const pathnameOf = (statement: { path: EditStatement["path"] }): string => {
    const path = statement.path;
    if (path === null) throw new Error("unreachable");
    if (path.kind === "url") return path.pathname;
    return path.raw;
};

const fragmentOf = (statement: { path: EditStatement["path"] }): string | null => {
    const path = statement.path;
    if (path === null || path.kind !== "url") return null;
    return path.fragment;
};

// Resolve target channel from fragment, validate against manifest.
// Returns null if validation fails (caller should return 400).
const resolveChannel = (fragment: string | null, channels: ChannelManifest, defaultChannel: string): string | null => {
    const target = fragment ?? defaultChannel;
    if (!(target in channels)) return null;
    return target;
};

export const editSessionEntry = async ({ db, statement, sessionId, runId, scheme, channels, defaultChannel }: EditCtx): Promise<EditResult> => {
    if (statement.path === null) return { status: 400, entryId: null, channel: null };
    if (statement.lineMarker !== null) return { status: 501, entryId: null, channel: null };

    const fragment = fragmentOf(statement);
    const targetChannel = resolveChannel(fragment, channels, defaultChannel);
    if (targetChannel === null) return { status: 400, entryId: null, channel: null };

    const pathname = pathnameOf(statement);
    const existing = db
        .prepare("SELECT id FROM entries WHERE scope = 'session' AND session_id = ? AND scheme = ? AND pathname = ?")
        .get(sessionId, scheme, pathname) as { id: number } | undefined;

    // Non-default channel write requires entry to exist.
    if (existing === undefined && fragment !== null) {
        return { status: 404, entryId: null, channel: targetChannel };
    }

    let entryId: number;
    let createdNow: boolean;
    if (existing === undefined) {
        const row = db
            .prepare("INSERT INTO entries (scope, session_id, scheme, pathname) VALUES ('session', ?, ?, ?) RETURNING id")
            .get(sessionId, scheme, pathname) as { id: number };
        entryId = row.id;
        createdNow = true;
    } else {
        entryId = existing.id;
        createdNow = false;
    }

    const body = statement.body ?? "";
    const writeChannel = db.prepare(
        "INSERT OR REPLACE INTO entry_channels (entry_id, name, content, mimetype, tokens, state) VALUES (?, ?, ?, ?, 0, 'static')",
    );
    const writeVisibility = db.prepare(
        "INSERT OR IGNORE INTO visibility (run_id, entry_id, channel, indexed) VALUES (?, ?, ?, 1)",
    );

    if (fragment === null) {
        // Default-channel EDIT — write target channel + preview companion.
        writeChannel.run(entryId, targetChannel, body, channels[targetChannel]);
        writeVisibility.run(runId, entryId, targetChannel);
        if ("preview" in channels && targetChannel !== "preview") {
            // v0: preview is a verbatim copy of body. MimetypeHandler.preview()
            // will refine this in a later PR (per SPEC §5.1).
            writeChannel.run(entryId, "preview", body, channels.preview);
            writeVisibility.run(runId, entryId, "preview");
        }
    } else {
        // Fragment-targeted EDIT — write only that channel.
        writeChannel.run(entryId, targetChannel, body, channels[targetChannel]);
        writeVisibility.run(runId, entryId, targetChannel);
    }

    if (Array.isArray(statement.signal)) {
        const insertTag = db.prepare("INSERT OR IGNORE INTO entry_tags (entry_id, tag) VALUES (?, ?)");
        for (const tag of statement.signal) insertTag.run(entryId, tag);
    }

    return { status: createdNow ? 201 : 200, entryId, channel: targetChannel };
};

export const readSessionEntry = async ({ db, statement, sessionId, scheme, channels, defaultChannel }: ReadCtx): Promise<ReadResult> => {
    if (statement.path === null) return { status: 400, content: null, mimetype: null, channel: null };
    if (statement.lineMarker !== null) return { status: 501, content: null, mimetype: null, channel: null };
    if (statement.body !== null) return { status: 501, content: null, mimetype: null, channel: null };
    if (Array.isArray(statement.signal) && statement.signal.length > 0) return { status: 501, content: null, mimetype: null, channel: null };

    const fragment = fragmentOf(statement);
    const targetChannel = resolveChannel(fragment, channels, defaultChannel);
    if (targetChannel === null) return { status: 400, content: null, mimetype: null, channel: null };

    const pathname = pathnameOf(statement);
    const row = db
        .prepare(
            "SELECT ec.content, ec.mimetype FROM entries e JOIN entry_channels ec ON ec.entry_id = e.id WHERE e.scope = 'session' AND e.session_id = ? AND e.scheme = ? AND e.pathname = ? AND ec.name = ?",
        )
        .get(sessionId, scheme, pathname, targetChannel) as { content: string; mimetype: string } | undefined;

    if (row === undefined) return { status: 404, content: null, mimetype: null, channel: targetChannel };
    return { status: 200, content: row.content, mimetype: row.mimetype, channel: targetChannel };
};

const setSessionEntryVisibility = async (
    { db, statement, sessionId, runId, scheme, channels, defaultChannel }: ShowHideCtx,
    target: 0 | 1,
): Promise<ShowHideResult> => {
    if (statement.path === null) return { status: 400 };
    if (statement.lineMarker !== null) return { status: 501 };
    if (statement.body !== null) return { status: 501 };
    if (Array.isArray(statement.signal) && statement.signal.length > 0) return { status: 501 };

    const fragment = fragmentOf(statement);
    const pathname = pathnameOf(statement);
    const entry = db
        .prepare("SELECT id FROM entries WHERE scope = 'session' AND session_id = ? AND scheme = ? AND pathname = ?")
        .get(sessionId, scheme, pathname) as { id: number } | undefined;
    if (entry === undefined) return { status: 404 };

    if (fragment === null) {
        // Fragment-less SHOW/HIDE — flip every channel of the entry.
        const existing = db
            .prepare("SELECT channel, indexed FROM visibility WHERE run_id = ? AND entry_id = ?")
            .all(runId, entry.id) as Array<{ channel: string; indexed: number }>;
        const existingByName = new Map(existing.map((r) => [r.channel, r.indexed]));

        let changed = 0;
        for (const channelName of Object.keys(channels)) {
            if (existingByName.get(channelName) === target) continue;
            db.prepare(
                "INSERT INTO visibility (run_id, entry_id, channel, indexed) VALUES (?, ?, ?, ?) ON CONFLICT (run_id, entry_id, channel) DO UPDATE SET indexed = excluded.indexed",
            ).run(runId, entry.id, channelName, target);
            changed += 1;
        }
        return { status: changed === 0 ? 304 : 200 };
    }

    // Fragment-targeted SHOW/HIDE — flip only that channel.
    const targetChannel = resolveChannel(fragment, channels, defaultChannel);
    if (targetChannel === null) return { status: 400 };

    const current = db
        .prepare("SELECT indexed FROM visibility WHERE run_id = ? AND entry_id = ? AND channel = ?")
        .get(runId, entry.id, targetChannel) as { indexed: number } | undefined;
    if (current?.indexed === target) return { status: 304 };

    db.prepare(
        "INSERT INTO visibility (run_id, entry_id, channel, indexed) VALUES (?, ?, ?, ?) ON CONFLICT (run_id, entry_id, channel) DO UPDATE SET indexed = excluded.indexed",
    ).run(runId, entry.id, targetChannel, target);
    return { status: 200 };
};

export const showSessionEntry = async (ctx: ShowHideCtx): Promise<ShowHideResult> => setSessionEntryVisibility(ctx, 1);

export const hideSessionEntry = async (ctx: ShowHideCtx): Promise<ShowHideResult> => setSessionEntryVisibility(ctx, 0);
