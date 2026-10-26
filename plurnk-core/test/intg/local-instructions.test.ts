// {§turn0-local-instructions} The root AGENTS.local.md rides turn 0 after AGENTS.md: read from disk whatever its git
// status, hidden only by an exclusion, root only; absent, nothing.
import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { Mock } from "@plurnk/plurnk-providers";
import { hermeticGitEnv } from "../../src/core/git-env.ts";
import { rpcCall, connect, withDaemon, runLoopToTerminal } from "./_rpc.ts";
import { makeMockResponse } from "./_mock.ts";

const execFileP = promisify(execFile);
const LOCAL = "# Local\nThis machine's rules.\n";

// Each standing the root AGENTS.local.md can have in the repository, with and without the project AGENTS.md beside it.
for (const standing of ["absent", "ignored", "untracked", "tracked", "excluded"] as const) {
    for (const withAgents of [true, false]) {
        const projected = standing !== "absent" && standing !== "excluded";
        test(`{§turn0-local-instructions}: an AGENTS.local.md ${standing}${withAgents ? " beside AGENTS.md" : ""} is ${projected ? "read at turn 0" : "not projected"}`, async () => {
            const prior = Object.fromEntries(["PLURNK_SERVICE_GIT_ALLOWED", "PLURNK_SERVICE_GIT_AUTO", "PLURNK_MEMBERS_ENABLED", "PLURNK_MEMBERS_no_local"]
                .map((key) => [key, process.env[key]]));
            process.env.PLURNK_SERVICE_GIT_ALLOWED = "1";
            process.env.PLURNK_SERVICE_GIT_AUTO = "1";
            process.env.PLURNK_MEMBERS_ENABLED = "1";
            // An operator exclusion ({§members-configuration}).
            if (standing === "excluded") process.env.PLURNK_MEMBERS_no_local = "!AGENTS.local.md";
            const dir = await mkdtemp(join(tmpdir(), "plurnk-local-instructions-"));
            try {
                await execFileP("git", ["init", "-q"], { cwd: dir, env: hermeticGitEnv() });
                if (standing === "ignored") await writeFile(join(dir, ".gitignore"), "AGENTS.local.md\n", "utf8");
                if (withAgents) await writeFile(join(dir, "AGENTS.md"), "# Project\nShared rules.\n", "utf8");
                if (standing !== "absent") await writeFile(join(dir, "AGENTS.local.md"), LOCAL, "utf8");
                if (standing === "tracked") await execFileP("git", ["add", "AGENTS.local.md"], { cwd: dir, env: hermeticGitEnv() });
                await mkdir(join(dir, "packages", "web"), { recursive: true });
                await writeFile(join(dir, "packages", "web", "AGENTS.local.md"), "# Nested\n", "utf8");
                const mock = new Mock({ contextWindow: 16384, responses: [makeMockResponse("````SEND [200]\ndone\n````", 50)] });
                await withDaemon(mock, async (db, _daemon, addr) => {
                    const ws = await connect(addr);
                    try {
                        const workspaceId = ((await rpcCall(ws, 1, "workspace.create", { name: "local-instructions", projectRoot: dir })).result as { id: number }).id;
                        const { loopId, finalStatus } = (await runLoopToTerminal(ws, 2, { prompt: "go" })) as { loopId: number; finalStatus: number };
                        assert.equal(finalStatus, 200);
                        const entry = await db.crud_find_workspace_entry.get<{ id: number }>({
                            workspace_id: workspaceId, scheme: "workspace", authority: "", pathname: "/_plurnk/AGENTS.local.md",
                        });
                        assert.equal(entry !== undefined, projected, projected ? "the local file is projected" : "nothing is projected");
                        if (entry !== undefined) {
                            const body = await db.test_get_channel.get<{ content: string }>({ entry_id: entry.id, name: "body" });
                            assert.equal(body?.content, LOCAL, "the projection mirrors the file");
                        }
                        const rows = await db.test_log_entries_by_loop.all<{ op: string; scheme: string; hostname: string | null; pathname: string; status_rx: number }>({ loop_id: loopId });
                        const reads = rows.filter((row) => row.op === "READ" && row.scheme === "workspace" && row.hostname === null && /^\/_plurnk\/AGENTS(\.local)?\.md$/u.test(row.pathname));
                        assert.deepEqual(reads.map(({ pathname, status_rx }) => [pathname, status_rx]),
                            [...withAgents ? [["/_plurnk/AGENTS.md", 200]] : [], ...projected ? [["/_plurnk/AGENTS.local.md", 200]] : []],
                            "turn 0 reads AGENTS.md, then its local override, each found");
                        const nested = await db.crud_find_workspace_entry.get<{ id: number }>({
                            workspace_id: workspaceId, scheme: "workspace", authority: "", pathname: "/_plurnk/instructions/packages/web/AGENTS.local.md",
                        });
                        assert.equal(nested, undefined, "a nested AGENTS.local.md is never projected");
                    } finally { ws.close(); }
                });
            } finally {
                await rm(dir, { recursive: true, force: true });
                for (const [key, value] of Object.entries(prior)) {
                    if (value === undefined) delete process.env[key];
                    else process.env[key] = value;
                }
            }
        });
    }
}
