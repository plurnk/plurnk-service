import { readFile, realpath, writeFile } from "node:fs/promises";
import { resolve, relative, isAbsolute, matchesGlob } from "node:path";
import { createPatch } from "diff";
import type { EditStatement, ReadStatement } from "@plurnk/plurnk-grammar";
import type { Db, PrepMethod } from "../core/Db.ts";
import type { SchemeManifest, PlurnkSchemeContext } from "../core/scheme-types.ts";
import EntryCrud from "./_entry-crud.ts";
import { LineMarkerOps, MimetypeBinary, ReadResolve } from "../content/index.ts";

type ReadResult = { status: number; content: string | null; mimetype: string | null; error?: string; startLine?: number | null; matches?: number | null; reason?: string };
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

type ContainmentResult =
    | { canonical: string; root: string }
    | { error: "no-root" | "traversal" | "not-found" };

// Resolve + workspace-root containment check. Returns the canonical
// path on success; classified error on absence/traversal. Used by read.
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

const resolveContained = async (pathname: string, root: string): Promise<ContainmentResult> => {
    const requested = isAbsolute(pathname) ? pathname : resolve(root, pathname);
    let canonical: string;
    try {
        canonical = await realpath(requested);
    } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") {
            return { error: "not-found" };
        }
        throw err;
    }
    const rel = relative(root, canonical);
    if (rel.startsWith("..") || isAbsolute(rel)) return { error: "traversal" };
    return { canonical, root };
};

// SECURITY — File deliberately implements only read() / edit() / applyResolution(),
// NOT the readEntry/writeEntry CRUD pair that COPY/MOVE dispatch on. So COPY and
// MOVE to or from a file:// path return 501 (Engine.#copyOrchestration), leaving
// read() (membership-gated) and edit()'s proposal flow (membership-gated) as the
// ONLY routes to disk. If you add readEntry/writeEntry here, they MUST carry the
// same membership gate, or COPY/MOVE becomes an ungated read/overwrite of a
// non-member — the `.env` leak/wipe the edit gate (§14.3) exists to prevent.
export default class File {
    static manifest: SchemeManifest = {
        name: "file",
        channels: {},  // dynamic mimetype per file extension
        defaultChannel: "body",
        category: "data",
        scope: "session",
        writableBy: ["model", "client", "plugin"],
        volatile: false,
        modelVisible: true,
    };

    async read(statement: ReadStatement, ctx: PlurnkSchemeContext): Promise<ReadResult> {
        if (statement.target === null) return { status: 400, content: null, mimetype: null, error: "READ requires a target path" };
        if (Array.isArray(statement.signal) && statement.signal.length > 0) {
            // file:// entries don't carry tag metadata (tags belong to canonical
            // entries; file entries are disk-truth). A tag-filtered READ on a
            // file path will never match — 404 by definition.
            return { status: 404, content: null, mimetype: null };
        }

        const root = await loadSessionRoot(ctx.db, ctx.sessionId);
        if (root === null) return { status: 400, content: null, mimetype: null, error: "session has no project_root; cannot READ files" };

        const pathname = statement.target.kind === "url" ? statement.target.pathname : statement.target.raw;
        const resolved = await resolveContained(pathname, root);
        if ("error" in resolved) {
            if (resolved.error === "not-found") return { status: 404, content: null, mimetype: null };
            return { status: 403, content: null, mimetype: null };
        }
        // Membership gate (SPEC §14.3 D4). The model reads only members:
        // entries the client added, OR git-tracked files registered as members
        // by resolveGitMembership at workspace setup (D1/D4) and refreshed at
        // prompt-composition (D5). Keyed on the canonical relpath (how members
        // are stored) AFTER the containment resolve, so a non-member is 404
        // (indistinguishable from not-found) and never reaches the read below.
        const member = await (ctx.db.crud_find_session_entry as PrepMethod).get<{ id: number }>({ session_id: ctx.sessionId, scheme: null, pathname: relative(resolved.root, resolved.canonical) });
        if (member === undefined) return { status: 404, content: null, mimetype: null };

        const mimetype = await detectFileMimetype(resolved.canonical, ctx);
        if (MimetypeBinary.isBinaryMimetype(mimetype)) return { status: 415, content: null, mimetype };

        const content = await readFile(resolved.canonical, "utf8");

        // `<L>` scopes; body matches within the scope (slice-then-match).
        // `<L>` dispatches on source mimetype (plurnk-grammar 0.13.0):
        //   JSON → LineMarkerOps.sliceJsonItems (item index)
        //   line-navigable → LineMarkerOps.sliceLines (line index)
        return ReadResolve.resolve({
            content,
            mimetype,
            lineMarker: statement.lineMarker,
            body: statement.body,
            mimetypes: ctx.mimetypes,
        });
    }

    // Edit op (task #42 canonical proposal consumer). Returns status=202
    // with a udiff body for client review + attrs carrying the full patched
    // content. Engine writes the proposed log entry, pauses dispatch, and
    // calls applyResolution() (below) after the proposal accepts.
    async edit(statement: EditStatement, ctx: PlurnkSchemeContext): Promise<EditResult> {
        if (statement.target === null) return { status: 400, error: "EDIT requires a path" };

        const root = await loadSessionRoot(ctx.db, ctx.sessionId);
        if (root === null) {
            return { status: 400, error: "session has no project_root; client must call session.create({projectRoot}) or session.set_root({projectRoot}) before file ops" };
        }

        const pathname = statement.target.kind === "url" ? statement.target.pathname : statement.target.raw;
        // Resolve existence + canonical path WITHOUT reading content yet — the
        // read is gated on membership below. A not-found target is fine (we
        // propose to create); traversal escape is fatal.
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
        // Re-check containment against the canonical path. Symlinks could
        // escape workspace; reject.
        const rel = relative(root, canonical);
        if (rel.startsWith("..") || isAbsolute(rel)) {
            return { status: 403, error: "path escapes workspace root" };
        }
        // Membership gate (SPEC §14.3), symmetric with read. EDIT may CREATE a
        // new path (proposal→accept adds it to the manifest) or edit an existing
        // MEMBER — but an existing NON-member is forbidden: never read its
        // content (no leak into the proposal) and never overwrite a file the
        // model can't see (a gitignored `.env` it never added). 403, the same
        // code as a traversal: "you can't write here," not "something is there."
        let original = "";
        if (fileExists) {
            const member = await (ctx.db.crud_find_session_entry as PrepMethod).get<{ id: number }>({ session_id: ctx.sessionId, scheme: null, pathname: rel });
            if (member === undefined) return { status: 403, error: "path is outside your workspace surface" };
            // read-only overlay (SPEC §14.3): a member matching a read-only glob is
            // readable but not writable — refuse before reading or diffing.
            const readonlyGlobs = (await (ctx.db.crud_list_session_constraints as PrepMethod).all<{ effect: string; glob: string }>({ session_id: ctx.sessionId }))
                .filter((c) => c.effect === "read-only").map((c) => c.glob);
            if (readonlyGlobs.some((g) => matchesGlob(rel, g))) return { status: 403, error: "member is read-only" };
            original = await readFile(canonical, "utf8");
        }

        // 415 on binary entries (SPEC.md §16.9).
        // Existing file's mimetype takes precedence; for new files, derive
        // from the proposed path so we don't accept binary writes via edit.
        const mimetype = await detectFileMimetype(canonical, ctx);
        if (MimetypeBinary.isBinaryMimetype(mimetype)) return { status: 415, error: `cannot EDIT binary mimetype \`${mimetype}\`` };

        // `<L>` line marker dispatches on file mimetype: JSON →
        // LineMarkerOps.applyJsonItemEdit (structural item edit); otherwise →
        // LineMarkerOps.applyLineMarkerEdit (line edit). On a non-existent file,
        // body becomes content regardless of marker (per "Resolved
        // ambiguities" §3).
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
        return {
            status: 202,
            body: patch,
            attrs: {
                path: rel,
                canonical,
                patch,
                patched,
            },
        };
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
