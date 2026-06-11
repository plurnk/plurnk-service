import type { EditStatement, ReadStatement } from "@plurnk/plurnk-grammar";
import type { PrepMethod } from "../core/Db.ts";
import type { PlurnkSchemeContext, SchemeManifest } from "../core/scheme-types.ts";
import { LineMarkerOps, MimetypeBinary, PathMimetype, ReadResolve, editedSpan } from "../content/index.ts";

// Shared static-method helpers for session-scope entry-bearing schemes
// (Known, Unknown, Skill). Each scheme passes its manifest; helpers
// extract scheme name + channels + defaultChannel. Channel routing
// follows SPEC §5.5: path.fragment ?? manifest.defaultChannel.

// The model sees its EDIT's RESULT — the edited area as it looks now,
// line-numbered with a couple lines of context (§14.6) — rendered from the
// `span` computed here and carried on rx. Post-edit state inline, no
// confirming READ; the same rendering serves system delta-EDITs (§14.5).
// Supersedes the prior input-echo of the source statement.
export type EditResult = { status: number; entryId: number | null; channel: string | null; span?: string | null };
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
export type OpenFoldResult = { status: number };

export default class EntryOps {
    static #pathnameOf(statement: { target: EditStatement["target"] }): string {
        const t = statement.target;
        if (t === null) throw new Error("unreachable");
        if (t.kind === "url") return t.pathname;
        return t.raw;
    }

    static #fragmentOf(statement: { target: EditStatement["target"] }): string | null {
        const t = statement.target;
        if (t === null || t.kind !== "url") return null;
        return t.fragment;
    }

    static #resolveChannel(fragment: string | null, channels: Record<string, string>, defaultChannel: string): string | null {
        const target = fragment ?? defaultChannel;
        if (!(target in channels)) return null;
        return target;
    }

    static async editSessionEntry(statement: EditStatement, ctx: PlurnkSchemeContext, manifest: SchemeManifest): Promise<EditResult> {
        if (statement.target === null) return { status: 400, entryId: null, channel: null };

        const { db, sessionId } = ctx;
        const { name: scheme, channels, defaultChannel } = manifest;

        const fragment = EntryOps.#fragmentOf(statement);
        const targetChannel = EntryOps.#resolveChannel(fragment, channels, defaultChannel);
        if (targetChannel === null) return { status: 400, entryId: null, channel: null };

        const pathname = EntryOps.#pathnameOf(statement);
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
        // identical content and no new tag. Mirrors OPEN/FOLD's 304 on no-op; hands the
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

        // §14.5 — reconcile this run's watermark to the just-written content, so the
        // build-time delta detector doesn't re-report the model's own edit (it's
        // already on the log via §14.6's EDIT row).
        if (ctx.runId !== undefined) {
            await (db.engine_set_watermark as PrepMethod).run({ run_id: ctx.runId, entry_id: entryId, channel: targetChannel, content: newContent });
        }

        if (Array.isArray(statement.signal)) {
            for (const tag of statement.signal) {
                await (db.crud_write_tag as PrepMethod).run({ entry_id: entryId, tag });
            }
        }

        return { status: createdNow ? 201 : 200, entryId, channel: targetChannel, span: editedSpan(originalContent, newContent) };
    }

    static async readSessionEntry(statement: ReadStatement, ctx: PlurnkSchemeContext, manifest: SchemeManifest): Promise<ReadResult> {
        if (statement.target === null) return { status: 400, content: null, mimetype: null, channel: null };

        const { db, sessionId } = ctx;
        const { name: scheme, channels, defaultChannel } = manifest;

        const fragment = EntryOps.#fragmentOf(statement);
        const targetChannel = EntryOps.#resolveChannel(fragment, channels, defaultChannel);
        if (targetChannel === null) return { status: 400, content: null, mimetype: null, channel: null };

        const pathname = EntryOps.#pathnameOf(statement);
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

        const r = await ReadResolve.resolve({
            content: row.content,
            mimetype: row.mimetype,
            lineMarker: statement.lineMarker,
            body: statement.body,
            mimetypes: ctx.mimetypes,
        });
        return { ...r, channel: targetChannel };
    }
}
