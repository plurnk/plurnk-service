import { readFile, realpath, writeFile } from "node:fs/promises";
import { resolve, relative, isAbsolute } from "node:path";
import { createPatch } from "diff";
import type { EditStatement, ReadStatement } from "@plurnk/plurnk-grammar";
import type { Db, PrepMethod } from "../core/Db.ts";
import type { SchemeManifest, PlurnkSchemeContext } from "../core/scheme-types.ts";

type ReadResult = { status: number; content: string | null; mimetype: string | null };
type EditResult = { status: number; body?: string; attrs?: object; error?: string };
type ApplyArgs = { attrs: { path?: string; patched?: string; [k: string]: unknown }; body?: string };
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
        if (statement.path === null) return { status: 400, content: null, mimetype: null };
        if (statement.lineMarker !== null) return { status: 501, content: null, mimetype: null };
        if (statement.body !== null) return { status: 501, content: null, mimetype: null };
        if (Array.isArray(statement.signal) && statement.signal.length > 0) return { status: 501, content: null, mimetype: null };

        const root = await loadSessionRoot(ctx.db, ctx.sessionId);
        if (root === null) return { status: 400, content: null, mimetype: null };

        const pathname = statement.path.kind === "url" ? statement.path.pathname : statement.path.raw;
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
        if (statement.path === null) return { status: 400, error: "EDIT requires a path" };
        if (statement.lineMarker !== null) return { status: 501, error: "lineMarker-based edits not yet supported" };

        const root = await loadSessionRoot(ctx.db, ctx.sessionId);
        if (root === null) {
            return { status: 400, error: "session has no project_root; client must call session.create({projectRoot}) or session.set_root({projectRoot}) before file ops" };
        }

        const pathname = statement.path.kind === "url" ? statement.path.pathname : statement.path.raw;
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
    // entry resolves with decision=accept. Reads the attrs that the
    // earlier edit() returned and writes the patched content to disk.
    // Returns the final outcome that gets stored on the log entry.
    async applyResolution(args: ApplyArgs): Promise<ApplyResult> {
        const { attrs, body } = args;
        const canonical = attrs.canonical;
        const patched = body ?? attrs.patched;
        if (typeof canonical !== "string" || canonical.length === 0) {
            return { status: 500, outcome: "applyResolution: missing attrs.canonical" };
        }
        if (typeof patched !== "string") {
            return { status: 500, outcome: "applyResolution: missing patched content" };
        }
        try {
            await writeFile(canonical, patched, "utf8");
            return { status: 200 };
        } catch (err) {
            return {
                status: 500,
                outcome: "write_failed",
                body: err instanceof Error ? err.message : String(err),
            };
        }
    }
}
