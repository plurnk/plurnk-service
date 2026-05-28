import { readFile, realpath, writeFile } from "node:fs/promises";
import { resolve, relative, isAbsolute } from "node:path";
import { createPatch } from "diff";
import type { EditStatement, ReadStatement } from "@plurnk/plurnk-grammar";
import type { Db, PrepMethod } from "../core/Db.ts";
import type { SchemeManifest, PlurnkSchemeContext } from "../core/scheme-types.ts";
import { writeEntry } from "./_entry-crud.ts";

type ReadResult = { status: number; content: string | null; mimetype: string | null; error?: string };
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
        // Error messages on the 501 paths are LOAD-BEARING: they surface
        // through the engine's telemetry.errors[] to the model's next
        // packet, telling it to retry with a different shape. Without
        // these, the model sees status=501 in the log with no
        // remediation hint and burns turns guessing.
        if (statement.lineMarker !== null) {
            return { status: 501, content: null, mimetype: null, error: "READ with <line-marker> not yet supported on file://; emit READ without <line-marker> to read the entire file" };
        }
        if (statement.body !== null) {
            return { status: 501, content: null, mimetype: null, error: "READ with a matcher body not yet supported on file://; emit `<<READ(path)::READ` (empty body) to read the entire file" };
        }
        if (Array.isArray(statement.signal) && statement.signal.length > 0) {
            return { status: 501, content: null, mimetype: null, error: "READ with [tag] filters not yet supported on file://; emit `<<READ(path)::READ` without the [tag] prefix" };
        }

        const root = await loadSessionRoot(ctx.db, ctx.sessionId);
        if (root === null) return { status: 400, content: null, mimetype: null, error: "session has no project_root; cannot READ files" };

        const pathname = statement.target.kind === "url" ? statement.target.pathname : statement.target.raw;
        const resolved = await resolveContained(pathname, root);
        if ("error" in resolved) {
            if (resolved.error === "not-found") return { status: 404, content: null, mimetype: null };
            return { status: 403, content: null, mimetype: null };  // traversal
        }
        const content = await readFile(resolved.canonical, "utf8");
        return { status: 200, content, mimetype: "text/plain" };
    }

    // Edit op (task #42 canonical proposal consumer). Returns status=202
    // with a udiff body for client review + attrs carrying the full patched
    // content. Engine writes the proposed log entry, pauses dispatch, and
    // calls applyResolution() (below) after the proposal accepts.
    async edit(statement: EditStatement, ctx: PlurnkSchemeContext): Promise<EditResult> {
        if (statement.target === null) return { status: 400, error: "EDIT requires a path" };
        if (statement.lineMarker !== null) return { status: 501, error: "lineMarker-based edits not yet supported" };

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
        try {
            canonical = await realpath(requested);
            original = await readFile(canonical, "utf8");
        } catch (err) {
            if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
            // File doesn't exist — propose to create it.
            canonical = requested;
        }
        // Re-check containment against the (now-resolved-or-fabricated)
        // canonical path. The requested path could resolve to a parent of
        // workspace via symlink; reject.
        const rel = relative(root, canonical);
        if (rel.startsWith("..") || isAbsolute(rel)) {
            return { status: 403, error: "path escapes workspace root" };
        }

        const patched = statement.body ?? "";
        const patch = createPatch(rel, original, patched, "current", "proposed");
        return {
            status: 202,
            body: patch,
            attrs: {
                path: rel,
                canonical,
                patch,        // full udiff (sent to client for render)
                patched,      // full new content (used by applyResolution)
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
