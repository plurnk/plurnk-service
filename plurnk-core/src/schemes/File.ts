import { mkdir, realpath, rm, stat, writeFile } from "node:fs/promises";
import Namespace from "../core/namespace.ts";
import Owner from "../core/Owner.ts";
import { dirname, relative, isAbsolute, join, matchesGlob, sep } from "node:path";
import { createPatch } from "diff";
import type { EditStatement, ReadStatement, FindStatement, ParsedPath } from "@plurnk/plurnk-grammar";
import type { Db, PrepMethod } from "../core/Db.ts";
import { decodePathParens } from "../core/path-decode.ts";
import GitMembership from "../core/git-membership.ts";
import type { SchemeManifest, PlurnkSchemeContext } from "../core/scheme-types.ts";
import EntryOps from "./_entry-ops.ts";
import type { ReadResult } from "./_entry-ops.ts";
import EntryFind from "./_entry-find.ts";
import type { FindResult } from "./_entry-find.ts";
import EntryCrud from "./_entry-crud.ts";
import type { ReadEntryResult, EntryData, WriteEntryResult, DeleteEntryResult } from "./_entry-crud.ts";

// Resolved + §membership-change-gated-sync disk-write target, or the error status to return.
type WriteTarget =
    | { ok: true; canonical: string; rel: string; fileExists: boolean; original: string; mimetype: string; baseSig: string | null }
    | { ok: false; status: number; error: string };
import { LineMarkerOps, MimetypeBinary, editedSpan } from "../content/index.ts";

type EditResult = { status: number; body?: string; attrs?: object; error?: string };
type ApplyArgs = { attrs: { path?: string; canonical?: string; patched?: string; span?: string; deletePath?: string; baseSig?: string | null; existed?: boolean; [k: string]: unknown }; body?: string };
type ApplyResult = { status: number; outcome?: string; body?: string };

// Workspace root for file ops is sourced from `workspaces.project_root`,
// supplied by the client at workspace.create (headless is forever; issue
// #150 wired the RPC; F.1 added the column). Server doesn't guess —
// the client owns workspace identity. If a workspace is headless
// (project_root=null), file ops fail at 400; the client either supplies
// a root or the op isn't appropriate for this workspace.
const loadWorkspaceRoot = async (db: Db, workspaceId: number): Promise<string | null> => {
    const row = await (db.envelope_get_workspace as PrepMethod).get<{ project_root: string | null }>({ id: workspaceId });
    return row?.project_root ?? null;
};


// Detect mimetype from a file's path. Routes through the Mimetypes service
// when available; falls back to the text primitive (text/markdown). The
// `MimetypeBinary.normalizeAutoTextMimetype` wrapper ensures text/plain returned by the
// service is normalized to text/markdown — plurnk-service never auto-
// derives text/plain (see mimetype-binary.ts MimetypeBinary.TEXT_PRIMITIVE_MIMETYPE).
const detectFileMimetype = async (canonical: string, ctx: PlurnkSchemeContext): Promise<string> => {
    if (ctx.mimetypes !== undefined) {
        const detected = await ctx.mimetypes.detect({ path: canonical });
        return MimetypeBinary.normalizeAutoTextMimetype(detected);
    }
    return MimetypeBinary.TEXT_PRIMITIVE_MIMETYPE;
};

// SECURITY — File is entry-backed, identical to Known: read()/find()/readEntry()
// delegate to the shared Entry* helpers over the membership-materialized entries
// (scheme=null). The membership gate is now ENTRY-EXISTENCE — a non-member has no
// entry, so read/find/readEntry 404 it for free, the same invariant Known runs on
// (a gitignored `.env` is never a member → never an entry → never readable). Disk
// I/O is confined to the two edges that own it: the git-membership materialize-IN
// and edit()/applyResolution()'s proposal-gated write-OUT (§membership), where the
// containment/traversal checks live.
//
// writeEntry() is the proposal-gated write-back: a COPY/MOVE *into* file:/// is a disk
// write, so it flows through the SAME §membership gate as EDIT (#resolveWriteTarget) — a
// 202 proposal, then applyResolution() writes on accept — never an ungated overwrite (the
// `.env`-wipe this guard prevents). COPY/MOVE *from* file:/// is readEntry (read-only).
export default class File {
    static manifest: SchemeManifest = {
        name: "file",
        storedScheme: "file",  // {§entry-identity-no-null} — file rows persist under the reserved 'file' scheme (a NULL identity component voids the UNIQUE index; run59/#545); renders as a bare path
        channels: {},  // dynamic mimetype per file extension
        defaultChannel: "body",
        category: "data",
        scope: "workspace",
        writableBy: ["model", "client", "plugin"],
        volatile: false,
        modelVisible: true,
        example: "<<READ(README.md)::READ",
        documentation: "The project's workspace files (git-tracked members, shown as bare paths) — THE TASK'S FILES: when asked to change the project, EDIT these, not your notes or scratch. READ and FIND them like any entry; EDIT proposes a diff for review and only writes to disk once accepted — the review is normal, not a refusal, so propose the edit rather than working around it. Non-members are invisible, so you can't read or clobber a file outside the tracked surface.",
    };

    // Entry-backed, identical to Known (the unified-addressing promise): read the
    // membership-materialized entry (scheme=null) through the shared helper. <L> /
    // body / binary-415 / tag-404 are all handled there; a non-member has no entry
    // → 404, the same gate Known runs on. Disk is reached only at the materialize
    // and write-back edges (git-membership, applyResolution) — never on a read.
    async read(statement: ReadStatement, ctx: PlurnkSchemeContext): Promise<ReadResult> {
        // {§fs-namei} — canonicalize ONCE, up front: resolution never depends on what exists
        // (the old fold-on-miss retry was existence-dependent meaning, run59's disease class).
        const canon = File.#canonTarget(statement, await loadWorkspaceRoot(ctx.db, ctx.workspaceId));
        return EntryOps.readWorkspaceEntry(canon ?? statement, ctx, File.manifest);
    }

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

    // Folderhood survives canonicalization (§find-scope-prefix-filter) — the shared
    // spelling canon lives on Namespace (the Dispatcher's log columns use the same one).
    static #canonSpelling(raw: string, root: string | null): string | null {
        return Namespace.canonicalizeSpelling(raw, root);
    }

    async find(statement: FindStatement, ctx: PlurnkSchemeContext): Promise<FindResult> {
        // {§fs-namei} — canonicalize the glob's path portion before the candidate scan, the
        // same seam READ/EDIT use; a bare `notes.md` and `/notes.md` scan identically.
        const canon = File.#canonTarget(statement, await loadWorkspaceRoot(ctx.db, ctx.workspaceId));
        return EntryFind.findWorkspaceEntries(canon ?? statement, ctx, File.manifest);
    }

    // COPY/MOVE FROM file:/// — read-only, gated by entry-existence (a non-member
    // has no entry → 404). The write-back side (writeEntry) is deliberately absent;
    // see the SECURITY note above.
    async readEntry(pathname: string, ctx: PlurnkSchemeContext): Promise<ReadEntryResult> {
        // §scheme-address — normalize the model-typed path (bare `brief.md`) to its `/rel` member key,
        // the same parity READ/EDIT/deleteEntry have. Without it a COPY/MOVE FROM a bare file path
        // misses the canonical-stored member and 404s a source that plainly exists.
        const root = await loadWorkspaceRoot(ctx.db, ctx.workspaceId);
        const key = root === null ? pathname : Namespace.canonicalize(pathname, root);
        return EntryCrud.readEntry(key ?? pathname, ctx, "file");
    }

    // §membership disk-write gate, shared by edit() and writeEntry() (the COPY/MOVE
    // dest). Resolves the canonical path; enforces containment (traversal → 403),
    // membership (existing non-member → 403, the `.env` protection), the read-only
    // overlay (→ 403), and binary (→ 415); reads current content for the diff. A
    // not-found path is fine — we propose to CREATE. ONE home for the gate: an edit
    // and a copy into file:/// are the same disk write under the same review.
    // §membership-edit-membership-gate — membership/containment/read-only/binary gate before any disk write
    async #resolveWriteTarget(pathname: string, ctx: PlurnkSchemeContext): Promise<WriteTarget> {
        const root = await loadWorkspaceRoot(ctx.db, ctx.workspaceId);
        if (root === null) return { ok: false, status: 400, error: "workspace has no project_root (headless is forever) — file ops need a workspace created with projectRoot" };
        // {§fs-namei} — the write side resolves through the SAME canonicalizer as reads;
        // a spelling that names nothing a file can be is refused before any disk touch.
        const key = Namespace.canonicalize(pathname, root);
        if (key === null) return { ok: false, status: 403, error: "path escapes workspace root" };
        const isMount = key.startsWith("../");

        let canonical: string;
        const requested = join(root, key);
        let fileExists = true;
        try {
            canonical = await realpath(requested);
        } catch (err) {
            if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
            canonical = requested;
            fileExists = false;
        }
        // {§fs-write-surface} 6 — only the root mints: no create on any mount, ever.
        if (isMount && !fileExists) return { ok: false, status: 403, error: "only the project root mints — create outside it is refused" };
        if (!isMount) {
            const relBare = relative(root, canonical);
            // in-tree keys whose realpath escapes (a symlink out) stay refused — the jail holds.
            if (relBare.startsWith("..") || isAbsolute(relBare)) return { ok: false, status: 403, error: "path escapes workspace root" };
        }
        const rel = key;  // the bare canonical member key ({§fs-canonical-name}) — storage ≡ wire

        let original = "";
        let baseSig: string | null = null;  // the snapshot signature the proposal is computed against; null = create (assumed-absent)
        if (fileExists) {
            const member = await (ctx.db.crud_get_member_sig as PrepMethod).get<{ id: number; synced_sig: string | null; membership_origin: string | null }>({ workspace_id: ctx.workspaceId, owner_id: await Owner.commonsId(ctx.db, ctx.workspaceId), scheme: "file", pathname: rel });
            // {§fs-errno} — the occupancy fact (POSIX O_EXCL precedent): something invisible
            // occupies the path; existence leaks, content stays dark. The model picks another name.
            if (member === undefined) return { ok: false, status: 403, error: `a file exists at ${rel}` };
            // {§fs-write-surface} 5 — a git-included mount member is read-only: git's grants
            // confer rw only within the project; only an explicit client grant carries write.
            if (isMount && member.membership_origin === "git") return { ok: false, status: 403, error: "member is read-only" };
            const viewGlobs = (await (ctx.db.crud_list_workspace_constraints as PrepMethod).all<{ effect: string; glob: string }>({ workspace_id: ctx.workspaceId }))
                .filter((c) => c.effect === "view").map((c) => c.glob);
            if (viewGlobs.some((g) => matchesGlob(rel, g))) return { ok: false, status: 403, error: "member is read-only" }; // view = read-only member, 403 on edit — §membership-overlay-view
            // The diff base is the entry's snapshot — the body channel the model READ — not a fresh
            // disk read. EDIT is naive against the view the model saw; the write-side CAS (applyResolution)
            // guards the landing. baseSig is that snapshot's stat, carried with the proposal so a sibling
            // worker's reconcile can't advance it under the paused proposal. §membership-edit-write-cas
            const snapshot = await (ctx.db.ops_read_channel as PrepMethod).get<{ content: string }>({ workspace_id: ctx.workspaceId, owner_id: await Owner.commonsId(ctx.db, ctx.workspaceId), scheme: "file", pathname: rel, channel: "body" });
            original = snapshot?.content ?? "";
            baseSig = member.synced_sig;
        } else {
            // {§fs-write-surface} 1 — the blind-write closure: an exclusive CREATE is legal only
            // where the RESULT will be a member. A client pick admits it; else git's auto-add
            // must (untracked-not-ignored). A non-git root grants nothing by itself.
            const picks = (await (ctx.db.crud_list_workspace_constraints as PrepMethod).all<{ effect: string; glob: string }>({ workspace_id: ctx.workspaceId }))
                .filter((c) => c.effect === "pick").map((c) => c.glob);
            const clientAdmits = picks.some((g) => matchesGlob(rel, g));
            if (!clientAdmits && !(await GitMembership.wouldGitAdmit(root, rel, ctx.signal))) {
                return { ok: false, status: 403, error: "create refused — the result would not be a member (git ignores it and no client pick covers it)" };
            }
        }

        const mimetype = await detectFileMimetype(canonical, ctx);
        if (MimetypeBinary.isBinaryMimetype(mimetype)) return { ok: false, status: 415, error: `cannot write binary mimetype \`${mimetype}\`` };
        return { ok: true, canonical, rel, fileExists, original, mimetype, baseSig };
    }

    // Edit op (task #42 canonical proposal consumer). Returns status=202
    // with a udiff body for client review + attrs carrying the full patched
    // content. Engine writes the proposed log entry, pauses dispatch, and
    // calls applyResolution() (below) after the proposal accepts.
    async edit(statement: EditStatement, ctx: PlurnkSchemeContext): Promise<EditResult> {
        if (statement.target === null) return { status: 400, error: "EDIT requires a path" };
        const pathname = statement.target.kind === "regex" ? statement.target.raw
            : decodePathParens(statement.target.kind === "url" ? statement.target.pathname : statement.target.raw); // #239 item 4
        const target = await this.#resolveWriteTarget(pathname, ctx);
        if (!target.ok) return { status: target.status, error: target.error };
        const { canonical, rel, fileExists, original, mimetype, baseSig } = target;

        // `<L>` line marker dispatches on file mimetype: JSON →
        // LineMarkerOps.applyJsonItemEdit (structural item edit); otherwise →
        // LineMarkerOps.applyLineMarkerEdit (line edit). On a non-existent file,
        // body becomes content regardless of marker (per "Resolved ambiguities" §scheme).
        const body = statement.body ?? "";
        let patched: string;
        if (statement.lineMarker !== null && fileExists) {
            const result = MimetypeBinary.isJsonMimetype(mimetype)
                ? LineMarkerOps.applyJsonItemEdit(original, statement.lineMarker, body)
                : LineMarkerOps.applyLineMarkerEdit(original, statement.lineMarker, body);
            if (result.status !== 200) return { status: result.status, error: result.error };
            patched = result.result ?? "";
        } else {
            patched = body;
        }

        const patch = createPatch(rel, original, patched, "current", "proposed");
        return { status: 202, body: patch, attrs: { path: rel, canonical, patch, patched, span: editedSpan(original, patched), baseSig, existed: fileExists } };
    }

    // COPY/MOVE INTO file:/// — the dest write. Same §membership gate as edit, same 202
    // proposal + applyResolution path: a copy onto disk is a disk write and earns
    // the identical human review. Dispatcher.#copyOrchestration propagates this 202;
    // ProposalLifecycle.workerApply routes the accept back here via the dest scheme;
    // applyResolution() writes the file + registers the entry. The copied content
    // is the source's body channel (full replacement — files are body-only).
    async writeEntry(pathname: string, entry: EntryData, ctx: PlurnkSchemeContext): Promise<WriteEntryResult> {
        const bodyChannel = entry.channels.body;
        if (bodyChannel === undefined) return { status: 400, created: false, entryId: null };
        const target = await this.#resolveWriteTarget(pathname, ctx);
        if (!target.ok) return { status: target.status, created: false, entryId: null };
        const { canonical, rel, fileExists, original, baseSig } = target;
        const patched = bodyChannel.content;
        const patch = createPatch(rel, original, patched, "current", "proposed");
        return { status: 202, created: !fileExists, entryId: null, body: patch, attrs: { path: rel, canonical, patch, patched, span: editedSpan(original, patched), baseSig, existed: fileExists } };
    }

    // applyResolution — called by Engine.dispatch after a proposed log
    // entry resolves with decision=accept. Two responsibilities:
    //   1. Write the patched content to disk.
    //   2. Register the file as an entry so it appears in the manifest and the
    //      model can READ its full landed work.
    // The accepted result returns the editedSpan diff as its body, so the EDIT row
    // itself carries the line-numbered confirmation of what changed — parity with the
    // entry-scheme EDIT's span; default-folding reclaims it at the next turn boundary.
    async applyResolution(args: ApplyArgs, ctx: PlurnkSchemeContext): Promise<ApplyResult> {
        const { attrs, body } = args;
        // Delete-apply (deferred behind review — the KILL proposal, or the MOVE source-delete gated by
        // its dest proposal): unlink the host file + deregister the entry on accept. A real unlink
        // failure surfaces as 500, never a silent noop; ENOENT ⇒ file already gone, still deregister.
        if (typeof attrs.deletePath === "string") {
            const root = await loadWorkspaceRoot(ctx.db, ctx.workspaceId);
            if (root === null) return { status: 500, outcome: "no project_root" };
            try {
                await rm(join(root, attrs.deletePath));
            } catch (err) {
                if ((err as NodeJS.ErrnoException).code !== "ENOENT") return { status: 500, outcome: "delete_failed", body: err instanceof Error ? err.message : String(err) };
            }
            await EntryCrud.deleteEntry(attrs.deletePath, ctx, "file");
            return { status: 200 };
        }
        const canonical = attrs.canonical;
        const relPath = attrs.path;
        const patched = body ?? attrs.patched;
        if (typeof canonical !== "string" || canonical.length === 0) {
            return { status: 500, outcome: "applyResolution: missing attrs.canonical" };
        }
        if (typeof relPath !== "string" || relPath.length === 0) {
            return { status: 500, outcome: "applyResolution: missing attrs.path" };
        }
        if (typeof patched !== "string") {
            return { status: 500, outcome: "applyResolution: missing patched content" };
        }
        // CAS — the write-side twin of #materializeMember's read-gate (synced_sig === sig). The
        // proposal was computed against the snapshot (body + baseSig); if disk drifted out-of-band
        // since propose, the full-blob write would clobber it. Refuse and surface a write_conflict —
        // the next reconcile narrates disk truth via FsDivergence; the model re-reads + re-proposes.
        // No clever re-diff, no clobber. §membership-edit-write-cas
        const baseSig = (args.attrs.baseSig ?? null) as string | null;
        const existed = args.attrs.existed === true;  // proposal targeted an existing member (edit) vs a fresh create
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
            return { status: 409, outcome: `write_conflict: ${relPath} changed on disk since the proposal (expected ${existed ? baseSig : "absent"}, found ${currentSig ?? "absent"}) — re-read and re-propose` };
        }
        try {
            // A write into a not-yet-existing subtree creates it — an accepted proposal must not
            // die on a missing parent dir (the fan-out digest: tasks/… write_failed on ENOENT).
            await mkdir(dirname(canonical), { recursive: true });
            await writeFile(canonical, patched, "utf8");
        } catch (err) {
            return {
                status: 500,
                outcome: "write_failed",
                body: err instanceof Error ? err.message : String(err),
            };
        }
        // Register the file as an entry so it appears in the manifest
        // under file:///<relPath> and is READ-able. mimetype is best-effort
        // by file extension; .md → text/markdown, anything else → text/plain.
        const mimetype = relPath.endsWith(".md") ? "text/markdown" : "text/plain";
        try {
            // scheme=null: the "file" scheme is a routing internal only;
            // never stored. Entries.scheme stays NULL for filesystem rows
            // so render-time bare-path output requires no special case.
            const { entryId } = await EntryCrud.writeEntry(relPath, {
                channels: { body: { content: patched, mimetype } },
                tags: [],
            }, ctx, "file");
            // Restamp synced_sig to the landed write so the next reconcile recognizes our own
            // write as the synced state — not an FsDivergence narrated back at the model.
            if (entryId !== null) {
                const landed = await stat(canonical);
                await (ctx.db.crud_set_synced_sig as PrepMethod).run({ entry_id: entryId, synced_sig: `${landed.mtimeMs}:${landed.size}` });
            }
        } catch (err) {
            // Disk write succeeded; entry registration failed. Surface
            // the write as 200 (file is on disk) but log the failure —
            // the manifest just won't reflect it until next time.
            // (Could harden to roll back the file write; for v0,
            // disk-truth-of-record wins.)
            return {
                status: 200,
                outcome: "materialize_failed",
                body: err instanceof Error ? err.message : String(err),
            };
        }
        return { status: 200, body: attrs.span };
    }

    // deleteEntry — the KILL / MOVE-source counterpart of writeEntry. Deleting a host file is
    // DESTRUCTIVE, so it PROPOSES for review (202), exactly as edit() does — never an ungated unlink.
    // §membership — only a MEMBER reaches the proposal; a non-member is invisible (404), so untracked
    // disk is never probed or touched. applyResolution unlinks + deregisters on accept.
    async deleteEntry(pathname: string, ctx: PlurnkSchemeContext): Promise<DeleteEntryResult> {
        const root = await loadWorkspaceRoot(ctx.db, ctx.workspaceId);
        if (root === null) return { status: 400 };
        const rel = Namespace.canonicalize(pathname, root);
        if (rel === null) return { status: 404 };
        const member = await (ctx.db.crud_find_workspace_entry as PrepMethod).get<{ id: number }>({ workspace_id: ctx.workspaceId, owner_id: await Owner.commonsId(ctx.db, ctx.workspaceId), scheme: "file", pathname: rel });
        if (member === undefined) return { status: 404 };
        return { status: 202, attrs: { deletePath: rel } };
    }
}
