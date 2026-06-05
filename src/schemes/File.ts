import { readFile, realpath, writeFile } from "node:fs/promises";
import { resolve, relative, isAbsolute } from "node:path";
import { createPatch } from "diff";
import type { EditStatement, ReadStatement } from "@plurnk/plurnk-grammar";
import type { Db, PrepMethod } from "../core/Db.ts";
import type { SchemeManifest, PlurnkSchemeContext } from "../core/scheme-types.ts";
import { writeEntry } from "./_entry-crud.ts";
import { isBinaryMimetype, isJsonMimetype, normalizeAutoTextMimetype, TEXT_PRIMITIVE_MIMETYPE } from "../content/index.ts";
import { sliceLines, sliceJsonItems, applyLineMarkerEdit, applyJsonItemEdit } from "../content/index.ts";
import { matchAgainstContent } from "../content/index.ts";

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
// `normalizeAutoTextMimetype` wrapper ensures text/plain returned by the
// service is normalized to text/markdown — plurnk-service never auto-
// derives text/plain (see mimetype-binary.ts TEXT_PRIMITIVE_MIMETYPE).
const detectFileMimetype = async (canonical: string, ctx: PlurnkSchemeContext): Promise<string> => {
    if (ctx.mimetypes !== undefined) {
        const detected = await ctx.mimetypes.detect({ path: canonical });
        return normalizeAutoTextMimetype(detected);
    }
    return TEXT_PRIMITIVE_MIMETYPE;
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
        flags: {
            proposes: true,  // file writes go through proposal lifecycle (task #42)
        },
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
        if (isBinaryMimetype(mimetype)) return { status: 415, content: null, mimetype };

        const content = await readFile(resolved.canonical, "utf8");

        // `<L>` scopes; body matches within the scope (slice-then-match).
        // `<L>` dispatches on source mimetype (plurnk-grammar 0.13.0):
        //   JSON → sliceJsonItems (item index)
        //   line-navigable → sliceLines (line index)
        let workingContent = content;
        let workingStart: number | null = 1;
        let workingMimetypeForSlice = TEXT_PRIMITIVE_MIMETYPE;
        if (statement.lineMarker !== null) {
            if (isJsonMimetype(mimetype)) {
                const sliced = sliceJsonItems(content, statement.lineMarker);
                if (sliced.status !== 200) return { status: sliced.status, content: null, mimetype };
                workingContent = sliced.body ?? "[]";
                workingStart = null;
                workingMimetypeForSlice = "application/json";
            } else {
                const sliced = sliceLines(content, statement.lineMarker);
                if (sliced.status !== 200) return { status: sliced.status, content: null, mimetype };
                workingContent = sliced.text ?? "";
                workingStart = sliced.startLine ?? null;
            }
        }
        if (statement.body !== null) {
            if (ctx.mimetypes === undefined) {
                return { status: 500, content: null, mimetype };
            }
            const matched = await matchAgainstContent(statement.body, workingContent, mimetype, ctx.mimetypes, workingStart ?? 1);
            if (matched.status === 204) {
                return { status: 204, content: "", mimetype: "application/json", startLine: null, matches: 0 };
            }
            if (matched.status === 203) {
                return { status: 203, content: matched.body ?? "", mimetype: matched.mimetype ?? "text/markdown", startLine: 1, reason: matched.reason };
            }
            if (matched.status !== 200) return { status: matched.status, content: null, mimetype };
            return { status: 200, content: matched.body ?? "[]", mimetype: "application/json", startLine: null, matches: matched.matches };
        }
        if (statement.lineMarker !== null) {
            const isEmptyJsonArray = workingMimetypeForSlice === "application/json" && workingContent === "[]";
            if (workingContent === "" || isEmptyJsonArray) {
                return { status: 204, content: "", mimetype: workingMimetypeForSlice, startLine: null };
            }
            return { status: 200, content: workingContent, mimetype: workingMimetypeForSlice, startLine: workingStart };
        }
        if (content === "") return { status: 204, content: "", mimetype, startLine: null };
        return { status: 200, content, mimetype, startLine: 1 };
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
        // Containment check (canonical path inside workspace). For edits,
        // a not-found target is fine — we're proposing to create or
        // overwrite. Traversal escape is fatal.
        let canonical: string;
        const requested = isAbsolute(pathname) ? pathname : resolve(root, pathname);
        let original = "";
        let fileExists = true;
        try {
            canonical = await realpath(requested);
            original = await readFile(canonical, "utf8");
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

        // 415 on binary entries (SPEC.md §16.9).
        // Existing file's mimetype takes precedence; for new files, derive
        // from the proposed path so we don't accept binary writes via edit.
        const mimetype = await detectFileMimetype(canonical, ctx);
        if (isBinaryMimetype(mimetype)) return { status: 415, error: `cannot EDIT binary mimetype \`${mimetype}\`` };

        // `<L>` line marker dispatches on file mimetype: JSON →
        // applyJsonItemEdit (structural item edit); otherwise →
        // applyLineMarkerEdit (line edit). On a non-existent file,
        // body becomes content regardless of marker (per "Resolved
        // ambiguities" §3).
        const body = statement.body ?? "";
        let patched: string;
        if (statement.lineMarker !== null && fileExists) {
            const result = isJsonMimetype(mimetype)
                ? applyJsonItemEdit(original, statement.lineMarker, body)
                : applyLineMarkerEdit(original, statement.lineMarker, body);
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
    //   2. Register an entries+visibility row so the file appears in
    //      the next packet's # Plurnk System Index. Without (2), the
    //      model has no artifact of completion to read and tends to
    //      re-EDIT the same file across turns. The index is what tells
    //      the model "your prior work landed."
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
        // Register the file as an indexed entry so the next packet's
        // # Plurnk System Index shows it under file://<relPath> with
        // the body content visible. mimetype is best-effort by file
        // extension; .md → text/markdown, anything else → text/plain.
        const mimetype = relPath.endsWith(".md") ? "text/markdown" : "text/plain";
        try {
            // scheme=null: the "file" scheme is a routing internal only;
            // never stored. Entries.scheme stays NULL for filesystem rows
            // so render-time bare-path output requires no special case.
            await writeEntry(relPath, {
                channels: { body: { content: patched, mimetype } },
                tags: [],
            }, ctx, null);
        } catch (err) {
            // Disk write succeeded; entry registration failed. Surface
            // the write as 200 (file is on disk) but log the failure —
            // index just won't reflect it until next time.
            // (Could harden to roll back the file write; for v0,
            // disk-truth-of-record wins.)
            return {
                status: 200,
                outcome: "indexed_failed",
                body: err instanceof Error ? err.message : String(err),
            };
        }
        return { status: 200 };
    }
}
