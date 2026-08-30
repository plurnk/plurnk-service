// #428 phase 2 — anchors key on content and neighborhood, not on the ordinal. The batch's
// commonest EDIT failure (run11 t33, run13 t16): the model's own earlier edit above a line
// shifted it, and every anchor below went stale. Now the anchors follow the lines.
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

test("{§line-anchors} anchors rendered before an insertion above still resolve after it; the edits land on the moved lines", async () => {
    const root = await mkdtemp(join(tmpdir(), "plurnk-shift-"));
    try {
        const env = hermeticGitEnv();
        await execFileP("git", ["init", "-q"], { cwd: root, env });
        await execFileP("git", ["config", "user.email", "fixture@plurnk.invalid"], { cwd: root, env });
        await execFileP("git", ["config", "user.name", "t"], { cwd: root, env });
        await writeFile(join(root, "doc.md"), V1);
        await execFileP("git", ["add", "doc.md"], { cwd: root, env });
        await execFileP("git", ["-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", "commit", "--no-verify", "-q", "-m", "seed"], { cwd: root, env });

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
                await rpcCall(ws, 1, "workspace.create", { name: "anchors-shift", projectRoot: root });
                const first = await runLoopToTerminal(ws, 2, { prompt: "look", policy: { proposals: "accept" } });
                assert.equal(first.result.status, 200);
                const readRow = (await db.engine_render_log.all<{ op: string; status_rx: number; rx: string }>({ worker_id: first.modelWorkerId! }))
                    .find(({ op, status_rx }) => op === "READ" && status_rx === 200);
                const anchors = JSON.parse(readRow?.rx ?? "{}").lineAnchors as string[] | undefined;
                assert.ok(Array.isArray(anchors) && anchors.length === 6, `the READ published one anchor per line; got ${JSON.stringify(anchors)}`);
                // Two lines land above the document between the READ and the EDIT. Lines 1–2 sat
                // against the head, so their neighborhoods change; lines 3–6 carry the same
                // neighborhood two ordinals lower and their anchors follow them.
                await writeFile(join(root, "doc.md"), `zero-a\nzero-b\n${V1}`);
                pending.batch = [
                    `## EDIT0 (file:///doc.md) <${anchors[2]},${anchors[3]}>\nTHREE-FOUR`,
                    `## EDIT0 (file:///doc.md) <${anchors[4]}>\nFIVE`,
                ].join("\n\n");
                const second = await runLoopToTerminal(ws, 3, { prompt: "edit", policy: { proposals: "accept" } });
                assert.equal(second.result.status, 200);
                const edits = (await db.engine_render_log.all<{ op: string; status_rx: number; rx: string }>({ worker_id: second.modelWorkerId! }))
                    .filter(({ op }) => op === "EDIT");
                assert.deepEqual(edits.map(({ status_rx }) => status_rx), [200, 200], `both anchored edits applied; got ${edits.map(({ rx }) => rx).join(" | ")}`);
                assert.equal(await readFile(join(root, "doc.md"), "utf8"), "zero-a\nzero-b\none\ntwo\nTHREE-FOUR\nFIVE\nsix\n", "the edits landed on the moved lines");
            } finally { ws.close(); }
        });
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});
