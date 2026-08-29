import test from "node:test";
import assert from "node:assert/strict";
import { Mock } from "@plurnk/plurnk-providers";
import type { MockResponse } from "@plurnk/plurnk-providers";
import Engine from "../../src/core/Engine.ts";
import SchemeRegistry from "../../src/core/SchemeRegistry.ts";
import type { Db } from "../../src/core/Db.ts";
import {
    insertLoop,
    insertTurn,
    insertWorker,
    insertWorkspace,
    openMigrated,
    seedEntryWithChannel,
} from "./_helpers.ts";

const response = (content: string): MockResponse => ({
    assistant: { content, reasoning: null },
});

const setup = async () => {
    const db = await openMigrated();
    const workspaceId = await insertWorkspace(db, `target-groups-${crypto.randomUUID()}`);
    const workerId = await insertWorker(db, workspaceId);
    const loopId = await insertLoop(db, workerId, 1, "exercise target groups");
    const engine = new Engine({ db, schemes: new SchemeRegistry() });
    return { db, workspaceId, workerId, loopId, engine };
};

const seedLogRead = async (
    db: Db,
    workerId: number,
    loopId: number,
    turnId: number,
    sequence: number,
): Promise<number> => {
    const row = await db.engine_insert_log_entry.get<{ id: number }>({
        worker_id: workerId,
        loop_id: loopId,
        turn_id: turnId,
        sequence,
        origin: "model",
        source: null,
        model_call_id: null,
        op: "READ",
        delimiter: "",
        signal: null,
        scheme: "worker",
        username: null,
        password: null,
        hostname: null,
        port: null,
        pathname: `/source-${sequence}.md`,
        query: null,
        fragment: null,
        lineMarker: null,
        tx: `## READ0 (worker:///source-${sequence}.md)`,
        mimetype_tx: "text/vnd.plurnk",
        rx: JSON.stringify({
            status: 200,
            content: `line from source ${sequence}`,
            mimetype: "text/plain",
            startLine: 1,
        }),
        mimetype_rx: "application/json",
        status_rx: 200,
        weight: 1,
        state: "resolved",
        outcome: null,
        attrs: "{}",
    });
    if (row === undefined) throw new Error("READ fixture insert returned no row");
    return row.id;
};

test("{§safe-uri-target-groups}: one admitted READ dispatches every explicit URI member", async () => {
    const { db, workspaceId, workerId, loopId, engine } = await setup();
    try {
        await seedEntryWithChannel(db, {
            workspaceId,
            pathname: "/alpha.md",
            content: "alpha",
        });
        await seedEntryWithChannel(db, {
            workspaceId,
            pathname: "/beta.md",
            content: "beta",
        });
        const provider = new Mock({
            contextWindow: 100_000,
            responses: [response([
                "# PLAN0",
                "Read both resources.",
                "",
                "## READ0 (worker:///alpha.md worker:///beta.md)",
                "",
                "## SEND0 [102]",
                "Both reads are pending review.",
            ].join("\n"))],
        });

        const result = await engine.runTurn({
            provider,
            workspaceId,
            workerId,
            loopId,
            messages: [{ role: "user", content: "Read both resources." }],
        });
        const rows = await db.test_log_entries_by_turn.all<{
            op: string | null;
            pathname: string | null;
            status_rx: number;
        }>({ turn_id: result.turnId });

        assert.deepEqual(
            rows
                .filter(({ op }) => op === "READ")
                .map(({ pathname, status_rx }) => ({ pathname, status: status_rx })),
            [
                { pathname: "/alpha.md", status: 200 },
                { pathname: "/beta.md", status: 200 },
            ],
        );
    } finally {
        await db.close();
    }
});

test("{§safe-uri-target-groups}: one admitted FOLD curates every explicit URI member", async () => {
    const { db, workspaceId, workerId, loopId, engine } = await setup();
    try {
        const sourceTurnId = await insertTurn(db, loopId, 1);
        const firstId = await seedLogRead(db, workerId, loopId, sourceTurnId, 1);
        const secondId = await seedLogRead(db, workerId, loopId, sourceTurnId, 2);
        const provider = new Mock({
            contextWindow: 100_000,
            responses: [response([
                "# PLAN0",
                "Curate both completed reads.",
                "",
                "## FOLD0 (log:///1/1/1/READ, log:///1/1/2/READ)",
                "",
                "## SEND0 [102]",
                "Both reads are folded.",
            ].join("\n"))],
        });

        const result = await engine.runTurn({
            provider,
            workspaceId,
            workerId,
            loopId,
            messages: [{ role: "user", content: "Curate both reads." }],
        });
        const rendered = await db.engine_render_log.all<{ id: number; folded: string }>({
            worker_id: workerId,
        });
        const foldedById = new Map(rendered.map(({ id, folded }) => [id, folded]));
        const rows = await db.test_log_entries_by_turn.all<{ op: string | null }>({
            turn_id: result.turnId,
        });

        assert.equal(foldedById.get(firstId), "[[1,-1]]");
        assert.equal(foldedById.get(secondId), "[[1,-1]]");
        assert.equal(rows.filter(({ op }) => op === "FOLD").length, 2);
    } finally {
        await db.close();
    }
});

test("{§safe-uri-target-groups}: one admitted KILL dispatches every explicit URI member independently", async () => {
    const { db, workspaceId, workerId, loopId, engine } = await setup();
    try {
        const sourceTurnId = await insertTurn(db, loopId, 1);
        const firstId = await seedLogRead(db, workerId, loopId, sourceTurnId, 1);
        const secondId = await seedLogRead(db, workerId, loopId, sourceTurnId, 2);
        const source = [
            "# PLAN0",
            "Retire the selected history.",
            "",
            "## KILL0 (log:///1/1/99/READ,log:///1/1/1/READ log:///1/1/2/READ)",
            "",
            "## SEND0 [102]",
            "Review the independent KILL outcomes.",
        ].join("\n");
        const provider = new Mock({
            contextWindow: 100_000,
            responses: [response(source)],
        });

        const result = await engine.runTurn({
            provider,
            workspaceId,
            workerId,
            loopId,
            messages: [{ role: "user", content: "Retire the selected history." }],
        });
        const rows = await db.test_log_entries_by_turn.all<{
            id: number;
            op: string | null;
            pathname: string | null;
            status_rx: number;
            attrs: string;
            rx: string;
        }>({ turn_id: result.turnId });
        const kills = rows.filter(({ op }) => op === "KILL");
        assert.deepEqual(
            kills.map(({ pathname, status_rx }) => ({ pathname, status: status_rx })),
            [
                { pathname: "/1/1/99/READ", status: 404 },
                { pathname: "/1/1/1/READ", status: 200 },
                { pathname: "/1/1/2/READ", status: 200 },
            ],
            "one failed member does not hide either later successful KILL",
        );

        const sources = await db.test_log_entries_by_turn.all<{ id: number; active: number }>({
            turn_id: sourceTurnId,
        });
        assert.deepEqual(
            sources.map(({ id, active }) => ({ id, active })),
            [
                { id: firstId, active: 0 },
                { id: secondId, active: 0 },
            ],
            "both durable source events leave only the active projection",
        );

        const effects = (await db.test_log_curation_effects_by_worker.all<{
            operation_log_entry_id: number;
            target_log_entry_id: number;
            active_before: number;
            active_after: number;
            op: string;
        }>({ worker_id: workerId })).filter(({ op }) => op === "KILL");
        assert.deepEqual(
            effects.map(({ operation_log_entry_id, target_log_entry_id, active_before, active_after }) => ({
                operation_log_entry_id,
                target_log_entry_id,
                active_before,
                active_after,
            })),
            [
                { operation_log_entry_id: kills[1]!.id, target_log_entry_id: firstId, active_before: 1, active_after: 0 },
                { operation_log_entry_id: kills[2]!.id, target_log_entry_id: secondId, active_before: 1, active_after: 0 },
            ],
            "each successful member owns its exact append-only curation effect",
        );

        const turnOps = rows.find(({ op, attrs }) => op === null && JSON.parse(attrs).kind === "turnOps");
        assert.equal((JSON.parse(turnOps?.rx ?? "null") as { content?: string }).content, source, "the authored grouped program remains exact and unexpanded");
    } finally {
        await db.close();
    }
});
