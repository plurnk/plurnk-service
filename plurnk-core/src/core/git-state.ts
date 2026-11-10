import { execFile } from "node:child_process";
import { declaredFilterProgram, gitOutputMaxBytes, hermeticGitEnv } from "./git-env.ts";
import { promisify } from "node:util";
import type { Db } from "./Db.ts";
import WorkspaceSettings from "./workspace-settings.ts";
import Namespace from "./namespace.ts";

interface GitFileStatus {
    path: string;
    status: string;
}

export interface GitStatus {
    branch: string | null;
    unborn?: boolean;
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
// have I touched" without running a command. Gated by
// `PLURNK_SERVICE_GIT_ALLOWED` (the
// hard service ceiling) + a git worktree. Returns null when git is disabled,
// headless, or non-git — the status block is then omitted entirely. This is the
// *state* read; the model's arbitrary git *operations* go through the `git` runtime.
export default class GitState {
    static #execFileP = promisify(execFile);

    static enabled(): boolean {
        // Feature-flag convention: `=== "1"` exactly. `.env.defaults` seeds it to 1
        // (default-on); a higher cascade level (shell/params) sets 0 to disable.
        return process.env.PLURNK_SERVICE_GIT_ALLOWED === "1";
    }

    static async status(db: Db, workspaceId: number, signal: AbortSignal | undefined): Promise<GitStatusSnapshot | null> {
        // {§operator-config-workspace-settings} — git:false denies workspace git status.
        if (!GitState.enabled() || (await WorkspaceSettings.read(db, workspaceId)).git === false) return null;
        const row = await db.envelope_get_workspace.get<{ project_root: string | null }>({ id: workspaceId });
        const root = row?.project_root ?? null;
        if (root === null) return null;
        let statusOutput: string;
        let repositoryRoot: string;
        const options = { cwd: root, signal, maxBuffer: gitOutputMaxBytes(), env: hermeticGitEnv(root) };
        try {
            repositoryRoot = (await GitState.#execFileP("git", ["rev-parse", "--show-toplevel"], options)).stdout.trim();
        } catch {
            return null;  // not a git worktree, or git absent — fail closed, no status
        }
        // {§membership} (#568): a supplied repository declaring a `filter.*` program is
        // never status-refreshed automatically — it could run that program as the daemon. The
        // membership pass that precedes this read announces the refusal once.
        if ((await declaredFilterProgram(repositoryRoot, signal)) !== null) return null;
        try {
            statusOutput = (await GitState.#execFileP("git", ["status", "--porcelain=v2", "-z", "--branch", "--untracked-files=all"], options)).stdout;
        } catch {
            return null;  // the worktree vanished or git failed — fail closed, no status
        }
        return GitState.#parse(statusOutput, root, repositoryRoot);
    }

    // Porcelain v2's branch headers distinguish unborn/detached HEAD without parsing prose.
    // NUL mode preserves path bytes, including the separate source of a rename/copy.
    static #parse(stdout: string, workspaceRoot: string, repositoryRoot: string): GitStatusSnapshot {
        let branch: string | null | undefined;
        let unborn = false;
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
            if (record.startsWith("# ")) {
                if (record.startsWith("# branch.head ")) {
                    const head = record.slice("# branch.head ".length);
                    branch = head === "(detached)" ? null : head;
                } else if (record.startsWith("# branch.oid ")) {
                    unborn = record === "# branch.oid (initial)";
                } else if (record.startsWith("# branch.ab ")) {
                    const counts = /^# branch\.ab \+(\d+) -(\d+)$/.exec(record);
                    if (counts === null) throw new TypeError(`Git status returned malformed tracking counts: ${JSON.stringify(record)}`);
                    ahead = Number(counts[1]);
                    behind = Number(counts[2]);
                }
                continue;
            }
            if (record.startsWith("? ")) {
                const rawPath = record.slice(2);
                if (rawPath.endsWith("/")) continue;
                untracked++;
                files.push({ path: Namespace.fromRepositoryPath(rawPath, workspaceRoot, repositoryRoot), status: "??" });
                continue;
            }
            const fields = record.split(" ");
            const prefixLength = record[0] === "1" ? 8 : record[0] === "2" ? 9 : record[0] === "u" ? 10 : 0;
            if (prefixLength === 0 || fields.length <= prefixLength || fields[1]?.length !== 2
                || fields.slice(0, prefixLength).some((field) => field.length === 0)) {
                throw new TypeError(`Git status returned a malformed porcelain record: ${JSON.stringify(record)}`);
            }
            const xy = fields[1].replaceAll(".", " ");
            const path = Namespace.fromRepositoryPath(fields.slice(prefixLength).join(" "), workspaceRoot, repositoryRoot);
            if (xy[0] !== " ") staged++;
            if (xy[1] !== " ") unstaged++;
            files.push({ path, status: xy });
            if (record[0] === "2") {
                const priorRecord = records[++i];
                if (priorRecord === undefined || priorRecord.length === 0) {
                    throw new TypeError(`Git status omitted the source path for ${JSON.stringify(record)}`);
                }
                files.push({ path: Namespace.fromRepositoryPath(priorRecord, workspaceRoot, repositoryRoot), status: xy });
            }
        }
        if (branch === undefined || branch === "") throw new TypeError("Git status omitted its branch.head header");
        files.sort((a, b) => a.path.localeCompare(b.path) || a.status.localeCompare(b.status));
        return { branch, unborn, ahead, behind, staged, unstaged, untracked, files };
    }
}
