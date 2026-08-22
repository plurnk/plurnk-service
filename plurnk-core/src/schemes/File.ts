import { lstat, mkdir, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import Namespace from "../core/namespace.ts";
import Owner from "../core/Owner.ts";
import { basename, dirname, relative, isAbsolute, join, matchesGlob } from "node:path";
import { createPatch } from "diff";
import type { FindStatement, ParsedPath } from "@plurnk/plurnk-contracts";
import type { Db } from "../core/Db.ts";
import { PathSyntax } from "@plurnk/plurnk-contracts";
import GitMembership, { type FileCreationAdmission } from "../core/git-membership.ts";
import type { SchemeManifest, PlurnkSchemeContext } from "../core/scheme-types.ts";
import EntryFind from "./_entry-find.ts";
import type { FindResult } from "./_entry-find.ts";
import EntryCrud from "./_entry-crud.ts";
import type { ReadEntryResult, EntryData, WriteEntryResult, DeleteEntryResult } from "./_entry-crud.ts";
import { CoreSchemeAdapterBase } from "../core/CoreSchemeServices.ts";
import type { CoreSchemeCallContext } from "../core/CoreSchemeServices.ts";
import ErrorDetail from "../core/ErrorDetail.ts";
import Results, { type SchemeResultBase } from "../core/results.ts";
import SchemeCtxImpl from "../core/caps/SchemeCtxImpl.ts";
import {
    type EntryAddress,
    InvalidOperationResultError,
    type ResolvedEditStatement,
    type ScopeNormalization,
    type ProposalApplyResult,
} from "@plurnk/plurnk-schemes";

// Resolved + {§membership-change-gated-sync} disk-write target, or the error status to return.
type AdmittedCreation = Extract<FileCreationAdmission, { ok: true }>;
type WriteTarget =
    | { ok: true; canonical: string; rel: string; fileExists: boolean; original: string; mimetype: string; baseSig: string | null; creationAdmission: AdmittedCreation | null }
    | {
        ok: false;
        code: string;
        status: number;
        detail: string;
        extensions?: Readonly<Record<string, unknown>>;
    };
import {
    LineMarkerOps,
    LineAnchors,
    EditCollision,
    MimetypeBinary,
    editReceipt,
    projectEditReceipt,
    reviewerReplacementReceipt,
    withEditReceiptParseIssues,
} from "../content/index.ts";
import type { EditBatchReceipt } from "../content/index.ts";
import DbProjectionCaps from "../core/caps/DbProjectionCaps.ts";

type EditResult = SchemeResultBase & { body?: string; attrs?: object; editReceipt?: EditBatchReceipt };
type ApplyArgs = { attrs: { path?: string; canonical?: string; patched?: string; mimetype?: string; editReceipt?: EditBatchReceipt; deletePath?: string; baseSig?: string | null; existed?: boolean; [k: string]: unknown }; body?: string };
type ApplyResult = ProposalApplyResult;

// Workspace root for file ops is sourced from `workspaces.project_root`,
// supplied at {§methods-workspace-create}. Under {§fs-namespace}, core never
// guesses a root: headless workspaces fail file operations at 400.
const loadWorkspaceRoot = async (db: Db, workspaceId: number): Promise<string | null> => {
    const row = await db.envelope_get_workspace.get<{ project_root: string | null }>({ id: workspaceId });
    return row?.project_root ?? null;
};

// Resolve the nearest existing ancestor, then append the still-absent tail. This
// gives a proposed create the same physical containment check as an existing path:
// an in-root symlinked parent cannot smuggle a root-scoped write outside the jail.
const prospectiveRealpath = async (requested: string): Promise<string> => {
    const tail: string[] = [basename(requested)];
    let cursor = dirname(requested);
    while (true) {
        try {
            return join(await realpath(cursor), ...tail);
        } catch (cause) {
            if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw cause;
        }
        const parent = dirname(cursor);
        if (parent === cursor) throw new Error(`No existing ancestor contains '${requested}'.`);
        tail.unshift(basename(cursor));
        cursor = parent;
    }
};


// Detect mimetype from a file's path through the configured registry. The
// `MimetypeBinary.normalizeAutoTextMimetype` wrapper ensures text/plain returned by the
// service is normalized to text/markdown — plurnk-service never auto-
// derives text/plain (see mimetype-binary.ts MimetypeBinary.TEXT_PRIMITIVE_MIMETYPE).
const detectFileMimetype = async (canonical: string, ctx: PlurnkSchemeContext): Promise<string> => {
    if (ctx.mimetypes === undefined) throw new Error("detectFileMimetype: configured mimetype registry is required");
    const detected = await ctx.mimetypes.detect({ path: canonical });
    return MimetypeBinary.normalizeAutoTextMimetype(detected);
};

// SECURITY — File's exact READ uses the core projector and broad FIND uses the
// shared entry query over the membership-materialized entries
// (stored under scheme="file"). The membership gate is now ENTRY-EXISTENCE — a non-member has no
// entry, so every read-side consumer 404s it at the shared entry boundary
// (a gitignored `.env` is never a member → never an entry → never readable). Disk
// I/O is confined to the two edges that own it: the git-membership materialize-IN
// and edit()/applyResolution()'s proposal-gated write-OUT ({§membership}), where the
// containment/traversal checks live.
//
// Core-only writeEntry() is the proposal-gated write-back: a COPY/MOVE *into* file:/// is a disk
// write, so it flows through the SAME {§membership} gate as EDIT (#resolveWriteTarget) — a
// 202 proposal, then applyResolution() writes on accept — never an ungated overwrite (the
// `.env`-wipe this guard prevents). COPY/MOVE *from* file:/// uses the core-only
// readEntry adapter.
export default class File extends CoreSchemeAdapterBase {
    static manifest: SchemeManifest = {
        name: "file",
        storedScheme: "file",  // {§entry-identity-no-null} — durable identity; file addresses still render as bare paths
        channels: {},  // dynamic mimetype per file extension
        defaultChannel: "body",
        category: "data",
        writableBy: ["model", "client", "plugin", "_plurnk"],
        volatile: false,
        modelVisible: true,
        folderScopes: true,
        textEditScopes: true,
        example: "## READ0 (README.md)",
        documentation: "The project's workspace files (shown as bare paths) — THE TASK'S FILES: when asked to change the project, EDIT these, not your notes or scratch. READ and FIND them like any entry; EDIT proposes a diff for review and only writes to disk once accepted — the review is normal, not a refusal, so propose the edit rather than working around it. Existing non-members are invisible and cannot be clobbered; admitted absent paths may be created.",
    };

    // {§fs-namei}/{§fs-canonical-name} — the ONE statement-normalizing seam: every model
    // spelling resolves through Namespace.canonicalize before storage, comparison, or render.
    // null (a spelling that names nothing a file can be) falls back to the original statement,
    // which the entry-existence gate then 404s — no second resolution vocabulary exists.
    static #canonTarget<S extends { target: ParsedPath | null }>(statement: S, root: string | null): S | null {
        const t = statement.target;
        if (t === null) return statement;
        if (t.kind === "url") {
            const key = File.#canonSpelling(t.pathname, root);
            if (key === null) return null;
            return key === t.pathname ? statement : { ...statement, target: { ...t, pathname: key } };
        }
        if (t.kind === "local") {
            const key = File.#canonSpelling(t.raw, root);
            if (key === null) return null;
            return key === t.raw ? statement : { ...statement, target: { ...t, raw: key } };
        }
        return statement; // regex — not a path
    }

    // Folderhood survives canonicalization ({§find-scope-prefix-filter}) — the shared
    // spelling canon lives on Namespace (the Dispatcher's log columns use the same one).
    static #canonSpelling(raw: string, root: string | null): string | null {
        return Namespace.canonicalizeSpelling(raw, root);
    }

    async resolveEntryAddress(target: ParsedPath, ctx: CoreSchemeCallContext): Promise<EntryAddress | null> {
        const core = this.coreContext(ctx);
        const pathname = File.#canonSpelling(
            target.kind === "url" ? target.pathname : target.raw,
            await loadWorkspaceRoot(core.db, core.workspaceId),
        );
        return pathname === null ? null : { authority: "", pathname, owner: "commons" };
    }

    async find(statement: FindStatement, ctx: CoreSchemeCallContext): Promise<FindResult> {
        const core = this.coreContext(ctx);
        // {§fs-namei} — canonicalize the glob's path portion before the candidate scan, the
        // same seam READ/EDIT use; a bare `notes.md` and `/notes.md` scan identically.
        const canon = File.#canonTarget(statement, await loadWorkspaceRoot(core.db, core.workspaceId));
        return EntryFind.findWorkspaceEntries(canon ?? statement, core, File.manifest);
    }

    // COPY/MOVE FROM file:/// — read-only, gated by entry-existence (a non-member
    // has no entry → 404). The write-back side (writeEntry) is deliberately absent;
    // see the SECURITY note above.
    async readEntry(pathname: string, ctx: CoreSchemeCallContext): Promise<ReadEntryResult> {
        const core = this.coreContext(ctx);
        // {§scheme-address} — normalize the model-typed path (bare `brief.md`) to its `/rel` member key,
        // the same parity READ/EDIT/deleteEntry have. Without it a COPY/MOVE FROM a bare file path
        // misses the canonical-stored member and 404s a source that plainly exists.
        const root = await loadWorkspaceRoot(core.db, core.workspaceId);
        const key = root === null ? pathname : Namespace.canonicalize(pathname, root);
        return EntryCrud.readEntry({ authority: "", pathname: key ?? pathname }, core, "file");
    }

    // {§membership} disk-write gate, shared by edit() and writeEntry() (the COPY/MOVE
    // dest). Resolves the canonical path; enforces containment (traversal → 403),
    // membership (existing non-member → 403, the `.env` protection), the read-only
    // overlay (→ 403), and binary (→ 415); reads current content for the diff. A
    // not-found path is fine — we propose to CREATE. ONE home for the gate: an edit
    // and a copy into file:/// are the same disk write under the same review.
    // {§membership-edit-membership-gate} — membership/containment/read-only/binary gate before any disk write
    async #resolveWriteTarget(pathname: string, ctx: PlurnkSchemeContext): Promise<WriteTarget> {
        const root = await loadWorkspaceRoot(ctx.db, ctx.workspaceId);
        if (root === null) {
            return {
                ok: false,
                code: "project-root-required",
                status: 400,
                detail: "The workspace has no project root, so it cannot write files.",
                extensions: { retryable: false },
            };
        }
        // {§fs-namei} — the write side resolves through the SAME canonicalizer as reads;
        // a spelling that names nothing a file can be is refused before any disk touch.
        const key = Namespace.canonicalize(pathname, root);
        if (key === null) {
            return {
                ok: false,
                code: "path-outside-workspace",
                status: 403,
                detail: `The requested path '${pathname}' is outside the workspace.`,
                extensions: {
                    requestedPath: pathname,
                    recovery: "Use a path within the workspace.",
                    retryable: false,
                },
            };
        }
        const isMount = key.startsWith("../");

        let canonical: string;
        const requested = join(root, key);
        let fileExists = true;
        try {
            canonical = await realpath(requested);
        } catch (err) {
            if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
            // A dangling final symlink occupies the name even though realpath cannot
            // follow it. Treat it as the same opaque existing non-member as O_EXCL.
            try {
                await lstat(requested);
                return {
                    ok: false,
                    code: "path-occupied-by-nonmember",
                    status: 403,
                    detail: `A non-member file already occupies '${key}'.`,
                    extensions: {
                        path: key,
                        recovery: "Choose an unoccupied member path.",
                        retryable: false,
                    },
                };
            } catch (occupancyCause) {
                if ((occupancyCause as NodeJS.ErrnoException).code !== "ENOENT") throw occupancyCause;
            }
            canonical = await prospectiveRealpath(requested);
            fileExists = false;
        }
        if (!isMount) {
            const relBare = relative(await realpath(root), canonical);
            // in-tree keys whose realpath escapes (a symlink out) stay refused — the jail holds.
            if (relBare.startsWith("..") || isAbsolute(relBare)) {
                return {
                    ok: false,
                    code: "path-outside-workspace",
                    status: 403,
                    detail: `The requested path '${pathname}' resolves outside the workspace.`,
                    extensions: {
                        requestedPath: pathname,
                        recovery: "Use a path within the workspace.",
                        retryable: false,
                    },
                };
            }
        }
        const rel = key;  // the bare canonical member key ({§fs-canonical-name}) — storage ≡ wire

        let original = "";
        let baseSig: string | null = null;  // the snapshot signature the proposal is computed against; null = create (assumed-absent)
        let creationAdmission: AdmittedCreation | null = null;
        if (fileExists) {
            const member = await ctx.db.crud_get_member_sig.get<{ id: number; synced_sig: string | null; membership_origin: string | null }>({ workspace_id: ctx.workspaceId, owner_id: await Owner.commonsId(ctx.db, ctx.workspaceId), scheme: "file", authority: "", pathname: rel });
            // {§fs-errno} — the occupancy fact (POSIX O_EXCL precedent): something invisible
            // occupies the path; existence leaks, content stays dark. The model picks another name.
            if (member === undefined) {
                return {
                    ok: false,
                    code: "path-occupied-by-nonmember",
                    status: 403,
                    detail: `A non-member file already occupies '${rel}'.`,
                    extensions: {
                        path: rel,
                        recovery: "Choose an unoccupied member path.",
                        retryable: false,
                    },
                };
            }
            // {§fs-write-surface} 5 — a git-included mount member is read-only: git's grants
            // confer rw only within the project; only a pick grant carries write.
            if (isMount && member.membership_origin === "git") {
                return {
                    ok: false,
                    code: "member-read-only",
                    status: 403,
                    detail: `The mounted member '${rel}' is read-only.`,
                    extensions: { path: rel, retryable: false },
                };
            }
            const viewGlobs = (await ctx.db.crud_list_workspace_constraints.all<{ effect: string; glob: string }>({ workspace_id: ctx.workspaceId }))
                .filter((c) => c.effect === "view").map((c) => c.glob);
            if (viewGlobs.some((g) => matchesGlob(rel, g))) {
                return {
                    ok: false,
                    code: "member-read-only",
                    status: 403,
                    detail: `The member '${rel}' is read-only.`,
                    extensions: { path: rel, retryable: false },
                };
            } // view = read-only member, 403 on edit - {§membership-overlay-view}
            // The diff base is the entry's snapshot — the body channel the model READ — not a fresh
            // disk read. EDIT is naive against the view the model saw; the write-side CAS (applyResolution)
            // guards the landing. baseSig is that snapshot's stat, carried with the proposal so a sibling
            // worker's reconcile can't advance it under the paused proposal. {§membership-edit-write-cas}
            const snapshot = await ctx.db.ops_read_channel.get<{ content: string }>({ workspace_id: ctx.workspaceId, owner_id: await Owner.commonsId(ctx.db, ctx.workspaceId), scheme: "file", authority: "", pathname: rel, channel: "body" });
            original = snapshot?.content ?? "";
            baseSig = member.synced_sig;
        } else {
            const admission = await GitMembership.planCreation(ctx.db, ctx.workspaceId, rel, ctx.signal);
            if (!admission.ok) return admission;
            creationAdmission = admission;
        }

        const mimetype = await detectFileMimetype(canonical, ctx);
        if (await MimetypeBinary.isBinaryMimetype(mimetype, ctx.mimetypes)) {
            return {
                ok: false,
                code: "binary-write-unsupported",
                status: 415,
                detail: `File EDIT does not support binary mimetype '${mimetype}'.`,
                extensions: {
                    mimetype,
                    retryable: false,
                },
            };
        }
        return { ok: true, canonical, rel, fileExists, original, mimetype, baseSig, creationAdmission };
    }

    // {§membership-edit-write-cas}, {§proposal-202-pauses}: return status=202
    // with a udiff body for client review and attrs carrying the full patched
    // content. Engine pauses dispatch and calls applyResolution() after accept.
    async editBatch(statements: readonly ResolvedEditStatement[], ctx: CoreSchemeCallContext): Promise<EditResult> {
        LineAnchors.assertResolved(statements);
        const failure = (
            code: string,
            status: number,
            detail: string,
            extensions: Readonly<Record<string, unknown>> = {},
        ): EditResult => Results.failure("scheme:file", code, status, detail, {}, extensions) as EditResult;
        const statement = statements[0];
        if (statement === undefined) {
            return failure(
                "edit-empty",
                400,
                "EDIT requires at least one statement.",
                {
                    recovery: "Provide an EDIT statement.",
                    retryable: false,
                },
            );
        }
        const core = this.coreContext(ctx);
        if (statement.target === null) {
            return failure(
                "edit-target-required",
                400,
                "EDIT requires a target path.",
                {
                    recovery: "Provide the file target.",
                    retryable: false,
                },
            );
        }
        const pathname = PathSyntax.decodeParens(statement.target.kind === "url" ? statement.target.pathname : statement.target.raw); // {§path-parentheses}
        const target = await this.#resolveWriteTarget(pathname, core);
        if (!target.ok) return failure(target.code, target.status, target.detail, target.extensions);
        const { canonical, rel, fileExists, original, mimetype, baseSig } = target;
        for (const candidate of statements.slice(1)) {
            if (candidate.target === null) {
                return failure(
                    "edit-batch-mismatch",
                    400,
                    "The EDIT batch spans multiple resources.",
                    {
                        recovery: "Submit a separate EDIT batch for each resource.",
                        retryable: false,
                    },
                );
            }
            const candidatePathname = PathSyntax.decodeParens(candidate.target.kind === "url" ? candidate.target.pathname : candidate.target.raw);
            const candidateTarget = await this.#resolveWriteTarget(candidatePathname, core);
            if (!candidateTarget.ok || candidateTarget.rel !== rel) {
                return failure(
                    "edit-batch-mismatch",
                    400,
                    "The EDIT batch spans multiple resources.",
                    {
                        recovery: "Submit a separate EDIT batch for each resource.",
                        retryable: false,
                    },
                );
            }
        }

        const precondition = SchemeCtxImpl.editPreconditionOf(ctx);
        if (precondition !== null && !LineAnchors.satisfies(precondition, original)) {
            return EditCollision.result(precondition.identity) as EditResult;
        }

        // {§edit-marker-required-on-existing} — markerless content creates a new
        // file; every existing-file rewrite states its range explicitly.
        let patched: string;
        let scopeNormalizations: ReadonlyArray<ScopeNormalization> | undefined;
        if (fileExists) {
            if (statements.some(({ lineMarker }) => lineMarker === null)) {
                return failure(
                    "line-marker-required",
                    400,
                    "EDIT of an existing file requires a line marker.",
                    {
                        recovery: "Use <1,-1> to replace the whole file or select a narrower range.",
                        retryable: false,
                    },
                );
            }
            const edits = statements.map((candidate) => ({ marker: candidate.lineMarker!, body: candidate.body ?? "" }));
            const result = LineMarkerOps.applyLineMarkerEditBatch(original, edits);
            if (result.status !== 200) return Results.assert(result) as EditResult;
            patched = result.result ?? "";
            scopeNormalizations = result.scopeNormalizations;
        } else {
            if (statements.length !== 1) {
                return failure(
                    "creation-batch-conflict",
                    409,
                    "Multiple EDIT operations attempted to create the same file.",
                    {
                        recovery: "Create the file with one EDIT before applying additional edits.",
                        retryable: false,
                    },
                );
            }
            patched = statement.body ?? "";
        }

        if (fileExists && patched === original) return {
            status: 304,
            ...(scopeNormalizations === undefined ? {} : { scopeNormalizations }),
        };  // {§edit-noop-304}

        const patch = createPatch(rel, original, patched, "current", "proposed");
        const receiptEdits = fileExists
            ? statements.map((candidate) => ({ marker: candidate.lineMarker!, body: candidate.body ?? "" }))
            : [{ marker: { marks: [1, -1] as [number, number] }, body: patched }];
        const batchReceipt = editReceipt(original, patched, receiptEdits);
        return {
            status: 202,
            body: patch,
            editReceipt: batchReceipt,
            ...(scopeNormalizations === undefined ? {} : { scopeNormalizations }),
            attrs: { path: rel, canonical, patch, patched, mimetype, editReceipt: batchReceipt, baseSig, existed: fileExists },
        };
    }

    async edit(statement: ResolvedEditStatement, ctx: CoreSchemeCallContext): Promise<EditResult> {
        return this.editBatch([statement], ctx);
    }

    // COPY/MOVE INTO file:/// — the dest write. Same {§membership} gate as edit, same 202
    // proposal + applyResolution path: a copy onto disk is a disk write and earns
    // the identical human review. ResourceMutations.#copyOrchestration propagates this 202;
    // ProposalLifecycle.workerApply routes the accept back here via the dest scheme;
    // applyResolution() writes the file + registers the entry. The copied content
    // is the source's body channel (full replacement — files are body-only).
    async writeEntry(pathname: string, entry: EntryData, ctx: CoreSchemeCallContext): Promise<WriteEntryResult> {
        const core = this.coreContext(ctx);
        const bodyChannel = entry.channels.body;
        if (bodyChannel === undefined) {
            return Results.failure(
                "scheme:file",
                "body-channel-required",
                400,
                "A file write requires a body channel.",
                { created: false, entryId: null },
                {
                    recovery: "Provide the file content in the body channel.",
                    retryable: false,
                },
            ) as WriteEntryResult;
        }
        const target = await this.#resolveWriteTarget(pathname, core);
        if (!target.ok) {
            return Results.failure(
                "scheme:file",
                target.code,
                target.status,
                target.detail,
                { created: false, entryId: null },
                target.extensions,
            ) as WriteEntryResult;
        }
        const { canonical, rel, fileExists, original, mimetype, baseSig } = target;
        const patched = bodyChannel.content;
        const patch = createPatch(rel, original, patched, "current", "proposed");
        return { status: 202, created: !fileExists, entryId: null, body: patch, attrs: { path: rel, canonical, patch, patched, mimetype, baseSig, existed: fileExists } };
    }

    // applyResolution — called by Engine.dispatch after a proposed log
    // entry resolves with decision=accept. Two responsibilities:
    //   1. Write the patched content to disk.
    //   2. Register the file as an entry so it appears in the manifest and the
    //      model can READ its full landed work.
    // {§edit-result-receipt-truth} — accepted EDITs return the receipt for what
    // landed. Dispatcher composes COPY/MOVE effects after this hook returns.
    async applyResolution(args: ApplyArgs, ctx: CoreSchemeCallContext): Promise<ApplyResult> {
        const core = this.coreContext(ctx);
        const { attrs, body } = args;
        // Delete-apply (deferred behind review — the KILL proposal, or the MOVE source-delete gated by
        // its dest proposal): unlink the host file + deregister the entry on accept. A real unlink
        // failure surfaces as 500, never a silent noop; ENOENT ⇒ file already gone, still deregister.
        if (typeof attrs.deletePath === "string") {
            const root = await loadWorkspaceRoot(core.db, core.workspaceId);
            if (root === null) {
                throw new InvalidOperationResultError("An accepted file deletion has no workspace project root.");
            }
            try {
                await rm(join(root, attrs.deletePath));
            } catch (err) {
                if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
                    console.error(`File deletion failed for '${attrs.deletePath}':`, err);
                    return Results.failure("scheme:file", "delete-failed", 500, `The file could not be deleted: ${ErrorDetail.preview(err)}`, {
                        outcome: "delete_failed",
                    }, {
                        path: attrs.deletePath,
                        stage: "filesystem-delete",
                    }) as ApplyResult;
                }
            }
            await EntryCrud.deleteEntry({ authority: "", pathname: attrs.deletePath }, core, "file");
            await GitMembership.removeGeneratedPick(core.db, core.workspaceId, attrs.deletePath);
            return { status: 200 };
        }
        let canonical = attrs.canonical;
        const relPath = attrs.path;
        const patched = body ?? attrs.patched;
        const mimetype = attrs.mimetype;
        if (typeof canonical !== "string" || canonical.length === 0) {
            throw new InvalidOperationResultError("The accepted file proposal is missing attrs.canonical.");
        }
        if (typeof relPath !== "string" || relPath.length === 0) {
            throw new InvalidOperationResultError("The accepted file proposal is missing attrs.path.");
        }
        if (typeof patched !== "string") {
            throw new InvalidOperationResultError("The accepted file proposal is missing patched content.");
        }
        if (typeof mimetype !== "string" || mimetype.length === 0) {
            throw new InvalidOperationResultError("The accepted file proposal is missing attrs.mimetype.");
        }
        const existed = args.attrs.existed === true;  // proposal targeted an existing member (edit) vs a fresh create
        let creationAdmission: AdmittedCreation | null = null;
        if (!existed) {
            // {§file-create-transaction}: approval is a fresh admission boundary. Re-resolve
            // the physical target so a parent symlink swapped while review was pending cannot
            // redirect an accepted root-scoped create outside the workspace.
            const acceptedTarget = await this.#resolveWriteTarget(relPath, core);
            if (!acceptedTarget.ok) {
                return Results.failure(
                    "scheme:file",
                    acceptedTarget.code,
                    acceptedTarget.status,
                    acceptedTarget.detail,
                    { outcome: "create_refused" },
                    acceptedTarget.extensions,
                ) as ApplyResult;
            }
            if (acceptedTarget.fileExists) {
                return EditCollision.result(relPath, { outcome: "edit_collision" }) as ApplyResult;
            }
            canonical = acceptedTarget.canonical;
            creationAdmission = acceptedTarget.creationAdmission;
            if (creationAdmission === null) {
                throw new InvalidOperationResultError("A revalidated file creation is missing its admission decision.");
            }
        }
        // CAS — the write-side twin of #materializeMember's read-gate (synced_sig === sig). The
        // proposal was computed against the snapshot (body + baseSig); if disk drifted out-of-band
        // since propose, the full-blob write would clobber it. Refuse and surface the same neutral
        // edit collision as an entry compare-and-swap —
        // the next reconcile narrates disk truth via FsDivergence; the model re-reads + re-proposes.
        // No clever re-diff, no clobber. {§membership-edit-write-cas}
        const baseSig = (args.attrs.baseSig ?? null) as string | null;
        let currentSig: string | null = null;
        try {
            const st = await stat(canonical);
            currentSig = `${st.mtimeMs}:${st.size}`;
        } catch (err) {
            if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
        }
        // Edit → CAS on the snapshot signature (a null baseSig is an un-materialized member with no
        // recorded snapshot — no baseline to guard, so the write proceeds). Create → the proposal
        // assumed an absent path, so any file present now is the conflict.
        const conflict = existed ? (baseSig !== null && currentSig !== baseSig) : (currentSig !== null);
        if (conflict) {
            return EditCollision.result(relPath, { outcome: "edit_collision" }) as ApplyResult;
        }
        let receipt = attrs.editReceipt;
        if (body !== undefined && body !== attrs.patched) {
            const original = existed ? await readFile(canonical, "utf8") : "";
            if (receipt === undefined) {
                if (typeof attrs.patched !== "string") {
                    throw new InvalidOperationResultError(
                        "The reviewer-modified file proposal is missing its proposed content.",
                    );
                }
                receipt = editReceipt(
                    original,
                    attrs.patched,
                    [{ marker: { marks: [1, -1] }, body: attrs.patched }],
                );
            }
            receipt = reviewerReplacementReceipt(original, patched, receipt);
        }
        if (receipt !== undefined) {
            const parseIssues = await new DbProjectionCaps(core).parseIssues(patched, mimetype);
            receipt = withEditReceiptParseIssues(receipt, parseIssues);
        }
        try {
            // A write into a not-yet-existing subtree creates it — an accepted proposal must not
            // die on a missing parent dir (the fan-out digest: tasks/… write_failed on ENOENT).
            await mkdir(dirname(canonical), { recursive: true });
            await writeFile(canonical, patched, { encoding: "utf8", flag: existed ? "w" : "wx" });
        } catch (err) {
            if (!existed && (err as NodeJS.ErrnoException).code === "EEXIST") {
                return EditCollision.result(relPath, { outcome: "edit_collision" }) as ApplyResult;
            }
            console.error(`File write failed for '${relPath}':`, err);
            return Results.failure(
                "scheme:file",
                "write-failed",
                500,
                `The file could not be written: ${ErrorDetail.preview(err)}`,
                { outcome: "write_failed" },
                {
                    path: relPath,
                    stage: "filesystem-write",
                },
            ) as ApplyResult;
        }
        // Register the exact mimetype resolved at proposal time, then complete the
        // membership-owned incorporation transaction. No fallible receipt work follows.
        try {
            // {§entry-identity-no-null} — file members persist under the reserved
            // `file` identity; bare-path rendering is a projection of that row.
            const { entryId } = await EntryCrud.writeEntry({ authority: "", pathname: relPath }, {
                channels: { body: { content: patched, mimetype } },
            }, core, "file");
            // Restamp synced_sig to the landed write so the next reconcile recognizes our own
            // write as the synced state — not an FsDivergence narrated back at the model.
            if (entryId !== null) {
                const landed = await stat(canonical);
                await core.db.crud_set_synced_sig.run({ entry_id: entryId, synced_sig: `${landed.mtimeMs}:${landed.size}` });
            }
            if (!existed) {
                if (entryId === null || creationAdmission === null || !creationAdmission.ok) {
                    throw new InvalidOperationResultError("A created file is missing its entry or admission decision.");
                }
                const root = await loadWorkspaceRoot(core.db, core.workspaceId);
                if (root === null) {
                    throw new InvalidOperationResultError("A created file lost its workspace project root.");
                }
                await GitMembership.incorporateCreation(
                    core.db,
                    core.workspaceId,
                    entryId,
                    root,
                    relPath,
                    creationAdmission,
                    ctx.signal,
                );
            }
        } catch (err) {
            if (!existed) {
                const rollbackErrors: unknown[] = [];
                try {
                    const row = await core.db.crud_find_workspace_entry.get<{ id: number }>({
                        workspace_id: core.workspaceId,
                        owner_id: await Owner.commonsId(core.db, core.workspaceId),
                        scheme: "file",
                        authority: "",
                        pathname: relPath,
                    });
                    if (row !== undefined) await core.db.crud_delete_entry.run({ entry_id: row.id });
                } catch (rollbackCause) {
                    rollbackErrors.push(rollbackCause);
                }
                try {
                    await rm(canonical);
                } catch (rollbackCause) {
                    if ((rollbackCause as NodeJS.ErrnoException).code !== "ENOENT") {
                        rollbackErrors.push(rollbackCause);
                    }
                }
                if (rollbackErrors.length > 0) {
                    const rollback = new AggregateError(rollbackErrors, `Creation rollback failed for '${relPath}'.`);
                    console.error(`File creation failed and rollback was incomplete for '${relPath}':`, err, rollback);
                    return Results.failure(
                        "scheme:file",
                        "creation-rollback-failed",
                        500,
                        `The file could not be incorporated and rollback was incomplete: ${ErrorDetail.preview(rollback)}`,
                        { outcome: "creation_rollback_failed" },
                        {
                            path: relPath,
                            stage: "creation-rollback",
                            cause: ErrorDetail.preview(err),
                            retryable: false,
                        },
                    ) as ApplyResult;
                }
                console.error(`File creation incorporation failed for '${relPath}':`, err);
                return Results.failure(
                    "scheme:file",
                    "creation-incorporation-failed",
                    500,
                    `The file could not be incorporated, so its exclusive creation was rolled back: ${ErrorDetail.preview(err)}`,
                    { outcome: "creation_rolled_back" },
                    {
                        path: relPath,
                        stage: "membership-incorporation",
                        retryable: false,
                    },
                ) as ApplyResult;
            }
            // An existing-file write has already changed disk. Surface the partial
            // failure rather than pretending the addressable entry followed it.
            console.error(`File registration failed for '${relPath}':`, err);
            return Results.failure(
                "scheme:file",
                "materialization-failed",
                500,
                `The file was written to disk but could not be registered: ${ErrorDetail.preview(err)}`,
                { outcome: "materialize_failed" },
                {
                    path: relPath,
                    stage: "entry-registration",
                    retryable: false,
                },
            ) as ApplyResult;
        }
        if (receipt === undefined) return { status: 200 };
        return {
            status: 200,
            editReceipt: receipt,
            result: { receipt: projectEditReceipt(receipt, 0) },
        };
    }

    // deleteEntry — the KILL / MOVE-source counterpart of writeEntry. Deleting a host file is
    // DESTRUCTIVE, so it PROPOSES for review (202), exactly as edit() does — never an ungated unlink.
    // {§membership} — only a MEMBER reaches the proposal; a non-member is invisible (404), so untracked
    // disk is never probed or touched. applyResolution unlinks + deregisters on accept.
    async deleteEntry(pathname: string, ctx: CoreSchemeCallContext): Promise<DeleteEntryResult> {
        const core = this.coreContext(ctx);
        const root = await loadWorkspaceRoot(core.db, core.workspaceId);
        if (root === null) {
            return Results.failure(
                "scheme:file",
                "project-root-required",
                400,
                "File deletion requires a workspace project root.",
                {},
                { retryable: false },
            ) as DeleteEntryResult;
        }
        const rel = Namespace.canonicalize(pathname, root);
        if (rel === null) return Results.failure("scheme:file", "entry-not-found", 404, `No file entry exists at ${pathname}.`, {}, { target: pathname }) as DeleteEntryResult;
        const member = await core.db.crud_find_workspace_entry.get<{ id: number }>({ workspace_id: core.workspaceId, owner_id: await Owner.commonsId(core.db, core.workspaceId), scheme: "file", authority: "", pathname: rel });
        if (member === undefined) return Results.failure("scheme:file", "entry-not-found", 404, `No file entry exists at ${rel}.`, {}, { target: rel }) as DeleteEntryResult;
        return { status: 202, attrs: { deletePath: rel } };
    }

    async deleteChannel(
        pathname: string,
        channel: string,
        ctx: CoreSchemeCallContext,
    ): Promise<DeleteEntryResult> {
        if (channel !== File.manifest.defaultChannel) {
            return Results.failure(
                "scheme:file",
                "channel-not-found",
                404,
                `No channel named #${channel} exists at ${pathname}.`,
                {},
                {
                    target: pathname,
                    channel,
                },
            ) as DeleteEntryResult;
        }
        return this.deleteEntry(pathname, ctx);
    }
}
