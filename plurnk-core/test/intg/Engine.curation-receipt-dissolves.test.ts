// {§curation-receipt-dissolves} — a successful log-curation receipt renders in exactly the packet
// after its turn (path, target, status) and is gone from the next one. The 2026-08-30 live drill
// showed why: with no receipt at all, a model that deferred its confirmation re-issued a broad
// KILL three times into the turn ceiling. A receipt that dissolves leaves nothing to curate.
import test from "node:test";
import assert from "node:assert/strict";
import { Mock } from "@plurnk/plurnk-providers";
import { rpcCall, connect, withDaemon, makeMockResponse, runLoopToTerminal } from "./_rpc.ts";
import { parseLogRecords } from "../LogRecords.ts";

const logSection = (packet: string): string => {
    const parsed = JSON.parse(packet) as { sections?: Array<{ name: string; content: string }> };
    return parsed.sections?.find((s) => s.name === "log")?.content ?? packet;
};
const rows = (log: string, op: string): Array<Record<string, unknown>> =>
    parseLogRecords(log).filter(({ path }) => typeof path === "string" && path.endsWith(`/${op}`));
const row = (log: string, op: string): Record<string, unknown> | undefined => rows(log, op)[0];

test("{§curation-receipt-dissolves} scoped and whole KILL receipts show once with their status, then dissolve; the 204 no-op shows once too", async () => {
    const mock = new Mock({ contextWindow: 32768, responses: [
        makeMockResponse("### EDIT0 (worker:///note)\nfirst line\nsecond line\n\n### READ0 (worker:///note)\n\n### SEND0 (NEXT)\nwrote", 50),
        makeMockResponse("### KILL0 (log:///1/**/READ) <1,-1>\n\n### KILL0 (log:///1/**/EDIT)\n\n### SEND0 (NEXT)\ncurated", 50),
        makeMockResponse("### KILL0 (log:///1/**/EDIT)\n\n### SEND0 (NEXT)\nagain", 50),
        makeMockResponse("### SEND0 (TERM)\ndone", 50),
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
            const kills = rows(afterCuration, "KILL");
            assert.equal(kills.length, 2, `both KILL receipts render once; got ${JSON.stringify(kills)}`);
            assert.ok(kills.every(({ status }) => status === 200), `each receipt carries its status; got ${JSON.stringify(kills)}`);
            assert.deepEqual(kills.map(({ target }) => target).toSorted(), ["log:///1/**/EDIT", "log:///1/**/READ"], "each receipt names its target");
            assert.equal(row(afterCuration, "EDIT"), undefined, "the killed EDIT row is retired from the projection");
            // The packet for turn 4 follows the no-op KILL: the earlier receipts are gone, the 204 shows once.
            const afterRepeat = await packetOf(4);
            assert.equal(rows(afterRepeat, "KILL").length, 1, "the earlier receipts dissolved");
            const repeat = row(afterRepeat, "KILL");
            assert.equal(repeat?.status, 204, `only the no-op KILL's 204 receipt remains, once; got ${JSON.stringify(repeat)}`);
            // History is append-only: every curation row stays in the DB.
            const history = await db.test_ops_by_loop.all<{ op: string; status_rx: number }>({});
            assert.deepEqual(history.filter((r) => r.op === "KILL").map((r) => `${r.op}[${r.status_rx}]`), ["KILL[200]", "KILL[200]", "KILL[204]"]);
        } finally { ws.close(); }
    });
});
