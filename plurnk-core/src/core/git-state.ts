import { execFile } from "node:child_process";
import { gitOutputMaxBytes, hermeticGitEnv, isomorphicGitEnabled } from "./git-env.ts";
import GitIso from "./git-iso.ts";
import { promisify } from "node:util";
import type { Db } from "./Db.ts";
import WorkspaceSettings from "./workspace-settings.ts";
import Namespace from "./namespace.ts";

export interface GitFileStatus {
    path: string;
    status: string;
}

export interface GitStatus {
    branch: string;
    ahead: number;
    behind: number;
    staged: number;
    unstaged: number;
    untracked: number;
}

export interface GitStatusSnapshot extends GitStatus {
    files: GitFileStatus[];
}

// Git working-tree state for the packet: the model's ambient "where am I, what
// have I touched" without running a command. Native Git is the default;
// PLURNK_SERVICE_GIT_ISO=1 explicitly selects the in-process portability
// backend. Gated by `PLURNK_SERVICE_GIT_ALLOWED` (the
// hard service ceiling) + a git worktree. Returns null when git is disabled,
// headless, or non-git — the status block is then omitted entirely. This is the
// *state* read; the model's arbitrary git *operations* go through EXEC[git].
export default class GitState {
    static #execFileP = promisify(execFile);

    static enabled(): boolean {
        // Feature-flag convention: `=== "1"` exactly. `.env.defaults` seeds it to 1
        // (default-on); a higher cascade level (shell/params) sets 0 to disable.
        return process.env.PLURNK_SERVICE_GIT_ALLOWED === "1";
    }

    static async status(db: Db, workspaceId: number, signal: AbortSignal | undefined): Promise<GitStatusSnapshot | null> {
        // {§operator-config-workspace-git} — git:false denies workspace git status.
        if (!GitState.enabled() || (await WorkspaceSettings.read(db, workspaceId)).git === false) return null;
        const row = await db.envelope_get_workspace.get<{ project_root: string | null }>({ id: workspaceId });
        const root = row?.project_root ?? null;
        if (root === null) return null;
        if (isomorphicGitEnabled()) {
            const repository = await GitIso.repoToplevel(root);
            if (repository === null) return null;
            return GitIso.status(root, repository);
        }
        let stdout: string;
        try {
            ({ stdout } = await GitState.#execFileP("git", ["status", "--porcelain=v1", "-z", "--branch", "--untracked-files=all"], { cwd: root, signal, maxBuffer: gitOutputMaxBytes(), env: hermeticGitEnv() }));
        } catch {
            return null;  // not a git worktree, or git absent — fail closed, no status
        }
        return GitState.#parse(stdout, root, await GitIso.repoToplevel(root) ?? root);
    }

    // `git status --porcelain=v1 -z --branch --untracked-files=all`: one NUL-delimited branch header,
    // then XY + path records. NUL mode preserves every legal pathname and gives
    // rename/copy records a second path field without an invented ` -> ` syntax.
    static #parse(stdout: string, workspaceRoot: string, repositoryRoot: string): GitStatusSnapshot {
        let branch = "";
        let ahead = 0;
        let behind = 0;
        let staged = 0;
        let unstaged = 0;
        let untracked = 0;
        const files: GitFileStatus[] = [];
        const records = stdout.split("\0");
        for (let i = 0; i < records.length; i++) {
            const record = records[i];
            if (record.length === 0) continue;
            if (record.startsWith("## ")) {
                branch = record.slice(3).split(/\.\.\.| /, 1)[0];
                ahead = Number(record.match(/ahead (\d+)/)?.[1] ?? 0);
                behind = Number(record.match(/behind (\d+)/)?.[1] ?? 0);
                continue;
            }
            if (record.length < 4 || record[2] !== " ") {
                throw new TypeError(`Git status returned a malformed porcelain record: ${JSON.stringify(record)}`);
            }
            const xy = record.slice(0, 2);
            const path = Namespace.fromRepositoryPath(record.slice(3), workspaceRoot, repositoryRoot);
            if (xy === "??") {
                untracked++;
                files.push({ path, status: "??" });
                continue;
            }
            if (xy[0] !== " ") staged++;
            if (xy[1] !== " ") unstaged++;
            files.push({ path, status: xy });
            if (xy[0] === "R" || xy[0] === "C") {
                const priorRecord = records[++i];
                if (priorRecord === undefined || priorRecord.length === 0) {
                    throw new TypeError(`Git status omitted the source path for ${JSON.stringify(record)}`);
                }
                files.push({ path: Namespace.fromRepositoryPath(priorRecord, workspaceRoot, repositoryRoot), status: xy });
            }
        }
        files.sort((a, b) => a.path.localeCompare(b.path) || a.status.localeCompare(b.status));
        return { branch, ahead, behind, staged, unstaged, untracked, files };
    }
}
