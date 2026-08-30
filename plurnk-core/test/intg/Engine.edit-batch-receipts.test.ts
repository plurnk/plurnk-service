// #428 phase 1 — a batch that collides names every stale anchor and says nothing was applied.
// run13 t16's shape: four anchored EDITs to one file, three from the current rendering and one
// whose line moved since the READ that rendered it.
import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, writeFile, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Mock } from "@plurnk/plurnk-providers";
import { hermeticGitEnv } from "../../src/core/git-env.ts";
import { rpcCall, connect, withDaemon, makeMockResponse, runLoopToTerminal } from "./_rpc.ts";

const execFileP = promisify(execFile);
const V1 = "one\ntwo\nthree\nfour\nfive\nsix\n";

test("{§edit-batch-receipt} one stale anchor: every edit is refused, the stale anchor is named, 0 of N applied", async () => {
    const root = await mkdtemp(join(tmpdir(), "plurnk-batch-"));
    try {
        const env = hermeticGitEnv();
        await execFileP("git", ["init", "-q"], { cwd: root, env });
        await execFileP("git", ["config", "user.email", "fixture@plurnk.invalid"], { cwd: root, env });
        await execFileP("git", ["config", "user.name", "t"], { cwd: root, env });
        await writeFile(join(root, "doc.md"), V1);
        await execFileP("git", ["add", "doc.md"], { cwd: root, env });
        await execFileP("git", ["-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", "commit", "--no-verify", "-q", "-m", "seed"], { cwd: root, env });

        // The batch is composed from the anchors the engine itself rendered in loop 1; the
        // mock's third response is filled in once those anchors are known.
        const pending: { batch: string | null } = { batch: null };
        const mock = new Mock({ contextWindow: 32768, responses: [
            makeMockResponse("## READ0 (file:///doc.md) <1,-1>\n\n## SEND0 [102]\nreading", 50),
            makeMockResponse("## SEND0 [200]\nread", 50),
        ] });
        const realGenerate = mock.generate.bind(mock);
        let calls = 0;
        mock.generate = async (args) => {
            calls += 1;
            if (calls === 3) return await new Mock({ contextWindow: 32768, responses: [makeMockResponse(`${pending.batch}\n\n## SEND0 [102]\nediting`, 50)] }).generate(args);
            if (calls === 4) return await new Mock({ contextWindow: 32768, responses: [makeMockResponse("## SEND0 [200]\nedited", 50)] }).generate(args);
            return await realGenerate(args);
        };
        await withDaemon(mock, async (db, _daemon, addr) => {
            const ws = await connect(addr);
            try {
                await rpcCall(ws, 1, "workspace.create", { name: "batch-receipt", projectRoot: root });
                const first = await runLoopToTerminal(ws, 2, { prompt: "look", policy: { proposals: "accept" } });
                assert.equal(first.result.status, 200);
                const readRow = (await db.engine_render_log.all<{ op: string; status_rx: number; rx: string }>({ worker_id: first.modelWorkerId! }))
                    .find(({ op, status_rx }) => op === "READ" && status_rx === 200);
                const anchors = JSON.parse(readRow?.rx ?? "{}").lineAnchors as string[] | undefined;
                assert.ok(Array.isArray(anchors) && anchors.length === 6, `the READ published one anchor per line; got ${JSON.stringify(anchors)}`);
                // Line 6 changes out-of-band: only anchors whose context window covers it (4–6) go
                // stale; lines 1–3 stay current. The batch takes 1, 2, 3 (fresh) and 5 (stale).
                await writeFile(join(root, "doc.md"), V1.replace("six\n", "SIX\n"));
                const stale = anchors[4]!;
                pending.batch = [
                    `## EDIT0 (file:///doc.md) <${anchors[0]}>\nONE`,
                    `## EDIT0 (file:///doc.md) <${anchors[1]}>\nTWO`,
                    `## EDIT0 (file:///doc.md) <${anchors[2]}>\nTHREE`,
                    `## EDIT0 (file:///doc.md) <${stale}>\nFIVE`,
                ].join("\n\n");
                const second = await runLoopToTerminal(ws, 3, { prompt: "edit", policy: { proposals: "accept" } });
                assert.equal(second.result.status, 200, "the model concludes; the batch is refused, never the loop");
                const rows = await db.engine_render_log.all<{ op: string; status_rx: number; rx: string }>({ worker_id: second.modelWorkerId! });
                const edits = rows.filter(({ op }) => op === "EDIT");
                assert.equal(edits.length, 4);
                for (const row of edits) {
                    const problem = JSON.parse(row.rx).problem;
                    assert.equal(row.status_rx, 409);
                    assert.equal(problem.type, "https://problems.plurnk.xyz/engine/edit/edit-collision");
                    assert.deepEqual(problem.staleAnchors, [{ anchor: stale, kind: "stale" }], "the one stale anchor is named on every row");
                    assert.equal(problem.editCount, 4);
                    assert.equal(problem.applied, 0);
                    assert.match(problem.recovery, new RegExp(`^${stale} no longer resolves — .*0 of 4 edits in this batch were applied`));
                }
                assert.equal(await readFile(join(root, "doc.md"), "utf8"), V1.replace("six\n", "SIX\n"), "nothing was applied");
            } finally { ws.close(); }
        });
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});
