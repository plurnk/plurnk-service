// {§methods-loop-run-open-paths} {§overflow-turn}: a client-attached report
// performs a real READ too large for the input capacity, before model inference.
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Daemon from "../../src/server/Daemon.ts";
import type { Db } from "../../src/core/Db.ts";
import { readStmt, urlPath } from "../intg/_dsl.ts";
import { logEntries } from "../intg/_helpers.ts";
import { initializeDemoRepository } from "./_git.ts";

export const seedOverflowFixture = async () => {
    const workspace = await mkdtemp(join(tmpdir(), "plurnk-overflow-recovery-"));
    const answer = "CEDAR-HARBOR-27";
    const content = `Telemetry: ${"sample nominal; ".repeat(12_000)}\nRecovery site: ${answer}.\n`;
    try {
        await writeFile(join(workspace, "incident.txt"), content);
        initializeDemoRepository(workspace, "incident report");
    } catch (error) {
        await rm(workspace, { recursive: true, force: true });
        throw error;
    }
    return {
        workspace,
        answer,
        content,
        prompt: "Which recovery site is recorded in the attached incident report?",
        openPaths: ["incident.txt"],
        cleanup: () => rm(workspace, { recursive: true, force: true }),
    };
};

export const assertOverflowEvidence = async ({ db, daemon, workspaceId, workerId, turnIds, fixture }: {
    db: Db;
    daemon: Daemon;
    workspaceId: number;
    workerId: number;
    turnIds: number[];
    fixture: Awaited<ReturnType<typeof seedOverflowFixture>>;
}) => {
    const turns = await Promise.all(turnIds.map(async (id) => {
        const row = await db.test_get_turn.get<{
            id: number; loop_id: number; sequence: number; producer: string;
            kind: string; status: number; packet: string | null;
        }>({ id });
        assert.ok(row, `turn ${id} is durable`);
        return row;
    }));
    const overflow = turns.find(({ kind }) => kind === "overflow");
    assert.ok(overflow, "the specimen actually exercised overflow recovery");
    assert.equal(overflow.producer, "_plurnk");
    assert.equal(overflow.packet, null, "overflow never sent the oversized packet to inference");
    assert.equal(overflow.status, 102, "overflow made room for the successor");
    const firstModel = turns.find(({ kind }) => kind === "inference");
    assert.ok(firstModel?.packet, "a real successor request follows recovery");
    assert.ok(firstModel.sequence > overflow.sequence, "the first model call starts after the actual overflow");

    const rows = await db.test_log_entries_by_loop.all<{
        turn_id: number; sequence: number; op: string | null; scheme: string | null;
        pathname: string | null; rx: string; folded: string; status_rx: number;
    }>({ loop_id: overflow.loop_id });
    const overflowRows = rows.filter((row) => row.turn_id === overflow.id);
    const attachedRead = overflowRows.find((row) => row.op === "READ"
        && row.scheme === null && row.pathname === "incident.txt");
    assert.ok(attachedRead, `the client attachment produced an ordinary READ: ${JSON.stringify(overflowRows.map(({ op, scheme, pathname }) => ({ op, scheme, pathname })))}`);
    assert.equal(attachedRead.status_rx, 200);
    assert.equal(attachedRead.folded, "[[1,-1]]", "overflow suppresses the READ's active body");
    const original = (JSON.parse(attachedRead.rx) as { content: string }).content;
    assert.equal(original, fixture.content, "the overflowing READ receipt retains the complete source");
    const loop = await db.engine_loop_sequence.get<{ sequence: number }>({ loop_id: overflow.loop_id });
    assert.ok(loop);
    const path = `/${loop.sequence}/${overflow.sequence}/${attachedRead.sequence}/READ`;
    const recovered = await daemon.look({
        workspaceId, workerId, functionalityWorkerId: workerId,
        statement: readStmt(urlPath("log", path)),
    });
    assert.equal(recovered.status, 200, "the original READ is still addressable through the normal resolver");
    assert.equal(typeof recovered.content, "string");
    assert.ok(recovered.content === original, "reading the complete history item returns its original bytes");
    assert.equal(await readFile(join(fixture.workspace, "incident.txt"), "utf8"), fixture.content, "curation never alters the source file");

    const projected = logEntries(JSON.parse(firstModel.packet));
    const visibleRead = projected.find((row) => row.path === `log://${path}`);
    assert.ok(visibleRead, "the first recovery packet retains the READ receipt");
    assert.equal("body" in visibleRead, false, "the oversized body is absent from that packet");
    const sendRow = overflowRows.find(({ op }) => op === "SEND");
    assert.ok(sendRow, "overflow completes through an ordinary SEND");
    const send = projected.find((row) => row.path === `log:///${loop.sequence}/${overflow.sequence}/${sendRow.sequence}/SEND`);
    assert.match(String(send?.body ?? ""), /Next: YOU MUST ONLY KILL/, "the actual recovery SEND is visible to the model");
    return { overflowTurns: turns.filter(({ kind }) => kind === "overflow").length, modelTurns: turns.filter(({ kind }) => kind === "inference").length };
};
