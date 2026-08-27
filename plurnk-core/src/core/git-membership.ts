// SPEC {§membership} D4 — git-ls-files workspace membership. {§membership-git-membership}
//
// When a workspace's `project_root` is a git working tree, the git-tracked
// files (`git ls-files`) are workspace MEMBERS without any explicit
// `pick`. This module resolves that membership and (when token accounting is
// available) materializes active members' model-readable representation into a body channel,
// so they appear in the entry catalog (FIND-served) and are READ-able.
//
// Decisions realized here:
//   D1 — workspace identity lives on the workspace (project_root).
//   D3 — disk co-location: members are channel-less markers until materialized;
//        disk stays the truth.
//   D4 — git present → ls-files membership. Git absent → no ambient fs-walk;
//        targeted explicit/generated picks remain the membership substrate. The
//        pick/hide/view constraint overlay (workspace_constraints) composes here:
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
import { resolve, join, matchesGlob, relative, isAbsolute } from "node:path";
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
import FileCreationPolicy from "./file-creation-policy.ts";
import FileMaterialization, { type FileMaterializationMetadata } from "./file-materialization.ts";

// {§membership-emi-divergence-signal} — a disk divergence captured at pre-turn:
// the entry's content before the Git-membership refresh versus its materialized
// representation after. The runtime worker retains it as source=file evidence.
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

type ConstraintRow = {
    effect: "pick" | "hide" | "view";
    glob: string;
    source: "explicit" | "create";
};

export type FileCreationAdmission =
    | {
        ok: true;
        // {§membership-baseline}: a creation is never incorporated by Git — an exact generated pick
        // (create-pick) or an explicit pick that already covers the path; never `git add`.
        incorporation: "explicit-pick" | "create-pick";
    }
    | {
        ok: false;
        code: string;
        status: 403;
        detail: string;
        extensions: Readonly<Record<string, unknown>>;
    };

export type FileCreationIncorporation = {
    origin: "constraint";
    generatedPick: boolean;
};

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

    static async #activeAutomaticRepository(
        db: Db,
        workspaceId: number,
        root: string,
        signal?: AbortSignal,
    ): Promise<string | null> {
        if (
            process.env.PLURNK_SERVICE_GIT_ALLOWED !== "1"
            || process.env.PLURNK_SERVICE_GIT_AUTO !== "1"
            || (await WorkspaceSettings.read(db, workspaceId)).git === false
        ) return null;
        return GitMembership.#repoToplevel(root, signal);
    }

    static async #isIgnoredByRepository(
        root: string,
        repository: string,
        key: string,
        signal?: AbortSignal,
    ): Promise<boolean | null> {
        const target = resolve(root, key);
        const repositoryPath = relative(repository, target);
        if (repositoryPath === "" || repositoryPath.startsWith("..") || isAbsolute(repositoryPath)) return null;
        try {
            await GitMembership.#execFileP("git", ["check-ignore", "-q", "--", repositoryPath], {
                cwd: repository,
                signal,
                env: hermeticGitEnv(),
            });
            return true;
        } catch (cause) {
            if ((cause as { code?: number }).code === 1) return false;
            throw new Error(`Git ignore classification failed for '${key}'.`, { cause });
        }
    }

    // {§membership-model-universe} entry (3): a standards-backed instruction file (AGENTS.md) is
    // projected from disk, but the standard never outranks the operator's exclusions — a path the
    // active repository ignores, or a `hide` constraint matches, contributes nothing.
    static async excludesInstruction(db: Db, workspaceId: number, key: string, signal?: AbortSignal): Promise<boolean> {
        const constraints = await db.crud_list_workspace_constraints.all<ConstraintRow>({ workspace_id: workspaceId });
        if (constraints.some(({ effect, glob }) => effect === "hide" && matchesGlob(key, glob))) return true;
        const root = await GitMembership.#loadWorkspaceRoot(db, workspaceId);
        if (root === null) return false;
        const repository = await GitMembership.#activeAutomaticRepository(db, workspaceId, root, signal);
        if (repository === null) return false;
        return (await GitMembership.#isIgnoredByRepository(root, repository, key, signal)) === true;
    }

    // {§file-create-single-owner}: File consumes this decision; it does not repeat
    // scope, overlay, or Git policy at the write call site.
    static async planCreation(
        db: Db,
        workspaceId: number,
        key: string,
        signal?: AbortSignal,
    ): Promise<FileCreationAdmission> {
        const root = await GitMembership.#loadWorkspaceRoot(db, workspaceId);
        if (root === null) {
            throw new TypeError("File creation admission requires a workspace project root.");
        }
        const settings = await WorkspaceSettings.read(db, workspaceId);
        const scope = FileCreationPolicy.effective(
            FileCreationPolicy.serviceScope(),
            settings.fileCreateScope,
        );
        const outsideRoot = key.startsWith("../");
        if (!FileCreationPolicy.admits(scope, outsideRoot)) {
            return {
                ok: false,
                code: scope === "none" ? "file-create-disabled" : "file-create-outside-scope",
                status: 403,
                detail: scope === "none"
                    ? `File creation is disabled for '${key}'.`
                    : `The effective creation scope '${scope}' does not admit '${key}'.`,
                extensions: {
                    path: key,
                    scope,
                    recovery: scope === "none"
                        ? "Edit an existing member or ask the operator to permit file creation."
                        : "Create the file inside the project root or ask the operator to permit namespace creation.",
                    retryable: false,
                },
            };
        }

        const rows = await db.crud_list_workspace_constraints.all<ConstraintRow>({ workspace_id: workspaceId });
        const exclusion = rows.find(({ effect, glob }) =>
            (effect === "hide" || effect === "view") && matchesGlob(key, glob));
        if (exclusion !== undefined) {
            return {
                ok: false,
                code: "file-create-excluded",
                status: 403,
                detail: `The ${exclusion.effect} constraint excludes creation at '${key}'.`,
                extensions: {
                    path: key,
                    effect: exclusion.effect,
                    recovery: `Remove the ${exclusion.effect} constraint or choose another path.`,
                    retryable: false,
                },
            };
        }

        if (rows.some(({ effect, glob, source }) =>
            effect === "pick" && source === "explicit" && matchesGlob(key, glob))) {
            return { ok: true, incorporation: "explicit-pick" };
        }

        const repository = await GitMembership.#activeAutomaticRepository(db, workspaceId, root, signal);
        if (repository !== null) {
            const ignored = await GitMembership.#isIgnoredByRepository(root, repository, key, signal);
            if (ignored === true) {
                return {
                    ok: false,
                    code: "file-create-gitignored",
                    status: 403,
                    detail: `Active Git policy ignores '${key}', and no explicit pick admits it.`,
                    extensions: {
                        path: key,
                        recovery: "Choose a Git-admitted path or add an explicit pick.",
                        retryable: false,
                    },
                };
            }
        }
        // {§membership-baseline}: not ignored, in root, admitted — still a pick, never a stage.
        return { ok: true, incorporation: "create-pick" };
    }

    // {§file-create-transaction}: this is the only incorporation owner. The caller has already
    // created and materialized the entry; the pick row is the transaction's final fallible state
    // change. {§membership-baseline}: Plurnk never runs `git add` — a created file is a member
    // because a pick says so, exactly like every other file in the model's universe.
    static async incorporateCreation(
        db: Db,
        workspaceId: number,
        entryId: number,
        key: string,
        admission: Extract<FileCreationAdmission, { ok: true }>,
    ): Promise<FileCreationIncorporation> {
        await db.crud_set_origin.run({ entry_id: entryId, membership_origin: "constraint" });
        if (admission.incorporation === "explicit-pick") return { origin: "constraint", generatedPick: false };
        await db.crud_insert_generated_workspace_constraint.run({ workspace_id: workspaceId, glob: key });
        return { origin: "constraint", generatedPick: true };
    }

    static removeGeneratedPick(db: Db, workspaceId: number, key: string): Promise<unknown> {
        return db.crud_delete_generated_workspace_constraint.run({ workspace_id: workspaceId, glob: key });
    }

    // {§membership-baseline}: the repository contributes exactly its TRACKED files. An untracked
    // file — however convenient — is never an ambient member; `pick` is the only other grantor.
    static async #projectMembers(root: string, repoRoot: string, signal: AbortSignal | undefined): Promise<string[]> {
        const members = new Set<string>();
        for (const file of await GitMembership.#gitTrackedFiles(repoRoot, signal)) {
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
    ): Promise<{ root: string; gitMembers: string[]; picked: string[]; maskedGenerated: string[]; hideGlobs: string[]; viewGlobs: string[] } | null> {
        const root = await GitMembership.#loadWorkspaceRoot(db, workspaceId);
        if (root === null) return null;   // headless — no disk surface to resolve

        const constraints = await db.crud_list_workspace_constraints.all<ConstraintRow>({ workspace_id: workspaceId });
        const hideGlobs = constraints.filter((c) => c.effect === "hide").map((c) => c.glob);
        const explicitPickGlobs = constraints.filter((c) => c.effect === "pick" && c.source === "explicit").map((c) => c.glob);
        const generatedPickGlobs = constraints.filter((c) => c.effect === "pick" && c.source === "create").map((c) => c.glob);
        const viewGlobs = constraints.filter((c) => c.effect === "view").map((c) => c.glob);

        // The repository containing project_root is the sole Git substrate.
        // PLURNK_SERVICE_GIT_ALLOWED=0 is the hard service ceiling and
        // PLURNK_SERVICE_GIT_AUTO=0 disables automatic Git membership.
        // {§operator-config-workspace-git} — git:false tightens the env ALLOWED ceiling.
        const workspaceGit = (await WorkspaceSettings.read(db, workspaceId)).git;
        let gitMembers: string[] = [];
        let repository: string | null = null;
        if (
            process.env.PLURNK_SERVICE_GIT_ALLOWED === "1"
            && process.env.PLURNK_SERVICE_GIT_AUTO === "1"
            && workspaceGit !== false
        ) {
            repository = await GitMembership.#repoToplevel(root, signal);
            if (repository !== null) {
                gitMembers = await GitMembership.#projectMembers(root, repository, signal);
            }
        }

        // Explicit picks may supersede Git ignore; runtime-generated picks may not.
        // Both remain ordinary targeted scans rather than a blind filesystem walk.
        const explicitPicked = explicitPickGlobs.length === 0
            ? []
            : await GitMembership.#scanPickMembers(root, explicitPickGlobs, signal);
        const generatedCandidates = generatedPickGlobs.length === 0
            ? []
            : await GitMembership.#scanExactPickMembers(root, generatedPickGlobs, signal);
        const generatedPicked: string[] = [];
        const maskedGenerated: string[] = [];
        for (const pathname of generatedCandidates) {
            const ignored = repository === null
                ? null
                : await GitMembership.#isIgnoredByRepository(root, repository, pathname, signal);
            if (ignored === true) maskedGenerated.push(pathname);
            else generatedPicked.push(pathname);
        }
        const picked = [...new Set([...explicitPicked, ...generatedPicked])]; // {§membership-overlay-pick}
        return { root, gitMembers, picked, maskedGenerated, hideGlobs, viewGlobs };
    }

    static async #removeMissingGeneratedPicks(
        db: Db,
        workspaceId: number,
        root: string,
    ): Promise<void> {
        const constraints = await db.crud_list_workspace_constraints.all<ConstraintRow>({ workspace_id: workspaceId });
        for (const { effect, glob: key, source } of constraints) {
            if (effect !== "pick" || source !== "create") continue;
            try {
                if ((await stat(resolve(root, key))).isFile()) continue;
            } catch (cause) {
                if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw cause;
            }
            await GitMembership.removeGeneratedPick(db, workspaceId, key);
        }
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
        const root = await GitMembership.#loadWorkspaceRoot(db, workspaceId);
        if (root === null) return { members: [], removed: [] };
        await GitMembership.#removeMissingGeneratedPicks(db, workspaceId, root);
        const inputs = await GitMembership.#resolveOverlayInputs(db, workspaceId, signal);
        if (inputs === null) return { members: [], removed: [] };   // headless — no disk surface to resolve
        const { gitMembers: members, picked, maskedGenerated, hideGlobs } = inputs;

        // Compose: (git ∪ pick) − hide ({§membership-overlay-hide}). Pick wins
        // provenance when both grantors admit a path; outside-root write authority
        // must not collapse into a read-only Git origin.
        const pickedSet = new Set(picked);
        const passesHide = (p: string): boolean => hideGlobs.length === 0 || !hideGlobs.some((g) => matchesGlob(p, g));
        const desiredGit = members.filter((p) => !pickedSet.has(p) && passesHide(p));
        const desiredPick = picked.filter(passesHide);
        // Glob matching above stays bare (client `pick`/`hide` patterns are bare);
        // storage, reconcile, and the returned set are namespace-absolute (`/src/foo.ts`)
        // so they match the parser's pathname the shared read helper queries by.
        const desired = [...desiredGit, ...desiredPick]; // bare canon keys ({§fs-canonical-name}) — ls-files output IS the canon
        const desiredSet = new Set(desired);
        const candidateSet = new Set([...members, ...picked, ...maskedGenerated]);

        // Reconcile so entries == members (the constitutive invariant): register the
        // desired with their origin, then un-register any overlay-owned member ('git'
        // or 'constraint') no longer desired — untracked, unmatched, or newly hidden.
        const commonsId = await Owner.commonsId(db, workspaceId);
        for (const pathname of desiredGit) {
            await db.crud_register_workspace_member.get({ workspace_id: workspaceId, owner_id: commonsId, scheme: "file", authority: "", pathname, membership_origin: "git" });
        }
        for (const pathname of desiredPick) {
            await db.crud_register_workspace_member.get({ workspace_id: workspaceId, owner_id: commonsId, scheme: "file", authority: "", pathname, membership_origin: "constraint" });
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
                        authority: "",
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

    // Targeted explicit-policy scan (SPEC {§membership} `pick`) — enumerate disk files
    // matching the persisted pick globs via node:fs glob (the pattern bounds the
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

    // Runtime-generated picks store canonical paths in the legacy `glob` column,
    // but their contract is exact. Never reinterpret legal path metacharacters as
    // patterns when restoring creation provenance.
    static async #scanExactPickMembers(
        root: string,
        keys: string[],
        signal: AbortSignal | undefined,
    ): Promise<string[]> {
        const matches: string[] = [];
        for (const key of keys) {
            if (signal?.aborted) break;
            try {
                if ((await stat(resolve(root, key))).isFile()) matches.push(key);
            } catch (cause) {
                if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw cause;
            }
        }
        return matches;
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
            workspace_id: ctx.workspaceId, owner_id: commonsId, scheme: "file", authority: "", pathname,
        });
        // SPEC {§membership-change-gated-sync} — the cheap detect is a stat (mtime:size),
        // never a content read: a member whose signature matches its last sync is a
        // no-op (not re-read, re-tokenized, or rewritten). Coverage stays exhaustive
        // (every member is stat'd); work is proportional to change.
        let sig: string;
        let sourceBytes: number;
        try {
            const st = await stat(canonical);
            // A directory-shaped member — an embedded-repo boundary the untracked scan lists as
            // `dir/` (native + iso alike) — is a membership marker: disk truth is a directory,
            // nothing to materialize. Mirrors missing-on-disk: membership stands, no channel.
            if (st.isDirectory()) return null;
            sig = `${st.mtimeMs}:${st.size}`;
            sourceBytes = st.size;
        } catch (err) {
            if ((err as NodeJS.ErrnoException).code === "ENOENT") {
                if (known === undefined || known.synced_sig === ABSENT_SIG) return null;
                const prior = await ctx.db.ops_read_channel.get<{ content: string }>({
                    workspace_id: ctx.workspaceId,
                    owner_id: commonsId,
                    scheme: "file",
                    authority: "",
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
            const sourceMaterialization = FileMaterialization.fromAttributes(known.attributes);
            if (sourceMaterialization !== null) {
                if (FileMaterialization.matchesCurrent(sourceMaterialization, sourceBytes)) return null;
            } else {
                const sourceProjection = sourceProjectionFrom(known.attributes);
                if (sourceProjection !== null) {
                    const currentIdentity = await GitMembership.#projectionIdentity(
                        sourceProjection.mimetype,
                        ctx.mimetypes,
                        identities,
                    );
                    if (currentIdentity === sourceProjection.identity) return null;
                }
            }
        }

        const mimetype = await GitMembership.#detectMimetype(canonical, ctx.mimetypes);
        const sourceMaterialization = FileMaterialization.classify(sourceBytes);
        if (sourceMaterialization.disposition === "input-limit") {
            return GitMembership.#materializeLimited(
                pathname,
                mimetype,
                sig,
                known?.synced_sig !== sig,
                known?.synced_sig === ABSENT_SIG,
                sourceMaterialization,
                ctx,
            );
        }
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
        const diskChanged = known?.synced_sig !== sig;
        const prior = diskChanged
            ? await ctx.db.ops_read_channel.get<{ content: string }>({
                workspace_id: ctx.workspaceId, owner_id: commonsId, scheme: "file", authority: "", pathname, channel: "body",
            })
            : undefined;
        const result = await EntryCrud.writeEntry(
            { authority: "", pathname },
            {
                channels: { body: { content, mimetype } },
                attributes: FileMaterialization.attributes(sourceMaterialization),
            },
            ctx,
            "file",
            commonsId,
        );
        if (result.entryId !== null) await ctx.db.crud_set_synced_sig.run({ entry_id: result.entryId, synced_sig: sig });
        const changed = prior !== undefined && prior.content !== content;
        if ((changed || known?.synced_sig === ABSENT_SIG) && result.entryId !== null) {
            return { pathname, entryId: result.entryId, channel: "body", before: prior?.content ?? "", after: content };
        }
        return null;
    }

    static async #materializeLimited(
        pathname: string,
        mimetype: string,
        sig: string,
        diskChanged: boolean,
        previouslyAbsent: boolean,
        metadata: FileMaterializationMetadata,
        ctx: PlurnkSchemeContext,
    ): Promise<FsDivergence | null> {
        const commonsId = await Owner.commonsId(ctx.db, ctx.workspaceId);
        const prior = diskChanged
            ? await ctx.db.ops_read_channel.get<{ content: string }>({
                workspace_id: ctx.workspaceId,
                owner_id: commonsId,
                scheme: "file",
                authority: "",
                pathname,
                channel: "body",
            })
            : undefined;
        const result = await EntryCrud.writeEntry(
            { authority: "", pathname },
            {
                channels: {
                    body: {
                        content: "",
                        mimetype,
                        producerResult: FileMaterialization.failure(pathname, metadata),
                    },
                },
                attributes: FileMaterialization.attributes(metadata),
            },
            ctx,
            "file",
            commonsId,
        );
        if (result.entryId !== null) {
            await ctx.db.crud_set_synced_sig.run({ entry_id: result.entryId, synced_sig: sig });
        }
        const changed = prior !== undefined && prior.content !== "";
        if ((changed || previouslyAbsent) && result.entryId !== null) {
            return {
                pathname,
                entryId: result.entryId,
                channel: "body",
                before: prior?.content ?? "",
                after: "",
            };
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
                authority: "",
                pathname,
                channel: "body",
            })
            : undefined;
        const result = await EntryCrud.writeEntry(
            { authority: "", pathname },
            {
                channels: { body: { content, mimetype: outputMimetype } },
                attributes: { sourceProjection: metadata },
            },
            ctx,
            "file",
            await Owner.commonsId(ctx.db, ctx.workspaceId),
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
        const clear = (): void => {
            if (passes?.get(ctx.workspaceId) === run) passes.delete(ctx.workspaceId);
        };
        // The caller owns `run` and its exact rejection. Cleanup observes both
        // settlements without creating a detached rejecting `finally()` clone.
        void run.then(clear, clear);
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
