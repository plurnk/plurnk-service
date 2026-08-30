// {§curation-receipt-dissolves} — a successful log-curation receipt renders in exactly the packet
// after its turn (path, target, status) and is gone from the next one. The 2026-08-30 live drill
// showed why: with no receipt at all, a model that deferred its confirmation re-issued a broad
// KILL three times into the turn ceiling. A receipt that dissolves leaves nothing to curate.
import test from "node:test";
import assert from "node:assert/strict";
import { Mock } from "@plurnk/plurnk-providers";
import { rpcCall, connect, withDaemon, makeMockResponse, runLoopToTerminal } from "./_rpc.ts";

const logSection = (packet: string): string => {
    const parsed = JSON.parse(packet) as { sections?: Array<{ name: string; content: string }> };
    return parsed.sections?.find((s) => s.name === "log")?.content ?? packet;
};
const row = (log: string, op: string): string | undefined => log.split("\n").find((line) => new RegExp(`"path":"log:///1/\\d+/\\d+/${op}"`).test(line));

test("{§curation-receipt-dissolves} FOLD and KILL receipts show once with their status, then dissolve; the 204 no-op shows once too", async () => {
    const mock = new Mock({ contextWindow: 32768, responses: [
        makeMockResponse("## EDIT0 (worker:///note)\nfirst line\nsecond line\n\n## READ0 (worker:///note)\n\n## SEND0 [102]\nwrote", 50),
        makeMockResponse("## FOLD0 (log:///1/**/READ)\n\n## KILL0 (log:///1/**/EDIT)\n\n## SEND0 [102]\ncurated", 50),
        makeMockResponse("## KILL0 (log:///1/**/EDIT)\n\n## SEND0 [102]\nagain", 50),
        makeMockResponse("## SEND0 [200]\ndone", 50),
    ] });
    await withDaemon(mock, async (db, _daemon, addr) => {
        const ws = await connect(addr);
        try {
            await rpcCall(ws, 1, "workspace.create", { name: "dissolve" });
            const result = await runLoopToTerminal(ws, 2, { prompt: "curate", policy: { proposals: "accept" } });
            assert.equal(result.result.status, 200);
            const ids = result.turnIds ?? [];
            assert.ok(ids.length >= 5, `init + four model turns; got ${ids.length}`);
            const packetOf = async (index: number) => logSection((await db.test_get_packet.get<{ packet: string }>({ id: ids[index]! }))!.packet);
            // The packet for turn 3 follows the curation turn: both receipts, with their statuses.
            const afterCuration = await packetOf(3);
            const fold = row(afterCuration, "FOLD"), kill = row(afterCuration, "KILL");
            assert.ok(fold !== undefined && /"status":200/.test(fold), `the FOLD receipt renders once with its status; got ${fold}`);
            assert.ok(kill !== undefined && /"status":200/.test(kill) && /log:\/\/\/1\/\*\*\/EDIT/.test(kill), `the KILL receipt renders once with its status and target; got ${kill}`);
            assert.equal(row(afterCuration, "EDIT"), undefined, "the killed EDIT row is retired from the projection");
            // The packet for turn 4 follows the no-op KILL: the earlier receipts are gone, the 204 shows once.
            const afterRepeat = await packetOf(4);
            assert.equal(row(afterRepeat, "FOLD"), undefined, "the FOLD receipt dissolved");
            const repeat = row(afterRepeat, "KILL");
            assert.ok(repeat !== undefined && /"status":204/.test(repeat), `only the no-op KILL's 204 receipt remains, once; got ${repeat}`);
            assert.equal((afterRepeat.match(/\/KILL"/g) ?? []).length, 1, "exactly one KILL row: the previous turn's");
            // History is append-only: every curation row stays in the DB.
            const rows = await db.test_ops_by_loop.all<{ op: string; status_rx: number }>({});
            assert.deepEqual(rows.filter((r) => r.op === "FOLD" || r.op === "KILL").map((r) => `${r.op}[${r.status_rx}]`), ["FOLD[200]", "KILL[200]", "KILL[204]"]);
        } finally { ws.close(); }
    });
});
