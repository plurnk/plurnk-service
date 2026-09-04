// {§git-skill} — the bundled git skill document is a worker-private entry beside the skills index,
// present exactly for a workspace whose project root sits inside a git repository, so the skills
// survey (turn zero's, or any FIND the model issues) lists it there with its summary; a
// plain-directory workspace never has it.
import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { Mock } from "@plurnk/plurnk-providers";
import { hermeticGitEnv } from "../../src/core/git-env.ts";
import { viableWindow } from "./_helpers.ts";
import { rpcCall, connect, withDaemon, waitForDb } from "./_rpc.ts";

const execFileP = promisify(execFile);

// The harness's plain-directory membership, so a repository-less root still admits its files.
process.env.PLURNK_MEMBERS_TASK = "**";
process.env.PLURNK_MEMBERS_ENABLED = "[\"task\"]";
process.env.PLURNK_SERVICE_OPTIMISTIC_WAIT_MS = "0";

const SUMMARY = "Advanced git usage: commits, branches, worktrees, and delegation in the Plurnk environment.";

const mockTurn = (dsl: string) => ({
    assistant: { content: `## PLAN0\n${dsl}`, reasoning: null, usage: { prompt: 0, completion: 0, reasoning: 0, cached: 0, total: 0 } },
    assistantRaw: null,
});

// One model FIND over the skills directory, then TERM: the survey the model itself would issue,
// independent of whether turn zero's orientation rows are visible or body-suppressed.
const runLoop = async (root: string) => {
    const mock = new Mock({
        contextWindow: viableWindow(),
        responses: [mockTurn("### FIND0 (worker://~/_plurnk/skills/*.md) <1,-1>\n\n### SEND0 (NEXT)\nlisting"), mockTurn("### SEND0 (TERM)\ndone")],
    });
    const rows = await withDaemon(mock, async (db, _daemon, addr) => {
        const ws = await connect(addr);
        try {
            await rpcCall(ws, 1, "workspace.create", { name: `git-skill-${Date.now()}`, projectRoot: root });
            const run = await rpcCall(ws, 2, "loop.run", { prompt: "look around", policy: { proposals: "accept" } });
            const loopId = (run.result as { loopId: number }).loopId;
            await waitForDb(
                () => db.engine_loop_status.get<{ status: number }>({ loop_id: loopId }),
                (r) => r?.status === 200,
                { timeoutMs: 30000 },
            );
            return db.test_entries_by_coordinate_owners.all<{ owner_id: number; content: string }>({ scheme: "worker", authority: "", pathname: "/_plurnk/skills/git.md" });
        } finally { ws.close(); }
    });
    const survey = mock.received[1]?.find((message) => message.role === "user");
    return { rows, survey: typeof survey?.content === "string" ? survey.content : "" };
};

test("{§git-skill} a git-backed workspace materializes git.md beside the skills index and the survey lists it", async () => {
    const root = await mkdtemp(join(tmpdir(), "plurnk-git-skill-"));
    try {
        await execFileP("git", ["init", "-q"], { cwd: root, env: hermeticGitEnv() });
        await writeFile(join(root, "README.md"), "# repo\n");
        await execFileP("git", ["add", "README.md"], { cwd: root, env: hermeticGitEnv() });
        await execFileP("git", ["-c", "user.name=test", "-c", "user.email=test@example.invalid", "commit", "-q", "-m", "init"], { cwd: root, env: hermeticGitEnv() });
        const { rows, survey } = await runLoop(root);
        assert.ok(rows.length >= 1, "git.md is materialized for the worker");
        assert.match(rows[0]!.content, /^# git — advanced repository usage\n\n## Summary\n\nAdvanced git usage: commits, branches, worktrees, and delegation in the Plurnk environment\./);
        assert.ok(survey.includes("worker://~/_plurnk/skills/git.md"), "the skills survey lists git.md");
        assert.ok(survey.includes(SUMMARY), "the survey row carries the summary");
        assert.ok(survey.includes("worker://~/_plurnk/skills/index.md"), "the skills index still sits beside it");
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test("{§git-skill} a plain-directory workspace has no git.md and its survey never names one", async () => {
    const root = await mkdtemp(join(tmpdir(), "plurnk-no-git-skill-"));
    try {
        await writeFile(join(root, "README.md"), "# plain\n");
        const { rows, survey } = await runLoop(root);
        assert.deepEqual(rows, []);
        assert.ok(!survey.includes("skills/git.md"));
        assert.ok(survey.includes("worker://~/_plurnk/skills/index.md"), "the survey itself ran");
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});
