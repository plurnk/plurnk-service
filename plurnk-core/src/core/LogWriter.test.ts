import test from "node:test";
import assert from "node:assert/strict";
import type { EditStatement } from "@plurnk/plurnk-contracts";
import LogWriter, { type LogRecord } from "./LogWriter.ts";
import type { Db } from "./Db.ts";
import { STORAGE_MAXIMUM_BYTES } from "./file-materialization.ts";

const makeWriter = () => {
    const inserted: LogRecord[] = [];
    const db = {
        engine_loop_turn_seqs: {
            get: async () => ({ loop_seq: 3, turn_seq: 45 }),
        },
        engine_insert_log_entry: {
            get: async (record: LogRecord) => {
                inserted.push(record);
                return { id: 99 };
            },
        },
    } as unknown as Db;

    const writer = new LogWriter({
        db,
        weighContent: (text) => text.length,
        extractTarget: (path) => ({
            scheme: path?.kind === "local" ? "file" : null,
            username: null,
            password: null,
            hostname: null,
            port: null,
            pathname: path?.kind === "local" ? path.raw : null,
            query: null,
            fragment: null,
        }),
        canonColumns: async () => {},
        signalToJson: () => null,
        isProposal: (_stmt, res) => res.status === 202,
    });
    return { writer, inserted };
};

const sampleEdit = (body = "replacement"): EditStatement => ({
    op: "edit",
    headers: null,
    aside: "update file",
    target: { kind: "local", raw: "src/index.ts" },
    lineMarker: null,
    matcher: null,
    body,
    position: { line: 1, column: 1 },
});

test("{§proposal} {§operation-results} LogWriter strips internal attrs from wire rx while persisting log_entry_rows.attrs", async () => {
    const { writer, inserted } = makeWriter();
    const logged = await writer.writeDispatchedLog({
        statement: sampleEdit(),
        result: {
            status: 202,
            body: "--- a/src/index.ts\n+++ b/src/index.ts\n",
            attrs: { path: "/abs/src/index.ts", patched: "large internal payload" },
        },
        workspaceId: 1,
        sessionId: 2,
        loopId: 3,
        turnId: 45,
        sequence: 1,
        origin: "model",
        curationPlan: null,
        modelCallId: 7,
        emissionIndex: 0,
    });

    assert.equal(logged.id, 99);
    assert.equal(logged.result.status, 202);
    assert.equal(inserted.length, 1);
    const record = inserted[0];
    assert.equal(record.state, "proposed");
    const wireRx = JSON.parse(record.rx) as Record<string, unknown>;
    assert.equal("attrs" in wireRx, false, "wire rx must never duplicate internal proposal attrs");
    assert.equal(wireRx.status, 202);
    const storedAttrs = JSON.parse(record.attrs) as Record<string, unknown>;
    assert.equal(storedAttrs.patched, "large internal payload");
    assert.equal(storedAttrs.emissionIndex, 0);
});

test("{§operation-results} LogWriter downgrades oversized rx or tx payloads to 413 result-payload-too-large within SQLite limits", async () => {
    const { writer, inserted } = makeWriter();
    const hugeDiff = "x".repeat(STORAGE_MAXIMUM_BYTES + 128);
    const rxLogged = await writer.writeDispatchedLog({
        statement: sampleEdit(),
        result: {
            status: 202,
            body: hugeDiff,
            attrs: { path: "/abs/src/index.ts", fanout: { total: 2, index: 1 } },
        },
        workspaceId: 1,
        sessionId: 2,
        loopId: 3,
        turnId: 45,
        sequence: 1,
        origin: "model",
        curationPlan: null,
        modelCallId: 7,
        emissionIndex: 2,
    });

    assert.equal(rxLogged.result.status, 413);
    assert.equal(rxLogged.result.problem?.type, "https://problems.plurnk.xyz/engine/log/result-payload-too-large");
    assert.equal(rxLogged.result.problem?.instance, "log:///3/45/1/edit");
    const rxRecord = inserted[0];
    assert.equal(rxRecord.state, "resolved", "an oversized proposal settles immediately as 413 rather than parking");
    assert.ok(rxRecord.rx.length <= STORAGE_MAXIMUM_BYTES);
    assert.ok(rxRecord.tx.length <= STORAGE_MAXIMUM_BYTES);
    assert.deepEqual(JSON.parse(rxRecord.attrs), {
        emissionIndex: 2,
        fanout: { total: 2, index: 1 },
    });

    const txLogged = await writer.writeDispatchedLog({
        statement: sampleEdit(hugeDiff),
        result: { status: 200 },
        workspaceId: 1,
        sessionId: 2,
        loopId: 3,
        turnId: 45,
        sequence: 2,
        origin: "model",
        curationPlan: null,
        modelCallId: 7,
    });
    assert.equal(txLogged.result.status, 413);
    assert.equal(txLogged.result.problem?.type, "https://problems.plurnk.xyz/engine/log/result-payload-too-large");
    const txRecord = inserted[1];
    assert.ok(txRecord.tx.length <= STORAGE_MAXIMUM_BYTES);
    assert.ok(txRecord.rx.length <= STORAGE_MAXIMUM_BYTES);
});
