// {§membership} {§worker-scheme-collect} — a child worker's admitted file write is a workspace
// member for every worker at once: after the child's `EDIT count.txt` (200) folds back, the
// parent's own `READ count.txt` answers the content, never `entry-not-found` (#373) — scoped
// or not, inside a git repository or in a bare directory.
import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Mock } from "@plurnk/plurnk-providers";
import { hermeticGitEnv } from "../../src/core/git-env.ts";
import { rpcCall, connect, withDaemon, makeMockResponse, runLoopToTerminal, flush } from "./_rpc.ts";
import { packetSection } from "./_helpers.ts";

const execFileP = promisify(execFile);

const gitRoot = async (): Promise<string> => {
    const root = await mkdtemp(join(tmpdir(), "plurnk-child-file-"));
    await execFileP("git", ["init", "-q"], { cwd: root, env: hermeticGitEnv() });
    await execFileP("git", ["config", "user.email", "fixture@plurnk.invalid"], { cwd: root, env: hermeticGitEnv() });
    await execFileP("git", ["config", "user.name", "t"], { cwd: root, env: hermeticGitEnv() });
    return root;
};

const bareRoot = async (): Promise<string> => mkdtemp(join(tmpdir(), "plurnk-child-file-bare-"));

const CASES: Array<{ name: string; root: () => Promise<string>; read: string }> = [
    { name: "git root, unscoped READ", root: gitRoot, read: "## READ0 (count.txt)" },
    { name: "git root, scoped READ <1,-1>", root: gitRoot, read: "## READ0 (count.txt) <1,-1>" },
    { name: "bare directory, scoped READ <1,-1>", root: bareRoot, read: "## READ0 (count.txt) <1,-1>" },
];

for (const c of CASES) {
    test(`a child's new file is readable by its parent by bare path right after the fold-back (${c.name})`, async () => {
        const root = await c.root();
        const mock = new Mock({ contextWindow: 32768, responses: [
            makeMockResponse("## WORK0 (worker://counter)\nWrite the number 3 to count.txt and conclude.\n\n## SEND0 [202] <-1>\nwaiting", 10),
            makeMockResponse("## EDIT0 (count.txt)\n3\n\n## SEND0 [102]\nwrote", 10),
            makeMockResponse("## SEND0 [200]\nwritten", 10),
            makeMockResponse(`${c.read}\n\n## SEND0 [102]\nreading`, 10),
            makeMockResponse("## SEND0 [200]\ndone", 10),
        ] });
        try {
            await withDaemon(mock, async (db, _daemon, addr) => {
                const ws = await connect(addr);
                try {
                    await rpcCall(ws, 1, "workspace.create", { name: "child-file-visibility", projectRoot: root });
                    const { finalStatus, loopId } = await runLoopToTerminal(ws, 2, { prompt: "delegate the count", flags: { auto: true } }, { timeoutMs: 20000 });
                    await flush();
                    const all = await db.test_log_entries_by_loop.all<{ op: string; origin: string; source: string | null; signal: string | null; status_rx: number; rx: string }>({ loop_id: loopId });
                    const edit = all.find((r) => r.op === "EDIT");
                    assert.ok(edit && edit.status_rx < 300, `the child's write was admitted, got ${edit?.status_rx}: ${edit?.rx.slice(0, 200)}`);
                    // {§env-delta-child-activity} — the child's model activity crossed, its
                    // runtime-private initialization never did.
                    const crossed = all.filter((r) => r.source === "worker://counter");
                    assert.ok(crossed.some((r) => r.op === "EDIT"), "the child's EDIT crossed to the parent");
                    assert.deepEqual(crossed.filter((r) => /"init"/.test(String(r.signal))).map((r) => r.op), [], "no turn-0 initialization row of the child reached the parent");
                    const read = all.find((r) => r.op === "READ" && r.origin === "model");
                    assert.ok(read, "the parent's READ was dispatched");
                    assert.equal(read.status_rx, 200, `the parent reads the child's file by bare path, got ${read.status_rx}: ${read.rx.slice(0, 220)}`);
                    assert.match(read.rx, /"content":"3"/, "the parent sees the child's content");
                    assert.equal(finalStatus, 200);
                } finally { ws.close(); }
            });
        } finally { await rm(root, { recursive: true, force: true }); }
    });
}

// {§child-orientation} {§worker-read-scope} — a child is told whose child it is (#394): its packet
// carries a Parent Worker pointer naming the parent, so it can address the parent's streams and
// space by name. The root worker has no such section.
test("a child's packet names its parent worker; the root's packet does not", async () => {
    const mock = new Mock({ contextWindow: 32768, responses: [
        makeMockResponse("## WORK0 (worker://counter)\nReply with the number 3.\n\n## SEND0 [202] <-1>\nwaiting", 10),
        makeMockResponse("## SEND0 [200]\n3", 10),
        makeMockResponse("## SEND0 [200]\ndone", 10),
    ] });
    await withDaemon(mock, async (db, _daemon, addr) => {
        const ws = await connect(addr);
        try {
            await rpcCall(ws, 1, "workspace.create", { name: "parent-pointer" });
            const workspaceId = 1;
            const { finalStatus, turnIds } = await runLoopToTerminal(ws, 2, { prompt: "delegate", flags: { auto: true } }, { timeoutMs: 20000 });
            assert.equal(finalStatus, 200);
            await flush();
            const childTurn = await db.test_first_packet_turn_by_worker_name.get<{ id: number }>({ workspace_id: workspaceId, name: "counter" });
            assert.ok(childTurn, "the child ran a model turn");
            const childPacket = JSON.parse((await db.test_get_packet.get<{ packet: string }>({ id: childTurn.id }))!.packet);
            assert.match(packetSection(childPacket, "parent-worker"), /^\* \d+ worker:\/\/model-1$/m, "the child is told its parent by name");
            const rootPacket = JSON.parse((await db.test_get_packet.get<{ packet: string }>({ id: turnIds![turnIds!.length - 1]! }))!.packet);
            assert.equal(packetSection(rootPacket, "parent-worker"), "", "a root worker has no parent pointer");
        } finally { ws.close(); }
    });
});
