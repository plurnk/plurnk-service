import EntrySemantic from "./_entry-semantic.ts";
import EntryCrud from "./_entry-crud.ts";
import type { EditStatement, ReadStatement } from "@plurnk/plurnk-grammar";
import type { Db } from "../core/Db.ts";
import { decodePathParens } from "../core/path-decode.ts";
import { foldAuthorityIntoPath } from "../core/plurnk-uri.ts";
import type { PlurnkSchemeContext, SchemeManifest } from "../core/scheme-types.ts";
import Owner from "../core/Owner.ts";
import EntryManifest from "./_entry-manifest.ts";
import { LineMarkerOps, MimetypeBinary, PathMimetype, ReadResolve, editReceipt, editReceiptUnit } from "../content/index.ts";
import type { EditBatchReceipt } from "../content/index.ts";
import Results, { type SchemeResultBase } from "../core/results.ts";

// Shared static-method helpers for workspace-scope entry-bearing schemes
// (Known, Unknown, Skill). Each scheme passes its manifest; helpers
// extract scheme name + channels + defaultChannel. Channel routing
// follows SPEC §channel-selection: path.fragment ?? manifest.defaultChannel.

// The model sees an EDIT effect receipt: revision identity, extent changes,
// source→result range mappings, and bounded join context (§edit-result-render).
export type EditResult = SchemeResultBase & { entryId: number | null; channel: string | null; editReceipt?: EditBatchReceipt | null };
// startLine = 1-indexed position the content starts at in the original
// source. Lets the render layer prefix N: correctly for both full
// reads (start=1) and <L> slices (start=N). Null when not line-relevant
// (matcher results, errors).
// matches = count of matcher hits when body matcher was used; null when
// no matcher in the statement. Surfaced in the log meta so the model
// distinguishes "0 matches" from "empty content."
// reason — surfaced on 203 dialect-fallback so the model sees why the
// structured parse failed and got raw content instead.
export type ReadResult = SchemeResultBase & { content: string | null; mimetype: string | null; channel: string | null; startLine?: number | null; matches?: number | null; reason?: string; awaitWorker?: string };
export type OpenFoldResult = SchemeResultBase;

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

    static async editWorkspaceEntryBatch(statements: readonly EditStatement[], ctx: PlurnkSchemeContext, manifest: SchemeManifest, explicitOwnerId?: number): Promise<EditResult> {
        const failure = (
            code: string,
            status: number,
            detail: string,
            fields: Readonly<Record<string, unknown>>,
        ): EditResult => Results.failure(`scheme:${manifest.name}`, code, status, detail, fields) as EditResult;
        const statement = statements[0];
        if (statement === undefined) return failure("edit-empty", 400, "EDIT batch is empty.", { entryId: null, channel: null });
        if (statement.target === null) return failure("edit-target-required", 400, "EDIT requires a target path.", { entryId: null, channel: null });

        const { db, workspaceId } = ctx;
        const { name: scheme, channels, defaultChannel } = manifest;

        const fragment = EntryOps.#fragmentOf(statement);
        const pathname = EntryOps.#pathnameOf(statement);
        const targetChannel = EntryOps.#resolveChannel(fragment, channels, defaultChannel);
        if (targetChannel === null) return failure("channel-not-found", 400, EntryOps.#channelMissFact(fragment, scheme, pathname, channels, defaultChannel), { entryId: null, channel: null });
        for (const candidate of statements.slice(1)) {
            if (candidate.target === null
                || EntryOps.#pathnameOf(candidate) !== pathname
                || EntryOps.#fragmentOf(candidate) !== fragment) {
                return failure("edit-batch-mismatch", 400, "EDIT batch spans multiple resources or channels.", { entryId: null, channel: targetChannel });
            }
        }

        const ownerId = await EntryOps.#ownerOf(explicitOwnerId, ctx);
        const existing = await db.crud_find_workspace_entry.get<{ id: number }>({ workspace_id: workspaceId, owner_id: ownerId, scheme, pathname });

        // Non-default channel write requires the entry to exist (§channel-selection-fragment-on-nonexistent-404).
        if (existing === undefined && fragment !== null) {
            return failure("entry-not-found", 404, `No entry exists at ${EntryManifest.toPath(scheme, pathname)}.`, { entryId: null, channel: targetChannel });
        }

        // Effective mimetype for this entry. Per plurnk-grammar 0.14.0:
        // "Path suffix declares mimetype; absent suffix defers to scheme default."
        // `known:///users.json` → application/json (extension wins).
        // `known:///users`      → text/markdown (scheme manifest default).
        const channelManifestDefault = channels[targetChannel];
        const effectiveMimetype = await PathMimetype.resolveEntryMimetype(pathname, channelManifestDefault, ctx.mimetypes);

        // 415 on binary entries (SPEC.md §op-invariants).
        if (existing !== undefined) {
            const channel = await db.ops_read_channel.get<{ mimetype: string }>({ ...{ workspace_id: workspaceId, scheme, pathname, channel: targetChannel }, owner_id: ownerId });
            if (channel !== undefined && MimetypeBinary.isBinaryMimetype(channel.mimetype)) {
                return failure("binary-edit-unsupported", 415, `The #${targetChannel} channel is binary and cannot be edited.`, { entryId: existing.id, channel: targetChannel });
            }
        }
        if (MimetypeBinary.isBinaryMimetype(effectiveMimetype)) {
            return failure("binary-edit-unsupported", 415, `The #${targetChannel} channel is binary and cannot be edited.`, { entryId: existing?.id ?? null, channel: targetChannel });
        }

        // Read current content unconditionally for diff generation (M.12 —
        // surface diff in EDIT response so wrong-marker mistakes are visible).
        let originalContent = "";
        if (existing !== undefined) {
            const channel = await db.ops_read_channel.get<{ content: string }>({ ...{ workspace_id: workspaceId, scheme, pathname, channel: targetChannel }, owner_id: ownerId });
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
        if (existing !== undefined && statements.some(({ lineMarker }) => lineMarker === null)) {
            return failure("line-marker-required", 400, "EDIT of an existing entry requires a line marker — use <1,-1> to replace the whole entry deliberately.", { entryId: existing.id, channel: targetChannel });
        }
        if (existing !== undefined) {
            const edits = statements.map((candidate) => ({
                marker: candidate.lineMarker!,
                body: candidate.body ?? "",
            }));
            const result = MimetypeBinary.isJsonMimetype(effectiveMimetype)
                ? LineMarkerOps.applyJsonItemEditBatch(originalContent, edits)
                : LineMarkerOps.applyLineMarkerEditBatch(originalContent, edits);
            if (result.status !== 200) return failure("edit-range-invalid", result.status, result.error ?? "The requested edit range is invalid.", { entryId: existing.id, channel: targetChannel });
            newContent = result.result ?? "";
        } else {
            if (statements.length !== 1) {
                return failure("creation-batch-conflict", 409, "Creation cannot coexist with another EDIT.", { entryId: null, channel: targetChannel });
            }
            newContent = statement.body ?? "";
        }

        // 304 no-op (SPEC §edit): an existing entry whose write would change nothing —
        // identical content and no new tag. Mirrors OPEN/FOLD's 304 on no-op; hands the
        // model a "you already did this" signal instead of a phantom 200 it can't
        // distinguish from a real update.
        if (existing !== undefined && newContent === originalContent) {
            const signalTags = statements.flatMap(({ signal }) => Array.isArray(signal) ? signal : []);
            let addsTag = false;
            if (signalTags.length > 0) {
                const have = new Set(
                    (await db.crud_read_tags.all<{ tag: string }>({ entry_id: existing.id })).map((r) => r.tag),
                );
                addsTag = signalTags.some((t) => !have.has(t));
            }
            if (!addsTag) return { status: 304, entryId: existing.id, channel: targetChannel };  // §edit-noop-304
        }

        let entryId: number;
        let createdNow: boolean;
        if (existing === undefined) {
            const row = await db.crud_insert_workspace_entry.get<{ id: number }>({ workspace_id: workspaceId, owner_id: ownerId, scheme, pathname });
            if (row === undefined) throw new Error("editWorkspaceEntry: insert returned no row");
            entryId = row.id;
            createdNow = true;
        } else {
            entryId = existing.id;
            createdNow = false;
        }

        if (ctx.tokenize === undefined) throw new Error("editWorkspaceEntry: ctx.tokenize is required for token accounting");
        await db.ops_upsert_channel.run({ entry_id: entryId, name: targetChannel, content: newContent, mimetype: effectiveMimetype, tokens: ctx.tokenize(newContent) }); // EDIT writes exactly the one resolved channel — §per-entry-channels-edit-writes-only-body
        // Search derivation is not a write concern. SearchIndex attaches the
        // updated readable projection before the next model execution.

        // Tags apply additively — each signal tag is written, never replacing existing ones. §edit-tags-additive
        for (const candidate of statements) {
            if (!Array.isArray(candidate.signal)) continue;
            for (const tag of candidate.signal) {
                await db.crud_write_tag.run({ entry_id: entryId, tag });
            }
        }

        const receiptEdits = existing === undefined
            ? [{ marker: { marks: [1, -1] as [number, number] }, body: newContent }]
            : statements.map((candidate) => ({ marker: candidate.lineMarker!, body: candidate.body ?? "" }));
        return {
            status: createdNow ? 201 : 200,
            entryId,
            channel: targetChannel,
            editReceipt: editReceipt(originalContent, newContent, receiptEdits, {
                unit: editReceiptUnit(MimetypeBinary.isJsonMimetype(effectiveMimetype), originalContent, newContent),
            }),
        };  // §edit-status-201-200
    }

    // Scope-aware entry delete — the KILL counterpart of editWorkspaceEntry. Resolves the
    // entry via the scope's crud_find variant (so a worker-scope row is found, not just
    // workspace), then deletes by id (channels/tags CASCADE). 404 when the entry is absent.
    static async deleteWorkspaceEntry(statement: { target: EditStatement["target"] }, ctx: PlurnkSchemeContext, manifest: SchemeManifest, explicitOwnerId?: number): Promise<SchemeResultBase> {
        if (statement.target === null) return Results.failure(`scheme:${manifest.name}`, "delete-target-required", 400, "KILL requires a target path.");
        const { db, workspaceId } = ctx;
        const pathname = EntryOps.#pathnameOf(statement);
        const ownerId = await EntryOps.#ownerOf(explicitOwnerId, ctx);
        const existing = await db.crud_find_workspace_entry.get<{ id: number }>({ workspace_id: workspaceId, owner_id: ownerId, scheme: manifest.name, pathname });
        if (existing === undefined) return Results.failure(`scheme:${manifest.name}`, "entry-not-found", 404, `No entry exists at ${EntryManifest.toPath(manifest.name, pathname)}.`);
        await db.crud_delete_entry.run({ entry_id: existing.id });
        return { status: 200 };
    }

    static async readWorkspaceEntry(statement: ReadStatement, ctx: PlurnkSchemeContext, manifest: SchemeManifest, explicitOwnerId?: number): Promise<ReadResult> {
        const failure = (
            code: string,
            status: number,
            detail: string,
            fields: Readonly<Record<string, unknown>>,
            extensions: Readonly<Record<string, unknown>> = {},
        ): ReadResult => Results.failure(`scheme:${manifest.name}`, code, status, detail, fields, extensions) as ReadResult;
        if (statement.target === null) return failure("read-target-required", 400, "READ requires a target path.", { content: null, mimetype: null, channel: null });

        const { db, workspaceId } = ctx;
        const { channels, defaultChannel } = manifest;
        // Scope by the manifest's persisted entries.scheme (storedScheme; absent →
        // name). File persists under the reserved 'file' scheme ({§entry-identity-no-null}).
        const scheme = EntryCrud.identityScheme(manifest);

        const fragment = EntryOps.#fragmentOf(statement);
        const pathname = EntryOps.#pathnameOf(statement);
        const targetChannel = EntryOps.#resolveChannel(fragment, channels, defaultChannel);
        if (targetChannel === null) return failure("channel-not-found", 400, EntryOps.#channelMissFact(fragment, scheme, pathname, channels, defaultChannel), { content: null, mimetype: null, channel: null });

        const ownerId = await EntryOps.#ownerOf(explicitOwnerId, ctx);
        // An xpath is a question about the DOM — a fragmentless xpath READ routes to the raw `html`
        // channel (the archive the decisive markdown body was projected from). A fragment still wins.
        let readChannel = targetChannel;
        if (fragment === null && statement.body !== null && statement.body.dialect === "xpath") {
            const html = await db.ops_read_channel.get<{ content: string }>({ ...{ workspace_id: workspaceId, scheme, pathname, channel: "html" }, owner_id: ownerId });
            if (html !== undefined) readChannel = "html";
        }
        const row = await db.ops_read_channel.get<{ content: string; mimetype: string }>({ ...{ workspace_id: workspaceId, scheme, pathname, channel: readChannel }, owner_id: ownerId });
        // §read-read-404 + {§fs-errno} — ENOENT carries its fact, the RESOLVED name in wire
        // canon: the model distinguishes wrong-address from wrong-range by the strings alone.
        if (row === undefined) return failure("entry-not-found", 404, `No entry exists at ${EntryManifest.toPath(scheme, pathname)}.`, { content: null, mimetype: null, channel: targetChannel });

        if (MimetypeBinary.isBinaryMimetype(row.mimetype)) {
            return failure("binary-read-unsupported", 415, `The #${targetChannel} channel is binary and cannot be rendered.`, { content: null, mimetype: row.mimetype, channel: targetChannel });
        }

        // `[tag]` filter: entry must have ALL requested tags. Mismatch = 404
        // (entry doesn't match the tag-scoped READ).
        if (Array.isArray(statement.signal) && statement.signal.length > 0) {
            const entry = await db.crud_find_workspace_entry.get<{ id: number }>({ workspace_id: workspaceId, owner_id: ownerId, scheme, pathname });
            if (entry === undefined) return failure("entry-not-found", 404, `No entry exists at ${EntryManifest.toPath(scheme, pathname)}.`, { content: null, mimetype: null, channel: targetChannel });
            const tagRows = await db.crud_read_tags.all<{ tag: string }>({ entry_id: entry.id });
            const have = new Set(tagRows.map((r) => r.tag));
            for (const want of statement.signal) {
                if (!have.has(want)) return failure("tag-not-found", 404, `The entry does not carry the required '${want}' tag.`, { content: null, mimetype: null, channel: targetChannel });
            }
        }

        const r = await ReadResolve.resolve({
            content: row.content,
            mimetype: row.mimetype,
            lineMarker: statement.lineMarker,
            body: statement.body,
            mimetypes: ctx.mimetypes,
        });
        if (r.status >= 400) {
            const detail = r.reason ?? `READ could not resolve the requested content (status ${r.status}).`;
            return failure(
                r.status === 416 ? "range-not-satisfiable" : "read-resolution-failed",
                r.status,
                detail,
                { content: null, mimetype: r.mimetype, channel: readChannel },
                r.range === undefined ? {} : { range: r.range },
            );
        }
        return { ...r, channel: readChannel }; // READ returns the resolved channel's content + mimetype — §read-read-content
    }
}
