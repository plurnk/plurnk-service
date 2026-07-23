// SPEC §membership D4 — git-ls-files workspace membership. §membership-git-membership
//
// When a workspace's `project_root` is a git working tree, the git-tracked
// files (`git ls-files`) are workspace MEMBERS without any explicit client
// `pick`. This module resolves that membership and (when token accounting is
// available) materializes active members' disk content into a body channel,
// so they appear in the entry catalog (FIND-served) and are READ-able.
//
// Decisions realized here:
//   D1 — workspace identity lives on the workspace (project_root).
//   D3 — disk co-location: members are channel-less markers until materialized;
//        disk stays the truth.
//   D4 — git present → ls-files membership. git absent → no fs-walk (this
//        module no-ops on a non-git project_root, leaving headless / non-git
//        workspaces completely unaffected). The pick/hide/view constraint
//        overlay (workspace_constraints) layers on top: resolveMembership applies
//        `(ls-files ∪ pick) − hide`; view is enforced at the File edit gate.
//   D5 — coverage is exhaustive, work is change-gated: every member is stat'd each
//        turn, but only one whose mtime:size signature changed is re-read,
//        re-tokenized, and rewritten; an unchanged member is a no-op, and the EMI
//        divergence rides that same pass. {§membership-change-gated-sync}
//
// git resolution is in-process by default (GitIso / isomorphic-git, #461) — portable,
// sandbox-safe, hermetic by construction. PLURNK_SERVICE_GIT_NATIVE=1 routes to system git
// (subprocess + hermeticGitEnv, AbortSignal-respecting) — the in-process membership pass
// measures ~8x native (~130ms at 20k files), so a large-repo host can buy the hot path back.

import { execFile } from "node:child_process";
import { hermeticGitEnv } from "./git-env.ts";
import GitIso from "./git-iso.ts";
import { promisify } from "node:util";
import { readFile, glob, stat } from "node:fs/promises";
import { resolve, relative, join, matchesGlob } from "node:path";
import type { Mimetypes } from "@plurnk/plurnk-mimetypes";
import { MimetypeBinary } from "../content/index.ts";
import type { Db, PrepMethod } from "./Db.ts";
import type { PlurnkSchemeContext } from "./scheme-types.ts";
import Owner from "./Owner.ts";
import EntryCrud from "../schemes/_entry-crud.ts";
import WorkspaceSettings from "./workspace-settings.ts";

// §env-delta — an ambient disk divergence captured at pre-turn: the entry's content
// before the git-membership re-read vs the disk content after. The plurnk worker narrates
// it as a source=file EDIT so every worker pulls it through the one delta path.
export interface FsDivergence {
    pathname: string;
    scheme: string | null;
    entryId: number;
    channel: string;
    before: string;
    after: string;
}

// Feature-flag convention: `=== "1"` exactly. Default (unset/0) = the in-process GitIso backend.
const nativeGit = (): boolean => process.env.PLURNK_SERVICE_GIT_NATIVE === "1";

export default class GitMembership {
    // Workspace creation starts a background warm while the first model turn
    // performs its own eager membership refresh. Both are legitimate callers,
    // but materialization is a delete-then-insert channel write: overlapping
    // passes can race on the same (entry_id, body). Serialize only the same
    // workspace in the same DB; different workspaces remain independent.
    static #indexChains = new WeakMap<Db, Map<number, Promise<void>>>();

    static #execFileP = promisify(execFile);

    // {§fs-write-surface} — the blind-write closure git half: would git ADMIT a create at
    // key (untracked-not-ignored)? check-ignore exit 0 = ignored (refuse), 1 = clean
    // (admit via auto-add), anything else (128, no repo) = git grants nothing here.
    static async wouldGitAdmit(root: string, key: string, signal?: AbortSignal): Promise<boolean> {
        try {
            await GitMembership.#execFileP("git", ["check-ignore", "-q", "--", key], { cwd: root, signal, env: hermeticGitEnv() });
            return false;
        } catch (err) {
            return (err as { code?: number }).code === 1;
        }
    }

    // project_root for a workspace. NULL = headless (no membership). Read once per
    // resolution; the File scheme reads the same column for its own root.
    static async #loadWorkspaceRoot(db: Db, workspaceId: number): Promise<string | null> {
        const row = await (db.envelope_get_workspace as PrepMethod).get<{ project_root: string | null }>({ id: workspaceId });
        return row?.project_root ?? null;
    }

    // Tracked files of one repo, workspace-relative — GitIso.trackedFiles (walk STAGE, blob
    // entries only) or `git ls-files --stage -z` under the native flag. Either way gitlinks
    // are filtered: a submodule (mode 160000, a commit pointer — a directory on disk, not a
    // file) is a separate declared repo, never a member of its superproject. Empty → [].
    static async #gitTrackedFiles(root: string, signal: AbortSignal | undefined, cache: object): Promise<string[]> {
        if (!nativeGit()) return GitIso.trackedFiles(root, cache);
        // NUL-delimited so paths with spaces/newlines survive.
        const { stdout } = await GitMembership.#execFileP("git", ["ls-files", "--stage", "-z"], { cwd: root, signal, maxBuffer: 64 * 1024 * 1024, env: hermeticGitEnv() });
        const files: string[] = [];
        for (const entry of stdout.split("\0")) {
            if (entry.length === 0) continue;
            const tab = entry.indexOf("\t");
            if (tab === -1) continue;
            if (entry.slice(0, entry.indexOf(" ")) === "160000") continue;  // gitlink — a submodule boundary
            files.push(entry.slice(tab + 1));
        }
        return files;
    }

    // Untracked-but-not-ignored files of one repo (SPEC §membership-auto-add) —
    // GitIso.untrackedFiles (the differential-gated pruning ignore-walk) or `git ls-files
    // --others --exclude-standard -z` under the native flag. A model-created file is a repo
    // member the moment it exists — no git-stage required — while `.gitignore` still filters it.
    static async #gitUntrackedFiles(root: string, signal: AbortSignal | undefined, cache: object): Promise<string[]> {
        if (!nativeGit()) return GitIso.untrackedFiles(root, cache);
        const { stdout } = await GitMembership.#execFileP("git", ["ls-files", "--others", "--exclude-standard", "-z"], { cwd: root, signal, maxBuffer: 64 * 1024 * 1024, env: hermeticGitEnv() });
        return stdout.split("\0").filter((e) => e.length > 0);
    }

    // Resolve a declared repo folder to its git toplevel (the repo root containing it), or
    // null if it isn't inside a git tree. GitIso.repoToplevel (findRoot) or `rev-parse
    // --show-toplevel` under the native flag — both handle plain repos, linked worktrees
    // (`.git` is a gitdir: file), and submodules alike.
    static async #repoToplevel(dir: string, signal: AbortSignal | undefined): Promise<string | null> {
        if (!nativeGit()) return GitIso.repoToplevel(dir);
        try {
            const { stdout } = await GitMembership.#execFileP("git", ["rev-parse", "--show-toplevel"], { cwd: dir, signal, env: hermeticGitEnv() });
            return stdout.trim();
        } catch {
            return null;  // not a git tree (or the dir is gone) — contributes nothing
        }
    }

    // The forest (SPEC §membership, §membership-forest): union every declared repo's MEMBERS —
    // tracked files PLUS untracked-but-not-ignored ones (§membership-auto-add) — each
    // path-prefixed by the repo's location relative to the workspace root (empty prefix when
    // the repo IS the root). Repos that don't resolve are skipped.
    static async #forestMembers(root: string, repoDirs: string[], signal: AbortSignal | undefined): Promise<string[]> {
        // Resolve every declared entry to its git toplevel, deduped: a glob (`*`) and an
        // explicit declaration can name the same repo, and resolving one repo twice is
        // wasted git work. {§membership-forest}
        const repoRoots = new Set<string>();
        for (const dir of repoDirs) {
            for (const candidate of await GitMembership.#expandRepoDirs(root, dir, signal)) {
                const repoRoot = await GitMembership.#repoToplevel(resolve(root, candidate), signal);
                if (repoRoot !== null) repoRoots.add(repoRoot);
            }
        }
        const members = new Set<string>();
        // One iso-git cache per PASS: pack/index parses are reused across this resolve's repos
        // and reads, then discarded — never carried across turns, so a rewritten index or
        // repacked store can't serve stale.
        const cache = {};
        for (const repoRoot of repoRoots) {
            // project_root is no boundary — only the relative-address base. EVERY member is
            // addressed relative to the root, a repo outside it included (a `..`-prefixed
            // path) — so the universal `join(root, pathname)` disk-resolver works unchanged;
            // an absolute pathname would nest UNDER root and never materialize. {§membership-overlay-repo}
            const prefix = relative(root, repoRoot);
            const tracked = await GitMembership.#gitTrackedFiles(repoRoot, signal, cache);
            const untracked = await GitMembership.#gitUntrackedFiles(repoRoot, signal, cache);
            for (const f of [...tracked, ...untracked]) {
                members.add(join(prefix, f));
            }
        }
        return [...members];
    }

    // A declared repo entry → the candidate directories it names. A literal path (no glob
    // magic) passes through untouched — preserving the "declare a repo ANYWHERE, including
    // OUTSIDE the root via `..` or an absolute path" contract that glob can't address upward.
    // A glob pattern is directory-expanded under the root via node:fs glob — `*` matches each
    // immediate child (one level), `**` recurses — dropping file matches, since only a
    // directory can be a repo; #repoToplevel then filters the non-git matches. {§membership-overlay-repo}
    static async #expandRepoDirs(root: string, dir: string, signal: AbortSignal | undefined): Promise<string[]> {
        if (!GitMembership.#isGlobPattern(dir)) return [dir];
        const dirs: string[] = [];
        for await (const rel of glob(dir, { cwd: root })) {
            if (signal?.aborted) return dirs;
            try {
                if ((await stat(resolve(root, rel))).isDirectory()) dirs.push(rel);
            } catch {
                // raced away between glob and stat — not a candidate
            }
        }
        return dirs;
    }

    // Does this declared repo entry carry glob magic (directory-expand it), or is it a
    // literal path (declared as-is)? The metacharacters node:fs glob honors.
    static #isGlobPattern(s: string): boolean {
        return /[*?[\]{}]/.test(s);
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

    // Shared overlay inputs — the candidate sets (git tracked+untracked union, pick scan) and
    // the overlay globs, before composition. Single-sources the (git ∪ pick) derivation + the
    // glob sets for resolveGitMembership (compose + reconcile) and resolveMembershipEffects
    // (derive per-file effect for clients, #243). Headless (no project_root) → null.
    static async #resolveOverlayInputs(
        db: Db,
        workspaceId: number,
        signal: AbortSignal | undefined,
    ): Promise<{ root: string; gitMembers: string[]; picked: string[]; hideGlobs: string[]; viewGlobs: string[] } | null> {
        const root = await GitMembership.#loadWorkspaceRoot(db, workspaceId);
        if (root === null) return null;   // headless — no disk surface to resolve

        const constraints = await (db.crud_list_workspace_constraints as PrepMethod).all<{ effect: string; glob: string }>({ workspace_id: workspaceId });
        const hideGlobs = constraints.filter((c) => c.effect === "hide").map((c) => c.glob);
        const pickGlobs = constraints.filter((c) => c.effect === "pick").map((c) => c.glob);
        const viewGlobs = constraints.filter((c) => c.effect === "view").map((c) => c.glob);

        // git substrate — the union of the workspace's DECLARED repos' MEMBERS: tracked files
        // plus untracked-but-not-ignored ones (§membership-auto-add). PLURNK_SERVICE_GIT_ALLOWED=0 is
        // the hard ceiling (deny all git membership); PLURNK_SERVICE_GIT_AUTO=1 declares project_root
        // as an implicit repo. Empty when git is denied or no declared repo resolves, so
        // `pick` is then the sole source. No early-return on non-git.
        const repoDirs = constraints.filter((c) => c.effect === "repo").map((c) => c.glob); // a declared repo's ls-files join membership, path-prefixed — §membership-overlay-repo
        if (process.env.PLURNK_SERVICE_GIT_AUTO === "1") repoDirs.push(root); // ALLOWED ceiling gates the AUTO default — §membership-git-flags
        // #232 — git:false is a workspace-level tighten of the env ALLOWED ceiling (env AND workspace).
        const workspaceGit = (await WorkspaceSettings.read(db, workspaceId)).git;
        const gitMembers = process.env.PLURNK_SERVICE_GIT_ALLOWED === "1" && workspaceGit !== false
            ? await GitMembership.#forestMembers(root, repoDirs, signal)
            : [];

        // `pick` overlay — a targeted, client-dictated scan for untracked matches
        // (node:fs glob over the client's pattern, never a blind walk).
        const picked = pickGlobs.length === 0 ? [] : await GitMembership.#scanPickMembers(root, pickGlobs, signal); // §membership-overlay-pick
        return { root, gitMembers, picked, hideGlobs, viewGlobs };
    }

    // Resolve a workspace's file membership: the desired set is (git ls-files ∪ pick
    // globs) − hide globs (SPEC §membership overlay), reconciled against the registered
    // overlay-owned members so entries == members. Channel-less rows — disk is the
    // truth (D3); the row is the membership marker File.read gates on. Returns the
    // desired pathnames so the caller can materialize them through writeEntry.
    //
    // signal-respecting: git shell-outs + the pick scan honor `signal`. Headless
    // (no project_root) yields nothing; a non-git root with pick-globs still resolves.
    static async resolveGitMembership(
        db: Db,
        workspaceId: number,
        signal: AbortSignal | undefined,
    ): Promise<string[]> {
        const inputs = await GitMembership.#resolveOverlayInputs(db, workspaceId, signal);
        if (inputs === null) return [];   // headless — no disk surface to resolve
        const { gitMembers: members, picked, hideGlobs } = inputs;

        // Compose: (git ∪ pick) − hide (§membership-overlay-hide), tracking origin for reconciliation — a path
        // in `members` is 'git', a pick-only match is 'constraint'.
        const memberSet = new Set(members);
        const passesHide = (p: string): boolean => hideGlobs.length === 0 || !hideGlobs.some((g) => matchesGlob(p, g));
        const desiredGit = members.filter(passesHide);
        const desiredPick = picked.filter((p) => !memberSet.has(p) && passesHide(p));
        // Glob matching above stays bare (client `pick`/`hide` patterns are bare);
        // storage, reconcile, and the returned set are namespace-absolute (`/src/foo.ts`)
        // so they match the parser's pathname the shared read helper queries by.
        const desired = [...desiredGit, ...desiredPick]; // bare canon keys ({§fs-canonical-name}) — ls-files output IS the canon
        const desiredSet = new Set(desired);

        // Reconcile so entries == members (the constitutive invariant): register the
        // desired with their origin, then un-register any overlay-owned member ('git'
        // or 'constraint') no longer desired — untracked, unmatched, or newly hidden.
        // Model-created ('client') members are never reclaimed.
        const commonsId = await Owner.commonsId(db, workspaceId);
        for (const pathname of desiredGit) {
            await (db.crud_register_workspace_member as PrepMethod).get({ workspace_id: workspaceId, owner_id: commonsId, scheme: "file", pathname, membership_origin: "git" });
        }
        for (const pathname of desiredPick) {
            await (db.crud_register_workspace_member as PrepMethod).get({ workspace_id: workspaceId, owner_id: commonsId, scheme: "file", pathname, membership_origin: "constraint" });
        }
        const registered = await (db.crud_list_reconcilable_members as PrepMethod).all<{ id: number; pathname: string }>({ workspace_id: workspaceId });
        for (const m of registered) {
            if (!desiredSet.has(m.pathname)) {
                await (db.crud_delete_entry as PrepMethod).run({ entry_id: m.id });
            }
        }
        return desired;
    }

    // Resolve each candidate's membership EFFECT without mutating — a read for clients (#243,
    // plurnk.nvim gutter signs): the same (git ∪ pick) / hide / view resolution resolveGitMembership
    // composes, surfaced per-file so a client signs member/view/hidden with ZERO glob-matching of
    // its own. `members` are (git ∪ pick) − hide, each tagged `view` (read-only, refused at the
    // File edit gate §membership-overlay-view) or plain `member`; `hidden` are candidates a `hide`
    // glob excludes (project files absent from the manifest). Paths namespace-absolute, matching
    // the manifest + storage. Headless → empty. {§membership-resolved-effects}
    static async resolveMembershipEffects(
        db: Db,
        workspaceId: number,
        signal: AbortSignal | undefined,
    ): Promise<{ members: Array<{ path: string; effect: "member" | "view" }>; hidden: string[] }> {
        const inputs = await GitMembership.#resolveOverlayInputs(db, workspaceId, signal);
        if (inputs === null) return { members: [], hidden: [] };   // headless
        const { gitMembers, picked, hideGlobs, viewGlobs } = inputs;
        // Match hide/view against the BARE path (client globs are bare, as the edit gate does),
        // then namespace-prefix the output. Composition mirrors resolveGitMembership exactly:
        // members = (git ∪ pick) − hide, hidden = (git ∪ pick) ∩ hide.
        const isHidden = (p: string): boolean => hideGlobs.some((g) => matchesGlob(p, g));
        const isView = (p: string): boolean => viewGlobs.some((g) => matchesGlob(p, g));
        const members: Array<{ path: string; effect: "member" | "view" }> = [];
        const hidden: string[] = [];
        for (const p of new Set([...gitMembers, ...picked])) {
            if (isHidden(p)) hidden.push(p);
            else members.push({ path: p, effect: isView(p) ? "view" : "member" });
        }
        members.sort((a, b) => a.path.localeCompare(b.path));
        hidden.sort();
        return { members, hidden };
    }

    // Targeted client-dictated scan (SPEC §membership `pick`) — enumerate disk files
    // matching the client's pick-globs via node:fs glob (the pattern bounds the
    // traversal; never a blind fs-walk). Files only — directories aren't members.
    // Workspace-relative paths, the same shape as git ls-files.
    static async #scanPickMembers(
        root: string,
        pickGlobs: string[],
        signal: AbortSignal | undefined,
    ): Promise<string[]> {
        const matches = new Set<string>();
        for (const pattern of pickGlobs) {
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
    // (D4/D5). Change-gated: a member whose mtime:size signature is unchanged since its
    // last sync is a no-op (the stat-gate below) — re-read + rewrite only on change.
    // Binary members materialize as an EMPTY body
    // channel stamped with their binary mimetype (#186 — visible in the manifest
    // and READ-415 via the one isBinaryMimetype gate, not a 404 ghost).
    // Missing-on-disk (tracked but deleted in the working tree) is
    // skipped — membership stands, no channel.
    static async #materializeMember(
        pathname: string,
        root: string,
        ctx: PlurnkSchemeContext,
    ): Promise<FsDivergence | null> {
        const canonical = join(root, pathname);  // pathname is namespace-absolute (`/src/foo.ts`); join roots it at the workspace
        // SPEC §membership-change-gated-sync — the cheap detect is a stat (mtime:size),
        // never a content read: a member whose signature matches its last sync is a
        // no-op (not re-read, re-tokenized, or rewritten). Coverage stays exhaustive
        // (every member is stat'd); work is proportional to change.
        let sig: string;
        try {
            const st = await stat(canonical);
            // A directory-shaped member — an embedded-repo boundary the untracked scan lists as
            // `dir/` (native + iso alike) — is a membership marker: disk truth is a directory,
            // nothing to materialize. Mirrors missing-on-disk: membership stands, no channel.
            if (st.isDirectory()) return null;
            sig = `${st.mtimeMs}:${st.size}`;
        } catch (err) {
            if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
            throw err;
        }
        const known = await (ctx.db.crud_get_member_sig as PrepMethod).get<{ id: number; synced_sig: string | null }>({
            workspace_id: ctx.workspaceId, owner_id: await Owner.commonsId(ctx.db, ctx.workspaceId), scheme: "file", pathname,
        });
        if (known !== undefined && known.synced_sig === sig) return null;  // unchanged — the change-gate

        const mimetype = await GitMembership.#detectMimetype(canonical, ctx.mimetypes);
        if (MimetypeBinary.isBinaryMimetype(mimetype)) {
            // Empty body channel stamped with the real binary mimetype — a first-
            // class entry that READ-415s through readWorkspaceEntry's isBinaryMimetype
            // gate (#186), not a channel-less row that would read as 404.
            const r = await EntryCrud.writeEntry(pathname, { channels: { body: { content: "", mimetype } }, tags: [] }, ctx, "file");
            if (r.entryId !== null) await (ctx.db.crud_set_synced_sig as PrepMethod).run({ entry_id: r.entryId, synced_sig: sig });
            return null;  // binary bodies are empty markers — no text divergence to narrate
        }
        let buf: Buffer;
        try {
            buf = await readFile(canonical);
        } catch (err) {
            if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
            throw err;
        }
        // §membership-binary-sniff (#320) — the extension map can lie (.wasm fell through to
        // the markdown DEFAULT and a 3.3MB blob entered the corpus as prose, three copies,
        // ~10M tokens). NUL bytes in the head are binary truth regardless of the label:
        // re-stamp octet-stream and take the binary arm (empty body, READ-415, never
        // FTS'd/embedded/tokenized as text).
        if (buf.subarray(0, 8192).includes(0)) {
            const r = await EntryCrud.writeEntry(pathname, { channels: { body: { content: "", mimetype: "application/octet-stream" } }, tags: [] }, ctx, "file");
            if (r.entryId !== null) await (ctx.db.crud_set_synced_sig as PrepMethod).run({ entry_id: r.entryId, synced_sig: sig });
            return null;
        }
        const content = buf.toString("utf8");
        // §env-delta — capture an out-of-band disk change BEFORE the refresh overwrites
        // the entry: an existing body channel whose content differs from disk is an
        // ambient divergence (D5). writeEntry then refreshes the entry to disk truth.
        const prior = await (ctx.db.ops_read_channel as PrepMethod).get<{ content: string }>({
            workspace_id: ctx.workspaceId, owner_id: await Owner.commonsId(ctx.db, ctx.workspaceId), scheme: "file", pathname, channel: "body",
        });
        const result = await EntryCrud.writeEntry(pathname, { channels: { body: { content, mimetype } }, tags: [] }, ctx, "file");
        if (result.entryId !== null) await (ctx.db.crud_set_synced_sig as PrepMethod).run({ entry_id: result.entryId, synced_sig: sig });
        if (prior !== undefined && prior.content !== content && result.entryId !== null) {
            return { pathname, scheme: "file", entryId: result.entryId, channel: "body", before: prior.content, after: content };
        }
        return null;
    }

    // Full membership + materialization pass for a worker. Registers git members,
    // then materializes each active (on-disk, non-binary) member as an entry
    // through writeEntry. Called at packet-composition time (Engine.runTurn) per
    // D5. No-ops on headless / non-git workspaces.
    static async indexGitMembership(ctx: PlurnkSchemeContext): Promise<FsDivergence[]> {
        let chains = GitMembership.#indexChains.get(ctx.db);
        if (chains === undefined) {
            chains = new Map();
            GitMembership.#indexChains.set(ctx.db, chains);
        }
        const prior = chains.get(ctx.workspaceId) ?? Promise.resolve();
        const run = prior.then(() => GitMembership.#indexGitMembershipUnlocked(ctx));
        const tail = run.then(() => {}, () => {});
        chains.set(ctx.workspaceId, tail);
        void tail.finally(() => {
            if (chains?.get(ctx.workspaceId) === tail) chains.delete(ctx.workspaceId);
        });
        return run;
    }

    static async #indexGitMembershipUnlocked(ctx: PlurnkSchemeContext): Promise<FsDivergence[]> {
        const root = await GitMembership.#loadWorkspaceRoot(ctx.db, ctx.workspaceId);
        if (root === null) return [];
        const tracked = await GitMembership.resolveGitMembership(ctx.db, ctx.workspaceId, ctx.signal);
        const divergences: FsDivergence[] = [];
        for (const pathname of tracked) {
            const divergence = await GitMembership.#materializeMember(pathname, root, ctx);
            if (divergence !== null) divergences.push(divergence);
        }
        return divergences;
    }
}
