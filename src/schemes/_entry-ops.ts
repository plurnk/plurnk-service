import type { EditStatement, HideStatement, ReadStatement, ShowStatement } from "@plurnk/plurnk-grammar";
import type { PrepMethod } from "../core/Db.ts";
import type { PlurnkSchemeContext, SchemeManifest } from "../core/scheme-types.ts";
import { isBinaryMimetype } from "../core/mimetype-binary.ts";
import { sliceLines, applyLineMarkerEdit } from "../core/line-marker.ts";
import { matchAgainstContent } from "../core/matcher.ts";

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

    // 415 on binary entries (per AGENTS.md "Resolved ambiguities" §2). Only
    // applies when entry exists with a known mimetype; new entries use the
    // manifest's channel mimetype, which we control.
    const channelMimetype = channels[targetChannel];
    if (existing !== undefined) {
        const channel = await (db.ops_read_channel as PrepMethod).get<{ mimetype: string }>({
            session_id: sessionId, scheme, pathname, channel: targetChannel,
        });
        if (channel !== undefined && isBinaryMimetype(channel.mimetype)) {
            return { status: 415, entryId: existing.id, channel: targetChannel };
        }
    }
    if (isBinaryMimetype(channelMimetype)) {
        return { status: 415, entryId: existing?.id ?? null, channel: targetChannel };
    }

    const body = statement.body ?? "";

    // `<L>` line marker EDIT semantics (plurnk.md §`<L>`). On a non-existent
    // entry, body becomes the content regardless of marker (per "Resolved
    // ambiguities" §3 — sentinels/positions only apply to existing content).
    let newContent: string;
    if (statement.lineMarker !== null && existing !== undefined) {
        const channel = await (db.ops_read_channel as PrepMethod).get<{ content: string }>({
            session_id: sessionId, scheme, pathname, channel: targetChannel,
        });
        const currentContent = channel?.content ?? "";
        const result = applyLineMarkerEdit(currentContent, statement.lineMarker, body);
        if (result.status !== 200) return { status: result.status, entryId: existing.id, channel: targetChannel };
        newContent = result.result ?? "";
    } else {
        newContent = body;
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

    await (db.ops_upsert_channel as PrepMethod).run({ entry_id: entryId, name: targetChannel, content: newContent, mimetype: channelMimetype });
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
    // <L> and body matcher are orthogonal selectors; combining them is
    // semantically ambiguous (slice-then-match vs match-then-slice not
    // resolved by plurnk.md). Reject.
    if (statement.lineMarker !== null && statement.body !== null) {
        return { status: 400, content: null, mimetype: null, channel: null };
    }

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

    if (isBinaryMimetype(row.mimetype)) {
        return { status: 415, content: null, mimetype: row.mimetype, channel: targetChannel };
    }

    // `[tag]` filter: entry must have ALL requested tags. Mismatch = 404
    // (entry doesn't match the tag-scoped READ).
    if (Array.isArray(statement.signal) && statement.signal.length > 0) {
        const entry = await (db.crud_find_session_entry as PrepMethod).get<{ id: number }>({ session_id: sessionId, scheme, pathname });
        if (entry === undefined) return { status: 404, content: null, mimetype: null, channel: targetChannel };
        const tagRows = await (db.crud_read_tags as PrepMethod).all<{ tag: string }>({ entry_id: entry.id });
        const have = new Set(tagRows.map((r) => r.tag));
        for (const want of statement.signal) {
            if (!have.has(want)) return { status: 404, content: null, mimetype: null, channel: targetChannel };
        }
    }

    if (statement.lineMarker !== null) {
        const sliced = sliceLines(row.content, statement.lineMarker);
        if (sliced.status !== 200) return { status: sliced.status, content: null, mimetype: row.mimetype, channel: targetChannel };
        return { status: 200, content: sliced.text ?? "", mimetype: row.mimetype, channel: targetChannel };
    }

    if (statement.body !== null) {
        const matched = matchAgainstContent(statement.body, row.content, row.mimetype);
        if (matched.status !== 200) return { status: matched.status, content: null, mimetype: row.mimetype, channel: targetChannel };
        return { status: 200, content: (matched.matches ?? []).join("\n"), mimetype: row.mimetype, channel: targetChannel };
    }

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
