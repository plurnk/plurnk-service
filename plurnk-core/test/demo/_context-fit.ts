// {§methods-loop-run-open-paths} {§context-fit}: client attachments are ordinary markerless READs
// dispatched before inference. Each lands whole when it fits the remaining budget and as a bodiless
// 413 receipt otherwise. Nothing overflows, nothing is withheld, no turn is manufactured.
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Daemon from "../../src/server/Daemon.ts";
import type { Db } from "../../src/core/Db.ts";
import { RESULT_EXCEEDS_BUDGET } from "../../src/core/ContextFit.ts";
import { localPath, readStmt } from "../intg/_dsl.ts";
import { logEntries, packetSection } from "../intg/_packet.ts";
import { initializeDemoRepository } from "./_git.ts";

export const seedAttachmentFixture = async () => {
    const workspace = await mkdtemp(join(tmpdir(), "plurnk-context-fit-"));
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
        telemetry,
        prompt: "Which recovery site is recorded in the attached incident report?",
        openPaths: ["incident.txt", ...otherPaths],
        cleanup: () => rm(workspace, { recursive: true, force: true }),
    };
};

export const assertContextFitEvidence = async ({ db, daemon, workspaceId, workerId, turnIds, fixture }: {
    db: Db;
    daemon: Daemon;
    workspaceId: number;
    workerId: number;
    turnIds: number[];
    fixture: Awaited<ReturnType<typeof seedAttachmentFixture>>;
}) => {
    const turns = await Promise.all(turnIds.map(async (id) => {
        const row = await db.test_get_turn.get<{
            id: number; loop_id: number; sequence: number; producer: string;
            kind: string; status: number; packet: string | null;
        }>({ id });
        assert.ok(row, `turn ${id} is durable`);
        return row;
    }));
    assert.ok(turns.every(({ kind }) => kind !== "overflow"), "no recovery turn is manufactured");
    for (const { packet } of turns) {
        if (packet === null) continue;
        assert.doesNotMatch(packetSection(JSON.parse(packet), "budget"), /WARNING|MUST/u, "the gauge carries no mandate ({§context-gauge})");
    }
    const firstModel = turns.find(({ producer, kind, packet }) => producer === "model" && kind === "inference" && packet !== null);
    assert.ok(firstModel?.packet, "the model received a request");
    const loop = await db.engine_loop_sequence.get<{ sequence: number }>({ loop_id: firstModel.loop_id });
    assert.ok(loop);

    const rows = await db.test_log_entries_by_loop.all<{
        id: number; turn_id: number; sequence: number; op: string | null; scheme: string | null; origin: string;
        pathname: string | null; rx: string; folded: string; active: number; status_rx: number;
    }>({ loop_id: firstModel.loop_id });
    const attachments = rows.filter((row) => row.op === "READ" && row.scheme === null && row.origin === "_plurnk"
        && fixture.openPaths.includes(row.pathname ?? ""));
    assert.deepEqual(attachments.map(({ pathname }) => pathname), fixture.openPaths, "every attachment produced exactly one ordinary READ row, in order");
    const landed = attachments.filter(({ status_rx }) => status_rx === 200);
    const receipts = attachments.filter(({ status_rx }) => status_rx === 413);
    assert.equal(landed.length + receipts.length, attachments.length, "each attachment either landed whole or is a receipt; nothing else");
    const projected = logEntries(JSON.parse(firstModel.packet));
    for (const row of landed) {
        const expected = row.pathname === "incident.txt" ? fixture.content : fixture.telemetry;
        assert.equal((JSON.parse(row.rx) as { content: string }).content, expected, `${row.pathname} landed whole`);
    }
    for (const row of receipts) {
        const rx = JSON.parse(row.rx) as { content: string | null; problem: { type: string; detail: string; lines: number; tokens: number; remaining: number; delivered?: number } };
        const expected = row.pathname === "incident.txt" ? fixture.content : fixture.telemetry;
        if (rx.content === null) assert.equal(rx.problem.delivered, undefined, `${row.pathname}: a receipt without a prefix delivered nothing`);
        else assert.ok((rx.problem.delivered ?? 0) > 0 && expected.startsWith(rx.content), `${row.pathname}: a receipt's body is the prefix of lines that fit`);
        assert.equal(rx.problem.type, RESULT_EXCEEDS_BUDGET);
        assert.ok(rx.problem.lines > 0 && rx.problem.tokens > rx.problem.remaining, "the receipt names the size and what remained");
        assert.match(rx.problem.detail, /READ a range, or KILL first\.$/u, "the receipt names the verbs ({§context-verbs})");
        const coordinate: string = `log:///${loop.sequence}/${firstModel.sequence}/${row.sequence}/READ`;
        const visible: Record<string, unknown> | undefined = projected.find((entry) => entry.logPath === coordinate);
        if (visible !== undefined && rx.content === null) assert.equal("body" in visible, false, "the body it could not hold is absent from the request");
    }

    const incident = attachments.find(({ pathname }) => pathname === "incident.txt")!;
    assert.ok(incident);
    const recovered = await daemon.look({ workspaceId, workerId, statement: readStmt(localPath("incident.txt"), { marks: [2] }) });
    assert.equal(recovered.status, 200, "the source stays readable by range whatever its row's fate ({§context-verbs})");
    assert.match(String(recovered.content), new RegExp(fixture.answer, "u"));
    if (incident.active === 0) {
        const effects = await db.test_log_curation_effects_by_worker.all<{
            operation_log_entry_id: number; target_log_entry_id: number;
            active_before: number; active_after: number;
        }>({ worker_id: workerId });
        const retirement = effects.find((effect) => effect.target_log_entry_id === incident.id
            && effect.active_before === 1 && effect.active_after === 0);
        assert.ok(retirement, "retirement has a durable curation effect, not missing history");
        const operation = rows.find(({ id }) => id === retirement.operation_log_entry_id);
        assert.ok(operation);
        assert.equal(operation.op, "KILL");
        assert.equal(operation.status_rx, 200, "a successful KILL accounts for the inactive projection");
    }
    assert.equal(await readFile(join(fixture.workspace, "incident.txt"), "utf8"), fixture.content, "curation never alters the source file");
    return {
        landed: landed.length,
        receipts: receipts.length,
        modelTurns: turns.filter(({ kind }) => kind === "inference").length,
        receiptActive: incident.active === 1,
    };
};
