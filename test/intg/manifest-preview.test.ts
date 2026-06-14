// PLURNK_MANIFEST_ITEMS — turn-0 manifest preview foist (§actor-boundary). When
// set, a plurnk-origin READ of plurnk:///manifest.json is foisted into the model's
// turn 0 (sliced to the first N items via jsonpath for positive N, full for -1);
// off by default. The READ runs AFTER the per-turn manifest write, so it hits the
// catalog, not a 404.
//
// NOTE: sets a process-global env var. node --test isolates each file in its own
// process, so this doesn't leak across files; the on/off cases run sequentially.

import test from "node:test";
import assert from "node:assert/strict";
import { Mock } from "@plurnk/plurnk-providers";
import type { PrepMethod } from "../../src/core/Db.ts";
import { rpcCall, connect, withDaemon, makeMockResponse } from "./_rpc.ts";

type LogRow = { op: string; pathname: string; scheme: string; status_rx: number };
const mock = () => new Mock({ contextSize: 8192, responses: [makeMockResponse("<<SEND[200]:done:SEND", 50)] });

test("[§actor-boundary-manifest-preview] PLURNK_MANIFEST_ITEMS foists a first-N manifest READ at turn 0 (none when unset)", async () => {
    const prev = process.env.PLURNK_MANIFEST_ITEMS;
    try {
        // ON: =2 → a manifest READ is foisted into turn 0, hitting the just-built catalog (200).
        process.env.PLURNK_MANIFEST_ITEMS = "2";
        await withDaemon(mock(), async (db, _daemon, addr) => {
            const ws = await connect(addr);
            try {
                await rpcCall(ws, 1, "session.create", { name: "manifest-on" });
                await rpcCall(ws, 2, "op.edit", { target: "known:///a.md", content: "alpha" });
                await rpcCall(ws, 3, "op.edit", { target: "known:///b.md", content: "bravo" });
                await rpcCall(ws, 4, "op.edit", { target: "known:///c.md", content: "charlie" });
                const resp = await rpcCall(ws, 5, "loop.run", { prompt: "go" });
                const { loopId } = resp.result as { loopId: number };
                const rows = await (db.test_log_entries_by_loop as PrepMethod).all<LogRow>({ loop_id: loopId });
                const mr = rows.find((r) => r.op === "READ" && r.scheme === "plurnk" && r.pathname === "/manifest.json");
                assert.ok(mr !== undefined, "turn 0 foists a READ of plurnk:///manifest.json when set");
                assert.equal(mr!.status_rx, 200, "the READ hits the just-built manifest (200 = matches), not a 404");
            } finally { ws.close(); }
        });

        // OFF: unset → no manifest READ at turn 0.
        delete process.env.PLURNK_MANIFEST_ITEMS;
        await withDaemon(mock(), async (db, _daemon, addr) => {
            const ws = await connect(addr);
            try {
                await rpcCall(ws, 1, "session.create", { name: "manifest-off" });
                const resp = await rpcCall(ws, 2, "loop.run", { prompt: "go" });
                const { loopId } = resp.result as { loopId: number };
                const rows = await (db.test_log_entries_by_loop as PrepMethod).all<LogRow>({ loop_id: loopId });
                assert.equal(rows.find((r) => r.op === "READ" && r.scheme === "plurnk" && r.pathname === "/manifest.json"), undefined, "no manifest READ foisted when unset");
            } finally { ws.close(); }
        });
    } finally {
        if (prev === undefined) delete process.env.PLURNK_MANIFEST_ITEMS; else process.env.PLURNK_MANIFEST_ITEMS = prev;
    }
});
