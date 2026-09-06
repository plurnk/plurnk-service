// {§edit-batch-receipt} {§edit-collision}
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
const BLOCK = "function f() {\n    return null;\n}\n\n";
const REPEATED = `${BLOCK}${BLOCK}${BLOCK}tail`;

type UnresolvedAnchor = { anchor: string; kind: "missing" | "ambiguous"; lines?: number[] };
const cases: readonly {
    name: string;
    source: string;
    current: string;
    scopes: (anchors: string[]) => string[][];
    unresolved: (anchors: string[]) => UnresolvedAnchor[];
}[] = [
    {
        name: "a never-issued anchor has no match, not an invented history",
        source: V1,
        current: V1,
        scopes: () => [["@451ok"]],
        unresolved: () => [{ anchor: "@451ok", kind: "missing" }],
    },
    {
        name: "an actually stale anchor reports the same current absence",
        source: V1,
        current: V1.replace("six\n", "SIX\n"),
        scopes: (anchors) => [[anchors[4]!]],
        unresolved: (anchors) => [{ anchor: anchors[4]!, kind: "missing" }],
    },
    {
        name: "an ambiguous anchor names its current matching lines",
        source: REPEATED,
        current: REPEATED,
        scopes: (anchors) => [[anchors[5]!]],
        unresolved: (anchors) => [{ anchor: anchors[5]!, kind: "ambiguous", lines: [6, 10] }],
    },
    {
        name: "independent failures name their own range endpoints and anchors",
        source: REPEATED,
        current: REPEATED.replace("tail", "TAIL"),
        scopes: (anchors) => [["@451ok", anchors[5]!], [anchors[12]!]],
        unresolved: (anchors) => [
            { anchor: "@451ok", kind: "missing" },
            { anchor: anchors[5]!, kind: "ambiguous", lines: [6, 10] },
            { anchor: anchors[12]!, kind: "missing" },
        ],
    },
];

for (const fixture of cases) test(`{§edit-batch-receipt} ${fixture.name}`, async () => {
    const root = await mkdtemp(join(tmpdir(), "plurnk-batch-"));
    try {
        const env = hermeticGitEnv();
        await execFileP("git", ["init", "-q"], { cwd: root, env });
        await execFileP("git", ["config", "user.email", "fixture@plurnk.invalid"], { cwd: root, env });
        await execFileP("git", ["config", "user.name", "t"], { cwd: root, env });
        await writeFile(join(root, "doc.md"), fixture.source);
        await execFileP("git", ["add", "doc.md"], { cwd: root, env });
        await execFileP("git", ["-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", "commit", "--no-verify", "-q", "-m", "seed"], { cwd: root, env });

        // The batch is composed from the anchors the engine itself rendered in loop 1; the
        // mock's third response is filled in once those anchors are known.
        const pending: { batch: string | null } = { batch: null };
        const mock = new Mock({ contextWindow: 32768, responses: [
            makeMockResponse("### READ0 (file:///doc.md) <1,-1>\n\n### SEND0 (NEXT)\nreading", 50),
            makeMockResponse("### SEND0 (TERM)\nread", 50),
        ] });
        const realGenerate = mock.generate.bind(mock);
        let calls = 0;
        mock.generate = async (args) => {
            calls += 1;
            if (calls === 3) return await new Mock({ contextWindow: 32768, responses: [makeMockResponse(`${pending.batch}\n\n### SEND0 (NEXT)\nediting`, 50)] }).generate(args);
            if (calls === 4) return await new Mock({ contextWindow: 32768, responses: [makeMockResponse("### SEND0 (TERM)\nedited", 50)] }).generate(args);
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
                assert.ok(Array.isArray(anchors) && anchors.length >= 6, `the READ published its anchors; got ${JSON.stringify(anchors)}`);
                assert.equal(anchors.includes("@451ok"), false, "the unknown anchor was never published");
                await writeFile(join(root, "doc.md"), fixture.current);
                const unresolved = fixture.unresolved(anchors);
                const statements = [
                    `### EDIT0 (file:///doc.md) <${anchors[0]}>\nONE`,
                    `### EDIT0 (file:///doc.md) <${anchors[1]}>\nTWO`,
                    "### EDIT0 (file:///doc.md) <3>\nTHREE",
                    ...fixture.scopes(anchors).map((marks) => `### EDIT0 (file:///doc.md) <${marks.join(",")}>\nreplacement`),
                ];
                pending.batch = statements.join("\n\n");
                const second = await runLoopToTerminal(ws, 3, { prompt: "edit", policy: { proposals: "accept" } });
                assert.equal(second.result.status, 200, "the model concludes after observing the individual failures");
                const rows = await db.engine_render_log.all<{ op: string; status_rx: number; rx: string }>({ worker_id: second.modelWorkerId! });
                const edits = rows.filter(({ op }) => op === "EDIT");
                assert.equal(edits.length, statements.length);
                assert.deepEqual(edits.slice(0, 3).map(({ status_rx }) => status_rx), [200, 200, 200], "valid earlier operations land independently");
                for (const [index, row] of edits.slice(3).entries()) {
                    const ownUnresolved: UnresolvedAnchor[] = unresolved.filter(({ anchor }) => fixture.scopes(anchors)[index]!.includes(anchor));
                    const problem = JSON.parse(row.rx).problem;
                    assert.equal(row.status_rx, 409);
                    assert.equal(problem.type, "https://problems.plurnk.xyz/engine/edit/edit-collision");
                    assert.equal(problem.detail, "EDIT collided with the current resource state.");
                    assert.deepEqual(problem.unresolvedAnchors, ownUnresolved, "each row diagnoses all of its own unresolved anchors");
                    assert.equal(problem.editCount, 1);
                    assert.equal(problem.applied, 0);
                    assert.equal(problem.recovery, "0 of 1 edits applied. READ the target for current coordinates.");
                    assert.equal(problem.retryable, false);
                    assert.equal("staleAnchors" in problem, false, "absence is not evidence of earlier validity");
                }
                const packet = JSON.parse((await db.test_get_packet.get<{ packet: string }>({ id: second.turnIds!.at(-1)! }))!.packet);
                const log = (packet.sections as Array<{ name: string; content: string }>).find(({ name }) => name === "log")?.content;
                assert.ok(typeof log === "string", "the next model packet contains the refused EDIT receipts");
                for (const anchor of unresolved) assert.ok(log.includes(JSON.stringify(anchor)), "the current-state diagnosis reaches the model");
                assert.ok(log.includes("0 of 1 edits applied."), "the packet reports only this operation's lack of effect");
                assert.doesNotMatch(log, /no longer resolves|since the READ|collided with another change|staleAnchors/);
                assert.equal(await readFile(join(root, "doc.md"), "utf8"), ["ONE", "TWO", "THREE", ...fixture.current.split("\n").slice(3)].join("\n"), "only the valid EDITs landed");
            } finally { ws.close(); }
        });
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});
