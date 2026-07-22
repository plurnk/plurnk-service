import EntrySemantic from "./_entry-semantic.ts";
import EntryCrud from "./_entry-crud.ts";
import type { EditStatement, ReadStatement } from "@plurnk/plurnk-grammar";
import type { Db, PrepMethod } from "../core/Db.ts";
import { decodePathParens } from "../core/path-decode.ts";
import { foldAuthorityIntoPath } from "../core/plurnk-uri.ts";
import type { PlurnkSchemeContext, SchemeManifest } from "../core/scheme-types.ts";
import Owner from "../core/Owner.ts";
import EntryManifest from "./_entry-manifest.ts";
import { LineMarkerOps, MimetypeBinary, PathMimetype, ReadResolve, editedSpan } from "../content/index.ts";

// Shared static-method helpers for workspace-scope entry-bearing schemes
// (Known, Unknown, Skill). Each scheme passes its manifest; helpers
// extract scheme name + channels + defaultChannel. Channel routing
// follows SPEC §channel-selection: path.fragment ?? manifest.defaultChannel.

// The model sees its EDIT's RESULT — the edited area as it looks now,
// line-numbered with a couple lines of context (§edit-result-render) — rendered from the
// `span` computed here and carried on rx. Post-edit state inline, no
// confirming READ; the same rendering serves system delta-EDITs (§env-delta).
// Supersedes the prior input-echo of the source statement.
export type EditResult = { status: number; entryId: number | null; channel: string | null; span?: string | null; error?: string };
// startLine = 1-indexed position the content starts at in the original
// source. Lets the render layer prefix N: correctly for both full
// reads (start=1) and <L> slices (start=N). Null when not line-relevant
// (matcher results, errors).
// matches = count of matcher hits when body matcher was used; null when
// no matcher in the statement. Surfaced in the log meta so the model
// distinguishes "0 matches" from "empty content."
// reason — surfaced on 203 dialect-fallback so the model sees why the
// structured parse failed and got raw content instead.
export type ReadResult = { status: number; content: string | null; mimetype: string | null; channel: string | null; startLine?: number | null; matches?: number | null; reason?: string; error?: string; awaitWorker?: string };
export type OpenFoldResult = { status: number };

export default class EntryOps {
    static #pathnameOf(statement: { target: EditStatement["target"] }): string {
        const t = statement.target;
        if (t === null) throw new Error("unreachable");
        if (t.kind === "regex") return t.raw; // regex source — parens are syntax, never encoded
        // Namespace-as-authority: fold a plurnk://docs/x.md authority back into the storage
        // path (/docs/x.md) so it keys identically to the empty-authority form. #239 item 4
        // ({§stream-owner-scoped} streams never reach this fold: their face resolves the authority
        // to the owner and hands the statement over authority-stripped.)
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

    // §channel-selection-unknown-channel-400 — the 400 carries its fact: the tried fragment and
    // the declared universe, so one miss teaches the topology instead of forcing a guessing walk
    // (run-sweep: a model probed #stdout/#stderr/#body against a results-channel search stream,
    // each miss a bare 400 that taught nothing).
    static #channelMissFact(fragment: string | null, scheme: string, pathname: string, channels: Record<string, string>, defaultChannel: string): string {
        const declared = [...new Set([defaultChannel, ...Object.keys(channels)])].filter((c) => c.length > 0);
        return `no channel #${fragment} at ${EntryManifest.toPath(scheme, pathname)}; channels: ${declared.join(", ")}`;
    }

    // {§entry-owner} — the entry's owner for this call: an owner-carved face (worker://, the
    // capability streams) resolves its authority itself (empty/~/name per its carving) and passes
    // the result explicitly; everything else is the workspace commons.
    static async #ownerOf(explicit: number | undefined, ctx: PlurnkSchemeContext): Promise<number> {
        if (explicit !== undefined) return explicit;
        return Owner.commonsId(ctx.db, ctx.workspaceId);
    }

    static async editWorkspaceEntry(statement: EditStatement, ctx: PlurnkSchemeContext, manifest: SchemeManifest, explicitOwnerId?: number): Promise<EditResult> {
        if (statement.target === null) return { status: 400, entryId: null, channel: null };

        const { db, workspaceId } = ctx;
        const { name: scheme, channels, defaultChannel } = manifest;

        const fragment = EntryOps.#fragmentOf(statement);
        const pathname = EntryOps.#pathnameOf(statement);
        const targetChannel = EntryOps.#resolveChannel(fragment, channels, defaultChannel);
        if (targetChannel === null) return { status: 400, entryId: null, channel: null, error: EntryOps.#channelMissFact(fragment, scheme, pathname, channels, defaultChannel) };

        const ownerId = await EntryOps.#ownerOf(explicitOwnerId, ctx);
        const existing = await (db.crud_find_workspace_entry as PrepMethod).get<{ id: number }>({ workspace_id: workspaceId, owner_id: ownerId, scheme, pathname });

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
            const channel = await (db.ops_read_channel as PrepMethod).get<{ mimetype: string }>({ ...{ workspace_id: workspaceId, scheme, pathname, channel: targetChannel }, owner_id: ownerId });
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
            const channel = await (db.ops_read_channel as PrepMethod).get<{ content: string }>({ ...{ workspace_id: workspaceId, scheme, pathname, channel: targetChannel }, owner_id: ownerId });
            originalContent = channel?.content ?? "";
        }

        // `<L>` line marker EDIT semantics. Dispatch on effective mimetype:
        // JSON → LineMarkerOps.applyJsonItemEdit (structural item edit, plurnk-grammar 0.13.0);
        // otherwise → LineMarkerOps.applyLineMarkerEdit (line edit, original semantics).
        // A CREATE (no existing entry) has nothing to scope into, so a markerless body
        // becomes the new entry's content. {§edit-marker-required-on-existing} (#571) — an
        // EXISTING entry has no easy-clobber path: a marker is REQUIRED, even for a
        // deliberate full rewrite (`<1,-1>` states that intent explicitly).
        let newContent: string;
        if (existing !== undefined && statement.lineMarker === null) {
            return { status: 400, entryId: existing.id, channel: targetChannel, error: "EDIT of an existing entry requires a line marker — use <1,-1> to replace the whole entry deliberately" };
        }
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
            const row = await (db.crud_insert_workspace_entry as PrepMethod).get<{ id: number }>({ workspace_id: workspaceId, owner_id: ownerId, scheme, pathname });
            if (row === undefined) throw new Error("editWorkspaceEntry: insert returned no row");
            entryId = row.id;
            createdNow = true;
        } else {
            entryId = existing.id;
            createdNow = false;
        }

        if (ctx.tokenize === undefined) throw new Error("editWorkspaceEntry: ctx.tokenize is required for token accounting");
        await (db.ops_upsert_channel as PrepMethod).run({ entry_id: entryId, name: targetChannel, content: newContent, mimetype: effectiveMimetype, tokens: ctx.tokenize(newContent) }); // EDIT writes exactly the one resolved channel — §per-entry-channels-edit-writes-only-body
        // §semantic-fts-at-write — the keyword half indexes with the write (body channel only).
        if (targetChannel === "body") await EntrySemantic.indexFts(db, entryId, newContent);
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

    // Scope-aware entry delete — the KILL counterpart of editWorkspaceEntry. Resolves the
    // entry via the scope's crud_find variant (so a worker-scope row is found, not just
    // workspace), then deletes by id (channels/tags CASCADE). 404 when the entry is absent.
    static async deleteWorkspaceEntry(statement: { target: EditStatement["target"] }, ctx: PlurnkSchemeContext, manifest: SchemeManifest, explicitOwnerId?: number): Promise<{ status: number }> {
        if (statement.target === null) return { status: 400 };
        const { db, workspaceId } = ctx;
        const pathname = EntryOps.#pathnameOf(statement);
        const ownerId = await EntryOps.#ownerOf(explicitOwnerId, ctx);
        const existing = await (db.crud_find_workspace_entry as PrepMethod).get<{ id: number }>({ workspace_id: workspaceId, owner_id: ownerId, scheme: manifest.name, pathname });
        if (existing === undefined) return { status: 404 };
        await (db.crud_delete_entry as PrepMethod).run({ entry_id: existing.id });
        return { status: 200 };
    }

    static async readWorkspaceEntry(statement: ReadStatement, ctx: PlurnkSchemeContext, manifest: SchemeManifest, explicitOwnerId?: number): Promise<ReadResult> {
        if (statement.target === null) return { status: 400, content: null, mimetype: null, channel: null };

        const { db, workspaceId } = ctx;
        const { channels, defaultChannel } = manifest;
        // Scope by the manifest's persisted entries.scheme (storedScheme; absent →
        // name). File persists under the reserved 'file' scheme ({§entry-identity-no-null}).
        const scheme = EntryCrud.identityScheme(manifest);

        const fragment = EntryOps.#fragmentOf(statement);
        const pathname = EntryOps.#pathnameOf(statement);
        const targetChannel = EntryOps.#resolveChannel(fragment, channels, defaultChannel);
        if (targetChannel === null) return { status: 400, content: null, mimetype: null, channel: null, error: EntryOps.#channelMissFact(fragment, scheme, pathname, channels, defaultChannel) };

        const ownerId = await EntryOps.#ownerOf(explicitOwnerId, ctx);
        // An xpath is a question about the DOM — a fragmentless xpath READ routes to the raw `html`
        // channel (the archive the decisive markdown body was projected from). A fragment still wins.
        let readChannel = targetChannel;
        if (fragment === null && statement.body !== null && statement.body.dialect === "xpath") {
            const html = await (db.ops_read_channel as PrepMethod).get<{ content: string }>({ ...{ workspace_id: workspaceId, scheme, pathname, channel: "html" }, owner_id: ownerId });
            if (html !== undefined) readChannel = "html";
        }
        const row = await (db.ops_read_channel as PrepMethod).get<{ content: string; mimetype: string }>({ ...{ workspace_id: workspaceId, scheme, pathname, channel: readChannel }, owner_id: ownerId });
        // §read-read-404 + {§fs-errno} — ENOENT carries its fact, the RESOLVED name in wire
        // canon: the model distinguishes wrong-address from wrong-range by the strings alone.
        if (row === undefined) return { status: 404, content: null, mimetype: null, channel: targetChannel, error: `no entry at ${EntryManifest.toPath(scheme, pathname)}` };

        if (MimetypeBinary.isBinaryMimetype(row.mimetype)) {
            return { status: 415, content: null, mimetype: row.mimetype, channel: targetChannel };
        }

        // `[tag]` filter: entry must have ALL requested tags. Mismatch = 404
        // (entry doesn't match the tag-scoped READ).
        if (Array.isArray(statement.signal) && statement.signal.length > 0) {
            const entry = await (db.crud_find_workspace_entry as PrepMethod).get<{ id: number }>({ workspace_id: workspaceId, owner_id: ownerId, scheme, pathname });
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
        return { ...r, channel: readChannel }; // READ returns the resolved channel's content + mimetype — §read-read-content
    }
}
