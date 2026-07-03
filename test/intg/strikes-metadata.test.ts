// §strikes-first-party-metadata (#313) — the loop's current strike streak rides
// generate({strikes}): 0 sent explicitly on clean turns, the live streak after struck
// ones, zeroed by recovery. Assessment lives in runLoop (rail #38), so the proof drives
// the REAL loop via the daemon. The model-facing packet NEVER carries it (§engine-rails).

import test from "node:test";
import assert from "node:assert/strict";
import { Mock } from "@plurnk/plurnk-providers";
import type { PrepMethod } from "../../src/core/Db.ts";
import { rpcCall, connect, withDaemon, makeMockResponse, runLoopToTerminal } from "./_rpc.ts";

class CapturingMock extends Mock {
    readonly seen: Array<number | undefined> = [];
    override async generate(args: Parameters<Mock["generate"]>[0] & { strikes?: number }): ReturnType<Mock["generate"]> {
        this.seen.push(args.strikes);
        return super.generate(args);
    }
}

test("[§strikes-first-party-metadata] generate carries the live streak — 0 explicit, bumped by a struck turn, zeroed by recovery", async () => {
    const mock = new CapturingMock({ contextSize: 100000, responses: [
        makeMockResponse("<<SEND[102]:working:SEND", 10),   // IDLE — a bare continue with no work op takes the idle steer strike
        makeMockResponse("no ops at all", 10),               // 422 no_ops → struck
        makeMockResponse("<<EDIT(known://note):r:EDIT\n<<SEND[102]:recovered:SEND", 10),  // clean, DISTINCT shape (an A-B-A fingerprint would trip rail #39)
        makeMockResponse("<<SEND[200]:done:SEND", 10),       // conclude
    ] });
    await withDaemon(mock, async (db, _daemon, addr) => {
        const ws = await connect(addr);
        try {
            await rpcCall(ws, 1, "session.create", { name: "strikes-meta" });
            const { finalStatus } = await runLoopToTerminal(ws, 2, { prompt: "go", maxTurns: 8 });
            assert.equal(finalStatus, 200, "the loop concluded through the struck turn");
            assert.deepEqual(mock.seen, [0, 1, 2, 0], "explicit 0 at start → 1 after the idle strike → 2 after no-ops → the working turn zeroes it");
            // The model-facing packets never carry it (§engine-rails: no metric to game).
            for (const row of await (db.test_all_packets as PrepMethod).all<{ packet: string }>({})) {
                const sections = (JSON.parse(row.packet) as { sections?: object[] }).sections ?? [];
                assert.ok(!/strike/i.test(JSON.stringify(sections)), "no packet section mentions strikes");
            }
        } finally { ws.close(); }
    });
});
