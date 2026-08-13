import test from "node:test";
import assert from "node:assert/strict";
import type { Db } from "../../src/core/Db.ts";
import { openMigrated, seedEnvelope, insertWorkspace, insertWorker, insertLoop, insertTurn } from "./_helpers.ts";
import LogEntry from "../../src/server/logEntry.ts";

type SqlValue = string | number | bigint | null;

const minimalLog = async (db: Db, ctx: { workerId: number; loopId: number; turnId: number }, overrides: Record<string, SqlValue> = {}): Promise<number> => {
    const params: Record<string, SqlValue> = {
        worker_id: ctx.workerId, loop_id: ctx.loopId, turn_id: ctx.turnId,
        sequence: 1, origin: "model", op: "EDIT", suffix: "",
        source: null,
        signal: JSON.stringify(["+philosophy"]),
        scheme: "worker", pathname: "/meaning", port: null, query: null,
        lineMarker: null,
        tx: "## EDIT0 [+philosophy] (worker:///meaning)\n42", mimetype_tx: "text/x-plurnk",
        rx: "", mimetype_rx: "text/plain", status_rx: 201,
        tokens: 32, attrs: "{}",
        ...overrides,
    };
    const row = await db.test_log_entries_insert_full.get<{ id: number }>(params);
    if (row === undefined) throw new Error("log_entries insert returned no row");
    return row.id;
};

test("fetchLogEntry surfaces loop_seq/turn_seq (ordinals), not just DB ids", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `ws-${crypto.randomUUID()}`);
        const workerId = await insertWorker(db, workspaceId);
        const loopId = await insertLoop(db, workerId, 3);   // loop ordinal 3
        const turnId = await insertTurn(db, loopId, 2);  // turn ordinal 2
        const id = await minimalLog(db, { workerId, loopId, turnId }, { tx: JSON.stringify("in"), rx: JSON.stringify("out") });
        const wire = await LogEntry.fetchLogEntry(db, id);
        assert.equal(wire.loop_seq, 3, "loop ordinal on the wire");
        assert.equal(wire.turn_seq, 2, "turn ordinal on the wire");
        assert.equal(wire.loop_id, loopId, "DB loop id still present");
        assert.equal(wire.turn_id, turnId, "DB turn id still present");
    } finally { await db.close(); }
});

test("fetchLogEntry preserves causal source and structured attributes", async () => {
    const db = await openMigrated();
    try {
        const ctx = await seedEnvelope(db, `wire-provenance-${crypto.randomUUID()}`);
        const id = await minimalLog(db, ctx, {
            origin: "plurnk",
            source: "worker://researcher",
            attrs: JSON.stringify({ kind: "entry_materialized" }),
            tx: JSON.stringify("in"),
            rx: JSON.stringify("out"),
        });
        await db.log_write_tag.run({ log_entry_id: id, tag: "research" });
        const wire = await LogEntry.fetchLogEntry(db, id);
        assert.equal(wire.source, "worker://researcher");
        assert.deepEqual(wire.attrs, { kind: "entry_materialized" });
        assert.deepEqual(wire.tags, ["philosophy", "research"]);
    } finally { await db.close(); }
});

test("log_entries: table is STRICT", async () => {
    const db = await openMigrated();
    try {
        const row = await db.test_log_entries_table_sql.get<{ sql: string }>();
        assert.match(row?.sql ?? "", /STRICT/);
    } finally { await db.close(); }
});

test("log_entries: minimal insert — defaults populate", async () => {
    const db = await openMigrated();
    try {
        const ctx = await seedEnvelope(db, "ws-log-defaults");
        const ins = await db.test_log_entries_insert_minimal.get<{ id: number }>({ worker_id: ctx.workerId, loop_id: ctx.loopId, turn_id: ctx.turnId });
        const row = await db.test_log_entries_get_by_id.get<{ version: number; at: string; suffix: string; tokens: number; signal: string | null; lineMarker: string | null }>({ id: ins?.id });
        assert.equal(row?.version, 0);
        assert.match(row?.at ?? "", /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
        assert.equal(row?.suffix, "");
        assert.equal(row?.tokens, 0);
        assert.equal(row?.signal, null);
        assert.equal(row?.lineMarker, null);
    } finally { await db.close(); }
});

test("log_entries: sequence UNIQUE within turn", async () => {
    const db = await openMigrated();
    try {
        const ctx = await seedEnvelope(db, "ws-log-actionuniq");
        await minimalLog(db, ctx, { sequence: 1 });
        await assert.rejects(
            () => minimalLog(db, ctx, { sequence: 1 }),
            /UNIQUE constraint failed/,
        );
    } finally { await db.close(); }
});

test("log_entries: sequence >= 1 enforced", async () => {
    const db = await openMigrated();
    try {
        const ctx = await seedEnvelope(db, "ws-log-actionneg");
        await assert.rejects(
            () => minimalLog(db, ctx, { sequence: 0 }),
            /CHECK constraint failed/,
        );
    } finally { await db.close(); }
});

test("log_entries: origin enum", async () => {
    const db = await openMigrated();
    try {
        const ctx = await seedEnvelope(db, "ws-log-origin");
        for (const [i, origin] of ["model", "client", "plurnk", "plugin"].entries()) {
            await minimalLog(db, ctx, { sequence: i + 1, origin });
        }
        await assert.rejects(
            () => minimalLog(db, ctx, { sequence: 4, origin: "admin" }),
            /CHECK constraint failed/,
        );
    } finally { await db.close(); }
});

test("log_entries: actionless kinds have exact authorship", async () => {
    const db = await openMigrated();
    try {
        const ctx = await seedEnvelope(db, "ws-log-actionless-kinds");
        await minimalLog(db, ctx, {
            sequence: 1, origin: "plurnk", op: null,
            attrs: JSON.stringify({ kind: "initialization" }),
        });
        await minimalLog(db, ctx, {
            sequence: 2, origin: "model", op: null,
            attrs: JSON.stringify({ kind: "model_emission" }),
        });
        for (const [sequence, origin, kind] of [
            [3, "model", "initialization"],
            [4, "plurnk", "model_emission"],
        ] as const) {
            await assert.rejects(
                () => minimalLog(db, ctx, { sequence, origin, op: null, attrs: JSON.stringify({ kind }) }),
                /CHECK constraint failed/,
            );
        }
        await assert.rejects(
            () => minimalLog(db, ctx, { sequence: 5, origin: "plurnk", op: null, attrs: JSON.stringify({ kind: "other" }) }),
            /CHECK constraint failed/,
        );
        await assert.rejects(
            () => minimalLog(db, ctx, { sequence: 6, origin: "plurnk", op: "READ", attrs: JSON.stringify({ kind: "initialization" }) }),
            /CHECK constraint failed/,
        );
    } finally { await db.close(); }
});

// (No "op enum" test: log_entries.op no longer CHECK-enumerates the grammar op set — that was a
// hand-copy of grammar's contract that went stale on every new verb. Op validity lives at the parse
// (grammar) + type (PlurnkOp) layer; the column stores what the typed engine writes.)

test("log_entries: status_rx range 100..599", async () => {
    const db = await openMigrated();
    try {
        const ctx = await seedEnvelope(db, "ws-log-statusrx");
        for (const [i, s] of [100, 200, 499, 599].entries()) {
            await minimalLog(db, ctx, { sequence: i + 1, status_rx: s });
        }
        for (const bad of [99, 600, 0, -1]) {
            await assert.rejects(
                () => minimalLog(db, ctx, { sequence: 999, status_rx: bad }),
                /CHECK constraint failed/,
            );
        }
    } finally { await db.close(); }
});

test("log_entries: mimetype CHECK", async () => {
    const db = await openMigrated();
    try {
        const ctx = await seedEnvelope(db, "ws-log-mimetypes");
        await assert.rejects(() => minimalLog(db, ctx, { mimetype_tx: "" }), /CHECK constraint failed/);
        await assert.rejects(() => minimalLog(db, ctx, { mimetype_rx: "" }), /CHECK constraint failed/);
    } finally { await db.close(); }
});

test("log_entries: scheme nullable; non-empty CHECK", async () => {
    const db = await openMigrated();
    try {
        const ctx = await seedEnvelope(db, "ws-log-tscheme");
        await minimalLog(db, ctx, { sequence: 1, scheme: null });
        await assert.rejects(
            () => minimalLog(db, ctx, { sequence: 2, scheme: "" }),
            /CHECK constraint failed/,
        );
    } finally { await db.close(); }
});

test("log_entries: port range", async () => {
    const db = await openMigrated();
    try {
        const ctx = await seedEnvelope(db, "ws-log-tport");
        await minimalLog(db, ctx, { sequence: 1, port: 443 });
        await minimalLog(db, ctx, { sequence: 2, port: 0 });
        await minimalLog(db, ctx, { sequence: 3, port: 65535 });
        await minimalLog(db, ctx, { sequence: 4, port: null });
        await assert.rejects(() => minimalLog(db, ctx, { sequence: 5, port: 65536 }), /CHECK constraint failed/);
        await assert.rejects(() => minimalLog(db, ctx, { sequence: 6, port: -1 }), /CHECK constraint failed/);
    } finally { await db.close(); }
});

test("log_entries: serialized query preserves absence, empty, order, and duplicates", async () => {
    const db = await openMigrated();
    try {
        const ctx = await seedEnvelope(db, "ws-log-json");
        await minimalLog(db, ctx, { sequence: 1, query: null, signal: null, lineMarker: null });
        await minimalLog(db, ctx, { sequence: 2, query: "", signal: '["+a","+b"]', lineMarker: '{"first":1,"last":10}' });
        await minimalLog(db, ctx, { sequence: 3, query: "b=2&a=1&a=3" });
        await assert.rejects(() => minimalLog(db, ctx, { sequence: 4, signal: "{bad" }), /CHECK constraint failed/);
        await assert.rejects(() => minimalLog(db, ctx, { sequence: 5, lineMarker: "broken" }), /CHECK constraint failed/);
    } finally { await db.close(); }
});

test("log_entries: signal polymorphism", async () => {
    const db = await openMigrated();
    try {
        const ctx = await seedEnvelope(db, "ws-log-sigpoly");
        await minimalLog(db, ctx, { sequence: 1, op: "EDIT",  signal: JSON.stringify(["+philosophy"]) });
        await minimalLog(db, ctx, { sequence: 2, op: "SEND",  signal: JSON.stringify(200) });
        await minimalLog(db, ctx, { sequence: 3, op: "EXEC",  signal: JSON.stringify("node") });
        await minimalLog(db, ctx, { sequence: 4, op: "READ",  signal: null });
        const rows = await db.test_log_entries_signals_by_turn.all<{ op: string; signal: string | null }>({ turn_id: ctx.turnId });
        assert.deepEqual(rows.map((r) => r.signal), ['["+philosophy"]', '200', '"node"', null]);
    } finally { await db.close(); }
});

test("log_entries: implicit and explicit additions share one stored tag identity", async () => {
    const db = await openMigrated();
    try {
        const ctx = await seedEnvelope(db, "ws-log-tag-boundary");
        await assert.rejects(
            () => minimalLog(db, ctx, { sequence: 1, signal: JSON.stringify(["-research"]) }),
            /classifying log operation signal accepts only tag or \+tag additions/,
        );
        const id = await minimalLog(db, ctx, {
            sequence: 1,
            signal: JSON.stringify(["research/topic", "+research/topic", "+reviewed"]),
        });
        for (const invalid of [
            "+signed",
            "-signed",
            "two words",
            "line\nbreak",
            "nonbreaking\u00a0space",
            "line\u2028separator",
            "byte-order\ufeffmark",
            "comma,tag",
            "bracket[tag]",
        ]) {
            await assert.rejects(
                () => db.log_write_tag.run({ log_entry_id: id, tag: invalid }),
                /log tag name is invalid/,
                invalid,
            );
        }
        assert.deepEqual(
            (await db.test_log_tags_by_worker.all<{ tag: string }>({ worker_id: ctx.workerId })).map(({ tag }) => tag),
            ["research/topic", "reviewed"],
        );
    } finally { await db.close(); }
});

test("log_entries: a malformed bound curation plan rolls back its row and every target change", async () => {
    const db = await openMigrated();
    try {
        const ctx = await seedEnvelope(db, "ws-log-curation-atomicity");
        const targetId = await minimalLog(db, ctx, { sequence: 1, signal: JSON.stringify(["+research"]) });
        for (const plan of [
            { ids: [targetId], expanded: 0, add: ["archive", "archive"], remove: [] },
            { ids: [targetId], expanded: 0, add: [], remove: ["nonbreaking\u00a0space"] },
        ]) {
            await assert.rejects(
                () => minimalLog(db, ctx, {
                    sequence: 2,
                    op: "FOLD",
                    signal: JSON.stringify(["research", "+archive"]),
                    attrs: JSON.stringify({ __plurnk_curation: plan }),
                }),
                /invalid private log curation payload/,
            );
        }
        assert.equal(
            (await db.test_get_log_expanded.get<{ expanded: number }>({
                worker_id: ctx.workerId,
                loop_seq: 1,
                turn_seq: 1,
                sequence: 1,
            }))?.expanded,
            1,
        );
        assert.deepEqual(
            await db.test_log_tags_by_worker.all<{ coordinate: string; tag: string }>({ worker_id: ctx.workerId }),
            [{ coordinate: "1/1/1", tag: "research" }],
        );
        assert.equal(
            (await db.test_count_log_entries_by_turn.get<{ n: number }>({ turn_id: ctx.turnId }))?.n,
            1,
            "the failed outer INSERT leaves no curation event row",
        );
    } finally { await db.close(); }
});

test("log_entries: curation effect deltas accept only canonical stored tag identities", async () => {
    const db = await openMigrated();
    try {
        const ctx = await seedEnvelope(db, "ws-log-curation-effect-boundary");
        const targetId = await minimalLog(db, ctx, { sequence: 1 });
        const operationId = await minimalLog(db, ctx, { sequence: 2, op: "OPEN", signal: null });
        await assert.rejects(
            () => db.fork_insert_log_curation_effect.run({
                operation_log_entry_id: operationId,
                target_log_entry_id: targetId,
                expanded_before: 1,
                tags_added: "[]",
                tags_removed: JSON.stringify(["nonbreaking\u00a0space"]),
            }),
            /invalid log curation effect/,
        );
        assert.deepEqual(
            await db.test_log_curation_effects_by_worker.all({ worker_id: ctx.workerId }),
            [],
        );
    } finally { await db.close(); }
});

test("log_entries: worker_id NOT NULL", async () => {
    const db = await openMigrated();
    try {
        const ctx = await seedEnvelope(db, "ws-log-norun");
        await assert.rejects(
            () => db.test_log_entries_insert_no_worker_id.run({ loop_id: ctx.loopId, turn_id: ctx.turnId }),
            /NOT NULL constraint failed: log_entries\.worker_id/,
        );
    } finally { await db.close(); }
});

test("log_entries: each FK rejection path", async () => {
    const db = await openMigrated();
    try {
        const ctx = await seedEnvelope(db, "ws-log-fkpaths");
        await assert.rejects(() => minimalLog(db, ctx, { worker_id: 99999 }),  /FOREIGN KEY constraint failed/);
        await assert.rejects(() => minimalLog(db, ctx, { loop_id: 99999 }), /FOREIGN KEY constraint failed/);
        await assert.rejects(() => minimalLog(db, ctx, { turn_id: 99999 }), /FOREIGN KEY constraint failed/);
    } finally { await db.close(); }
});

test("log_entries: ON DELETE CASCADE via turn", async () => {
    const db = await openMigrated();
    try {
        const ctx = await seedEnvelope(db, "ws-log-turncasc");
        await minimalLog(db, ctx, { sequence: 1 });
        await minimalLog(db, ctx, { sequence: 2 });
        await db.test_log_entries_delete_turns.run({ id: ctx.turnId });
        const remaining = (await db.test_log_entries_count_all.get<{ n: number }>())?.n;
        assert.equal(remaining, 0);
    } finally { await db.close(); }
});

test("log_entries: full CASCADE chain", async () => {
    const db = await openMigrated();
    try {
        const ctx = await seedEnvelope(db, "ws-log-fullchain");
        await minimalLog(db, ctx);
        await db.test_workspaces_delete.run({ id: ctx.workspaceId });
        const remaining = (await db.test_log_entries_count_all.get<{ n: number }>())?.n;
        assert.equal(remaining, 0);
    } finally { await db.close(); }
});

test("log_entries: immutability trigger — UPDATE of core fields rejected", async () => {
    const db = await openMigrated();
    try {
        const ctx = await seedEnvelope(db, "ws-log-immut");
        const id = await minimalLog(db, ctx);
        // Lifecycle columns (state/outcome/status_rx/rx) are updateable for
        // the proposal lifecycle, and the curation trigger may remove its
        // private attrs payload; the original action stays pinned forever.
        await assert.rejects(
            () => db.test_log_entries_update_tx.run({ tx: "tampered", id }),
            /log_entries core fields are immutable/,
        );
        const tx = (await db.test_log_entries_get_tx_by_id.get<{ tx: string }>({ id }))?.tx;
        assert.match(tx ?? "", /^## EDIT0/);
    } finally { await db.close(); }
});

test("log_entries: DELETE is allowed", async () => {
    const db = await openMigrated();
    try {
        const ctx = await seedEnvelope(db, "ws-log-delok");
        const id = await minimalLog(db, ctx);
        await db.test_log_entries_delete.run({ id });
        const count = (await db.test_log_entries_count_all.get<{ n: number }>())?.n;
        assert.equal(count, 0);
    } finally { await db.close(); }
});

test("log_entries: tokens negative rejected", async () => {
    const db = await openMigrated();
    try {
        const ctx = await seedEnvelope(db, "ws-log-toksneg");
        await assert.rejects(
            () => minimalLog(db, ctx, { tokens: -1 }),
            /CHECK constraint failed/,
        );
    } finally { await db.close(); }
});

test("log_entries: indexes exist", async () => {
    const db = await openMigrated();
    try {
        const rows = await db.test_log_entries_indexes.all<{ name: string; sql: string }>();
        const names = rows.map((r) => r.name).sort();
        assert.deepEqual(names, [
            "log_entries_at",
            "log_entries_loop_id",
            "log_entries_model_call_id",
            "log_entries_turn_id_sequence",
            "log_entries_worker_ambient_event",
            "log_entries_worker_id",
        ]);
        const uniq = rows.find((r) => r.name === "log_entries_turn_id_sequence");
        assert.match(uniq?.sql ?? "", /UNIQUE/);
        const modelCall = rows.find((r) => r.name === "log_entries_model_call_id");
        assert.match(modelCall?.sql ?? "", /UNIQUE/);
        assert.match(modelCall?.sql ?? "", /model_call_id IS NOT NULL/);
        const occurrence = rows.find((r) => r.name === "log_entries_worker_ambient_event");
        assert.match(occurrence?.sql ?? "", /UNIQUE/);
        assert.match(occurrence?.sql ?? "", /ambient_event_id IS NOT NULL/);
    } finally { await db.close(); }
});

test("log_entries: query log:///<L>/<T>/<A> address pattern", async () => {
    const db = await openMigrated();
    try {
        const ctx = await seedEnvelope(db, "ws-log-address");
        await minimalLog(db, ctx, { sequence: 1 });
        await minimalLog(db, ctx, { sequence: 2, op: "SEND" });
        const row = await db.test_log_entries_address_join.get<{ op: string; loop_seq: number; turn_seq: number; sequence: number }>({ loop_seq: 1, turn_seq: 1, sequence: 2 });
        assert.equal(row?.op, "SEND");
        assert.equal(row?.loop_seq, 1);
        assert.equal(row?.turn_seq, 1);
        assert.equal(row?.sequence, 2);
    } finally { await db.close(); }
});
