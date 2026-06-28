// PLURNK_FILES_ITEMS — turn-0 catalog preview foist (§actor-boundary). A plurnk-origin
// FIND(scheme:///**) is foisted into the model's turn 0 per scheme: memory/scratch/docs always
// FULL, the first-N cap applies ONLY to the file list (-1 = all full, N = file list first-N with
// memory full, 0/unset = off). The catalog is FIND-served (no manifest.json entry).
//
// NOTE: sets a process-global env var. node --test isolates each file in its own
// process, so this doesn't leak across files; the on/off cases run sequentially.

import test from "node:test";
import assert from "node:assert/strict";
import { Mock } from "@plurnk/plurnk-providers";
import type { PrepMethod } from "../../src/core/Db.ts";
import { rpcCall, connect, withDaemon, makeMockResponse, runLoopToTerminal } from "./_rpc.ts";

type LogRow = { op: string; pathname: string; scheme: string; status_rx: number; rx: string };
const mock = () => new Mock({ contextSize: 8192, responses: [makeMockResponse("<<SEND[200]:done:SEND", 50)] });

test("[§actor-boundary-catalog-preview] PLURNK_FILES_ITEMS foists the catalog at turn 0 — memory FULL, the files cap never truncates it (none when off)", async () => {
    const prev = process.env.PLURNK_FILES_ITEMS;
    try {
        // ON with a cap: =2 → the catalog is foisted at turn 0 (200). The cap is FILES-only; the
        // model's memory (known) foists FULL — all 3 entries, never truncated to the first 2 (#286).
        process.env.PLURNK_FILES_ITEMS = "2";
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
                const cf = rows.find((r) => r.op === "FIND" && r.scheme === "known");
                assert.ok(cf !== undefined, "turn 0 foists a FIND(known:///**) catalog preview when set");
                assert.equal(cf!.status_rx, 200, "the catalog FIND returns the scheme's rows (200)");
                const parsed = JSON.parse(cf!.rx) as { content?: string; results?: unknown[] };
                const items = parsed.results ?? (parsed.content !== undefined ? JSON.parse(parsed.content) as unknown[] : []);
                assert.equal(items.length, 3, "memory (known) foists FULL even at PLURNK_FILES_ITEMS=2 — the files cap never truncates the model's own memory");
            } finally { ws.close(); }
        });

        // OFF: unset → no manifest READ at turn 0.
        delete process.env.PLURNK_FILES_ITEMS;
        await withDaemon(mock(), async (db, _daemon, addr) => {
            const ws = await connect(addr);
            try {
                await rpcCall(ws, 1, "session.create", { name: "manifest-off" });
                const resp = await runLoopToTerminal(ws, 2, { prompt: "go" });
                const { loopId } = resp as { loopId: number };
                const rows = await (db.test_log_entries_by_loop as PrepMethod).all<LogRow>({ loop_id: loopId });
                assert.equal(rows.find((r) => r.op === "FIND"), undefined, "no catalog FIND foisted when unset");
            } finally { ws.close(); }
        });
    } finally {
        if (prev === undefined) delete process.env.PLURNK_FILES_ITEMS; else process.env.PLURNK_FILES_ITEMS = prev;
    }
});

// The catalog is FIND-served — there is no plurnk:///manifest.json entry. With the preview
// off, the run opens with no foisted catalog; the model FINDs each scheme on demand (the
// "always a single directory to READ" invariant retired with the manifest.json entry).
test("no manifest.json entry — the catalog is FIND-served; preview-off foists no FIND", async () => {
    const prev = process.env.PLURNK_FILES_ITEMS;
    process.env.PLURNK_FILES_ITEMS = "0"; // preview OFF
    try {
        await withDaemon(mock(), async (db, _daemon, addr) => {
            const ws = await connect(addr);
            try {
                await rpcCall(ws, 1, "session.create", { name: "catalog-find-served" });
                await rpcCall(ws, 2, "op.edit", { target: "known:///a.md", content: "alpha" });
                const resp = await runLoopToTerminal(ws, 3, { prompt: "go" });
                const { loopId } = resp as { loopId: number };
                const entry = await (db.test_get_entry_id_by_scheme_pathname as PrepMethod).get<{ id: number }>({ scheme: "plurnk", pathname: "/manifest.json" });
                assert.equal(entry?.id, undefined, "no plurnk:///manifest.json entry — the catalog is not materialized as an entry");
                const rows = await (db.test_log_entries_by_loop as PrepMethod).all<LogRow>({ loop_id: loopId });
                assert.equal(rows.find((r) => r.op === "FIND"), undefined, "preview off → no catalog FIND foisted; the model FINDs on demand");
            } finally { ws.close(); }
        });
    } finally {
        if (prev === undefined) delete process.env.PLURNK_FILES_ITEMS; else process.env.PLURNK_FILES_ITEMS = prev;
    }
});

// #231 — a session's client-chosen filesItems REPLACES the env default outright,
// both directions: it can switch the preview off when env says on, and on when off.
test("[§operator-config-session-files-items] session.create settings.filesItems replaces the env default at turn 0", async () => {
    const prev = process.env.PLURNK_FILES_ITEMS;
    try {
        // env ON (full) but the client's session asks for OFF (0) → no preview foisted.
        process.env.PLURNK_FILES_ITEMS = "-1";
        await withDaemon(mock(), async (db, _daemon, addr) => {
            const ws = await connect(addr);
            try {
                await rpcCall(ws, 1, "session.create", { name: "mi-off", settings: { filesItems: 0 } });
                const resp = await runLoopToTerminal(ws, 2, { prompt: "go" });
                const { loopId } = resp as { loopId: number };
                const rows = await (db.test_log_entries_by_loop as PrepMethod).all<LogRow>({ loop_id: loopId });
                assert.equal(rows.find((r) => r.op === "FIND"), undefined, "session filesItems:0 replaces env -1 — no catalog FIND foisted");
            } finally { ws.close(); }
        });
        // env OFF (0) but the client's session asks for ON (-1) → preview appears.
        process.env.PLURNK_FILES_ITEMS = "0";
        await withDaemon(mock(), async (db, _daemon, addr) => {
            const ws = await connect(addr);
            try {
                await rpcCall(ws, 1, "session.create", { name: "mi-on", settings: { filesItems: -1 } });
                const resp = await runLoopToTerminal(ws, 2, { prompt: "go" });
                const { loopId } = resp as { loopId: number };
                const rows = await (db.test_log_entries_by_loop as PrepMethod).all<LogRow>({ loop_id: loopId });
                const cf = rows.find((r) => r.op === "FIND");
                assert.ok(cf !== undefined && cf.status_rx === 200, "session filesItems:-1 replaces env 0 — catalog FIND foisted");
            } finally { ws.close(); }
        });
    } finally {
        if (prev === undefined) delete process.env.PLURNK_FILES_ITEMS; else process.env.PLURNK_FILES_ITEMS = prev;
    }
});

// #231 — the client surface is narrow + validated; malformed settings fail hard.
test("session.create rejects malformed settings — fail hard, no silent accept (#231)", async () => {
    await withDaemon(mock(), async (_db, _daemon, addr) => {
        const ws = await connect(addr);
        try {
            const badMI = await rpcCall(ws, 1, "session.create", { name: "bad-mi", settings: { filesItems: 1.5 } });
            assert.ok(badMI.error, "a non-integer filesItems is a JSON-RPC error, not a silent accept");
            assert.match(badMI.error!.message, /filesItems must be an integer/);
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
    const prev = process.env.PLURNK_FILES_ITEMS;
    process.env.PLURNK_FILES_ITEMS = "-1"; // preview ON
    try {
        const twoLoops = new Mock({ contextSize: 8192, responses: [makeMockResponse("<<SEND[200]:done:SEND", 50), makeMockResponse("<<SEND[200]:done:SEND", 50)] });
        await withDaemon(twoLoops, async (db, _daemon, addr) => {
            const ws = await connect(addr);
            try {
                await rpcCall(ws, 1, "session.create", { name: "foist-once" });
                await rpcCall(ws, 2, "op.edit", { target: "known:///a.md", content: "alpha" });
                const r1 = await runLoopToTerminal(ws, 3, { prompt: "first" });
                const r2 = await runLoopToTerminal(ws, 4, { prompt: "second" });
                const catalogFind = async (loopId: number) => {
                    const rows = await (db.test_log_entries_by_loop as PrepMethod).all<LogRow>({ loop_id: loopId });
                    return rows.find((r) => r.op === "FIND" && r.scheme === "known");
                };
                assert.ok((await catalogFind((r1 as { loopId: number }).loopId)) !== undefined, "run's first loop foists the catalog preview");
                assert.equal(await catalogFind((r2 as { loopId: number }).loopId), undefined, "the second loop does NOT re-foist it — it's already in the run's log (#269)");
            } finally { ws.close(); }
        });
    } finally {
        if (prev === undefined) delete process.env.PLURNK_FILES_ITEMS; else process.env.PLURNK_FILES_ITEMS = prev;
    }
});

test("[§model-entry] the turn-0 exemplar mirrors the REAL foisted survey — dynamic, not a static print", async () => {
    const prev = process.env.PLURNK_FILES_ITEMS;
    try {
        process.env.PLURNK_FILES_ITEMS = "-1"; // foist the full per-scheme catalog at turn 0
        await withDaemon(mock(), async (db, _daemon, addr) => {
            const ws = await connect(addr);
            try {
                await rpcCall(ws, 1, "session.create", { name: "turn0-exemplar" });
                await rpcCall(ws, 2, "op.edit", { target: "known:///a.md", content: "alpha" });
                const resp = await runLoopToTerminal(ws, 3, { prompt: "go" });
                const { modelRunId } = resp as { modelRunId: number };
                // The run's first turn opens with the turn-0 `model` exemplar at 1/1/1, born OPEN.
                const row = await (db.log_read_by_coordinate as PrepMethod).get<{ op: string; rx: string }>({ run_id: modelRunId, loop_seq: 1, turn_seq: 1, sequence: 1 });
                assert.equal(row?.op, "model", "the run's first turn opens with the turn-0 model exemplar");
                const content = (JSON.parse(row!.rx) as { content: string }).content;
                // Dynamic — it carries the FIND the foist ACTUALLY dispatched (known:///**), rendered to
                // DSL and framed PLAN → SEND. Not a frozen print: feed-as-turn-0, show-in-turn-1 are one act.
                assert.match(content, /^<<PLAN:Initialize:PLAN/, "opens with the reasoning move");
                assert.match(content, /<<FIND\(known:\/\/\/\*\*\)::FIND/, "the real foisted survey, rendered back to DSL");
                assert.match(content, /<<SEND\[102\]:Initialized:SEND$/, "closes with the progress signal");
            } finally { ws.close(); }
        });
    } finally {
        if (prev === undefined) delete process.env.PLURNK_FILES_ITEMS; else process.env.PLURNK_FILES_ITEMS = prev;
    }
});
