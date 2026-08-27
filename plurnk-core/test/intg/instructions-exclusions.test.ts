// {§membership-model-universe} entry (3): the AGENTS.md standard admits instruction content from
// disk, but never past the operator's exclusions — an AGENTS.md the repository ignores, or a hide
// constraint matches, is not projected; a plain nested one still is (#400).
import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { Mock } from "@plurnk/plurnk-providers";
import { hermeticGitEnv } from "../../src/core/git-env.ts";
import { rpcCall, connect, withDaemon, makeMockResponse, runLoopToTerminal } from "./_rpc.ts";

const execFileP = promisify(execFile);

test("an ignored or hidden AGENTS.md is never projected; the standard does not outrank .gitignore or hide", async () => {
    const priorAllowed = process.env.PLURNK_SERVICE_GIT_ALLOWED;
    const priorAuto = process.env.PLURNK_SERVICE_GIT_AUTO;
    process.env.PLURNK_SERVICE_GIT_ALLOWED = "1";
    process.env.PLURNK_SERVICE_GIT_AUTO = "1";
    const dir = await mkdtemp(join(tmpdir(), "plurnk-instructions-"));
    try {
        await execFileP("git", ["init", "-q"], { cwd: dir, env: hermeticGitEnv() });
        await writeFile(join(dir, ".gitignore"), "packages/secret/AGENTS.md\n/AGENTS.md\n", "utf8");
        await writeFile(join(dir, "AGENTS.md"), "# root — ignored by .gitignore\n", "utf8");
        for (const sub of ["web", "secret", "hidden"]) {
            await mkdir(join(dir, "packages", sub), { recursive: true });
            await writeFile(join(dir, "packages", sub, "AGENTS.md"), `# ${sub}\n`, "utf8");
        }
        const mock = new Mock({ contextWindow: 16384, responses: [makeMockResponse("## SEND0 [200]\ndone", 50)] });
        await withDaemon(mock, async (db, _daemon, addr) => {
            const ws = await connect(addr);
            try {
                const workspaceId = ((await rpcCall(ws, 1, "workspace.create", { name: "instructions", projectRoot: dir })).result as { id: number }).id;
                await db.crud_insert_workspace_constraint.run({ workspace_id: workspaceId, effect: "hide", glob: "packages/hidden/**" });
                const { loopId, finalStatus } = (await runLoopToTerminal(ws, 2, { prompt: "go" })) as { loopId: number; finalStatus: number };
                assert.equal(finalStatus, 200);
                const workerId = (await db.test_get_worker_id_by_loop.get<{ worker_id: number }>({ loop_id: loopId }))!.worker_id;
                const entry = (pathname: string) => db.crud_find_workspace_entry.get<{ id: number }>({
                    workspace_id: workspaceId, owner_id: workerId, scheme: "worker", authority: "", pathname,
                });
                assert.equal(await entry("/_plurnk/agents.md"), undefined, "a gitignored root AGENTS.md is not projected");
                assert.equal(await entry("/_plurnk/instructions/packages/secret/AGENTS.md"), undefined, "a gitignored nested AGENTS.md is not projected");
                assert.equal(await entry("/_plurnk/instructions/packages/hidden/AGENTS.md"), undefined, "a hidden nested AGENTS.md is not projected");
                assert.ok(await entry("/_plurnk/instructions/packages/web/AGENTS.md"), "an admitted nested AGENTS.md still is");
                const rows = await db.test_log_entries_by_worker.all<{ op: string | null; pathname: string; status_rx: number }>({ worker_id: workerId });
                assert.equal(rows.some((r) => r.pathname === "/_plurnk/agents.md" && r.status_rx >= 400), false, "no turn-0 stunt fires for an excluded root AGENTS.md — nothing 404s");
            } finally { ws.close(); }
        });
    } finally {
        await rm(dir, { recursive: true, force: true });
        if (priorAllowed === undefined) delete process.env.PLURNK_SERVICE_GIT_ALLOWED;
        else process.env.PLURNK_SERVICE_GIT_ALLOWED = priorAllowed;
        if (priorAuto === undefined) delete process.env.PLURNK_SERVICE_GIT_AUTO;
        else process.env.PLURNK_SERVICE_GIT_AUTO = priorAuto;
    }
});
