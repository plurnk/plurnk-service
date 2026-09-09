// {§strikes-first-party-metadata} — the loop's current strike streak rides
// generate({strikes}): 0 sent explicitly on clean turns, the live streak after struck
// ones, zeroed by recovery. Assessment lives in runLoop, so the proof drives
// the REAL loop via the daemon. The model-facing packet NEVER carries it ({§engine-rails}).

import test from "node:test";
import assert from "node:assert/strict";
import { Mock } from "@plurnk/plurnk-providers";
import type { MockResponse } from "@plurnk/plurnk-providers";
import { rpcCall, connect, withDaemon, runLoopToTerminal } from "./_rpc.ts";

const response = (content: string, completion: number = 0): MockResponse => ({
    assistant: {
        content,
        reasoning: null,
    },
    usage: { inputTokens: 0, outputTokens: completion, totalTokens: completion },
});

class CapturingMock extends Mock {
    readonly seen: Array<number | undefined> = [];
    override async generate(args: Parameters<Mock["generate"]>[0] & { strikes?: number }): ReturnType<Mock["generate"]> {
        this.seen.push(args.strikes);
        return super.generate(args);
    }
}

test("generate carries the live streak — 0 explicit, bumped by a struck turn, zeroed by recovery", async () => {
    const mock = new CapturingMock({ contextWindow: 100000, responses: [
        response("```READ (worker:///absent)```", 10),
        response("\n```FIND (worker:///x)\n$fC\n```\n\n```TASK\n[{\"content\":\"continue\",\"status\":\"in_progress\"}]\n```", 10),
        response("\n```EDIT (worker:///note)\nr\n```\n\n```TASK\n[{\"content\":\"recovered\",\"status\":\"in_progress\"}]\n```", 10),
        response("\n```SEND\ndone\n```\n```TASK\n[{\"content\":\"Task completed.\",\"status\":\"completed\"}]\n```", 10),
    ] });
    await withDaemon(mock, async (db, _daemon, addr) => {
        const ws = await connect(addr);
        try {
            await rpcCall(ws, 1, "workspace.create", { name: "strikes-meta" });
            const { finalStatus } = await runLoopToTerminal(ws, 2, { prompt: "go", maxTurns: 8 });
            assert.equal(finalStatus, 200, "the loop concluded through the struck turn");
            assert.deepEqual(mock.seen, [0, 1, 2, 0], "raw admitted turns carry 0 → missing inventory strike → bounded-parse strike → clean reset");
            // The model-facing packets never carry it ({§engine-rails}: no metric to game).
            for (const row of await db.test_all_packets.all<{ packet: string }>({})) {
                const sections = (JSON.parse(row.packet) as { sections?: object[] }).sections ?? [];
                assert.ok(!/strike/i.test(JSON.stringify(sections)), "no packet section mentions strikes");
            }
        } finally { ws.close(); }
    });
});

test("an operation-bearing turn with omitted TASK is admitted, struck once, and continued", async () => {
    const mock = new CapturingMock({ contextWindow: 100000, responses: [
        response("```EDIT (worker:///proof.md)\nlanded\n```", 10),
        response("```TASK\n[{\"content\":\"Task completed.\",\"status\":\"completed\"}]\n```", 10),
    ] });
    await withDaemon(mock, async (db, _daemon, addr) => {
        const ws = await connect(addr);
        try {
            await rpcCall(ws, 1, "workspace.create", { name: "recovered-envelope-strike" });
            const { finalStatus } = await runLoopToTerminal(ws, 2, {
                prompt: "go",
                maxTurns: 4,
                policy: { proposals: "accept" },
            });
            assert.equal(finalStatus, 200);
            assert.deepEqual(mock.seen, [0, 1], "missing inventory prices one admitted turn, not a retry");
            const ops = await db.test_ops_by_loop.all<{ op: string; status_rx: number }>({});
            assert.equal(
                ops.find(({ op }) => op === "EDIT")?.status_rx,
                201,
                `the useful operation landed: ${JSON.stringify(ops)}`,
            );
            assert.equal(
                ops.filter(({ op, status_rx }) => op === "TASK" && status_rx === 409).length,
                1, "the missing inventory receives one exact receipt",
            );
        } finally { ws.close(); }
    });
});

test("a 416 range-miss is an exploratory miss — soft, never a strike (like 404/501)", async () => {
    // Range-probing is the surgical behavior wanted under pressure; striking it prices
    // caution into the exact motion being taught. {404, 416, 501}: one set, evenly applied.
    const mock = new CapturingMock({ contextWindow: 100000, responses: [
        response("\n```EDIT (worker:///short)\none line only\n```\n\n```TASK\n[{\"content\":\"wrote\",\"status\":\"in_progress\"}]\n```", 10),
        response("\n```READ (worker:///short) <99,100>```\n```TASK\n[{\"content\":\"probing\",\"status\":\"in_progress\"}]\n```", 10),
        response("\n```SEND\ndone\n```\n```TASK\n[{\"content\":\"Task completed.\",\"status\":\"completed\"}]\n```", 10),
    ] });
    await withDaemon(mock, async (_db, _daemon, addr) => {
        const ws = await connect(addr);
        try {
            await rpcCall(ws, 1, "workspace.create", { name: "soft-416" });
            const { finalStatus } = await runLoopToTerminal(ws, 2, { prompt: "go", maxTurns: 6 });
            assert.equal(finalStatus, 200);
            assert.deepEqual(mock.seen, [0, 0, 0], "the range-miss turn never bumped the streak");
        } finally { ws.close(); }
    });
});

test("an EXEC operation error remains visible but does not bump the strike streak", async () => {
    const mock = new CapturingMock({ contextWindow: 100000, responses: [
        response("\n```EXEC```\n```TASK\n[{\"content\":\"correcting\",\"status\":\"in_progress\"}]\n```", 10),
        response("\n```SEND\ndone\n```\n```TASK\n[{\"content\":\"Task completed.\",\"status\":\"completed\"}]\n```", 10),
    ] });
    await withDaemon(mock, async (db, _daemon, addr) => {
        const ws = await connect(addr);
        try {
            await rpcCall(ws, 1, "workspace.create", { name: "soft-exec" });
            const { finalStatus } = await runLoopToTerminal(ws, 2, { prompt: "go", maxTurns: 4 });
            assert.equal(finalStatus, 200);
            assert.deepEqual(mock.seen, [0, 0], "the failed EXEC did not alter first-party strike metadata");
            const ops = await db.test_ops_by_loop.all<{ op: string; status_rx: number }>({});
            assert.ok(
                ops.some(({ op, status_rx }) => op === "EXEC" && status_rx === 400),
                "the exact EXEC failure remains durable evidence",
            );
        } finally { ws.close(); }
    });
});
