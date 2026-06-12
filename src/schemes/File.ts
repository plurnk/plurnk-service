import { readFile, realpath, writeFile } from "node:fs/promises";
import { resolve, relative, isAbsolute, matchesGlob } from "node:path";
import { createPatch } from "diff";
import type { EditStatement, ReadStatement, FindStatement } from "@plurnk/plurnk-grammar";
import type { Db, PrepMethod } from "../core/Db.ts";
import type { SchemeManifest, PlurnkSchemeContext } from "../core/scheme-types.ts";
import EntryOps from "./_entry-ops.ts";
import type { ReadResult } from "./_entry-ops.ts";
import EntryFind from "./_entry-find.ts";
import type { FindResult } from "./_entry-find.ts";
import EntryCrud from "./_entry-crud.ts";
import type { ReadEntryResult, EntryData, WriteEntryResult } from "./_entry-crud.ts";

// Resolved + §14.3-gated disk-write target, or the error status to return.
type WriteTarget =
    | { ok: true; canonical: string; rel: string; fileExists: boolean; original: string; mimetype: string }
    | { ok: false; status: number; error: string };
import { LineMarkerOps, MimetypeBinary } from "../content/index.ts";

type EditResult = { status: number; body?: string; attrs?: object; error?: string };
type ApplyArgs = { attrs: { path?: string; canonical?: string; patched?: string; [k: string]: unknown }; body?: string };
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
// and edit()/applyResolution()'s proposal-gated write-OUT (§14.3), where the
// containment/traversal checks live.
//
// writeEntry() is deliberately ABSENT: a COPY/MOVE *into* file:// is a disk write
// and MUST flow through the §14.3 proposal gate (like EDIT), not an ungated
// overwrite — the `.env`-wipe this guard prevents. So COPY/MOVE *from* file://
// works (readEntry); *into* file:// stays 501 until the proposal-gated write-back
// lands. The 501 is duck-typed on writeEntry's absence (Engine.#copyOrchestration).
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
    };

    // Entry-backed, identical to Known (the unified-addressing promise): read the
    // membership-materialized entry (scheme=null) through the shared helper. <L> /
    // body / binary-415 / tag-404 are all handled there; a non-member has no entry
    // → 404, the same gate Known runs on. Disk is reached only at the materialize
    // and write-back edges (git-membership, applyResolution) — never on a read.
    async read(statement: ReadStatement, ctx: PlurnkSchemeContext): Promise<ReadResult> {
        return EntryOps.readSessionEntry(statement, ctx, File.manifest);
    }

    async find(statement: FindStatement, ctx: PlurnkSchemeContext): Promise<FindResult> {
        return EntryFind.findSessionEntries(statement, ctx, File.manifest);
    }

    // COPY/MOVE FROM file:// — read-only, gated by entry-existence (a non-member
    // has no entry → 404). The write-back side (writeEntry) is deliberately absent;
    // see the SECURITY note above.
    async readEntry(pathname: string, ctx: PlurnkSchemeContext): Promise<ReadEntryResult> {
        return EntryCrud.readEntry(pathname, ctx, null);
    }

    // §14.3 disk-write gate, shared by edit() and writeEntry() (the COPY/MOVE
    // dest). Resolves the canonical path; enforces containment (traversal → 403),
    // membership (existing non-member → 403, the `.env` protection), the read-only
    // overlay (→ 403), and binary (→ 415); reads current content for the diff. A
    // not-found path is fine — we propose to CREATE. ONE home for the gate: an edit
    // and a copy into file:// are the same disk write under the same review.
    async #resolveWriteTarget(pathname: string, ctx: PlurnkSchemeContext): Promise<WriteTarget> {
        const root = await loadSessionRoot(ctx.db, ctx.sessionId);
        if (root === null) return { ok: false, status: 400, error: "session has no project_root; client must call session.create({projectRoot}) or session.set_root({projectRoot}) before file ops" };

        let canonical: string;
        const requested = isAbsolute(pathname) ? pathname : resolve(root, pathname);
        let fileExists = true;
        try {
            canonical = await realpath(requested);
        } catch (err) {
            if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
            canonical = requested;
            fileExists = false;
        }
        const rel = relative(root, canonical);
        if (rel.startsWith("..") || isAbsolute(rel)) return { ok: false, status: 403, error: "path escapes workspace root" };

        let original = "";
        if (fileExists) {
            const member = await (ctx.db.crud_find_session_entry as PrepMethod).get<{ id: number }>({ session_id: ctx.sessionId, scheme: null, pathname: rel });
            if (member === undefined) return { ok: false, status: 403, error: "path is outside your workspace surface" };
            const readonlyGlobs = (await (ctx.db.crud_list_session_constraints as PrepMethod).all<{ effect: string; glob: string }>({ session_id: ctx.sessionId }))
                .filter((c) => c.effect === "read-only").map((c) => c.glob);
            if (readonlyGlobs.some((g) => matchesGlob(rel, g))) return { ok: false, status: 403, error: "member is read-only" };
            original = await readFile(canonical, "utf8");
        }

        const mimetype = await detectFileMimetype(canonical, ctx);
        if (MimetypeBinary.isBinaryMimetype(mimetype)) return { ok: false, status: 415, error: `cannot write binary mimetype \`${mimetype}\`` };
        return { ok: true, canonical, rel, fileExists, original, mimetype };
    }

    // Edit op (task #42 canonical proposal consumer). Returns status=202
    // with a udiff body for client review + attrs carrying the full patched
    // content. Engine writes the proposed log entry, pauses dispatch, and
    // calls applyResolution() (below) after the proposal accepts.
    async edit(statement: EditStatement, ctx: PlurnkSchemeContext): Promise<EditResult> {
        if (statement.target === null) return { status: 400, error: "EDIT requires a path" };
        const pathname = statement.target.kind === "url" ? statement.target.pathname : statement.target.raw;
        const target = await this.#resolveWriteTarget(pathname, ctx);
        if (!target.ok) return { status: target.status, error: target.error };
        const { canonical, rel, fileExists, original, mimetype } = target;

        // `<L>` line marker dispatches on file mimetype: JSON →
        // LineMarkerOps.applyJsonItemEdit (structural item edit); otherwise →
        // LineMarkerOps.applyLineMarkerEdit (line edit). On a non-existent file,
        // body becomes content regardless of marker (per "Resolved ambiguities" §3).
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
        return { status: 202, body: patch, attrs: { path: rel, canonical, patch, patched } };
    }

    // COPY/MOVE INTO file:// — the dest write. Same §14.3 gate as edit, same 202
    // proposal + applyResolution path: a copy onto disk is a disk write and earns
    // the identical human review. Engine.#copyOrchestration propagates this 202;
    // Engine.#runApplyResolution routes the accept back here via the dest scheme;
    // applyResolution() writes the file + registers the entry. The copied content
    // is the source's body channel (full replacement — files are body-only).
    async writeEntry(pathname: string, entry: EntryData, ctx: PlurnkSchemeContext): Promise<WriteEntryResult> {
        const bodyChannel = entry.channels.body;
        if (bodyChannel === undefined) return { status: 400, created: false, entryId: null };
        const target = await this.#resolveWriteTarget(pathname, ctx);
        if (!target.ok) return { status: target.status, created: false, entryId: null };
        const { canonical, rel, fileExists, original } = target;
        const patched = bodyChannel.content;
        const patch = createPatch(rel, original, patched, "current", "proposed");
        return { status: 202, created: !fileExists, entryId: null, body: patch, attrs: { path: rel, canonical, patch, patched } };
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
        try {
            await writeFile(canonical, patched, "utf8");
        } catch (err) {
            return {
                status: 500,
                outcome: "write_failed",
                body: err instanceof Error ? err.message : String(err),
            };
        }
        // Register the file as an entry so it appears in the manifest
        // under file://<relPath> and is READ-able. mimetype is best-effort
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
            // §14.3/§14.5 — advance this run's watermark to the just-written content,
            // so the model's own accepted edit isn't re-reported next turn as an
            // external disk divergence (the EMI signal is for OUT-of-band changes
            // only). Mirrors editSessionEntry's reconcile.
            if (ctx.runId !== undefined) {
                await (ctx.db.engine_set_watermark as PrepMethod).run({ run_id: ctx.runId, entry_id: entryId, channel: "body", content: patched });
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
