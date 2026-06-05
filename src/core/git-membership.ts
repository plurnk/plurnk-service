// SPEC §14.3 D4 — git-ls-files workspace membership.
//
// When a session's `project_root` is a git working tree, the git-tracked
// files (`git ls-files`) are workspace MEMBERS without any explicit client
// `add`. This module resolves that membership and (when token accounting is
// available) materializes active members' disk content into a body channel +
// visibility so they surface in packet.system.index.
//
// Decisions realized here:
//   D1 — workspace identity lives on the session (project_root).
//   D3 — disk co-location: members are channel-less markers until materialized;
//        disk stays the truth.
//   D4 — git present → ls-files membership. git absent → no fs-walk (this
//        module no-ops on a non-git project_root, leaving headless / non-git
//        sessions completely unaffected). The add/ignore/read-only constraint
//        overlay (session_constraints) is a documented follow-up — not built
//        here; bare git-ls-files membership is the whole of this phase.
//   D5 — EMI is eager + relevance-bounded: materialize is re-read from disk at
//        resolution time so a divergent member reflects current disk content.
//
// git resolution shells out via node:child_process (the same surface the
// File scheme's tests and the demo fixture use) and respects AbortSignal.

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { Mimetypes } from "@plurnk/plurnk-mimetypes";
import { MimetypeBinary } from "../content/index.ts";
import type { Db, PrepMethod } from "./Db.ts";
import type { PlurnkSchemeContext } from "./scheme-types.ts";
import EntryCrud from "../schemes/_entry-crud.ts";

const execFileP = promisify(execFile);

// project_root for a session. NULL = headless (no membership). Read once per
// resolution; the File scheme reads the same column for its own root.
const loadSessionRoot = async (db: Db, sessionId: number): Promise<string | null> => {
    const row = await (db.envelope_get_session as PrepMethod).get<{ project_root: string | null }>({ id: sessionId });
    return row?.project_root ?? null;
};

// Is `root` the top of a git working tree? `git rev-parse --is-inside-work-tree`
// exits non-zero (throws here) when `root` is not under git — the gate that
// keeps non-git / headless sessions out of any git path (D4: "git absent → no
// fs-walk"). Conservative: any git failure means "not a git workspace."
const isGitWorkTree = async (root: string, signal: AbortSignal | undefined): Promise<boolean> => {
    try {
        const { stdout } = await execFileP("git", ["rev-parse", "--is-inside-work-tree"], { cwd: root, signal });
        return stdout.trim() === "true";
    } catch {
        return false;
    }
};

// Tracked files, workspace-relative, via `git ls-files -z`. NUL-delimited so
// paths with spaces/newlines survive. Empty repo → [].
const gitTrackedFiles = async (root: string, signal: AbortSignal | undefined): Promise<string[]> => {
    const { stdout } = await execFileP("git", ["ls-files", "-z"], { cwd: root, signal, maxBuffer: 64 * 1024 * 1024 });
    return stdout.split("\0").filter((p) => p.length > 0);
};

// Detect a tracked file's mimetype (mirrors File.detectFileMimetype): route
// through the Mimetypes service when present, normalizing the auto-text result
// to the text primitive (plurnk-service never auto-derives text/plain). No
// service → text primitive.
const detectMimetype = async (canonical: string, mimetypes: Mimetypes | undefined): Promise<string> => {
    if (mimetypes !== undefined) {
        const detected = await mimetypes.detect({ path: canonical });
        return MimetypeBinary.normalizeAutoTextMimetype(detected);
    }
    return MimetypeBinary.TEXT_PRIMITIVE_MIMETYPE;
};

// Register every git-tracked file as a bare session member (scheme=null),
// idempotently. Channel-less — disk is the truth (D3); the row is the
// membership marker File.read gates on. Returns the tracked pathnames so the
// caller can materialize them through writeEntry.
//
// signal-respecting: the git shell-outs honor `signal`; on a non-git or
// headless root nothing is touched.
export const resolveGitMembership = async (
    db: Db,
    sessionId: number,
    signal: AbortSignal | undefined,
): Promise<string[]> => {
    const root = await loadSessionRoot(db, sessionId);
    if (root === null) return [];
    if (!await isGitWorkTree(root, signal)) return [];

    const tracked = await gitTrackedFiles(root, signal);
    for (const pathname of tracked) {
        await (db.crud_register_session_member as PrepMethod).get({ session_id: sessionId, scheme: null, pathname });
    }
    return tracked;
};

// Materialize a member's disk content into a body channel + visibility for the
// run via writeEntry (the entry-write paradigm) — so it surfaces in
// packet.system.index (D4/D5). Re-reads disk each call (eager + relevance-
// bounded). Binary files are members but never materialized into a text
// channel. Missing-on-disk (tracked but deleted in the working tree) is
// skipped — membership stands, no channel.
const materializeMember = async (
    pathname: string,
    root: string,
    ctx: PlurnkSchemeContext,
): Promise<void> => {
    const canonical = resolve(root, pathname);
    const mimetype = await detectMimetype(canonical, ctx.mimetypes);
    if (MimetypeBinary.isBinaryMimetype(mimetype)) return;
    let content: string;
    try {
        content = await readFile(canonical, "utf8");
    } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
        throw err;
    }
    // writeEntry finds the registered member (scheme=null) and refreshes its
    // body channel each turn, so a member edited out-of-band reflects current
    // disk content (D5) — tokenization + visibility flow through the paradigm.
    await EntryCrud.writeEntry(pathname, { channels: { body: { content, mimetype } }, tags: [] }, ctx, null);
};

// Full membership + materialization pass for a run. Registers git members,
// then materializes each active (on-disk, non-binary) member into the index
// through writeEntry. Called at packet-composition time (Engine.runTurn) per
// D5. No-ops on headless / non-git sessions.
export const indexGitMembership = async (ctx: PlurnkSchemeContext): Promise<void> => {
    const root = await loadSessionRoot(ctx.db, ctx.sessionId);
    if (root === null) return;
    const tracked = await resolveGitMembership(ctx.db, ctx.sessionId, ctx.signal);
    for (const pathname of tracked) {
        await materializeMember(pathname, root, ctx);
    }
};
