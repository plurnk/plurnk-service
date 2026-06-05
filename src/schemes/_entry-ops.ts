import type { EditStatement, HideStatement, ReadStatement, ShowStatement } from "@plurnk/plurnk-grammar";
import type { PrepMethod } from "../core/Db.ts";
import type { PlurnkSchemeContext, SchemeManifest } from "../core/scheme-types.ts";
import { LineMarkerOps, Matcher, MimetypeBinary, PathMimetype } from "../content/index.ts";

// Shared free functions for session-scope entry-bearing schemes
// (Known, Unknown, Skill). Each scheme passes its manifest; helpers
// extract scheme name + channels + defaultChannel. Channel routing
// follows SPEC §5.5: path.fragment ?? manifest.defaultChannel.

// The model sees its EDIT echoed back as heredoc form via packet-wire's
// log render (which re-emits the source EditStatement from log_entries.tx),
// not via a rx-side diff. Same syntax both directions — the most honest
// signal for the model to reason about its own state changes.
export type EditResult = { status: number; entryId: number | null; channel: string | null };
// startLine = 1-indexed position the content starts at in the original
// source. Lets the render layer prefix N:\t correctly for both full
// reads (start=1) and <L> slices (start=N). Null when not line-relevant
// (matcher results, errors).
// matches = count of matcher hits when body matcher was used; null when
// no matcher in the statement. Surfaced in the log meta so the model
// distinguishes "0 matches" from "empty content."
// reason — surfaced on 203 dialect-fallback so the model sees why the
// structured parse failed and got raw content instead.
export type ReadResult = { status: number; content: string | null; mimetype: string | null; channel: string | null; startLine?: number | null; matches?: number | null; reason?: string };
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

    // Effective mimetype for this entry. Per plurnk-grammar 0.14.0:
    // "Path suffix declares mimetype; absent suffix defers to scheme default."
    // `known://users.json` → application/json (extension wins).
    // `known://users`      → text/markdown (scheme manifest default).
    const channelManifestDefault = channels[targetChannel];
    const effectiveMimetype = await PathMimetype.resolveEntryMimetype(pathname, channelManifestDefault, ctx.mimetypes);

    // 415 on binary entries (SPEC.md §16.9).
    if (existing !== undefined) {
        const channel = await (db.ops_read_channel as PrepMethod).get<{ mimetype: string }>({
            session_id: sessionId, scheme, pathname, channel: targetChannel,
        });
        if (channel !== undefined && MimetypeBinary.isBinaryMimetype(channel.mimetype)) {
            return { status: 415, entryId: existing.id, channel: targetChannel };
        }
    }
    if (MimetypeBinary.isBinaryMimetype(effectiveMimetype)) {
        return { status: 415, entryId: existing?.id ?? null, channel: targetChannel };
    }

    const body = statement.body ?? "";

    // Read current content unconditionally for diff generation (M.12 —
    // surface diff in EDIT response so wrong-marker mistakes are visible).
    let originalContent = "";
    if (existing !== undefined) {
        const channel = await (db.ops_read_channel as PrepMethod).get<{ content: string }>({
            session_id: sessionId, scheme, pathname, channel: targetChannel,
        });
        originalContent = channel?.content ?? "";
    }

    // `<L>` line marker EDIT semantics. Dispatch on effective mimetype:
    // JSON → LineMarkerOps.applyJsonItemEdit (structural item edit, plurnk-grammar 0.13.0);
    // otherwise → LineMarkerOps.applyLineMarkerEdit (line edit, original semantics).
    // On a non-existent entry, body becomes the content regardless of marker
    // (per "Resolved ambiguities" §3 — sentinels/positions only apply to
    // existing content).
    let newContent: string;
    if (statement.lineMarker !== null && existing !== undefined) {
        const result = MimetypeBinary.isJsonMimetype(effectiveMimetype)
            ? LineMarkerOps.applyJsonItemEdit(originalContent, statement.lineMarker, body)
            : LineMarkerOps.applyLineMarkerEdit(originalContent, statement.lineMarker, body);
        if (result.status !== 200) return { status: result.status, entryId: existing.id, channel: targetChannel };
        newContent = result.result ?? "";
    } else {
        newContent = body;
    }

    // 304 no-op (SPEC §6.1): an existing entry whose write would change nothing —
    // identical content and no new tag. Mirrors SHOW/HIDE's 304 on no-op; hands the
    // model a "you already did this" signal instead of a phantom 200 it can't
    // distinguish from a real update.
    if (existing !== undefined && newContent === originalContent) {
        const signalTags = Array.isArray(statement.signal) ? statement.signal : [];
        let addsTag = false;
        if (signalTags.length > 0) {
            const have = new Set(
                (await (db.crud_read_tags as PrepMethod).all<{ tag: string }>({ entry_id: existing.id })).map((r) => r.tag),
            );
            addsTag = signalTags.some((t) => !have.has(t));
        }
        if (!addsTag) return { status: 304, entryId: existing.id, channel: targetChannel };
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

    if (ctx.tokenize === undefined) throw new Error("editSessionEntry: ctx.tokenize is required for token accounting");
    await (db.ops_upsert_channel as PrepMethod).run({ entry_id: entryId, name: targetChannel, content: newContent, mimetype: effectiveMimetype, tokens: ctx.tokenize(newContent) });
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

    if (MimetypeBinary.isBinaryMimetype(row.mimetype)) {
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

    // `<L>` scopes; body matches within the scope. Slot order in plurnk.md
    // is `<L>?:body?`, so the natural composition is slice-then-match.
    // `<L>` dispatches on source mimetype (plurnk-grammar 0.13.0):
    //   line-navigable (text/markdown, source) → LineMarkerOps.sliceLines (line index)
    //   JSON                                   → LineMarkerOps.sliceJsonItems (item index)
    //   XML/HTML                               → LineMarkerOps.sliceLines (defer XML structural)
    let workingContent = row.content;
    let workingStart: number | null = 1;
    let workingMimetypeForSlice = MimetypeBinary.TEXT_PRIMITIVE_MIMETYPE;
    if (statement.lineMarker !== null) {
        if (MimetypeBinary.isJsonMimetype(row.mimetype)) {
            const sliced = LineMarkerOps.sliceJsonItems(row.content, statement.lineMarker);
            if (sliced.status !== 200) return { status: sliced.status, content: null, mimetype: row.mimetype, channel: targetChannel };
            workingContent = sliced.body ?? "[]";
            workingStart = null;
            workingMimetypeForSlice = "application/json";
        } else {
            const sliced = LineMarkerOps.sliceLines(row.content, statement.lineMarker);
            if (sliced.status !== 200) return { status: sliced.status, content: null, mimetype: row.mimetype, channel: targetChannel };
            workingContent = sliced.text ?? "";
            workingStart = sliced.startLine ?? null;
        }
    }

    if (statement.body !== null) {
        if (ctx.mimetypes === undefined) {
            return { status: 500, content: null, mimetype: row.mimetype, channel: targetChannel };
        }
        const matched = await Matcher.matchAgainstContent(statement.body, workingContent, row.mimetype, ctx.mimetypes, workingStart ?? 1);
        if (matched.status === 204) {
            return { status: 204, content: "", mimetype: "text/markdown", channel: targetChannel, startLine: null, matches: 0 };
        }
        if (matched.status === 203) {
            // Dialect-parse-failure fallback: raw source as text/markdown,
            // reason field surfaces why the structured parse failed.
            return { status: 203, content: matched.body ?? "", mimetype: matched.mimetype ?? "text/markdown", channel: targetChannel, startLine: 1, reason: matched.reason };
        }
        if (matched.status !== 200) return { status: matched.status, content: null, mimetype: row.mimetype, channel: targetChannel };
        return { status: 200, content: matched.body ?? "", mimetype: "text/markdown", channel: targetChannel, startLine: null, matches: matched.matches };
    }

    if (statement.lineMarker !== null) {
        // `<L>` slice mimetype follows the source family:
        //   line-navigable source → text/markdown (text primitive)
        //   JSON source           → application/json (preserve structure for compose)
        // Workspace `<L>` empty case (sentinel <0>/<-1>) is 204.
        // For JSON sources LineMarkerOps.sliceJsonItems returns body="[]" on sentinels;
        // we treat empty array as 204 here for shape consistency.
        const isEmptyJsonArray = workingMimetypeForSlice === "application/json" && workingContent === "[]";
        if (workingContent === "" || isEmptyJsonArray) {
            return { status: 204, content: "", mimetype: workingMimetypeForSlice, channel: targetChannel, startLine: null };
        }
        return { status: 200, content: workingContent, mimetype: workingMimetypeForSlice, channel: targetChannel, startLine: workingStart };
    }

    if (row.content === "") {
        return { status: 204, content: "", mimetype: row.mimetype, channel: targetChannel, startLine: null };
    }
    return { status: 200, content: row.content, mimetype: row.mimetype, channel: targetChannel, startLine: 1 };
};

// Paginate a list of items per a `<L>` results marker. Sentinels <0> and
// <-1> select empty (insertion points have no result content).
const paginateResults = <T>(items: T[], marker: { first: number; last: number | null }): { status: number; items?: T[] } => {
    const total = items.length;
    const { first, last } = marker;
    if (last === null) {
        if (first === 0 || first === -1) return { status: 200, items: [] };
        if (first > 0 && first <= total) return { status: 200, items: [items[first - 1]] };
        return { status: 416 };
    }
    let n = first;
    let m = last;
    if (n === 0) n = 1;
    if (m === -1) m = total;
    if (n < 1 || n > total) return { status: 416 };
    if (m < 1 || m > total) return { status: 416 };
    if (n > m) return { status: 416 };
    return { status: 200, items: items.slice(n - 1, m) };
};

const setSessionEntryVisibility = async (
    statement: ShowStatement | HideStatement,
    ctx: PlurnkSchemeContext,
    manifest: SchemeManifest,
    target: 0 | 1,
): Promise<ShowHideResult> => {
    if (statement.target === null) return { status: 400 };

    const { db, sessionId, runId } = ctx;
    const { name: scheme, channels, defaultChannel } = manifest;

    const fragment = fragmentOf(statement);
    const isMultiEntry = statement.body !== null
        || (Array.isArray(statement.signal) && statement.signal.length > 0)
        || statement.lineMarker !== null;

    if (!isMultiEntry) {
        // Single-entry path: exact pathname lookup.
        const pathname = pathnameOf(statement);
        const entry = await (db.crud_find_session_entry as PrepMethod).get<{ id: number }>({ session_id: sessionId, scheme, pathname });
        if (entry === undefined) return { status: 404 };

        const upsertVis = db.ops_upsert_visibility as PrepMethod;
        if (fragment === null) {
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
        const targetChannel = resolveChannel(fragment, channels, defaultChannel);
        if (targetChannel === null) return { status: 400 };
        const current = await (db.ops_get_visibility_for_channel as PrepMethod).get<{ indexed: number }>({
            run_id: runId, entry_id: entry.id, channel: targetChannel,
        });
        if (current?.indexed === target) return { status: 304 };
        await upsertVis.run({ run_id: runId, entry_id: entry.id, channel: targetChannel, indexed: target });
        return { status: 200 };
    }

    // Multi-entry path: target is treated as a pathname GLOB scope. Body
    // matcher (glob/regex) further filters by pathname; xpath/jsonpath
    // would filter by content (501 pending plurnk-mimetypes#3). Tag
    // signal filters by tag. <L> paginates the matched results.
    let regexFilter: RegExp | null = null;
    let pathnameGlob: string | null = null;
    if (statement.body !== null) {
        if (statement.body.dialect === "glob") {
            pathnameGlob = statement.body.raw;
        } else if (statement.body.dialect === "regex") {
            try { regexFilter = new RegExp(statement.body.pattern, statement.body.flags); }
            catch { return { status: 400 }; }
        } else {
            return { status: 501 };
        }
    }
    const scopePathname = pathnameOf(statement);
    const scopeGlob = scopePathname.length > 0 ? `${scopePathname}*` : null;
    const tags = Array.isArray(statement.signal) ? statement.signal : [];
    const tagsParam = tags.length > 0 ? JSON.stringify(tags) : "[]";

    const rows = await (db.find_session_entries as PrepMethod).all<{ pathname: string }>({
        session_id: sessionId, scheme,
        scope_pathname: scopeGlob,
        pathname_pattern: pathnameGlob,
        tags: tagsParam,
    });
    let pathnames = rows.map((r) => r.pathname);
    if (regexFilter !== null) pathnames = pathnames.filter((p) => regexFilter.test(p));

    if (statement.lineMarker !== null) {
        const page = paginateResults(pathnames, statement.lineMarker);
        if (page.status !== 200) return { status: page.status };
        pathnames = page.items ?? [];
    }
    if (pathnames.length === 0) return { status: 304 };

    // Resolve fragment to a target channel (applies uniformly across matches).
    let scopeChannel: string | null = null;
    if (fragment !== null) {
        scopeChannel = resolveChannel(fragment, channels, defaultChannel);
        if (scopeChannel === null) return { status: 400 };
    }
    const upsertVis = db.ops_upsert_visibility as PrepMethod;
    let changed = 0;
    for (const p of pathnames) {
        const e = await (db.crud_find_session_entry as PrepMethod).get<{ id: number }>({ session_id: sessionId, scheme, pathname: p });
        if (e === undefined) continue;
        const channelsToFlip = scopeChannel !== null ? [scopeChannel] : Object.keys(channels);
        for (const channelName of channelsToFlip) {
            const current = await (db.ops_get_visibility_for_channel as PrepMethod).get<{ indexed: number }>({
                run_id: runId, entry_id: e.id, channel: channelName,
            });
            if (current?.indexed === target) continue;
            await upsertVis.run({ run_id: runId, entry_id: e.id, channel: channelName, indexed: target });
            changed += 1;
        }
    }
    return { status: changed === 0 ? 304 : 200 };
};

export const showSessionEntry = async (statement: ShowStatement | HideStatement, ctx: PlurnkSchemeContext, manifest: SchemeManifest): Promise<ShowHideResult> =>
    setSessionEntryVisibility(statement, ctx, manifest, 1);

export const hideSessionEntry = async (statement: ShowStatement | HideStatement, ctx: PlurnkSchemeContext, manifest: SchemeManifest): Promise<ShowHideResult> =>
    setSessionEntryVisibility(statement, ctx, manifest, 0);
