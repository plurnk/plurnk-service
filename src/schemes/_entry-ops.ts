import type { EditStatement, ReadStatement } from "@plurnk/plurnk-grammar";
import type { Db, PrepMethod } from "../core/Db.ts";
import { decodePathParens } from "../core/path-decode.ts";
import { foldAuthorityIntoPath } from "../core/plurnk-uri.ts";
import type { PlurnkSchemeContext, SchemeManifest } from "../core/scheme-types.ts";
import { LineMarkerOps, MimetypeBinary, PathMimetype, ReadResolve, editedSpan } from "../content/index.ts";

// Shared static-method helpers for session-scope entry-bearing schemes
// (Known, Unknown, Skill). Each scheme passes its manifest; helpers
// extract scheme name + channels + defaultChannel. Channel routing
// follows SPEC §channel-selection: path.fragment ?? manifest.defaultChannel.

// The model sees its EDIT's RESULT — the edited area as it looks now,
// line-numbered with a couple lines of context (§edit-result-render) — rendered from the
// `span` computed here and carried on rx. Post-edit state inline, no
// confirming READ; the same rendering serves system delta-EDITs (§env-delta).
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
        if (t.kind === "regex") return t.raw; // regex source — parens are syntax, never encoded
        // Namespace-as-authority: fold a plurnk://docs/x.md authority back into the storage
        // path (/docs/x.md) so it keys identically to the empty-authority form. #239 item 4
        if (t.kind === "url") return decodePathParens(foldAuthorityIntoPath(t.hostname, t.pathname));
        return decodePathParens(t.raw);
    }

    static #fragmentOf(statement: { target: EditStatement["target"] }): string | null {
        const t = statement.target;
        if (t === null || t.kind !== "url") return null;
        return t.fragment;
    }

    static #resolveChannel(fragment: string | null, channels: Record<string, string>, defaultChannel: string): string | null {
        const target = fragment ?? defaultChannel; // fragment selects the named channel; absent → default — §channel-selection-fragment-selects-named-channel §channel-selection-fragmentless-targets-default-channel
        // The default channel is always valid — dynamic-channel schemes (File:
        // channels={}, mimetype derived per-file) declare none, but their body
        // channel still exists. A non-default fragment must be a declared channel.
        if (target === defaultChannel) return target;
        if (!(target in channels)) return null; // unknown channel name → null → 400 at the caller — §channel-selection-unknown-channel-400
        return target;
    }

    // §run-scheme — pick the scope's CRUD/read statement. A run-scope scheme
    // (manifest.scope === "run", today only run://) keys its entries in the run
    // partition; every other scheme resolves the session statement, byte-identical.
    static #stmt(db: Db, scope: string, base: "crud_find" | "crud_insert" | "ops_read_channel"): PrepMethod {
        const run = { crud_find: "crud_find_run_entry", crud_insert: "crud_insert_run_entry", ops_read_channel: "ops_read_channel_run" } as const;
        const session = { crud_find: "crud_find_session_entry", crud_insert: "crud_insert_session_entry", ops_read_channel: "ops_read_channel" } as const;
        return db[(scope === "run" ? run : session)[base]] as PrepMethod;
    }

    static async editSessionEntry(statement: EditStatement, ctx: PlurnkSchemeContext, manifest: SchemeManifest): Promise<EditResult> {
        if (statement.target === null) return { status: 400, entryId: null, channel: null };

        const { db, sessionId } = ctx;
        const { name: scheme, channels, defaultChannel } = manifest;

        const fragment = EntryOps.#fragmentOf(statement);
        const targetChannel = EntryOps.#resolveChannel(fragment, channels, defaultChannel);
        if (targetChannel === null) return { status: 400, entryId: null, channel: null };

        const pathname = EntryOps.#pathnameOf(statement);
        const existing = await EntryOps.#stmt(db, manifest.scope, "crud_find").get<{ id: number }>({ session_id: sessionId, scheme, pathname });

        // Non-default channel write requires the entry to exist (§channel-selection-fragment-on-nonexistent-404).
        if (existing === undefined && fragment !== null) {
            return { status: 404, entryId: null, channel: targetChannel };
        }

        // Effective mimetype for this entry. Per plurnk-grammar 0.14.0:
        // "Path suffix declares mimetype; absent suffix defers to scheme default."
        // `known:///users.json` → application/json (extension wins).
        // `known:///users`      → text/markdown (scheme manifest default).
        const channelManifestDefault = channels[targetChannel];
        const effectiveMimetype = await PathMimetype.resolveEntryMimetype(pathname, channelManifestDefault, ctx.mimetypes);

        // 415 on binary entries (SPEC.md §op-invariants).
        if (existing !== undefined) {
            const channel = await EntryOps.#stmt(db, manifest.scope, "ops_read_channel").get<{ mimetype: string }>({
                session_id: sessionId, scheme, pathname, channel: targetChannel,
            });
            if (channel !== undefined && MimetypeBinary.isBinaryMimetype(channel.mimetype)) {
                return { status: 415, entryId: existing.id, channel: targetChannel };
            }
        }
        if (MimetypeBinary.isBinaryMimetype(effectiveMimetype)) {
            return { status: 415, entryId: existing?.id ?? null, channel: targetChannel };
        }

        const body = statement.body ?? "";  // null clears — §edit-null-clears

        // Read current content unconditionally for diff generation (M.12 —
        // surface diff in EDIT response so wrong-marker mistakes are visible).
        let originalContent = "";
        if (existing !== undefined) {
            const channel = await EntryOps.#stmt(db, manifest.scope, "ops_read_channel").get<{ content: string }>({
                session_id: sessionId, scheme, pathname, channel: targetChannel,
            });
            originalContent = channel?.content ?? "";
        }

        // `<L>` line marker EDIT semantics. Dispatch on effective mimetype:
        // JSON → LineMarkerOps.applyJsonItemEdit (structural item edit, plurnk-grammar 0.13.0);
        // otherwise → LineMarkerOps.applyLineMarkerEdit (line edit, original semantics).
        // On a non-existent entry, body becomes the content regardless of marker
        // (per "Resolved ambiguities" §scheme — sentinels/positions only apply to
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

        // 304 no-op (SPEC §edit): an existing entry whose write would change nothing —
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
            if (!addsTag) return { status: 304, entryId: existing.id, channel: targetChannel };  // §edit-noop-304
        }

        let entryId: number;
        let createdNow: boolean;
        if (existing === undefined) {
            const row = await EntryOps.#stmt(db, manifest.scope, "crud_insert").get<{ id: number }>({ session_id: sessionId, scheme, pathname });
            if (row === undefined) throw new Error("editSessionEntry: insert returned no row");
            entryId = row.id;
            createdNow = true;
        } else {
            entryId = existing.id;
            createdNow = false;
        }

        if (ctx.tokenize === undefined) throw new Error("editSessionEntry: ctx.tokenize is required for token accounting");
        await (db.ops_upsert_channel as PrepMethod).run({ entry_id: entryId, name: targetChannel, content: newContent, mimetype: effectiveMimetype, tokens: ctx.tokenize(newContent) }); // EDIT writes exactly the one resolved channel — §per-entry-channels-edit-writes-only-body
        // NB: NO @graph derivation here — a scheme write resolves the mimetype
        // label but never invokes the mimetypes handler (§mimetype). The symbol index is
        // built engine-side at manifest-add (EntryManifest.buildManifestBody).

        // Tags apply additively — each signal tag is written, never replacing existing ones. §edit-tags-additive
        if (Array.isArray(statement.signal)) {
            for (const tag of statement.signal) {
                await (db.crud_write_tag as PrepMethod).run({ entry_id: entryId, tag });
            }
        }

        return { status: createdNow ? 201 : 200, entryId, channel: targetChannel, span: editedSpan(originalContent, newContent) };  // §edit-status-201-200
    }

    static async readSessionEntry(statement: ReadStatement, ctx: PlurnkSchemeContext, manifest: SchemeManifest): Promise<ReadResult> {
        if (statement.target === null) return { status: 400, content: null, mimetype: null, channel: null };

        const { db, sessionId } = ctx;
        const { channels, defaultChannel } = manifest;
        // Scope by the manifest's persisted entries.scheme (storedScheme; absent →
        // name). File sets storedScheme=null — its rows persist bare (scheme=NULL).
        const scheme = manifest.storedScheme === undefined ? manifest.name : manifest.storedScheme;

        const fragment = EntryOps.#fragmentOf(statement);
        const targetChannel = EntryOps.#resolveChannel(fragment, channels, defaultChannel);
        if (targetChannel === null) return { status: 400, content: null, mimetype: null, channel: null };

        const pathname = EntryOps.#pathnameOf(statement);
        const row = await EntryOps.#stmt(db, manifest.scope, "ops_read_channel").get<{ content: string; mimetype: string }>({
            session_id: sessionId, scheme, pathname, channel: targetChannel,
        });
        if (row === undefined) return { status: 404, content: null, mimetype: null, channel: targetChannel };  // §read-read-404

        if (MimetypeBinary.isBinaryMimetype(row.mimetype)) {
            return { status: 415, content: null, mimetype: row.mimetype, channel: targetChannel };
        }

        // `[tag]` filter: entry must have ALL requested tags. Mismatch = 404
        // (entry doesn't match the tag-scoped READ).
        if (Array.isArray(statement.signal) && statement.signal.length > 0) {
            const entry = await EntryOps.#stmt(db, manifest.scope, "crud_find").get<{ id: number }>({ session_id: sessionId, scheme, pathname });
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
        return { ...r, channel: targetChannel }; // READ returns the resolved channel's content + mimetype — §read-read-content
    }
}
