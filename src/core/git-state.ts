import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { Db, PrepMethod } from "./Db.ts";

export interface GitStatus {
    branch: string;
    ahead: number;
    behind: number;
    staged: number;
    unstaged: number;
    untracked: number;
}

// SPEC §telemetry — git working-tree state for the telemetry section: the model's
// ambient "where am I, what have I touched" without running a command. A
// service-side shell-out (git is local + cheap, the same surface git membership
// uses), gated by `PLURNK_GIT_ENABLED` (the hard service ceiling) + a git
// worktree. Returns null when git is disabled, headless, or non-git — the
// telemetry block is then omitted entirely. This is the *state* read; the
// model's arbitrary git *operations* go through the (daughter) EXEC[git].
export default class GitState {
    static #execFileP = promisify(execFile);

    static enabled(): boolean {
        // Feature-flag convention: `=== "1"` exactly. `.env.example` seeds it to 1
        // (default-on); a higher cascade level (shell/params) sets 0 to disable.
        return process.env.PLURNK_GIT_ENABLED === "1";
    }

    static async status(db: Db, sessionId: number, signal: AbortSignal | undefined): Promise<GitStatus | null> {
        if (!GitState.enabled()) return null;
        const row = await (db.envelope_get_session as PrepMethod).get<{ project_root: string | null }>({ id: sessionId });
        const root = row?.project_root ?? null;
        if (root === null) return null;
        let stdout: string;
        try {
            ({ stdout } = await GitState.#execFileP("git", ["status", "--porcelain", "--branch"], { cwd: root, signal, maxBuffer: 16 * 1024 * 1024 }));
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
