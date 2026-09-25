// {§line-anchors} {§line-anchor-disambiguation} {§edit-anchor-continuity}
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
const prefix = Array.from({ length: 10 }, (_, index) => `prefix-${index}\n`).join("");
const suffix = Array.from({ length: 10 }, (_, index) => `suffix-${index}\n`).join("");

for (const fixture of [
    { name: "unique", source: V1, first: 3, expected: "one\ntwo\nTHREE-FOUR\nFIVE\nsix\n" },
    { name: "repeated", source: `${prefix}${V1}${V1}${suffix}`, first: 13, expected: `${prefix}one\ntwo\nTHREE-FOUR\nFIVE\nsix\n${V1}${suffix}` },
]) test(`{§line-anchors}: ${fixture.name} file anchors survive a shift between loops and successive same-program edits`, async () => {
    const root = await mkdtemp(join(tmpdir(), "plurnk-shift-"));
    try {
        const env = hermeticGitEnv();
        await execFileP("git", ["init", "-q"], { cwd: root, env });
        await execFileP("git", ["config", "user.email", "fixture@plurnk.invalid"], { cwd: root, env });
        await execFileP("git", ["config", "user.name", "t"], { cwd: root, env });
        await writeFile(join(root, "doc.md"), fixture.source);
        await execFileP("git", ["add", "doc.md"], { cwd: root, env });
        await execFileP("git", ["-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", "commit", "--no-verify", "-q", "-m", "seed"], { cwd: root, env });

        const pending: { batch: string | null } = { batch: null };
        const mock = new Mock({ contextWindow: 32768, responses: [
            makeMockResponse("````READ (file:///doc.md) <1,-1>````\n````NOTE\nreading\n````", 50),
            makeMockResponse("````KILL\nread\n````", 50),
        ] });
        const realGenerate = mock.generate.bind(mock);
        let calls = 0;
        mock.generate = async (args) => {
            calls += 1;
            if (calls === 3) return await new Mock({ contextWindow: 32768, responses: [makeMockResponse(`${pending.batch}

\`\`\`\`NOTE
editing
\`\`\`\``, 50)] }).generate(args);
            if (calls === 4) return await new Mock({ contextWindow: 32768, responses: [makeMockResponse("````KILL\nedited\n````", 50)] }).generate(args);
            return await realGenerate(args);
        };
        await withDaemon(mock, async (db, _daemon, addr) => {
            const ws = await connect(addr);
            try {
                await rpcCall(ws, 1, "workspace.create", { name: "anchors-shift", projectRoot: root });
                const first = await runLoopToTerminal(ws, 2, { prompt: "look", policy: { proposals: "accept" } });
                assert.equal(first.result.status, 200);
                const readRow = (await db.engine_render_log.all<{ op: string; origin: string; status_rx: number; rx: string }>({ worker_id: first.modelWorkerId! }))
                    .find(({ op, origin, status_rx }) => op === "READ" && origin === "model" && status_rx === 200);
                const anchors = JSON.parse(readRow?.rx ?? "{}").lineAnchors as string[] | undefined;
                assert.ok(Array.isArray(anchors) && anchors.length === fixture.source.split("\n").length - 1, `the READ published one anchor per line; got ${JSON.stringify(anchors)}`);
                if (fixture.name === "repeated") assert.notEqual(anchors[fixture.first - 1], anchors[fixture.first + 5], "the two copies have distinct handles");
                await writeFile(join(root, "doc.md"), `zero-a\nzero-b\n${fixture.source}`);
                pending.batch = [
                    `\`\`\`\`EDIT (file:///doc.md) <${anchors[fixture.first - 1]},${anchors[fixture.first]}>
THREE-FOUR
\`\`\`\``,
                    `\`\`\`\`EDIT (file:///doc.md) <${anchors[fixture.first + 1]}>
FIVE
\`\`\`\``,
                ].join("\n\n");
                const second = await runLoopToTerminal(ws, 3, { prompt: "edit", policy: { proposals: "accept" } });
                assert.equal(second.result.status, 200);
                const edits = (await db.engine_render_log.all<{ op: string; origin: string; status_rx: number; rx: string }>({ worker_id: second.modelWorkerId! }))
                    .filter(({ op }) => op === "EDIT");
                assert.deepEqual(edits.map(({ status_rx }) => status_rx), [200, 200], `both anchored edits applied; got ${edits.map(({ rx }) => rx).join(" | ")}`);
                assert.equal(await readFile(join(root, "doc.md"), "utf8"), `zero-a\nzero-b\n${fixture.expected}`, "the edits landed on the selected moved lines, leaving any twin intact");
            } finally { ws.close(); }
        });
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});
