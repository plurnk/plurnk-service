// {§methods-loop-run-open-paths} {§context-output-admission}: individually bounded attachment
// READs jointly exceed input capacity before model inference.
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Daemon from "../../src/server/Daemon.ts";
import type { Db } from "../../src/core/Db.ts";
import { readStmt, urlPath } from "../intg/_dsl.ts";
import { logEntries, packetSection } from "../intg/_helpers.ts";
import { initializeDemoRepository } from "./_git.ts";

export const seedOverflowFixture = async () => {
    const workspace = await mkdtemp(join(tmpdir(), "plurnk-overflow-recovery-"));
    const answer = "CEDAR-HARBOR-27";
    const telemetry = `Telemetry: ${"sample nominal; ".repeat(150)}\n`;
    const content = `${telemetry}Recovery site: ${answer}.\n`;
    const otherPaths = Array.from({ length: 15 }, (_, index) => `telemetry-${index + 1}.txt`);
    try {
        await writeFile(join(workspace, "incident.txt"), content);
        await Promise.all(otherPaths.map((path) => writeFile(join(workspace, path), telemetry)));
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
        openPaths: ["incident.txt", ...otherPaths],
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
    const overflowRequests = turns.filter(({ packet }) => packet !== null
        && packetSection(JSON.parse(packet), "budget").includes("> YOU MUST ONLY KILL"));
    const firstModel = overflowRequests[0];
    assert.ok(firstModel?.packet, "the specimen actually delivered an overflow-withheld request");
    assert.equal(firstModel.producer, "model");
    assert.equal(firstModel.kind, "inference");
    assert.ok(turns.every(({ kind }) => kind !== "overflow"), "no recovery turn is manufactured");

    const rows = await db.test_log_entries_by_loop.all<{
        id: number; turn_id: number; sequence: number; op: string | null; scheme: string | null;
        pathname: string | null; rx: string; folded: string; active: number; status_rx: number;
    }>({ loop_id: firstModel.loop_id });
    const overflowRows = rows.filter((row) => row.turn_id === firstModel.id);
    const attachedRead = overflowRows.find((row) => row.op === "READ"
        && row.scheme === null && row.pathname === "incident.txt");
    assert.ok(attachedRead, `the client attachment produced an ordinary READ: ${JSON.stringify(overflowRows.map(({ op, scheme, pathname }) => ({ op, scheme, pathname })))}`);
    assert.equal(attachedRead.status_rx, 200);
    const original = (JSON.parse(attachedRead.rx) as { content: string }).content;
    assert.equal(original, fixture.content, "the overflowing READ receipt retains the complete source");
    const loop = await db.engine_loop_sequence.get<{ sequence: number }>({ loop_id: firstModel.loop_id });
    assert.ok(loop);
    const path = `/${loop.sequence}/${firstModel.sequence}/${attachedRead.sequence}/READ`;
    const recovered = await daemon.look({
        workspaceId, workerId, statement: readStmt(urlPath("log", path), { marks: [1, -1] }),
    });
    if (attachedRead.active === 1) {
        if (attachedRead.folded === "[]") {
            assert.equal(recovered.status, 200, "withheld output remains READable at its log address");
            assert.equal(recovered.content, fixture.content.replace(/\n$/u, ""), "the addressed line selection retains every source line");
        } else {
            const effects = await db.test_log_curation_effects_by_worker.all<{ target_log_entry_id: number; operation_log_entry_id: number }>({ worker_id: workerId });
            assert.ok(effects.some((effect) => effect.target_log_entry_id === attachedRead.id
                && rows.some((row) => row.id === effect.operation_log_entry_id && row.op === "KILL")), "only an actual KILL can account for later readable-body trimming");
        }
    } else {
        assert.equal(attachedRead.active, 0);
        const effects = await db.test_log_curation_effects_by_worker.all<{
            operation_log_entry_id: number; target_log_entry_id: number;
            active_before: number; active_after: number;
        }>({ worker_id: workerId });
        const retirement = effects.find((effect) => effect.target_log_entry_id === attachedRead.id
            && effect.active_before === 1 && effect.active_after === 0);
        assert.ok(retirement, "retirement has a durable curation effect, not missing history");
        const operation = rows.find(({ id }) => id === retirement.operation_log_entry_id);
        assert.ok(operation);
        assert.equal(operation.op, "KILL");
        assert.equal(operation.status_rx, 200, "a successful KILL accounts for the inactive projection");
        assert.ok(turns.some(({ id, sequence }) => id === operation.turn_id && sequence >= firstModel.sequence),
            "the receipt was retired after the recovery packet reached the model");
        assert.equal(recovered.status, 404, "retired history is absent from the active log resolver");
        assert.ok(recovered.problem && typeof recovered.problem === "object" && "type" in recovered.problem);
        assert.equal(recovered.problem.type, "https://problems.plurnk.xyz/scheme/log/entry-not-found");
    }
    assert.equal(await readFile(join(fixture.workspace, "incident.txt"), "utf8"), fixture.content, "curation never alters the source file");

    const projected = logEntries(JSON.parse(firstModel.packet));
    const visibleRead = projected.find((row) => row.path === `log://${path}`);
    assert.ok(visibleRead, "the first recovery packet retains the READ receipt");
    assert.equal("body" in visibleRead, false, "the oversized body is absent from that packet");
    assert.equal(visibleRead.overflow, "2 output lines not shown; logTokensTotal exceeds logTokensMax");
    assert.match(packetSection(JSON.parse(firstModel.packet), "budget"), /> \[!WARNING\]\n> YOU MUST ONLY KILL/u);
    assert.ok(!projected.some((row) => String(row.path).endsWith("/TASK") && String(row.body).includes("YOU MUST ONLY")), "the warning is not an invented assignment");
    return {
        overflowRequests: overflowRequests.length,
        modelTurns: turns.filter(({ kind }) => kind === "inference").length,
        receiptActive: attachedRead.active === 1,
    };
};
