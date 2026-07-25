import { execFile } from "node:child_process";
import { hermeticGitEnv } from "./git-env.ts";
import GitIso from "./git-iso.ts";
import { promisify } from "node:util";
import type { Db } from "./Db.ts";
import WorkspaceSettings from "./workspace-settings.ts";

export interface GitStatus {
    branch: string;
    ahead: number;
    behind: number;
    staged: number;
    unstaged: number;
    untracked: number;
}

// SPEC §telemetry — git working-tree state for the telemetry section: the model's
// ambient "where am I, what have I touched" without running a command. In-process
// by default (GitIso / isomorphic-git, #461 — portable, sandbox-safe, hermetic by
// construction); PLURNK_SERVICE_GIT_NATIVE=1 shells out to system git instead (the
// same surface git membership routes). Gated by `PLURNK_SERVICE_GIT_ALLOWED` (the
// hard service ceiling) + a git worktree. Returns null when git is disabled,
// headless, or non-git — the telemetry block is then omitted entirely. This is the
// *state* read; the model's arbitrary git *operations* go through EXEC[git].
export default class GitState {
    static #execFileP = promisify(execFile);

    static enabled(): boolean {
        // Feature-flag convention: `=== "1"` exactly. `.env.defaults` seeds it to 1
        // (default-on); a higher cascade level (shell/params) sets 0 to disable.
        return process.env.PLURNK_SERVICE_GIT_ALLOWED === "1";
    }

    static async status(db: Db, workspaceId: number, signal: AbortSignal | undefined): Promise<GitStatus | null> {
        // #232 — git:false denies git telemetry for the workspace (env AND workspace ceiling).
        if (!GitState.enabled() || (await WorkspaceSettings.read(db, workspaceId)).git === false) return null;
        const row = await db.envelope_get_workspace.get<{ project_root: string | null }>({ id: workspaceId });
        const root = row?.project_root ?? null;
        if (root === null) return null;
        if (process.env.PLURNK_SERVICE_GIT_NATIVE !== "1") {
            try {
                return await GitIso.status(root);
            } catch {
                return null;  // not a git worktree (or unborn HEAD) — fail closed, no telemetry
            }
        }
        let stdout: string;
        try {
            ({ stdout } = await GitState.#execFileP("git", ["status", "--porcelain", "--branch"], { cwd: root, signal, maxBuffer: 16 * 1024 * 1024, env: hermeticGitEnv() }));
        } catch {
            return null;  // not a git worktree, or git absent — fail closed, no telemetry
        }
        return GitState.#parse(stdout);
    }

    // `git status --porcelain --branch`: a `## branch...remote [ahead N, behind M]`
    // header, then one XY-prefixed line per change (X=index/staged, Y=worktree/
    // unstaged; `??` = untracked).
    static #parse(stdout: string): GitStatus {
        let branch = "";
        let ahead = 0;
        let behind = 0;
        let staged = 0;
        let unstaged = 0;
        let untracked = 0;
        for (const line of stdout.split("\n")) {
            if (line.length === 0) continue;
            if (line.startsWith("## ")) {
                branch = line.slice(3).split(/\.\.\.| /, 1)[0];
                ahead = Number(line.match(/ahead (\d+)/)?.[1] ?? 0);
                behind = Number(line.match(/behind (\d+)/)?.[1] ?? 0);
                continue;
            }
            const xy = line.slice(0, 2);
            if (xy === "??") { untracked++; continue; }
            if (xy[0] !== " ") staged++;
            if (xy[1] !== " ") unstaged++;
        }
        return { branch, ahead, behind, staged, unstaged, untracked };
    }
}
