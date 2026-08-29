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
        response("# PLAN0\ncontinue without work\n\n## SEND0 [102]\nworking", 10),
        response("# PLAN0\nattempt a malformed matcher\n\n## FIND0 (worker:///x)\n$fC\n\n## SEND0 [102]\ncontinue", 10),
        response("# PLAN0\nrecover\n\n## EDIT0 (worker:///note)\nr\n\n## SEND0 [102]\nrecovered", 10),
        response("# PLAN0\nfinish\n\n## SEND0 [200]\ndone", 10),
    ] });
    await withDaemon(mock, async (db, _daemon, addr) => {
        const ws = await connect(addr);
        try {
            await rpcCall(ws, 1, "workspace.create", { name: "strikes-meta" });
            const { finalStatus } = await runLoopToTerminal(ws, 2, { prompt: "go", maxTurns: 8 });
            assert.equal(finalStatus, 200, "the loop concluded through the struck turn");
            assert.deepEqual(mock.seen, [0, 1, 2, 0], "raw admitted turns carry 0 → idle strike → bounded-parse strike → clean reset");
            // The model-facing packets never carry it ({§engine-rails}: no metric to game).
            for (const row of await db.test_all_packets.all<{ packet: string }>({})) {
                const sections = (JSON.parse(row.packet) as { sections?: object[] }).sections ?? [];
                assert.ok(!/strike/i.test(JSON.stringify(sections)), "no packet section mentions strikes");
            }
        } finally { ws.close(); }
    });
});

test("an operation-bearing turn with omitted PLAN and SEND is admitted, struck once, and continued", async () => {
    const mock = new CapturingMock({ contextWindow: 100000, responses: [
        response("## EDIT0 (worker:///proof.md)\nlanded", 10),
        response("# PLAN0\n[]\n## SEND0 [200]", 10),
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
            assert.deepEqual(mock.seen, [0, 1], "both omitted boundaries price one admitted turn, not two failures or a retry");
            const ops = await db.test_ops_by_loop.all<{ op: string; status_rx: number }>({});
            assert.equal(
                ops.find(({ op }) => op === "EDIT")?.status_rx,
                201,
                `the useful operation landed: ${JSON.stringify(ops)}`,
            );
            assert.equal(
                ops.filter(({ op, status_rx }) => op === "error" && status_rx === 400).length,
                2,
                "the model receives one exact warning for each recovered boundary",
            );
        } finally { ws.close(); }
    });
});

test("a 416 range-miss is an exploratory miss — soft, never a strike (like 404/501)", async () => {
    // Range-probing is the surgical behavior wanted under pressure; striking it prices
    // caution into the exact motion being taught. {404, 416, 501}: one set, evenly applied.
    const mock = new CapturingMock({ contextWindow: 100000, responses: [
        response("# PLAN0\ncreate a short entry\n\n## EDIT0 (worker:///short)\none line only\n\n## SEND0 [102]\nwrote", 10),
        response("# PLAN0\nprobe a missing range\n\n## READ0 (worker:///short) <99,100>\n\n## SEND0 [102]\nprobing", 10),
        response("# PLAN0\nfinish\n\n## SEND0 [200]\ndone", 10),
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
        response("# PLAN0\ntry an empty command\n\n## EXEC0\n\n## SEND0 [102]\ncorrecting", 10),
        response("# PLAN0\nfinish\n\n## SEND0 [200]\ndone", 10),
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
