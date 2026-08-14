import EntrySemantic from "./_entry-semantic.ts";
import EntryCrud from "./_entry-crud.ts";
import type { RangeExtent, ReadStatement, TextRegion } from "@plurnk/plurnk-contracts";
import type { Db } from "../core/Db.ts";
import { entryPathnameOf, renderTarget } from "../core/plurnk-uri.ts";
import type { PlurnkSchemeContext, SchemeManifest } from "../core/scheme-types.ts";
import Owner from "../core/Owner.ts";
import EntryManifest from "./_entry-manifest.ts";
import { EditCollision, LineAnchors, LineMarkerOps, MimetypeBinary, PathMimetype, ReadProjector, editReceipt } from "../content/index.ts";
import type { EditBatchReceipt, LineAnchorPrecondition } from "../content/index.ts";
import Results, { type SchemeResultBase } from "../core/results.ts";
import type { ResolvedEditStatement, ScopeNormalization } from "@plurnk/plurnk-schemes";
import { contentHash } from "../core/content-hash.ts";

// Shared static-method helpers for owner-addressed entry-bearing schemes.
// Each scheme passes its manifest; helpers extract scheme name, channels,
// and defaultChannel. Channel routing
// follows SPEC {§channel-selection}: path.fragment ?? manifest.defaultChannel.

// Produce the aggregate scheme receipt owned by
// {§scheme-edit-batch-receipt}; core projects each authored row under
// {§edit-result-receipt-projection}.
export type EditResult = SchemeResultBase & { entryId: number | null; channel: string | null; editReceipt?: EditBatchReceipt | null };
// startLine = 1-indexed position the content starts at in the original
// source. Lets the render layer prefix N: correctly for both full
// reads (start=1) and <L> slices (start=N). Null when not line-relevant
// (errors).
export type ReadResult = SchemeResultBase & {
    content: string | null;
    mimetype: string | null;
    channel: string | null;
    startLine?: number | null;
    region?: TextRegion;
    range?: RangeExtent;
    reason?: string;
    awaitWorker?: string;
};
export type OpenFoldResult = SchemeResultBase;

interface ReadAddress {
    readonly ownerId?: number;
    readonly pathname?: string;
}

export default class EntryOps {
    static #pathnameOf(statement: { target: ResolvedEditStatement["target"] }): string {
        const t = statement.target;
        if (t === null) throw new Error("unreachable");
        // Owner-carved schemes strip their authority before reaching the shared
        // entry layer; every remaining authority is part of entry identity.
        return entryPathnameOf(t);
    }

    static #fragmentOf(statement: { target: ResolvedEditStatement["target"] }): string | null {
        const t = statement.target;
        if (t === null || t.kind !== "url") return null;
        return t.fragment;
    }

    static #resolveChannel(fragment: string | null, channels: Record<string, string>, defaultChannel: string): string | null {
        const target = fragment ?? defaultChannel; // fragment selects the named channel; absent → default — {§channel-selection-fragment-selects-named-channel} {§channel-selection-fragmentless-targets-default-channel}
        // The default channel is always valid — dynamic-channel schemes (File:
        // channels={}, mimetype derived per-file) declare none, but their body
        // channel still exists. A non-default fragment must be a declared channel.
        if (target === defaultChannel) return target;
        if (!(target in channels)) return null; // unknown channel name → null → 400 at the caller — {§channel-selection-unknown-channel-400}
        return target;
    }

    // {§channel-selection-unknown-channel-400} — the 400 carries its fact: the tried fragment and
    // the declared universe, so one miss teaches the topology instead of forcing a guessing walk
    // (failure specimen: a model probed #stdout/#stderr/#body against a results-channel search stream,
    // each miss a bare 400 that taught nothing).
    static #channelMiss(
        fragment: string | null,
        scheme: string,
        pathname: string,
        channels: Record<string, string>,
        defaultChannel: string,
    ): { detail: string; extensions: Readonly<Record<string, unknown>> } {
        const availableChannels = [...new Set([defaultChannel, ...Object.keys(channels)])].filter((channel) => channel.length > 0);
        const requestedChannel = fragment ?? defaultChannel;
        return {
            detail: `Channel #${requestedChannel} does not exist at ${EntryManifest.toPath(scheme, pathname)}.`,
            extensions: {
                requestedChannel,
                availableChannels,
                ...(availableChannels.length === 0
                    ? {}
                    : { recovery: `Use one of the available channels: ${availableChannels.map((channel) => `#${channel}`).join(", ")}.` }),
                retryable: false,
            },
        };
    }

    // {§entry-owner} — the entry's owner for this call: an owner-carved face (worker://, the
    // capability streams) resolves its authority itself (empty/~/name per its carving) and passes
    // the result explicitly; everything else is the workspace commons.
    static async #ownerOf(explicit: number | undefined, ctx: PlurnkSchemeContext): Promise<number> {
        if (explicit !== undefined) return explicit;
        return Owner.commonsId(ctx.db, ctx.workspaceId);
    }

    static async editWorkspaceEntryBatch(
        statements: readonly ResolvedEditStatement[],
        ctx: PlurnkSchemeContext,
        manifest: SchemeManifest,
        explicitOwnerId?: number,
        precondition: LineAnchorPrecondition | null = null,
    ): Promise<EditResult> {
        LineAnchors.assertResolved(statements);
        const failure = (
            code: string,
            status: number,
            detail: string,
            fields: Readonly<Record<string, unknown>>,
            extensions: Readonly<Record<string, unknown>> = {},
        ): EditResult => Results.failure(`scheme:${manifest.name}`, code, status, detail, fields, extensions) as EditResult;
        const statement = statements[0];
        if (statement === undefined) {
            return failure(
                "edit-empty",
                400,
                "EDIT requires at least one statement.",
                { entryId: null, channel: null },
                {
                    recovery: "Provide an EDIT statement.",
                    retryable: false,
                },
            );
        }
        if (statement.target === null) {
            return failure(
                "edit-target-required",
                400,
                "EDIT requires a target path.",
                { entryId: null, channel: null },
                {
                    recovery: "Provide the entry target.",
                    retryable: false,
                },
            );
        }

        const { db, workspaceId } = ctx;
        const { name: scheme, channels, defaultChannel } = manifest;

        const fragment = EntryOps.#fragmentOf(statement);
        const pathname = EntryOps.#pathnameOf(statement);
        const targetChannel = EntryOps.#resolveChannel(fragment, channels, defaultChannel);
        if (targetChannel === null) {
            const miss = EntryOps.#channelMiss(fragment, scheme, pathname, channels, defaultChannel);
            return failure("channel-not-found", 400, miss.detail, { entryId: null, channel: null }, miss.extensions);
        }
        for (const candidate of statements.slice(1)) {
            if (candidate.target === null
                || EntryOps.#pathnameOf(candidate) !== pathname
                || EntryOps.#fragmentOf(candidate) !== fragment) {
                return failure(
                    "edit-batch-mismatch",
                    400,
                    "The EDIT batch spans multiple resources or channels.",
                    { entryId: null, channel: targetChannel },
                    {
                        recovery: "Submit a separate EDIT batch for each resource and channel.",
                        retryable: false,
                    },
                );
            }
        }

        const ownerId = await EntryOps.#ownerOf(explicitOwnerId, ctx);
        const existing = await db.crud_find_workspace_entry.get<{ id: number }>({ workspace_id: workspaceId, owner_id: ownerId, scheme, pathname });

        // Non-default channel write requires the entry to exist ({§channel-selection-fragment-on-nonexistent-404}).
        if (existing === undefined && fragment !== null) {
            return failure("entry-not-found", 404, `No entry exists at ${EntryManifest.toPath(scheme, pathname)}.`, { entryId: null, channel: targetChannel });
        }

        // Effective mimetype for this entry, per the shared contracts:
        // "Path suffix declares mimetype; absent suffix defers to scheme default."
        // `worker:///users.json` → application/json (extension wins).
        // `worker:///users`      → text/markdown (scheme manifest default).
        const channelManifestDefault = channels[targetChannel];
        const effectiveMimetype = await PathMimetype.resolveEntryMimetype(pathname, channelManifestDefault, ctx.mimetypes);

        const channel = existing === undefined
            ? undefined
            : await db.ops_read_channel.get<{ content: string; mimetype: string }>({
                workspace_id: workspaceId,
                scheme,
                pathname,
                channel: targetChannel,
                owner_id: ownerId,
            });

        // 415 on binary entries (SPEC.md {§op-invariants}).
        if (existing !== undefined) {
            if (channel !== undefined && await MimetypeBinary.isBinaryMimetype(channel.mimetype, ctx.mimetypes)) {
                return failure("binary-edit-unsupported", 415, `The #${targetChannel} channel is binary and cannot be edited.`, { entryId: existing.id, channel: targetChannel });
            }
        }
        if (await MimetypeBinary.isBinaryMimetype(effectiveMimetype, ctx.mimetypes)) {
            return failure("binary-edit-unsupported", 415, `The #${targetChannel} channel is binary and cannot be edited.`, { entryId: existing?.id ?? null, channel: targetChannel });
        }

        // Read current content unconditionally for diff generation (M.12 —
        // surface diff in EDIT response so wrong-marker mistakes are visible).
        const originalContent = channel?.content ?? "";
        if (precondition !== null && !LineAnchors.satisfies(precondition, originalContent)) {
            return EditCollision.result(precondition.identity, {
                entryId: existing?.id ?? null,
                channel: targetChannel,
            }) as EditResult;
        }

        // `<scope>` always addresses the selected channel's textual representation.
        // Structured query dialects locate content but never redefine mutation coordinates.
        // A missing selected channel has nothing to scope into, so a markerless body
        // becomes that channel's content. {§edit-marker-required-on-existing}: an
        // existing selected channel has no easy-clobber path: a marker is REQUIRED,
        // even for a deliberate full rewrite (`<1,-1>` states that intent explicitly).
        let newContent: string;
        let scopeNormalizations: ReadonlyArray<ScopeNormalization> | undefined;
        const channelExists = channel !== undefined;
        if (channelExists && existing === undefined) {
            throw new Error("An entry channel cannot exist without its owning entry.");
        }
        const existingEntryId = existing?.id ?? null;
        if (channelExists && statements.some(({ lineMarker }) => lineMarker === null)) {
            return failure(
                "line-marker-required",
                400,
                "EDIT of an existing entry requires a line marker.",
                { entryId: existingEntryId, channel: targetChannel },
                {
                    recovery: "Use <1,-1> to replace the whole entry or select a narrower range.",
                    retryable: false,
                },
            );
        }
        if (channelExists) {
            const edits = statements.map((candidate) => ({
                marker: candidate.lineMarker!,
                body: candidate.body ?? "",
            }));
            const result = LineMarkerOps.applyLineMarkerEditBatch(originalContent, edits);
            if (result.status !== 200) {
                return Results.assert({
                    ...result,
                    entryId: existingEntryId,
                    channel: targetChannel,
                }) as EditResult;
            }
            newContent = result.result ?? "";
            scopeNormalizations = result.scopeNormalizations;
        } else {
            if (statements.length !== 1) {
                return failure(
                    "creation-batch-conflict",
                    409,
                    "Multiple EDIT operations attempted to create the same entry.",
                    { entryId: null, channel: targetChannel },
                    {
                        recovery: "Create the entry with one EDIT before applying additional edits.",
                        retryable: false,
                    },
                );
            }
            newContent = statement.body ?? "";
        }

        // 304 no-op (SPEC {§edit}): an existing entry whose write would change nothing.
        // Mirrors OPEN/FOLD's idempotence; hands the
        // model a "you already did this" signal instead of a phantom 200 it can't
        // distinguish from a real update.
        if (channelExists && newContent === originalContent) {
            return {
                status: 304,
                entryId: existingEntryId,
                channel: targetChannel,
                ...(scopeNormalizations === undefined ? {} : { scopeNormalizations }),
            };  // {§edit-noop-304}
        }

        let entryId: number;
        let createdNow: boolean;
        if (existing === undefined) {
            const row = await db.ops_insert_workspace_entry_if_absent.get<{ id: number }>({
                workspace_id: workspaceId,
                owner_id: ownerId,
                scheme,
                pathname,
            });
            if (row === undefined) {
                return EditCollision.result(
                    precondition?.identity ?? EntryManifest.toPath(scheme, pathname),
                    { entryId: null, channel: targetChannel },
                ) as EditResult;
            }
            entryId = row.id;
            createdNow = true;
        } else {
            entryId = existing.id;
            createdNow = false;
        }

        if (ctx.tokenize === undefined) throw new Error("editWorkspaceEntry: ctx.tokenize is required for token accounting");
        const write = {
            entry_id: entryId,
            name: targetChannel,
            content: newContent,
            mimetype: effectiveMimetype,
            tokens: ctx.tokenize(newContent),
            content_hash: contentHash(newContent),
        };
        const landed = channel === undefined
            ? await db.ops_insert_channel_if_absent.get<{ name: string }>(write)
            : await db.ops_update_channel_if_content.get<{ name: string }>({
                ...write,
                expected_content: originalContent,
            });
        if (landed === undefined) {
            return EditCollision.result(
                precondition?.identity ?? EntryManifest.toPath(scheme, pathname),
                { entryId, channel: targetChannel },
            ) as EditResult;
        }
        // EDIT writes exactly the one resolved channel — {§per-entry-channels-edit-writes-only-body}.
        // Search derivation is not a write concern. SearchIndex attaches the
        // updated readable projection before the next model execution.

        const receiptEdits = !channelExists
            ? [{ marker: { marks: [1, -1] as [number, number] }, body: newContent }]
            : statements.map((candidate) => ({ marker: candidate.lineMarker!, body: candidate.body ?? "" }));
        return {
            status: createdNow ? 201 : 200,
            entryId,
            channel: targetChannel,
            editReceipt: editReceipt(originalContent, newContent, receiptEdits),
            ...(scopeNormalizations === undefined ? {} : { scopeNormalizations }),
        };  // {§edit-status-201-200}
    }

    // Owner-aware entry delete — the KILL counterpart of editWorkspaceEntry. Resolves
    // the exact owner-held row, then deletes it (including channels by CASCADE). 404 when absent.
    static async deleteWorkspaceEntry(statement: { target: ResolvedEditStatement["target"] }, ctx: PlurnkSchemeContext, manifest: SchemeManifest, explicitOwnerId?: number): Promise<SchemeResultBase> {
        if (statement.target === null) {
            return Results.failure(
                `scheme:${manifest.name}`,
                "delete-target-required",
                400,
                "KILL requires a target path.",
                {},
                {
                    recovery: "Provide the entry target.",
                    retryable: false,
                },
            );
        }
        const { db, workspaceId } = ctx;
        const pathname = EntryOps.#pathnameOf(statement);
        const ownerId = await EntryOps.#ownerOf(explicitOwnerId, ctx);
        const existing = await db.crud_find_workspace_entry.get<{ id: number }>({ workspace_id: workspaceId, owner_id: ownerId, scheme: manifest.name, pathname });
        if (existing === undefined) {
            return Results.failure(
                `scheme:${manifest.name}`,
                "entry-not-found",
                404,
                `No entry exists at ${EntryManifest.toPath(manifest.name, pathname)}.`,
                {},
                { target: EntryManifest.toPath(manifest.name, pathname) },
            );
        }
        await db.crud_delete_entry.run({ entry_id: existing.id });
        return { status: 200 };
    }

    static async readWorkspaceEntry(
        statement: ReadStatement,
        ctx: PlurnkSchemeContext,
        manifest: SchemeManifest,
        address: ReadAddress = {},
    ): Promise<ReadResult> {
        const failure = (
            code: string,
            status: number,
            detail: string,
            fields: Readonly<Record<string, unknown>>,
            extensions: Readonly<Record<string, unknown>> = {},
        ): ReadResult => Results.failure(`scheme:${manifest.name}`, code, status, detail, fields, extensions) as ReadResult;
        if (statement.target === null) {
            return failure(
                "read-target-required",
                400,
                "READ requires a target path.",
                { content: null, mimetype: null, channel: null },
                {
                    recovery: "Provide the entry target.",
                    retryable: false,
                },
            );
        }

        // Scope by the manifest's persisted entries.scheme (storedScheme; absent →
        // name). File persists under the reserved 'file' scheme ({§entry-identity-no-null}).
        const scheme = EntryCrud.identityScheme(manifest);

        const pathname = address.pathname ?? EntryOps.#pathnameOf(statement);
        const identity = statement.target.kind === "url"
            ? renderTarget({ ...statement.target, pathname })
            : renderTarget({ scheme: null, pathname });
        if (identity === null) throw new TypeError("READ resolved an unrenderable resource identity.");
        const ownerId = await EntryOps.#ownerOf(address.ownerId, ctx);
        const stored = await EntryCrud.readEntry(pathname, ctx, scheme, ownerId);
        // {§read-read-404} + {§fs-errno} — ENOENT carries its fact, the RESOLVED name in wire
        // canon: the model distinguishes wrong-address from wrong-range by the strings alone.
        if (stored.entry === null) {
            return failure(
                "entry-not-found",
                404,
                `No entry exists at ${EntryManifest.toPath(scheme, pathname)}.`,
                { content: null, mimetype: null, channel: null },
                { target: EntryManifest.toPath(scheme, pathname) },
            );
        }
        return ReadProjector.project({
            statement,
            manifest: { ...manifest, name: scheme },
            target: EntryManifest.toPath(scheme, pathname),
            identity,
            representation: stored.entry,
            mimetypes: ctx.mimetypes,
        }) as Promise<ReadResult>;
    }
}
