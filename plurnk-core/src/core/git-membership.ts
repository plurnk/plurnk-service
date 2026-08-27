// SPEC {§membership} D4 — git-ls-files workspace membership. {§membership-git-membership}
//
// When a workspace's `project_root` is a git working tree, the git-tracked
// files (`git ls-files`) are workspace MEMBERS without any definition.
// This module resolves that membership and (when token accounting is
// available) materializes active members' model-readable representation into a body channel,
// so they appear in the entry catalog (FIND-served) and are READ-able.
//
// Decisions realized here:
//   D1 — workspace identity lives on the workspace (project_root).
//   D3 — disk co-location: members are channel-less markers until materialized;
//        disk stays the truth.
//   D4 — git present → ls-files membership. Git absent → no ambient fs-walk;
//        member definitions and creation records remain the membership substrate.
//        The overlay (workspace_constraints: include | exclude) composes here:
//        `(ls-files ∪ include) − exclude` ({§membership-overlay-include}).
//   D5 — coverage is exhaustive, work is change-gated: every member is stat'd each
//        turn, but only one whose mtime:size signature changed is re-read,
//        re-tokenized, and rewritten. A binary source also compares the installed
//        projection identity without reacquiring bytes. EMI divergence rides the
//        same pass. {§membership-change-gated-sync}
//
// Git resolution uses native Git (subprocess + hermeticGitEnv,
// AbortSignal-respecting).

import { execFile, spawn } from "node:child_process";
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

// One overlay row ({§members-projection}): members / model — a projected definition (human-authored
// / model-proposed, the latter never admitted past the repository's ignore rules); create — the
// exact record of a file Plurnk wrote ({§fs-create-record}).
export type OverlayRow = {
    effect: "include" | "exclude";
    glob: string;
    source: "create" | "members" | "model";
};

// What an overlay resolves to on disk — a read for the members family ({§members-projection}).
export type OverlayResolution = {
    root: string;
    tracked: ReadonlySet<string>;
    members: string[];
    excluded: string[];
    masked: string[];
    scans: ReadonlyMap<string, readonly string[]>;
    excludeGlobs: readonly string[];
};

export type FileCreationAdmission =
    | {
        ok: true;
        // {§membership-baseline}: a creation is never incorporated by Git — an exact creation
        // record, or a projected member definition that already covers the path; never `git add`.
        incorporation: "definition" | "creation";
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
    creationRecord: boolean;
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
    // active repository ignores, or an exclusion matches, contributes nothing.
    static async excludesInstruction(db: Db, workspaceId: number, key: string, signal?: AbortSignal): Promise<boolean> {
        const constraints = await db.crud_list_workspace_constraints.all<OverlayRow>({ workspace_id: workspaceId });
        if (constraints.some(({ effect, glob }) => effect === "exclude" && matchesGlob(key, glob))) return true;
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

        const rows = await db.crud_list_workspace_constraints.all<OverlayRow>({ workspace_id: workspaceId });
        const exclusion = rows.find(({ effect, glob }) => effect === "exclude" && matchesGlob(key, glob));
        if (exclusion !== undefined) {
            return {
                ok: false,
                code: "file-create-excluded",
                status: 403,
                detail: `A members exclusion (\`!${exclusion.glob}\`) covers '${key}'.`,
                extensions: {
                    path: key,
                    glob: exclusion.glob,
                    recovery: "Remove or disable the excluding members definition, or choose another path.",
                    retryable: false,
                },
            };
        }

        if (rows.some(({ effect, glob, source }) =>
            effect === "include" && source === "members" && matchesGlob(key, glob))) {
            return { ok: true, incorporation: "definition" };
        }

        const repository = await GitMembership.#activeAutomaticRepository(db, workspaceId, root, signal);
        if (repository !== null) {
            const ignored = await GitMembership.#isIgnoredByRepository(root, repository, key, signal);
            if (ignored === true) {
                return {
                    ok: false,
                    code: "file-create-gitignored",
                    status: 403,
                    detail: `Active Git policy ignores '${key}', and no members definition includes it.`,
                    extensions: {
                        path: key,
                        recovery: "Choose a Git-admitted path or add a members definition that includes it.",
                        retryable: false,
                    },
                };
            }
        }
        // {§membership-baseline}: not ignored, in root, admitted — still a record, never a stage.
        return { ok: true, incorporation: "creation" };
    }

    // {§file-create-transaction}: this is the only incorporation owner. The caller has already
    // created and materialized the entry; the record row is the transaction's final fallible state
    // change. {§membership-baseline}: Plurnk never runs `git add` — a created file is a member
    // because a record says so, exactly like every other added file in the model's universe.
    static async incorporateCreation(
        db: Db,
        workspaceId: number,
        entryId: number,
        key: string,
        admission: Extract<FileCreationAdmission, { ok: true }>,
    ): Promise<FileCreationIncorporation> {
        await db.crud_set_origin.run({ entry_id: entryId, membership_origin: "constraint" });
        if (admission.incorporation === "definition") return { origin: "constraint", creationRecord: false };
        await db.crud_insert_generated_workspace_constraint.run({ workspace_id: workspaceId, glob: key });
        return { origin: "constraint", creationRecord: true };
    }

    static removeCreationRecord(db: Db, workspaceId: number, key: string): Promise<unknown> {
        return db.crud_delete_generated_workspace_constraint.run({ workspace_id: workspaceId, glob: key });
    }

    // {§membership-baseline}: the repository contributes exactly its TRACKED files. An untracked
    // file — however convenient — is never an ambient member; a member definition is the only
    // other grantor.
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

    // Single-sources the (git ∪ include) derivation and the exclusion globs for
    // #reconcileGitMembership (compose + reconcile) and resolveOverlay (a read for the members
    // family, {§members-projection}). Headless → null.
    static async #resolveOverlayInputs(
        db: Db,
        workspaceId: number,
        signal: AbortSignal | undefined,
        constraints: readonly OverlayRow[],
    ): Promise<{ root: string; gitMembers: string[]; included: string[]; masked: string[]; excludeGlobs: string[]; scans: Map<string, string[]> } | null> {
        const root = await GitMembership.#loadWorkspaceRoot(db, workspaceId);
        if (root === null) return null;   // headless — no disk surface to resolve

        const excludeGlobs = constraints.filter((c) => c.effect === "exclude").map((c) => c.glob);
        const definitionGlobs = [...new Set(constraints.filter((c) => c.effect === "include" && c.source === "members").map((c) => c.glob))];
        const creationKeys = constraints.filter((c) => c.effect === "include" && c.source === "create").map((c) => c.glob);
        // A human definition of the same pattern already admits it, past ignore; scan it once.
        const modelGlobs = [...new Set(constraints.filter((c) => c.effect === "include" && c.source === "model").map((c) => c.glob))]
            .filter((pattern) => !definitionGlobs.includes(pattern));

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

        // Member definitions may supersede Git ignore; creation records and model definitions may
        // not. All remain targeted scans rather than a blind filesystem walk.
        const scans = new Map<string, string[]>();
        for (const pattern of definitionGlobs) scans.set(pattern, await GitMembership.#scanIncluded(root, [pattern], signal));
        const defined = [...scans.values()].flat();
        const ignoredBy = async (pathname: string): Promise<boolean | null> =>
            (repository === null ? null : GitMembership.#isIgnoredByRepository(root, repository, pathname, signal));
        const admitted: string[] = [];
        const masked: string[] = [];
        for (const pathname of await GitMembership.#scanCreations(root, creationKeys, signal)) {
            if ((await ignoredBy(pathname)) === true) masked.push(pathname);
            else admitted.push(pathname);
        }
        // {§members-projection}: a model definition is a pattern scan like a human one, but it never
        // outranks the repository's ignore rules ({§membership-model-universe}).
        for (const pattern of modelGlobs) {
            const scan = await GitMembership.#scanIncluded(root, [pattern], signal);
            scans.set(pattern, scan);
            for (const pathname of scan) {
                if ((await ignoredBy(pathname)) === true) masked.push(pathname);
                else admitted.push(pathname);
            }
        }
        const included = [...new Set([...defined, ...admitted])]; // {§membership-overlay-include}
        return { root, gitMembers, included, masked, excludeGlobs, scans };
    }

    static async #removeMissingCreationRecords(
        db: Db,
        workspaceId: number,
        root: string,
    ): Promise<void> {
        const constraints = await db.crud_list_workspace_constraints.all<OverlayRow>({ workspace_id: workspaceId });
        for (const { effect, glob: key, source } of constraints) {
            if (effect !== "include" || source !== "create") continue;
            try {
                if ((await stat(resolve(root, key))).isFile()) continue;
            } catch (cause) {
                if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw cause;
            }
            await GitMembership.removeCreationRecord(db, workspaceId, key);
        }
    }

    // Resolve a workspace's file membership: the desired set is (git ls-files ∪ include
    // patterns) − exclude patterns (SPEC {§membership} overlay), reconciled against the registered
    // overlay-owned members so entries == members. Channel-less rows — disk is the
    // truth (D3); the row is the membership marker File.read gates on. Returns the
    // desired pathnames so the caller can materialize them through writeEntry.
    //
    // signal-respecting: git shell-outs + the pattern scans honor `signal`. Headless
    // (no project_root) yields nothing; a non-git root with inclusions still resolves.
    static async #reconcileGitMembership(
        db: Db,
        workspaceId: number,
        signal: AbortSignal | undefined,
    ): Promise<MembershipResolution> {
        const root = await GitMembership.#loadWorkspaceRoot(db, workspaceId);
        if (root === null) return { members: [], removed: [] };
        await GitMembership.#removeMissingCreationRecords(db, workspaceId, root);
        const constraints = await db.crud_list_workspace_constraints.all<OverlayRow>({ workspace_id: workspaceId });
        const inputs = await GitMembership.#resolveOverlayInputs(db, workspaceId, signal, constraints);
        if (inputs === null) return { members: [], removed: [] };   // headless — no disk surface to resolve
        const { gitMembers: members, included, masked, excludeGlobs } = inputs;

        // Compose: (git ∪ include) − exclude ({§membership-overlay-exclude}). An inclusion wins
        // provenance when both grantors admit a path; outside-root write authority
        // must not collapse into a read-only Git origin.
        const includedSet = new Set(included);
        const passesExclusions = (p: string): boolean => excludeGlobs.length === 0 || !excludeGlobs.some((g) => matchesGlob(p, g));
        const desiredGit = members.filter((p) => !includedSet.has(p) && passesExclusions(p));
        const desiredIncluded = included.filter(passesExclusions);
        // Glob matching above stays bare (definition patterns are bare);
        // storage, reconcile, and the returned set are namespace-absolute (`/src/foo.ts`)
        // so they match the parser's pathname the shared read helper queries by.
        const desired = [...desiredGit, ...desiredIncluded]; // bare canon keys ({§fs-canonical-name}) — ls-files output IS the canon
        const desiredSet = new Set(desired);
        const candidateSet = new Set([...members, ...included, ...masked]);

        // Reconcile so entries == members (the constitutive invariant): register the
        // desired with their origin, then un-register any overlay-owned member ('git'
        // or 'constraint') no longer desired — untracked, unmatched, or newly excluded.
        const commonsId = await Owner.commonsId(db, workspaceId);
        for (const pathname of desiredGit) {
            await db.crud_register_workspace_member.get({ workspace_id: workspaceId, owner_id: commonsId, scheme: "file", authority: "", pathname, membership_origin: "git" });
        }
        for (const pathname of desiredIncluded) {
            await db.crud_register_workspace_member.get({ workspace_id: workspaceId, owner_id: commonsId, scheme: "file", authority: "", pathname, membership_origin: "constraint" });
        }
        const registered = await db.crud_list_reconcilable_members.all<{ id: number; pathname: string }>({ workspace_id: workspaceId });
        const removed: FsDivergence[] = [];
        for (const m of registered) {
            if (!desiredSet.has(m.pathname)) {
                // A path that left Git/include membership also left disk truth (for
                // example an untracked deletion or staged rename). An exclusion is
                // policy, not a filesystem occurrence, and is therefore silent.
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

    // {§members-projection} — what an overlay resolves to, without mutating: the committed rows
    // when `rows` is undefined, else the engine's creation records plus the given family rows (a
    // family preparing its projection). Headless → null.
    static async resolveOverlay(
        db: Db,
        workspaceId: number,
        rows: readonly OverlayRow[] | undefined,
        signal: AbortSignal | undefined,
    ): Promise<OverlayResolution | null> {
        const stored = await db.crud_list_workspace_constraints.all<OverlayRow>({ workspace_id: workspaceId });
        const constraints = rows === undefined ? stored : [...stored.filter((row) => row.source === "create"), ...rows];
        const inputs = await GitMembership.#resolveOverlayInputs(db, workspaceId, signal, constraints);
        if (inputs === null) return null;
        const { root, gitMembers, included, masked, excludeGlobs, scans } = inputs;
        const excludedBy = (p: string): boolean => excludeGlobs.some((g) => matchesGlob(p, g));
        const candidates = [...new Set([...gitMembers, ...included])].toSorted();
        return {
            root,
            tracked: new Set(gitMembers),
            members: candidates.filter((p) => !excludedBy(p)),
            excluded: candidates.filter(excludedBy),
            masked,
            scans,
            excludeGlobs,
        };
    }

    // Whether the active repository ignores `key`; null when no automatic repository governs it.
    static async isIgnored(db: Db, workspaceId: number, key: string, signal: AbortSignal | undefined): Promise<boolean | null> {
        const root = await GitMembership.#loadWorkspaceRoot(db, workspaceId);
        if (root === null) return null;
        const repository = await GitMembership.#activeAutomaticRepository(db, workspaceId, root, signal);
        if (repository === null) return null;
        return GitMembership.#isIgnoredByRepository(root, repository, key, signal);
    }

    // The files one include pattern names on disk — the members family's preview of an `add`.
    static scanPattern(root: string, pattern: string, signal: AbortSignal | undefined): Promise<string[]> {
        return GitMembership.#scanIncluded(root, [pattern], signal);
    }

    // Which of `paths` the active repository ignores, in one `git check-ignore` pass.
    static async ignoredSubset(db: Db, workspaceId: number, paths: readonly string[], signal: AbortSignal | undefined): Promise<Set<string>> {
        const ignored = new Set<string>();
        if (paths.length === 0) return ignored;
        const root = await GitMembership.#loadWorkspaceRoot(db, workspaceId);
        if (root === null) return ignored;
        const repository = await GitMembership.#activeAutomaticRepository(db, workspaceId, root, signal);
        if (repository === null) return ignored;
        const keys = new Map<string, string>();
        for (const key of paths) {
            const repositoryPath = relative(repository, resolve(root, key));
            if (repositoryPath === "" || repositoryPath.startsWith("..") || isAbsolute(repositoryPath)) continue;
            keys.set(repositoryPath, key);
        }
        if (keys.size === 0) return ignored;
        const child = spawn("git", ["check-ignore", "-z", "--stdin"], { cwd: repository, env: hermeticGitEnv(), signal, stdio: ["pipe", "pipe", "pipe"] });
        const out: Buffer[] = [];
        const err: Buffer[] = [];
        child.stdout.on("data", (chunk: Buffer) => out.push(chunk));
        child.stderr.on("data", (chunk: Buffer) => err.push(chunk));
        child.stdin.end(`${[...keys.keys()].join("\0")}\0`);
        const code = await new Promise<number | null>((settle, reject) => {
            child.once("error", reject);
            child.once("close", settle);
        });
        // 0: some path is ignored; 1: none is. Anything else is a failed subprocess.
        if (code !== 0 && code !== 1) throw new Error(`git check-ignore failed (${code}): ${Buffer.concat(err).toString("utf8").trim()}`);
        for (const repositoryPath of Buffer.concat(out).toString("utf8").split("\0")) {
            const key = keys.get(repositoryPath);
            if (key !== undefined) ignored.add(key);
        }
        return ignored;
    }

    // Targeted definition scan (SPEC {§membership} `include`) — enumerate disk files
    // matching the patterns via node:fs glob (the pattern bounds the
    // traversal; never a blind fs-walk). Files only — directories aren't members.
    // Workspace-relative paths, the same shape as git ls-files.
    static async #scanIncluded(
        root: string,
        patterns: string[],
        signal: AbortSignal | undefined,
    ): Promise<string[]> {
        const matches = new Set<string>();
        for (const pattern of patterns) {
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

    // Creation records store canonical paths in the `glob` column, but their contract is exact.
    // Never reinterpret legal path metacharacters as patterns when restoring creation provenance.
    static async #scanCreations(
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
