import { lastReply } from "./_helpers.ts";
import test from "node:test";
import assert from "node:assert/strict";
import { Mock } from "@plurnk/plurnk-providers";
import { rpcCall, connect, withDaemon, makeMockResponse, runLoopToTerminal } from "./_rpc.ts";

for (const curate of [false, true]) {
    test(`{§completion-defers-to-results}: mutation receipts require observation, including when curated=${curate}`, async () => {
        const extra = curate ? "````READ (worker:///notes.md)\n````\n````READ (worker:///notes.md)\n````\n````KILL (log:///**/EDIT)\n````\n" : "";
        const mock = new Mock({ contextWindow: 16384, responses: [
            makeMockResponse("````EDIT (worker:///notes.md)\nhello\n````\n" + extra + "````SEND\nWritten.\n````"),
            makeMockResponse("````KILL\n````"),
        ] });
        await withDaemon(mock, async (db, _daemon, addr) => {
            const ws = await connect(addr);
            try {
                await rpcCall(ws, 1, "workspace.create", { name: "mutation-gate" });
                const result = await runLoopToTerminal(ws, 2, { prompt: "go", policy: { proposals: "accept" } });
                assert.equal(result.finalStatus, 200);
                assert.equal(result.result.content, undefined);
        assert.equal(await lastReply(db, result.loopId), "Written.");
                assert.equal(mock.received.length, 2, "a completed mutation needs one observation turn, no terminal ceremony");
                const rows = await db.test_log_entries_by_loop.all<{ op: string; origin: string; status_rx: number }>({ loop_id: result.loopId });
                const model = rows.filter(({ origin }) => origin === "model");
                assert.deepEqual(model.map(({ op }) => op), curate ? ["EDIT", "READ", "READ", "KILL", "SEND", "KILL"] : ["EDIT", "SEND", "KILL"]);
                assert.equal(model[0]!.status_rx, 201);
                assert.deepEqual(model.slice(1).map(({ op, status_rx }) => [op, status_rx]),
                    curate ? [["READ", 200], ["READ", 200], ["KILL", 204], ["SEND", 200], ["KILL", 200]] : [["SEND", 200], ["KILL", 200]],
                    "curation cannot select a same-turn receipt before it is published");
                assert.match(JSON.stringify(mock.received[1]), /notes\.md/);
                const entry = await db.test_get_channel_by_pathname_scheme.get<{ content: string }>({ pathname: "/notes.md", scheme: "worker", name: "body" });
                assert.equal(entry?.content, "hello", "both creation and retained content are verified");
            } finally { ws.close(); }
        });
    });
}
