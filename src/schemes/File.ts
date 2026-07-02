import { mkdir, realpath, stat, writeFile } from "node:fs/promises";
import { dirname, relative, isAbsolute, join, matchesGlob, sep } from "node:path";
import { createPatch } from "diff";
import type { EditStatement, ReadStatement, FindStatement, ParsedPath } from "@plurnk/plurnk-grammar";
import type { Db, PrepMethod } from "../core/Db.ts";
import { decodePathParens } from "../core/path-decode.ts";
import type { SchemeManifest, PlurnkSchemeContext } from "../core/scheme-types.ts";
import EntryOps from "./_entry-ops.ts";
import type { ReadResult } from "./_entry-ops.ts";
import EntryFind from "./_entry-find.ts";
import type { FindResult } from "./_entry-find.ts";
import EntryCrud from "./_entry-crud.ts";
import type { ReadEntryResult, EntryData, WriteEntryResult } from "./_entry-crud.ts";

// Resolved + §membership-gated disk-write target, or the error status to return.
type WriteTarget =
    | { ok: true; canonical: string; rel: string; fileExists: boolean; original: string; mimetype: string; baseSig: string | null }
    | { ok: false; status: number; error: string };
import { LineMarkerOps, MimetypeBinary } from "../content/index.ts";

type EditResult = { status: number; body?: string; attrs?: object; error?: string };
type ApplyArgs = { attrs: { path?: string; canonical?: string; patched?: string; baseSig?: string | null; existed?: boolean; [k: string]: unknown }; body?: string };
type ApplyResult = { status: number; outcome?: string; body?: string };

// Workspace root for file ops is sourced from `sessions.project_root`,
// supplied by the client at session.create or session.set_root (issue
// #150 wired the RPC; F.1 added the column). Server doesn't guess —
// the client owns workspace identity. If a session is headless
// (project_root=null), file ops fail at 400; the client either supplies
// a root or the op isn't appropriate for this session.
const loadSessionRoot = async (db: Db, sessionId: number): Promise<string | null> => {
    const row = await (db.envelope_get_session as PrepMethod).get<{ project_root: string | null }>({ id: sessionId });
    return row?.project_root ?? null;
};

// The model may hand us an absolute disk path (echoed from exec/build output) instead of the
// workspace-relative key it sees in the manifest. An absolute path UNDER the project root
// normalizes back to its relative key — so it resolves to the member, not a 404 (READ) or a
// wrong CREATE nested under root (EDIT). Outside-root absolutes don't arise: the model only
// ever sees those members as their `../`-relative keys, never an absolute form.
const toWorkspaceRelative = (pathname: string, root: string): string =>
    pathname === root || pathname.startsWith(root + sep) ? `/${relative(root, pathname)}` : pathname;

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
        storedScheme: null,  // file rows persist bare (entries.scheme = NULL); renders as a bare path
        channels: {},  // dynamic mimetype per file extension
        defaultChannel: "body",
        category: "data",
        scope: "session",
        writableBy: ["model", "client", "plugin"],
        volatile: false,
        modelVisible: true,
        example: "<<READ(README.md)::READ",
        documentation: "The project's workspace files (git-tracked members, shown as bare paths). READ and FIND them like any entry; EDIT proposes a diff for review and only writes to disk once accepted. Non-members are invisible, so you can't read or clobber a file outside the tracked surface.",
    };

    // Entry-backed, identical to Known (the unified-addressing promise): read the
    // membership-materialized entry (scheme=null) through the shared helper. <L> /
    // body / binary-415 / tag-404 are all handled there; a non-member has no entry
    // → 404, the same gate Known runs on. Disk is reached only at the materialize
    // and write-back edges (git-membership, applyResolution) — never on a read.
    async read(statement: ReadStatement, ctx: PlurnkSchemeContext): Promise<ReadResult> {
        const r = await EntryOps.readSessionEntry(statement, ctx, File.manifest);
        if (r.status !== 404) return r;
        // 404 fallback: the model may have used an absolute disk path (echoed from exec/build
        // output) instead of the relative key it sees. Normalize + retry — an absolute-under-
        // root member then resolves; anything else keeps the 404. No cost on the hit path.
        const normalized = File.#normalizeFileTarget(statement, await loadSessionRoot(ctx.db, ctx.sessionId));
        return normalized === statement ? r : EntryOps.readSessionEntry(normalized, ctx, File.manifest);
    }

    static #normalizeFileTarget<S extends { target: ParsedPath | null }>(statement: S, root: string | null): S {
        const t = statement.target;
        if (root === null || t === null) return statement;
        // A bare member parses as a LocalPath (`notes.md` / `/notes.md` → raw); a scheme'd
        // one as a UrlPath (pathname). Normalize whichever the grammar produced to the `/rel`
        // member key — the LOCAL form is what the model actually emits. regex isn't a path.
        if (t.kind === "url") {
            const norm = File.#toMemberKey(t.pathname, root);
            return norm === t.pathname ? statement : { ...statement, target: { ...t, pathname: norm } };
        }
        if (t.kind === "local") {
            const norm = File.#toMemberKey(t.raw, root);
            return norm === t.raw ? statement : { ...statement, target: { ...t, raw: norm } };
        }
        return statement;
    }

    // Map any path form the model might type to its namespace member key `/rel`, so READ
    // resolves a member the way writeEntry does (the parity that was missing — READ only
    // normalized absolute disk paths). Two forms collapse to `/rel`: an absolute path under
    // root (echoed from exec output) and a namespace-relative path — bare `notes.md`,
    // `/notes.md`, or `sub/x`, which is what the model naturally copies from the catalog.
    // A path escaping root is left unchanged → it stays a 404, so the membership boundary
    // holds (the entry-existence gate has the final say; no disk is touched on a read).
    static #toMemberKey(pathname: string, root: string): string {
        const abs = toWorkspaceRelative(pathname, root);
        if (abs !== pathname) return abs;
        const relBare = relative(root, join(root, pathname));
        return relBare === "" || relBare.startsWith("..") || isAbsolute(relBare) ? pathname : `/${relBare}`;
    }

    async find(statement: FindStatement, ctx: PlurnkSchemeContext): Promise<FindResult> {
        // Normalize the model-typed path to the `/rel` member key BEFORE the candidate
        // glob — the parity READ/EDIT already have (§scheme-address). Without it a bare
        // `notes.md` globs `notes.md*` and misses the canonical-stored `/notes.md`.
        const normalized = File.#normalizeFileTarget(statement, await loadSessionRoot(ctx.db, ctx.sessionId));
        return EntryFind.findSessionEntries(normalized, ctx, File.manifest);
    }

    // COPY/MOVE FROM file:/// — read-only, gated by entry-existence (a non-member
    // has no entry → 404). The write-back side (writeEntry) is deliberately absent;
    // see the SECURITY note above.
    async readEntry(pathname: string, ctx: PlurnkSchemeContext): Promise<ReadEntryResult> {
        return EntryCrud.readEntry(pathname, ctx, null);
    }

    // §membership disk-write gate, shared by edit() and writeEntry() (the COPY/MOVE
    // dest). Resolves the canonical path; enforces containment (traversal → 403),
    // membership (existing non-member → 403, the `.env` protection), the read-only
    // overlay (→ 403), and binary (→ 415); reads current content for the diff. A
    // not-found path is fine — we propose to CREATE. ONE home for the gate: an edit
    // and a copy into file:/// are the same disk write under the same review.
    // §membership-edit-membership-gate — membership/containment/read-only/binary gate before any disk write
    async #resolveWriteTarget(pathname: string, ctx: PlurnkSchemeContext): Promise<WriteTarget> {
        const root = await loadSessionRoot(ctx.db, ctx.sessionId);
        if (root === null) return { ok: false, status: 400, error: "session has no project_root; client must call session.create({projectRoot}) or session.set_root({projectRoot}) before file ops" };
        // An absolute disk path the model echoed → its relative key, so EDIT hits the member
        // instead of proposing a wrong CREATE nested under root (the fileExists=false path).
        pathname = toWorkspaceRelative(pathname, root);

        let canonical: string;
        // pathname is namespace-absolute (`/note`); join roots it at the workspace
        // root — the leading slash is the namespace origin, not a filesystem path.
        const requested = join(root, pathname);
        let fileExists = true;
        try {
            canonical = await realpath(requested);
        } catch (err) {
            if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
            canonical = requested;
            fileExists = false;
        }
        const relBare = relative(root, canonical);
        if (relBare.startsWith("..") || isAbsolute(relBare)) return { ok: false, status: 403, error: "path escapes workspace root" };
        const rel = `/${relBare}`;  // namespace-absolute entry key — matches the parser + membership storage

        let original = "";
        let baseSig: string | null = null;  // the snapshot signature the proposal is computed against; null = create (assumed-absent)
        if (fileExists) {
            const member = await (ctx.db.crud_get_member_sig as PrepMethod).get<{ id: number; synced_sig: string | null }>({ session_id: ctx.sessionId, scheme: null, pathname: rel });
            if (member === undefined) return { ok: false, status: 403, error: "path is outside your workspace surface" };
            const viewGlobs = (await (ctx.db.crud_list_session_constraints as PrepMethod).all<{ effect: string; glob: string }>({ session_id: ctx.sessionId }))
                .filter((c) => c.effect === "view").map((c) => c.glob);
            if (viewGlobs.some((g) => matchesGlob(relBare, g))) return { ok: false, status: 403, error: "member is read-only" }; // view = read-only member, 403 on edit — §membership-overlay-view
            // The diff base is the entry's snapshot — the body channel the model READ — not a fresh
            // disk read. EDIT is naive against the view the model saw; the write-side CAS (applyResolution)
            // guards the landing. baseSig is that snapshot's stat, carried with the proposal so a sibling
            // run's reconcile can't advance it under the paused proposal. §membership-edit-write-cas
            const snapshot = await (ctx.db.ops_read_channel as PrepMethod).get<{ content: string }>({ session_id: ctx.sessionId, scheme: null, pathname: rel, channel: "body" });
            original = snapshot?.content ?? "";
            baseSig = member.synced_sig;
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
        return { status: 202, body: patch, attrs: { path: rel, canonical, patch, patched, baseSig, existed: fileExists } };
    }

    // COPY/MOVE INTO file:/// — the dest write. Same §membership gate as edit, same 202
    // proposal + applyResolution path: a copy onto disk is a disk write and earns
    // the identical human review. Dispatcher.#copyOrchestration propagates this 202;
    // ProposalLifecycle.runApply routes the accept back here via the dest scheme;
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
        return { status: 202, created: !fileExists, entryId: null, body: patch, attrs: { path: rel, canonical, patch, patched, baseSig, existed: fileExists } };
    }

    // applyResolution — called by Engine.dispatch after a proposed log
    // entry resolves with decision=accept. Two responsibilities:
    //   1. Write the patched content to disk.
    //   2. Register the file as an entry so it appears in the manifest
    //      and the model can READ its landed work. Without (2), the
    //      model has no artifact of completion to read and tends to
    //      re-EDIT the same file across turns. The log's EDIT row + the
    //      manifest entry are what tell the model "your prior work landed."
    async applyResolution(args: ApplyArgs, ctx: PlurnkSchemeContext): Promise<ApplyResult> {
        const { attrs, body } = args;
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
            }, ctx, null);
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
        return { status: 200 };
    }
}
