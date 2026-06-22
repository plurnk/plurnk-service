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
import { rpcCall, connect, withDaemon, makeMockResponse, runLoopToTerminal } from "./_rpc.ts";

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
                const resp = await runLoopToTerminal(ws, 5, { prompt: "go" });
                const { loopId } = resp as { loopId: number };
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
                const resp = await runLoopToTerminal(ws, 2, { prompt: "go" });
                const { loopId } = resp as { loopId: number };
                const rows = await (db.test_log_entries_by_loop as PrepMethod).all<LogRow>({ loop_id: loopId });
                assert.equal(rows.find((r) => r.op === "READ" && r.scheme === "plurnk" && r.pathname === "/manifest.json"), undefined, "no manifest READ foisted when unset");
            } finally { ws.close(); }
        });
    } finally {
        if (prev === undefined) delete process.env.PLURNK_MANIFEST_ITEMS; else process.env.PLURNK_MANIFEST_ITEMS = prev;
    }
});

// Note 293 (c): plurnk:///manifest.json is materialized every turn regardless of the
// preview switch or entry count — so the model always has the directory to READ (a
// valid, possibly-sparse JSON array), even when the preview is off and nothing's there.
test("manifest.json is materialized with the preview off — the model always has an (empty) directory to READ", async () => {
    const prev = process.env.PLURNK_MANIFEST_ITEMS;
    process.env.PLURNK_MANIFEST_ITEMS = "0"; // preview OFF
    try {
        await withDaemon(mock(), async (db, _daemon, addr) => {
            const ws = await connect(addr);
            try {
                await rpcCall(ws, 1, "session.create", { name: "manifest-empty" });
                await runLoopToTerminal(ws, 2, { prompt: "go" });
                const entry = await (db.test_get_entry_id_by_scheme_pathname as PrepMethod).get<{ id: number }>({ scheme: "plurnk", pathname: "/manifest.json" });
                assert.ok(entry?.id !== undefined, "plurnk:///manifest.json is materialized even with the preview off");
                const body = await (db.test_get_channel_by_pathname_scheme as PrepMethod).get<{ content: string }>({ pathname: "/manifest.json", scheme: "plurnk", name: "body" });
                const catalog = JSON.parse(body?.content ?? "null");
                assert.ok(Array.isArray(catalog), "the materialized manifest is a valid JSON array — the directory the model READs, even when sparse");
            } finally { ws.close(); }
        });
    } finally {
        if (prev === undefined) delete process.env.PLURNK_MANIFEST_ITEMS; else process.env.PLURNK_MANIFEST_ITEMS = prev;
    }
});

// #231 — a session's client-chosen manifestItems REPLACES the env default outright,
// both directions: it can switch the preview off when env says on, and on when off.
test("[§operator-config-session-manifest-items] session.create settings.manifestItems replaces the env default at turn 0", async () => {
    const prev = process.env.PLURNK_MANIFEST_ITEMS;
    try {
        // env ON (full) but the client's session asks for OFF (0) → no preview foisted.
        process.env.PLURNK_MANIFEST_ITEMS = "-1";
        await withDaemon(mock(), async (db, _daemon, addr) => {
            const ws = await connect(addr);
            try {
                await rpcCall(ws, 1, "session.create", { name: "mi-off", settings: { manifestItems: 0 } });
                const resp = await runLoopToTerminal(ws, 2, { prompt: "go" });
                const { loopId } = resp as { loopId: number };
                const rows = await (db.test_log_entries_by_loop as PrepMethod).all<LogRow>({ loop_id: loopId });
                assert.equal(rows.find((r) => r.op === "READ" && r.scheme === "plurnk" && r.pathname === "/manifest.json"), undefined, "session manifestItems:0 replaces env -1 — no preview foisted");
            } finally { ws.close(); }
        });
        // env OFF (0) but the client's session asks for ON (-1) → preview appears.
        process.env.PLURNK_MANIFEST_ITEMS = "0";
        await withDaemon(mock(), async (db, _daemon, addr) => {
            const ws = await connect(addr);
            try {
                await rpcCall(ws, 1, "session.create", { name: "mi-on", settings: { manifestItems: -1 } });
                const resp = await runLoopToTerminal(ws, 2, { prompt: "go" });
                const { loopId } = resp as { loopId: number };
                const rows = await (db.test_log_entries_by_loop as PrepMethod).all<LogRow>({ loop_id: loopId });
                const mr = rows.find((r) => r.op === "READ" && r.scheme === "plurnk" && r.pathname === "/manifest.json");
                assert.ok(mr !== undefined && mr.status_rx === 200, "session manifestItems:-1 replaces env 0 — preview foisted");
            } finally { ws.close(); }
        });
    } finally {
        if (prev === undefined) delete process.env.PLURNK_MANIFEST_ITEMS; else process.env.PLURNK_MANIFEST_ITEMS = prev;
    }
});

// #231 — the client surface is narrow + validated; malformed settings fail hard.
test("session.create rejects malformed settings — fail hard, no silent accept (#231)", async () => {
    await withDaemon(mock(), async (_db, _daemon, addr) => {
        const ws = await connect(addr);
        try {
            const badMI = await rpcCall(ws, 1, "session.create", { name: "bad-mi", settings: { manifestItems: 1.5 } });
            assert.ok(badMI.error, "a non-integer manifestItems is a JSON-RPC error, not a silent accept");
            assert.match(badMI.error!.message, /manifestItems must be an integer/);
            const badAlias = await rpcCall(ws, 2, "session.create", { name: "bad-alias", settings: { mdDocs: [{ alias: "has/slash", content: "x" }] } });
            assert.ok(badAlias.error, "a malformed mdDocs alias is a JSON-RPC error");
            assert.match(badAlias.error!.message, /alias must be/);
        } finally { ws.close(); }
    });
});

// #269 — turn-0 run-once foists (manifest preview, AGENTS, operator docs) fire on the run's FIRST
// loop only; later loops in the same run already carry them in the persistent log, so re-foisting
// each loop spammed the log + burned tokens. Two loops in one run: the manifest READ is in loop 1's
// log, absent from loop 2's.
test("[#269] turn-0 run-once foists fire on the run's first loop only, not every loop", async () => {
    const prev = process.env.PLURNK_MANIFEST_ITEMS;
    process.env.PLURNK_MANIFEST_ITEMS = "-1"; // preview ON
    try {
        const twoLoops = new Mock({ contextSize: 8192, responses: [makeMockResponse("<<SEND[200]:done:SEND", 50), makeMockResponse("<<SEND[200]:done:SEND", 50)] });
        await withDaemon(twoLoops, async (db, _daemon, addr) => {
            const ws = await connect(addr);
            try {
                await rpcCall(ws, 1, "session.create", { name: "foist-once" });
                await rpcCall(ws, 2, "op.edit", { target: "known:///a.md", content: "alpha" });
                const r1 = await runLoopToTerminal(ws, 3, { prompt: "first" });
                const r2 = await runLoopToTerminal(ws, 4, { prompt: "second" });
                const manifestRead = async (loopId: number) => {
                    const rows = await (db.test_log_entries_by_loop as PrepMethod).all<LogRow>({ loop_id: loopId });
                    return rows.find((r) => r.op === "READ" && r.scheme === "plurnk" && r.pathname === "/manifest.json");
                };
                assert.ok((await manifestRead((r1 as { loopId: number }).loopId)) !== undefined, "run's first loop foists the manifest preview");
                assert.equal(await manifestRead((r2 as { loopId: number }).loopId), undefined, "the second loop does NOT re-foist it — it's already in the run's log (#269)");
            } finally { ws.close(); }
        });
    } finally {
        if (prev === undefined) delete process.env.PLURNK_MANIFEST_ITEMS; else process.env.PLURNK_MANIFEST_ITEMS = prev;
    }
});
