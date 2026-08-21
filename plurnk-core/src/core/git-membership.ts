// SPEC {§membership} D4 — git-ls-files workspace membership. {§membership-git-membership}
//
// When a workspace's `project_root` is a git working tree, the git-tracked
// files (`git ls-files`) are workspace MEMBERS without any explicit client
// `pick`. This module resolves that membership and (when token accounting is
// available) materializes active members' model-readable representation into a body channel,
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
//        re-tokenized, and rewritten. A binary source also compares the installed
//        projection identity without reacquiring bytes. EMI divergence rides the
//        same pass. {§membership-change-gated-sync}
//
// Git resolution uses native Git (subprocess + hermeticGitEnv,
// AbortSignal-respecting).

import { execFile } from "node:child_process";
import { gitOutputMaxBytes, hermeticGitEnv } from "./git-env.ts";
import { promisify } from "node:util";
import { readFile, glob, stat } from "node:fs/promises";
import { resolve, join, matchesGlob } from "node:path";
import {
    MimetypeInputLimitError,
    type Mimetypes,
    type ProcessInput,
} from "@plurnk/plurnk-mimetypes";
import { MimetypeBinary } from "../content/index.ts";
import type { Db } from "./Db.ts";
import type { PlurnkSchemeContext } from "./scheme-types.ts";
import Owner from "./Owner.ts";
import EntryCrud from "../schemes/_entry-crud.ts";
import WorkspaceSettings from "./workspace-settings.ts";
import Namespace from "./namespace.ts";

// {§env-delta} — an ambient disk divergence captured at pre-turn: the entry's content
// before the git-membership refresh vs its materialized representation after. The plurnk worker narrates
// it as a source=file EDIT so every worker pulls it through the one delta path.
export interface FsDivergence {
    pathname: string;
    entryId: number;
    channel: string;
    before: string;
    after: string;
}

type SourceProjectionDisposition = "projected" | "unavailable" | "input-limit";

interface SourceProjectionMetadata {
    mimetype: string;
    identity: string;
    disposition: SourceProjectionDisposition;
    maximumBytes?: number;
    observedBytes?: number;
}

interface MemberSnapshot {
    id: number;
    synced_sig: string | null;
    attributes: string;
}

interface MembershipResolution {
    members: string[];
    removed: FsDivergence[];
}

const ABSENT_SIG = "absent";

const sourceProjectionFrom = (encoded: string): SourceProjectionMetadata | null => {
    const attributes = JSON.parse(encoded) as unknown;
    if (attributes === null || typeof attributes !== "object" || Array.isArray(attributes)) {
        throw new TypeError("GitMembership: entry attributes must be a JSON object");
    }
    const candidate = (attributes as { sourceProjection?: unknown }).sourceProjection;
    if (candidate === undefined) return null;
    if (candidate === null || typeof candidate !== "object" || Array.isArray(candidate)) {
        throw new TypeError("GitMembership: sourceProjection must be a JSON object");
    }
    const projection = candidate as Partial<SourceProjectionMetadata>;
    if (
        typeof projection.mimetype !== "string"
        || projection.mimetype.length === 0
        || typeof projection.identity !== "string"
        || projection.identity.length === 0
        || !["projected", "unavailable", "input-limit"].includes(projection.disposition ?? "")
    ) {
        throw new TypeError("GitMembership: sourceProjection metadata is malformed");
    }
    const hasLimit = Number.isSafeInteger(projection.maximumBytes)
        && (projection.maximumBytes ?? 0) > 0
        && Number.isSafeInteger(projection.observedBytes)
        && (projection.observedBytes ?? 0) > (projection.maximumBytes ?? 0);
    if ((projection.disposition === "input-limit") !== hasLimit) {
        throw new TypeError("GitMembership: sourceProjection input-limit evidence is malformed");
    }
    return projection as SourceProjectionMetadata;
};

export default class GitMembership {
    // Workspace creation starts a background warm while the first model turn
    // performs its own eager membership refresh. Both are legitimate callers,
    // but materialization is a delete-then-insert channel write: overlapping
    // passes can race on the same (entry_id, body). Coalesce overlapping calls for
    // the same workspace into one pass; different workspaces remain independent.
    static #indexPasses = new WeakMap<Db, Map<number, Promise<FsDivergence[]>>>();

    static #execFileP = promisify(execFile);

    // {§fs-write-surface} — the blind-write closure git half: would git ADMIT a create at
    // key (untracked-not-ignored)? check-ignore exit 0 = ignored (refuse), 1 = clean
    // (automatic membership admission, never `git add`), anything else (128, no
    // repo) = git grants nothing here.
    static async wouldGitAdmit(root: string, key: string, signal?: AbortSignal): Promise<boolean> {
        try {
            await GitMembership.#execFileP("git", ["check-ignore", "-q", "--", key], { cwd: root, signal, env: hermeticGitEnv() });
            return false;
        } catch (err) {
            return (err as { code?: number }).code === 1;
        }
    }

    static async stageFile(root: string, key: string, signal?: AbortSignal): Promise<void> {
        try {
            await GitMembership.#execFileP("git", ["add", "--", key], { cwd: root, signal, env: hermeticGitEnv() });
        } catch {
            // Ignore staging errors if root is not a git repo
        }
    }

    // project_root for a workspace. NULL = headless (no membership). Read once per
    // resolution; the File scheme reads the same column for its own root.
    static async #loadWorkspaceRoot(db: Db, workspaceId: number): Promise<string | null> {
        const row = await db.envelope_get_workspace.get<{ project_root: string | null }>({ id: workspaceId });
        return row?.project_root ?? null;
    }

    // Tracked files of one repo, workspace-relative via `git ls-files --stage -z`. Gitlinks
    // are filtered: a submodule is a repository boundary, not a file member. Empty → [].
    static async #gitTrackedFiles(root: string, signal: AbortSignal | undefined): Promise<string[]> {
        // NUL-delimited so paths with spaces/newlines survive.
        const { stdout } = await GitMembership.#execFileP("git", ["ls-files", "--stage", "-z"], { cwd: root, signal, maxBuffer: gitOutputMaxBytes(), env: hermeticGitEnv() });
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

    // Untracked-but-not-ignored members of one repo ({§membership-auto-add}) —
    // `git ls-files --others --exclude-standard -z`. A model-created file is a repo
    // member the moment it exists — no git-stage required — while `.gitignore` still filters it.
    static async #gitUntrackedFiles(root: string, signal: AbortSignal | undefined): Promise<string[]> {
        const { stdout } = await GitMembership.#execFileP("git", ["ls-files", "--others", "--exclude-standard", "-z"], { cwd: root, signal, maxBuffer: gitOutputMaxBytes(), env: hermeticGitEnv() });
        return stdout.split("\0").filter((e) => e.length > 0);
    }

    // Resolve a directory to the containing Git repository, or null when absent.
    static async #repoToplevel(dir: string, signal: AbortSignal | undefined): Promise<string | null> {
        try {
            const { stdout } = await GitMembership.#execFileP("git", ["rev-parse", "--show-toplevel"], { cwd: dir, signal, env: hermeticGitEnv() });
            return stdout.trim();
        } catch {
            return null;  // not a git tree (or the dir is gone) — contributes nothing
        }
    }

    // A workspace owns exactly the repository containing project_root. Packages and
    // projects inside that repository share its Git state; unrelated repositories
    // belong to unrelated workspaces.
    static async projectRepository(db: Db, workspaceId: number, signal?: AbortSignal): Promise<string | null> {
        const root = await GitMembership.#loadWorkspaceRoot(db, workspaceId);
        if (root === null || process.env.PLURNK_SERVICE_GIT_ALLOWED !== "1") return null;
        if ((await WorkspaceSettings.read(db, workspaceId)).git === false) return null;
        return GitMembership.#repoToplevel(root, signal);
    }

    static async #projectMembers(root: string, repoRoot: string, signal: AbortSignal | undefined): Promise<string[]> {
        const members = new Set<string>();
        const tracked = await GitMembership.#gitTrackedFiles(repoRoot, signal);
        const untracked = await GitMembership.#gitUntrackedFiles(repoRoot, signal);
        for (const file of [...tracked, ...untracked]) {
            members.add(Namespace.fromRepositoryPath(file, root, repoRoot));
        }
        return [...members];
    }

    // Detect a tracked file's mimetype (mirrors File.detectFileMimetype) through
    // the configured registry, normalizing auto-derived text/plain to the text
    // primitive.
    static async #detectMimetype(canonical: string, mimetypes: Mimetypes | undefined): Promise<string> {
        if (mimetypes === undefined) throw new Error("GitMembership: configured mimetype registry is required");
        const detected = await mimetypes.detect({ path: canonical });
        return MimetypeBinary.normalizeAutoTextMimetype(detected);
    }

    static #projectionIdentity(
        mimetype: string,
        mimetypes: Mimetypes | undefined,
        identities: Map<string, Promise<string>>,
    ): Promise<string> {
        if (mimetypes === undefined) throw new Error("GitMembership: configured mimetype registry is required");
        let identity = identities.get(mimetype);
        if (identity === undefined) {
            identity = mimetypes.projectionIdentity(mimetype);
            identities.set(mimetype, identity);
        }
        return identity;
    }

    // Shared overlay inputs — the candidate sets (git tracked+untracked union, pick scan) and
    // the overlay globs, before composition. Single-sources the (git ∪ pick) derivation + the
    // glob sets for resolveGitMembership (compose + reconcile) and resolveMembershipEffects
    // (derive per-file effect for clients, {§membership-resolved-effects}). Headless → null.
    static async #resolveOverlayInputs(
        db: Db,
        workspaceId: number,
        signal: AbortSignal | undefined,
    ): Promise<{ root: string; gitMembers: string[]; picked: string[]; hideGlobs: string[]; viewGlobs: string[] } | null> {
        const root = await GitMembership.#loadWorkspaceRoot(db, workspaceId);
        if (root === null) return null;   // headless — no disk surface to resolve

        const constraints = await db.crud_list_workspace_constraints.all<{ effect: string; glob: string }>({ workspace_id: workspaceId });
        const hideGlobs = constraints.filter((c) => c.effect === "hide").map((c) => c.glob);
        const pickGlobs = constraints.filter((c) => c.effect === "pick").map((c) => c.glob);
        const viewGlobs = constraints.filter((c) => c.effect === "view").map((c) => c.glob);

        // The repository containing project_root is the sole Git substrate.
        // PLURNK_SERVICE_GIT_ALLOWED=0 is the hard service ceiling and
        // PLURNK_SERVICE_GIT_AUTO=0 disables automatic Git membership.
        // {§operator-config-workspace-git} — git:false tightens the env ALLOWED ceiling.
        const workspaceGit = (await WorkspaceSettings.read(db, workspaceId)).git;
        let gitMembers: string[] = [];
        if (
            process.env.PLURNK_SERVICE_GIT_ALLOWED === "1"
            && process.env.PLURNK_SERVICE_GIT_AUTO === "1"
            && workspaceGit !== false
        ) {
            const repository = await GitMembership.#repoToplevel(root, signal);
            if (repository !== null) {
                gitMembers = await GitMembership.#projectMembers(root, repository, signal);
            }
        }

        // `pick` overlay — a targeted, client-dictated scan for untracked matches
        // (node:fs glob over the client's pattern, never a blind walk).
        const picked = pickGlobs.length === 0 ? [] : await GitMembership.#scanPickMembers(root, pickGlobs, signal); // {§membership-overlay-pick}
        return { root, gitMembers, picked, hideGlobs, viewGlobs };
    }

    // Resolve a workspace's file membership: the desired set is (git ls-files ∪ pick
    // globs) − hide globs (SPEC {§membership} overlay), reconciled against the registered
    // overlay-owned members so entries == members. Channel-less rows — disk is the
    // truth (D3); the row is the membership marker File.read gates on. Returns the
    // desired pathnames so the caller can materialize them through writeEntry.
    //
    // signal-respecting: git shell-outs + the pick scan honor `signal`. Headless
    // (no project_root) yields nothing; a non-git root with pick-globs still resolves.
    static async #reconcileGitMembership(
        db: Db,
        workspaceId: number,
        signal: AbortSignal | undefined,
    ): Promise<MembershipResolution> {
        const inputs = await GitMembership.#resolveOverlayInputs(db, workspaceId, signal);
        if (inputs === null) return { members: [], removed: [] };   // headless — no disk surface to resolve
        const { gitMembers: members, picked, hideGlobs } = inputs;

        // Compose: (git ∪ pick) − hide ({§membership-overlay-hide}), tracking origin for reconciliation — a path
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
        const candidateSet = new Set([...members, ...picked]);

        // Reconcile so entries == members (the constitutive invariant): register the
        // desired with their origin, then un-register any overlay-owned member ('git'
        // or 'constraint') no longer desired — untracked, unmatched, or newly hidden.
        // Model-created ('client') members are never reclaimed.
        const commonsId = await Owner.commonsId(db, workspaceId);
        for (const pathname of desiredGit) {
            await db.crud_register_workspace_member.get({ workspace_id: workspaceId, owner_id: commonsId, scheme: "file", pathname, membership_origin: "git" });
        }
        for (const pathname of desiredPick) {
            await db.crud_register_workspace_member.get({ workspace_id: workspaceId, owner_id: commonsId, scheme: "file", pathname, membership_origin: "constraint" });
        }
        const registered = await db.crud_list_reconcilable_members.all<{ id: number; pathname: string }>({ workspace_id: workspaceId });
        const removed: FsDivergence[] = [];
        for (const m of registered) {
            if (!desiredSet.has(m.pathname)) {
                // A path that left Git/pick membership also left disk truth (for
                // example an untracked deletion or staged rename). A hide overlay
                // is policy, not a filesystem occurrence, and is therefore silent.
                if (!candidateSet.has(m.pathname)) {
                    const prior = await db.ops_read_channel.get<{ content: string }>({
                        workspace_id: workspaceId,
                        owner_id: commonsId,
                        scheme: "file",
                        pathname: m.pathname,
                        channel: "body",
                    });
                    if (prior !== undefined) {
                        removed.push({
                            pathname: m.pathname,
                            entryId: m.id,
                            channel: "body",
                            before: prior.content,
                            after: "",
                        });
                    }
                }
                await db.crud_delete_entry.run({ entry_id: m.id });
            }
        }
        return { members: desired, removed };
    }

    static async resolveGitMembership(
        db: Db,
        workspaceId: number,
        signal: AbortSignal | undefined,
    ): Promise<string[]> {
        return (await GitMembership.#reconcileGitMembership(db, workspaceId, signal)).members;
    }

    // Resolve each candidate's membership effect without mutating — a read for clients
    // ({§membership-resolved-effects}): the same (git ∪ pick) / hide / view resolution resolveGitMembership
    // composes, surfaced per-file so a client signs member/view/hidden with ZERO glob-matching of
    // its own. `members` are (git ∪ pick) − hide, each tagged `view` (read-only, refused at the
    // File edit gate {§membership-overlay-view}) or plain `member`; `hidden` are candidates a `hide`
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

    // Targeted client-dictated scan (SPEC {§membership} `pick`) — enumerate disk files
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

    // Materialize a member's model-readable snapshot into a body channel via writeEntry (the
    // entry-write paradigm) — so it appears in the manifest catalog and is READ-able
    // (D4/D5). Change-gated: text changes with mtime:size; binary projections also
    // change when their opaque reader identity changes. A binary source persists
    // only derived Unicode when its installed handler provides it, otherwise an
    // empty typed marker ({§membership-source-projection}).
    // A tracked path missing on disk retains membership but loses its stale
    // readable channels; its explicit absent signature makes a later
    // reappearance another observable divergence.
    static async #materializeMember(
        pathname: string,
        root: string,
        ctx: PlurnkSchemeContext,
        identities: Map<string, Promise<string>>,
    ): Promise<FsDivergence | null> {
        const canonical = join(root, pathname);  // pathname is namespace-absolute (`/src/foo.ts`); join roots it at the workspace
        const commonsId = await Owner.commonsId(ctx.db, ctx.workspaceId);
        const known = await ctx.db.crud_get_member_sig.get<MemberSnapshot>({
            workspace_id: ctx.workspaceId, owner_id: commonsId, scheme: "file", pathname,
        });
        // SPEC {§membership-change-gated-sync} — the cheap detect is a stat (mtime:size),
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
            if ((err as NodeJS.ErrnoException).code === "ENOENT") {
                if (known === undefined || known.synced_sig === ABSENT_SIG) return null;
                const prior = await ctx.db.ops_read_channel.get<{ content: string }>({
                    workspace_id: ctx.workspaceId,
                    owner_id: commonsId,
                    scheme: "file",
                    pathname,
                    channel: "body",
                });
                await ctx.db.crud_delete_channels.run({ entry_id: known.id });
                await ctx.db.crud_mark_member_absent.run({ entry_id: known.id });
                return prior === undefined ? null : {
                    pathname,
                    entryId: known.id,
                    channel: "body",
                    before: prior.content,
                    after: "",
                };
            }
            throw err;
        }
        if (known !== undefined && known.synced_sig === sig) {
            const sourceProjection = sourceProjectionFrom(known.attributes);
            if (sourceProjection === null) return null;
            const currentIdentity = await GitMembership.#projectionIdentity(
                sourceProjection.mimetype,
                ctx.mimetypes,
                identities,
            );
            if (currentIdentity === sourceProjection.identity) return null;
        }

        const mimetype = await GitMembership.#detectMimetype(canonical, ctx.mimetypes);
        if (await MimetypeBinary.isBinaryMimetype(mimetype, ctx.mimetypes)) {
            return GitMembership.#materializeBinary(
                pathname,
                { path: canonical },
                mimetype,
                sig,
                known?.synced_sig !== sig,
                known?.synced_sig === ABSENT_SIG,
                ctx,
                identities,
            );
        }
        let buf: Buffer;
        try {
            buf = await readFile(canonical);
        } catch (err) {
            if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
            throw err;
        }
        // {§membership-binary-sniff} — the extension map can lie (.wasm fell through to
        // the markdown DEFAULT and a 3.3MB blob entered the corpus as prose, three copies,
        // ~10M tokens). NUL bytes in the head are binary truth regardless of the label:
        // re-stamp octet-stream and take the same bounded projection-or-marker arm.
        if (buf.subarray(0, 8192).includes(0)) {
            return GitMembership.#materializeBinary(
                pathname,
                { content: buf, hint: "application/octet-stream" },
                "application/octet-stream",
                sig,
                known?.synced_sig !== sig,
                known?.synced_sig === ABSENT_SIG,
                ctx,
                identities,
            );
        }
        const content = buf.toString("utf8");
        // {§env-delta-filesystem-narration} — capture the prior snapshot before
        // materialization replaces it, then journal the resulting net span.
        const prior = await ctx.db.ops_read_channel.get<{ content: string }>({
            workspace_id: ctx.workspaceId, owner_id: commonsId, scheme: "file", pathname, channel: "body",
        });
        const result = await EntryCrud.writeEntry(
            pathname,
            { channels: { body: { content, mimetype } }, attributes: {} },
            ctx,
            "file",
        );
        if (result.entryId !== null) await ctx.db.crud_set_synced_sig.run({ entry_id: result.entryId, synced_sig: sig });
        const changed = prior !== undefined && prior.content !== content;
        if ((changed || known?.synced_sig === ABSENT_SIG) && result.entryId !== null) {
            return { pathname, entryId: result.entryId, channel: "body", before: prior?.content ?? "", after: content };
        }
        return null;
    }

    static async #materializeBinary(
        pathname: string,
        input: ProcessInput,
        mimetype: string,
        sig: string,
        diskChanged: boolean,
        previouslyAbsent: boolean,
        ctx: PlurnkSchemeContext,
        identities: Map<string, Promise<string>>,
    ): Promise<FsDivergence | null> {
        const mimetypes = ctx.mimetypes;
        if (mimetypes === undefined) throw new Error("GitMembership: configured mimetype registry is required");

        let content = "";
        let outputMimetype = mimetype;
        let metadata: SourceProjectionMetadata;
        try {
            const projected = await mimetypes.projectReadable(input);
            if (projected === null) {
                metadata = {
                    mimetype,
                    identity: await GitMembership.#projectionIdentity(mimetype, mimetypes, identities),
                    disposition: "unavailable",
                };
            } else {
                content = projected.content;
                outputMimetype = "text/markdown";
                metadata = {
                    mimetype: projected.sourceMimetype,
                    identity: projected.projectionIdentity,
                    disposition: "projected",
                };
            }
        } catch (cause) {
            if (!(cause instanceof MimetypeInputLimitError)) throw cause;
            metadata = {
                mimetype,
                identity: await GitMembership.#projectionIdentity(mimetype, mimetypes, identities),
                disposition: "input-limit",
                maximumBytes: cause.maximumBytes,
                observedBytes: cause.observedBytes,
            };
        }

        const prior = diskChanged && metadata.disposition === "projected"
            ? await ctx.db.ops_read_channel.get<{ content: string }>({
                workspace_id: ctx.workspaceId,
                owner_id: await Owner.commonsId(ctx.db, ctx.workspaceId),
                scheme: "file",
                pathname,
                channel: "body",
            })
            : undefined;
        const result = await EntryCrud.writeEntry(
            pathname,
            {
                channels: { body: { content, mimetype: outputMimetype } },
                attributes: { sourceProjection: metadata },
            },
            ctx,
            "file",
        );
        if (result.entryId !== null) {
            await ctx.db.crud_set_synced_sig.run({ entry_id: result.entryId, synced_sig: sig });
        }
        const changed = prior !== undefined && prior.content !== content;
        if ((changed || previouslyAbsent) && result.entryId !== null) {
            return {
                pathname,
                entryId: result.entryId,
                channel: "body",
                before: prior?.content ?? "",
                after: content,
            };
        }
        return null;
    }

    // Full membership + materialization pass for a worker. Registers git members,
    // then materializes each active on-disk member as an entry
    // through writeEntry. Called at packet-composition time (Engine.runTurn) per
    // D5. No-ops on headless / non-git workspaces.
    static async indexGitMembership(ctx: PlurnkSchemeContext): Promise<FsDivergence[]> {
        let passes = GitMembership.#indexPasses.get(ctx.db);
        if (passes === undefined) {
            passes = new Map();
            GitMembership.#indexPasses.set(ctx.db, passes);
        }
        const existing = passes.get(ctx.workspaceId);
        if (existing !== undefined) return existing;
        const run = GitMembership.#indexGitMembershipUnlocked(ctx);
        passes.set(ctx.workspaceId, run);
        void run.finally(() => {
            if (passes?.get(ctx.workspaceId) === run) passes.delete(ctx.workspaceId);
        });
        return run;
    }

    static async #indexGitMembershipUnlocked(ctx: PlurnkSchemeContext): Promise<FsDivergence[]> {
        const root = await GitMembership.#loadWorkspaceRoot(ctx.db, ctx.workspaceId);
        if (root === null) return [];
        const resolution = await GitMembership.#reconcileGitMembership(ctx.db, ctx.workspaceId, ctx.signal);
        const divergences: FsDivergence[] = [...resolution.removed];
        const identities = new Map<string, Promise<string>>();
        for (const pathname of resolution.members) {
            const divergence = await GitMembership.#materializeMember(pathname, root, ctx, identities);
            if (divergence !== null) divergences.push(divergence);
        }
        return divergences;
    }
}
