import type { EditStatement, HideStatement, ReadStatement, ShowStatement } from "@plurnk/plurnk-grammar";
import type { PrepMethod } from "../core/Db.ts";
import type { PlurnkSchemeContext, SchemeManifest } from "../core/scheme-types.ts";

// Shared free functions for session-scope entry-bearing schemes
// (Known, Unknown, Skill). Each scheme passes its manifest; helpers
// extract scheme name + channels + defaultChannel. Channel routing
// follows SPEC §5.5: path.fragment ?? manifest.defaultChannel.

export type EditResult = { status: number; entryId: number | null; channel: string | null };
export type ReadResult = { status: number; content: string | null; mimetype: string | null; channel: string | null };
export type ShowHideResult = { status: number };

const pathnameOf = (statement: { target: EditStatement["target"] }): string => {
    const t = statement.target;
    if (t === null) throw new Error("unreachable");
    if (t.kind === "url") return t.pathname;
    return t.raw;
};

const fragmentOf = (statement: { target: EditStatement["target"] }): string | null => {
    const t = statement.target;
    if (t === null || t.kind !== "url") return null;
    return t.fragment;
};

const resolveChannel = (fragment: string | null, channels: Record<string, string>, defaultChannel: string): string | null => {
    const target = fragment ?? defaultChannel;
    if (!(target in channels)) return null;
    return target;
};

export const editSessionEntry = async (statement: EditStatement, ctx: PlurnkSchemeContext, manifest: SchemeManifest): Promise<EditResult> => {
    if (statement.target === null) return { status: 400, entryId: null, channel: null };
    if (statement.lineMarker !== null) return { status: 501, entryId: null, channel: null };

    const { db, sessionId, runId } = ctx;
    const { name: scheme, channels, defaultChannel } = manifest;

    const fragment = fragmentOf(statement);
    const targetChannel = resolveChannel(fragment, channels, defaultChannel);
    if (targetChannel === null) return { status: 400, entryId: null, channel: null };

    const pathname = pathnameOf(statement);
    const existing = await (db.crud_find_session_entry as PrepMethod).get<{ id: number }>({ session_id: sessionId, scheme, pathname });

    // Non-default channel write requires entry to exist.
    if (existing === undefined && fragment !== null) {
        return { status: 404, entryId: null, channel: targetChannel };
    }

    let entryId: number;
    let createdNow: boolean;
    if (existing === undefined) {
        const row = await (db.crud_insert_session_entry as PrepMethod).get<{ id: number }>({ session_id: sessionId, scheme, pathname });
        if (row === undefined) throw new Error("editSessionEntry: insert returned no row");
        entryId = row.id;
        createdNow = true;
    } else {
        entryId = existing.id;
        createdNow = false;
    }

    const body = statement.body ?? "";
    await (db.ops_upsert_channel as PrepMethod).run({ entry_id: entryId, name: targetChannel, content: body, mimetype: channels[targetChannel] });
    await (db.crud_write_visibility as PrepMethod).run({ run_id: runId, entry_id: entryId, channel: targetChannel });

    if (Array.isArray(statement.signal)) {
        for (const tag of statement.signal) {
            await (db.crud_write_tag as PrepMethod).run({ entry_id: entryId, tag });
        }
    }

    return { status: createdNow ? 201 : 200, entryId, channel: targetChannel };
};

export const readSessionEntry = async (statement: ReadStatement, ctx: PlurnkSchemeContext, manifest: SchemeManifest): Promise<ReadResult> => {
    if (statement.target === null) return { status: 400, content: null, mimetype: null, channel: null };
    if (statement.lineMarker !== null) return { status: 501, content: null, mimetype: null, channel: null };
    if (statement.body !== null) return { status: 501, content: null, mimetype: null, channel: null };
    if (Array.isArray(statement.signal) && statement.signal.length > 0) return { status: 501, content: null, mimetype: null, channel: null };

    const { db, sessionId } = ctx;
    const { name: scheme, channels, defaultChannel } = manifest;

    const fragment = fragmentOf(statement);
    const targetChannel = resolveChannel(fragment, channels, defaultChannel);
    if (targetChannel === null) return { status: 400, content: null, mimetype: null, channel: null };

    const pathname = pathnameOf(statement);
    const row = await (db.ops_read_channel as PrepMethod).get<{ content: string; mimetype: string }>({
        session_id: sessionId, scheme, pathname, channel: targetChannel,
    });

    if (row === undefined) return { status: 404, content: null, mimetype: null, channel: targetChannel };
    return { status: 200, content: row.content, mimetype: row.mimetype, channel: targetChannel };
};

const setSessionEntryVisibility = async (
    statement: ShowStatement | HideStatement,
    ctx: PlurnkSchemeContext,
    manifest: SchemeManifest,
    target: 0 | 1,
): Promise<ShowHideResult> => {
    if (statement.target === null) return { status: 400 };
    if (statement.lineMarker !== null) return { status: 501 };
    if (statement.body !== null) return { status: 501 };
    if (Array.isArray(statement.signal) && statement.signal.length > 0) return { status: 501 };

    const { db, sessionId, runId } = ctx;
    const { name: scheme, channels, defaultChannel } = manifest;

    const fragment = fragmentOf(statement);
    const pathname = pathnameOf(statement);
    const entry = await (db.crud_find_session_entry as PrepMethod).get<{ id: number }>({ session_id: sessionId, scheme, pathname });
    if (entry === undefined) return { status: 404 };

    const upsertVis = db.ops_upsert_visibility as PrepMethod;

    if (fragment === null) {
        // Fragment-less SHOW/HIDE — flip every channel of the entry.
        const existing = await (db.ops_list_visibility_for_entry as PrepMethod).all<{ channel: string; indexed: number }>({
            run_id: runId, entry_id: entry.id,
        });
        const existingByName = new Map(existing.map((r) => [r.channel, r.indexed]));

        let changed = 0;
        for (const channelName of Object.keys(channels)) {
            if (existingByName.get(channelName) === target) continue;
            await upsertVis.run({ run_id: runId, entry_id: entry.id, channel: channelName, indexed: target });
            changed += 1;
        }
        return { status: changed === 0 ? 304 : 200 };
    }

    // Fragment-targeted SHOW/HIDE — flip only that channel.
    const targetChannel = resolveChannel(fragment, channels, defaultChannel);
    if (targetChannel === null) return { status: 400 };

    const current = await (db.ops_get_visibility_for_channel as PrepMethod).get<{ indexed: number }>({
        run_id: runId, entry_id: entry.id, channel: targetChannel,
    });
    if (current?.indexed === target) return { status: 304 };

    await upsertVis.run({ run_id: runId, entry_id: entry.id, channel: targetChannel, indexed: target });
    return { status: 200 };
};

export const showSessionEntry = async (statement: ShowStatement | HideStatement, ctx: PlurnkSchemeContext, manifest: SchemeManifest): Promise<ShowHideResult> =>
    setSessionEntryVisibility(statement, ctx, manifest, 1);

export const hideSessionEntry = async (statement: ShowStatement | HideStatement, ctx: PlurnkSchemeContext, manifest: SchemeManifest): Promise<ShowHideResult> =>
    setSessionEntryVisibility(statement, ctx, manifest, 0);
