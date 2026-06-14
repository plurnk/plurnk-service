// SPEC §membership D4 — git-ls-files workspace membership.
//
// When a session's `project_root` is a git working tree, the git-tracked
// files (`git ls-files`) are workspace MEMBERS without any explicit client
// `add`. This module resolves that membership and (when token accounting is
// available) materializes active members' disk content into a body channel,
// so they appear in the manifest catalog (plurnk://manifest.json) and are READ-able.
//
// Decisions realized here:
//   D1 — workspace identity lives on the session (project_root).
//   D3 — disk co-location: members are channel-less markers until materialized;
//        disk stays the truth.
//   D4 — git present → ls-files membership. git absent → no fs-walk (this
//        module no-ops on a non-git project_root, leaving headless / non-git
//        sessions completely unaffected). The add/ignore/read-only constraint
//        overlay (session_constraints) layers on top: resolveMembership applies
//        `(ls-files ∪ add) − ignore`; read-only is enforced at the File edit gate.
//   D5 — EMI is eager + exhaustive: every active member is re-read from disk at
//        resolution time so a divergent member reflects current disk content.
//
// git resolution shells out via node:child_process (the same surface the
// File scheme's tests and the demo fixture use) and respects AbortSignal.

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile, glob, stat } from "node:fs/promises";
import { resolve, matchesGlob } from "node:path";
import type { Mimetypes } from "@plurnk/plurnk-mimetypes";
import { MimetypeBinary } from "../content/index.ts";
import type { Db, PrepMethod } from "./Db.ts";
import type { PlurnkSchemeContext } from "./scheme-types.ts";
import EntryCrud from "../schemes/_entry-crud.ts";

// §env-delta — an ambient disk divergence captured at pre-turn: the entry's content
// before the git-membership re-read vs the disk content after. The plurnk run narrates
// it as a source=file EDIT so every run pulls it through the one delta path.
export interface FsDivergence {
    pathname: string;
    scheme: string | null;
    entryId: number;
    channel: string;
    before: string;
    after: string;
}

export default class GitMembership {
    static #execFileP = promisify(execFile);

    // project_root for a session. NULL = headless (no membership). Read once per
    // resolution; the File scheme reads the same column for its own root.
    static async #loadSessionRoot(db: Db, sessionId: number): Promise<string | null> {
        const row = await (db.envelope_get_session as PrepMethod).get<{ project_root: string | null }>({ id: sessionId });
        return row?.project_root ?? null;
    }

    // Is `root` the top of a git working tree? `git rev-parse --is-inside-work-tree`
    // exits non-zero (throws here) when `root` is not under git — the gate that
    // keeps non-git / headless sessions out of any git path (D4: "git absent → no
    // fs-walk"). Conservative: any git failure means "not a git workspace."
    static async #isGitWorkTree(root: string, signal: AbortSignal | undefined): Promise<boolean> {
        try {
            const { stdout } = await GitMembership.#execFileP("git", ["rev-parse", "--is-inside-work-tree"], { cwd: root, signal });
            return stdout.trim() === "true";
        } catch {
            return false;
        }
    }

    // Tracked files, workspace-relative, via `git ls-files -z`. NUL-delimited so
    // paths with spaces/newlines survive. Empty repo → [].
    static async #gitTrackedFiles(root: string, signal: AbortSignal | undefined): Promise<string[]> {
        const { stdout } = await GitMembership.#execFileP("git", ["ls-files", "-z"], { cwd: root, signal, maxBuffer: 64 * 1024 * 1024 });
        return stdout.split("\0").filter((p) => p.length > 0);
    }

    // Detect a tracked file's mimetype (mirrors File.detectFileMimetype): route
    // through the Mimetypes service when present, normalizing the auto-text result
    // to the text primitive (plurnk-service never auto-derives text/plain). No
    // service → text primitive.
    static async #detectMimetype(canonical: string, mimetypes: Mimetypes | undefined): Promise<string> {
        if (mimetypes !== undefined) {
            const detected = await mimetypes.detect({ path: canonical });
            return MimetypeBinary.normalizeAutoTextMimetype(detected);
        }
        return MimetypeBinary.TEXT_PRIMITIVE_MIMETYPE;
    }

    // Resolve a session's file membership: the desired set is (git ls-files ∪ add
    // globs) − ignore globs (SPEC §membership overlay), reconciled against the registered
    // overlay-owned members so entries == members. Channel-less rows — disk is the
    // truth (D3); the row is the membership marker File.read gates on. Returns the
    // desired pathnames so the caller can materialize them through writeEntry.
    //
    // signal-respecting: git shell-outs + the add scan honor `signal`. Headless
    // (no project_root) yields nothing; a non-git root with add-globs still resolves.
    static async resolveGitMembership(
        db: Db,
        sessionId: number,
        signal: AbortSignal | undefined,
    ): Promise<string[]> {
        const root = await GitMembership.#loadSessionRoot(db, sessionId);
        if (root === null) return [];   // headless — no disk surface to resolve

        const constraints = await (db.crud_list_session_constraints as PrepMethod).all<{ effect: string; glob: string }>({ session_id: sessionId });
        const ignoreGlobs = constraints.filter((c) => c.effect === "ignore").map((c) => c.glob);
        const addGlobs = constraints.filter((c) => c.effect === "add").map((c) => c.glob);

        // git substrate — empty when root isn't a git worktree, so `add` is then the
        // SOLE membership source (SPEC §membership). No early-return on non-git.
        const tracked = await GitMembership.#isGitWorkTree(root, signal)
            ? await GitMembership.#gitTrackedFiles(root, signal)
            : [];

        // `add` overlay — a targeted, client-dictated scan for untracked matches
        // (node:fs glob over the client's pattern, never a blind walk).
        const added = addGlobs.length === 0 ? [] : await GitMembership.#scanAddMembers(root, addGlobs, signal);

        // Compose: (git ∪ add) − ignore, tracking origin for reconciliation — a path
        // in `tracked` is 'git', an add-only match is 'constraint'.
        const trackedSet = new Set(tracked);
        const passesIgnore = (p: string): boolean => ignoreGlobs.length === 0 || !ignoreGlobs.some((g) => matchesGlob(p, g));
        const desiredGit = tracked.filter(passesIgnore);
        const desiredAdd = added.filter((p) => !trackedSet.has(p) && passesIgnore(p));
        const desired = [...desiredGit, ...desiredAdd];
        const desiredSet = new Set(desired);

        // Reconcile so entries == members (the constitutive invariant): register the
        // desired with their origin, then un-register any overlay-owned member ('git'
        // or 'constraint') no longer desired — untracked, unmatched, or newly ignored.
        // Model-created ('client') members are never reclaimed.
        for (const pathname of desiredGit) {
            await (db.crud_register_session_member as PrepMethod).get({ session_id: sessionId, scheme: null, pathname, membership_origin: "git" });
        }
        for (const pathname of desiredAdd) {
            await (db.crud_register_session_member as PrepMethod).get({ session_id: sessionId, scheme: null, pathname, membership_origin: "constraint" });
        }
        const registered = await (db.crud_list_reconcilable_members as PrepMethod).all<{ id: number; pathname: string }>({ session_id: sessionId });
        for (const m of registered) {
            if (!desiredSet.has(m.pathname)) {
                await (db.crud_delete_entry as PrepMethod).run({ entry_id: m.id });
            }
        }
        return desired;
    }

    // Targeted client-dictated scan (SPEC §membership `add`) — enumerate disk files
    // matching the client's add-globs via node:fs glob (the pattern bounds the
    // traversal; never a blind fs-walk). Files only — directories aren't members.
    // Workspace-relative paths, the same shape as git ls-files.
    static async #scanAddMembers(
        root: string,
        addGlobs: string[],
        signal: AbortSignal | undefined,
    ): Promise<string[]> {
        const matches = new Set<string>();
        for (const pattern of addGlobs) {
            for await (const rel of glob(pattern, { cwd: root })) {
                if (signal?.aborted) return [...matches];
                try {
                    if ((await stat(resolve(root, rel))).isFile()) matches.add(rel);
                } catch {
                    // raced away between glob and stat — not a member
                }
            }
        }
        return [...matches];
    }

    // Materialize a member's disk content into a body channel via writeEntry (the
    // entry-write paradigm) — so it appears in the manifest catalog and is READ-able
    // (D4/D5). Re-reads disk each call (eager + exhaustive — every active
    // member, no relevance pass). Binary members materialize as an EMPTY body
    // channel stamped with their binary mimetype (#186 — visible in the manifest
    // and READ-415 via the one isBinaryMimetype gate, not a 404 ghost).
    // Missing-on-disk (tracked but deleted in the working tree) is
    // skipped — membership stands, no channel.
    static async #materializeMember(
        pathname: string,
        root: string,
        ctx: PlurnkSchemeContext,
    ): Promise<FsDivergence | null> {
        const canonical = resolve(root, pathname);
        const mimetype = await GitMembership.#detectMimetype(canonical, ctx.mimetypes);
        if (MimetypeBinary.isBinaryMimetype(mimetype)) {
            // Empty body channel stamped with the real binary mimetype — a first-
            // class entry that READ-415s through readSessionEntry's isBinaryMimetype
            // gate (#186), not a channel-less row that would read as 404.
            await EntryCrud.writeEntry(pathname, { channels: { body: { content: "", mimetype } }, tags: [] }, ctx, null);
            return null;  // binary bodies are empty markers — no text divergence to narrate
        }
        let content: string;
        try {
            content = await readFile(canonical, "utf8");
        } catch (err) {
            if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
            throw err;
        }
        // §env-delta — capture an out-of-band disk change BEFORE the refresh overwrites
        // the entry: an existing body channel whose content differs from disk is an
        // ambient divergence (D5). writeEntry then refreshes the entry to disk truth.
        const prior = await (ctx.db.ops_read_channel as PrepMethod).get<{ content: string }>({
            session_id: ctx.sessionId, scheme: null, pathname, channel: "body",
        });
        const result = await EntryCrud.writeEntry(pathname, { channels: { body: { content, mimetype } }, tags: [] }, ctx, null);
        if (prior !== undefined && prior.content !== content && result.entryId !== null) {
            return { pathname, scheme: null, entryId: result.entryId, channel: "body", before: prior.content, after: content };
        }
        return null;
    }

    // Full membership + materialization pass for a run. Registers git members,
    // then materializes each active (on-disk, non-binary) member as an entry
    // through writeEntry. Called at packet-composition time (Engine.runTurn) per
    // D5. No-ops on headless / non-git sessions.
    static async indexGitMembership(ctx: PlurnkSchemeContext): Promise<FsDivergence[]> {
        const root = await GitMembership.#loadSessionRoot(ctx.db, ctx.sessionId);
        if (root === null) return [];
        const tracked = await GitMembership.resolveGitMembership(ctx.db, ctx.sessionId, ctx.signal);
        const divergences: FsDivergence[] = [];
        for (const pathname of tracked) {
            const divergence = await GitMembership.#materializeMember(pathname, root, ctx);
            if (divergence !== null) divergences.push(divergence);
        }
        return divergences;
    }
}
