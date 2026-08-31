// #449 — a body FIND over a large member tree survives a member whose content crashes
// a mimetype handler (run127's exact shape: an unbalanced HTML template partial walked
// Readability into a null and a 1,916-file FIND died as a blank 500).
import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, writeFile, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Mock } from "@plurnk/plurnk-providers";
import { hermeticGitEnv } from "../../src/core/git-env.ts";
import { rpcCall, connect, withDaemon, makeMockResponse, runLoopToTerminal } from "./_rpc.ts";

const execFileP = promisify(execFile);

test("#449: a body FIND over ~2k members with a handler-crashing member answers truthfully, not 500", async () => {
    const root = await mkdtemp(join(tmpdir(), "plurnk-findglob-"));
    try {
        const env = hermeticGitEnv();
        await execFileP("git", ["init", "-q"], { cwd: root, env });
        await execFileP("git", ["config", "user.email", "fixture@plurnk.invalid"], { cwd: root, env });
        await execFileP("git", ["config", "user.name", "t"], { cwd: root, env });
        await writeFile(join(root, "main.go"), "package main\n");
        for (let dir = 0; dir < 40; dir += 1) {
            await mkdir(join(root, "test", `pkg${dir}`), { recursive: true });
            for (let file = 0; file < 48; file += 1) {
                await writeFile(join(root, "test", `pkg${dir}`, `case${file}_test.go`), `package pkg${dir}\n// marker case\n`);
            }
        }
        // The corpus poison: an unbalanced template partial that crashes Readability.
        await writeFile(
            join(root, "test", "pkg0", "header.html"),
            "<header><div class=\"cart\"></a>{{ render \"/partials/mini-cart.html\" }}</div></header>\n",
        );
        await execFileP("git", ["add", "-A"], { cwd: root, env });
        await execFileP("git", ["-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", "commit", "--no-verify", "-q", "-m", "seed"], { cwd: root, env });

        const mock = new Mock({ contextWindow: 200_000, responses: [
            makeMockResponse("## FIND0 (test/**)\nmarker case\n\n## SEND0 [102]\nlooking", 50),
            makeMockResponse("## SEND0 [200]\ndone", 50),
        ] });
        await withDaemon(mock, async (db, _daemon, addr) => {
            const ws = await connect(addr);
            try {
                await rpcCall(ws, 1, "workspace.create", { name: "findglob", projectRoot: root });
                const outcome = await runLoopToTerminal(ws, 2, { prompt: "find", policy: { proposals: "accept" } });
                assert.equal(outcome.result.status, 200);
                const rows = await db.engine_render_log.all<{ op: string; status_rx: number; rx: string }>({ worker_id: outcome.modelWorkerId! });
                const find = rows.find(({ op }) => op === "FIND");
                assert.ok(find, "the FIND row exists");
                assert.notEqual(find!.status_rx, 500, `FIND must not 500: ${JSON.parse(find!.rx).problem?.detail ?? find!.rx.slice(0, 200)}`);
                assert.ok([200, 204, 404].includes(find!.status_rx), `truthful status; got ${find!.status_rx}`);
            } finally { ws.close(); }
        });
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});
