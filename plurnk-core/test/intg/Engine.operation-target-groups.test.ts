import test from "node:test";
import assert from "node:assert/strict";
import { Mock } from "@plurnk/plurnk-providers";
import type { MockResponse } from "@plurnk/plurnk-providers";
import Engine from "../../src/core/Engine.ts";
import SchemeRegistry from "../../src/core/SchemeRegistry.ts";
import type { Db } from "../../src/core/Db.ts";
import { insertLoop, insertTurn, insertWorker, insertWorkspace, openMigrated, seedEntryWithChannel } from "./_db.ts";
import LogEntryProjection from "../../src/core/LogEntryProjection.ts";
import { DEFAULT_MIMETYPES } from "./_scheme.ts";

const response = (content: string): MockResponse => ({
    assistant: { content, reasoning: null },
});

const setup = async () => {
    const db = await openMigrated();
    const workspaceId = await insertWorkspace(db, `target-groups-${crypto.randomUUID()}`);
    const workerId = await insertWorker(db, workspaceId);
    const loopId = await insertLoop(db, workerId, 1, "exercise target groups");
    const engine = new Engine({ db, schemes: new SchemeRegistry(), mimetypes: DEFAULT_MIMETYPES });
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
        scheme: "worker",
        username: null,
        password: null,
        hostname: null,
        port: null,
        pathname: `/source-${sequence}.md`,
        query: null,
        fragment: null,
        lineMarker: null,
        tx: `\`\`\`\`READ (worker:///source-${sequence}.md)\`\`\`\``,
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
            responses: [response("\n````READ (worker:///alpha.md worker:///beta.md)````\n````NOTE\nBoth reads are pending review.\n````")],
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
            attrs: string;
            pathname: string | null;
            status_rx: number;
        }>({ turn_id: result.turnId });

        assert.deepEqual(
            rows
                .filter((row) => row.op === "READ" && !LogEntryProjection.isEmission(row))
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

test("{§safe-uri-target-groups}: one admitted scoped KILL curates every explicit URI member", async () => {
    const { db, workspaceId, workerId, loopId, engine } = await setup();
    try {
        const sourceTurnId = await insertTurn(db, loopId, 1);
        const firstId = await seedLogRead(db, workerId, loopId, sourceTurnId, 1);
        const secondId = await seedLogRead(db, workerId, loopId, sourceTurnId, 2);
        const provider = new Mock({
            contextWindow: 100_000,
            responses: [response("\n````KILL (log:///1/1/1/READ, log:///1/1/2/READ) <1,-1>````\n````NOTE\nBoth read bodies are suppressed.\n````")],
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
        assert.equal(rows.filter(({ op }) => op === "KILL").length, 2);
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
        const source = "\n````KILL (log:///1/1/99/READ,log:///1/1/1/READ log:///1/1/2/READ)````\n````NOTE\nReview the independent KILL outcomes.\n````";
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

        const programs = await db.test_turn_sources.all<{ kind: string; content: string }>({ worker_id: workerId });
        assert.ok(programs.some((row) => row.kind === "ops" && row.content === source), "the authored grouped program remains exact and unexpanded");
    } finally {
        await db.close();
    }
});

test("{§target-group} {§safe-uri-target-groups}: a KILL written one path per slot curates every member, the scope binding to its slot; the program stays as authored", async () => {
    const { db, workspaceId, workerId, loopId, engine } = await setup();
    try {
        const sourceTurnId = await insertTurn(db, loopId, 1);
        const firstId = await seedLogRead(db, workerId, loopId, sourceTurnId, 1);
        const secondId = await seedLogRead(db, workerId, loopId, sourceTurnId, 2);
        const heading = "KILL (log:///1/1/1/READ) (log:///1/1/2/READ) <1,-1>";
        const provider = new Mock({
            contextWindow: 100_000,
            responses: [response(`\n\`\`\`\`${heading}\`\`\`\`\n\`\`\`\`NOTE\nThe first is retired, the second trimmed.\n\`\`\`\``)],
        });
        const result = await engine.runTurn({ provider, workspaceId, workerId, loopId, messages: [{ role: "user", content: "Curate both reads." }] });
        const rows = await db.test_log_entries_by_loop.all<{ id: number; op: string | null; turn_id: number; status_rx: number; folded: string; active: number }>({ loop_id: loopId });
        const byId = new Map(rows.map((row) => [row.id, row]));
        assert.equal(byId.get(firstId)?.active, 0, "an unscoped member retires its row whole");
        assert.equal(byId.get(secondId)?.active, 1);
        assert.equal(byId.get(secondId)?.folded, "[[1,-1]]", "the scope binds to the slot it follows");
        assert.deepEqual(rows.filter((row) => row.turn_id === result.turnId && row.op === "KILL").map(({ status_rx }) => status_rx), [200, 200], "one row per member");
        const programs = await db.test_turn_sources.all<{ turn_id: number; kind: string; content: string }>({ worker_id: workerId });
        const ops = programs.find(({ turn_id, kind }) => turn_id === result.turnId && kind === "ops");
        assert.ok(ops !== undefined && ops.content.includes(heading), "the stored program is the authored group, unexpanded");
    } finally {
        await db.close();
    }
});

test("{§target-group} {§safe-uri-target-groups}: a READ written one path per slot lands one row per member", async () => {
    const { db, workspaceId, workerId, loopId, engine } = await setup();
    try {
        await seedEntryWithChannel(db, { workspaceId, pathname: "/alpha.md", content: "alpha" });
        await seedEntryWithChannel(db, { workspaceId, pathname: "/beta.md", content: "beta" });
        const provider = new Mock({
            contextWindow: 100_000,
            responses: [response("\n````READ (worker:///alpha.md) (worker:///beta.md)````\n````NOTE\nBoth reads are pending review.\n````")],
        });
        const result = await engine.runTurn({ provider, workspaceId, workerId, loopId, messages: [{ role: "user", content: "Read both resources." }] });
        const rows = await db.test_log_entries_by_turn.all<{ op: string | null; attrs: string; pathname: string | null; status_rx: number }>({ turn_id: result.turnId });
        assert.deepEqual(
            rows.filter((row) => row.op === "READ" && !LogEntryProjection.isEmission(row)).map(({ pathname, status_rx }) => ({ pathname, status: status_rx })),
            [{ pathname: "/alpha.md", status: 200 }, { pathname: "/beta.md", status: 200 }],
        );
    } finally {
        await db.close();
    }
});

test("{§target-group}: READ keeps each scope and local matcher while applying the heading default to other members", async () => {
    const { db, workspaceId, workerId, loopId, engine } = await setup();
    try {
        const content = "outside\nlocal\nshared\nlocal\nshared\noutside";
        await seedEntryWithChannel(db, { workspaceId, pathname: "/alpha.md", content });
        await seedEntryWithChannel(db, { workspaceId, pathname: "/beta.md", content });
        const source = '```READ (worker:///alpha.md) <2,3> [{"pattern":"/local/"}] (worker:///beta.md) <3,4> /shared/\n```';
        const provider = new Mock({ contextWindow: 100_000, responses: [response(source)] });
        const result = await engine.runTurn({ provider, workspaceId, workerId, loopId, messages: [{ role: "user", content: "Read the selected lines." }] });
        const rows = await db.test_log_entries_by_turn.all<{ op: string | null; attrs: string; pathname: string; rx: string; status_rx: number }>({ turn_id: result.turnId });
        const reads = rows.filter((row) => row.op === "READ" && !LogEntryProjection.isEmission(row));
        assert.deepEqual(reads.map(({ pathname, status_rx, rx }) => [pathname, status_rx, JSON.parse(rx).content]),
            [["/alpha.md", 200, "local\n"], ["/beta.md", 200, "shared\n"]]);
        assert.deepEqual(reads.map(({ rx }) => JSON.parse(rx).lineOrdinals), [[2], [3]]);
    } finally { await db.close(); }
});

test("{§trailing-slots}: an ambiguous grouped KILL changes no member, while its sibling NOTE still executes", async () => {
    const { db, workspaceId, workerId, loopId, engine } = await setup();
    try {
        const sourceTurnId = await insertTurn(db, loopId, 1);
        const ids = [await seedLogRead(db, workerId, loopId, sourceTurnId, 1), await seedLogRead(db, workerId, loopId, sourceTurnId, 2)];
        const source = '```KILL (log:///1/1/1/READ) (log:///1/1/2/READ) /source/ <1,3>\n```\n\n```NOTE\nsibling retained\n```';
        const provider = new Mock({ contextWindow: 100_000, responses: [response(source)] });
        const result = await engine.runTurn({ provider, workspaceId, workerId, loopId, messages: [{ role: "user", content: "Curate selected lines." }] });
        const originals = await db.test_log_entries_by_turn.all<{ id: number; active: number; folded: string }>({ turn_id: sourceTurnId });
        assert.deepEqual(originals.filter(({ id }) => ids.includes(id)).map(({ id, active, folded }) => [id, active, folded]),
            ids.map((id) => [id, 1, "[]"]));
        const rows = await db.test_log_entries_by_turn.all<{ op: string | null; status_rx: number; rx: string }>({ turn_id: result.turnId });
        assert.equal(rows.some(({ op }) => op === "KILL"), false);
        assert.ok(rows.some(({ op, status_rx }) => op === "NOTE" && status_rx === 200));
        assert.ok(rows.some(({ status_rx, rx }) => status_rx >= 400 && rx.includes("The scope `<1,3>` follows the shared pattern of a target group.")));
    } finally { await db.close(); }
});

for (const limit of [0, 1, 2]) {
    test(`{§operator-config-workspace-max-commands-floor} {§target-group}: limit ${limit} counts compiled targets, not headings`, async () => {
        const original = process.env.PLURNK_SERVICE_MAX_COMMANDS;
        process.env.PLURNK_SERVICE_MAX_COMMANDS = limit === 0 ? "-1" : String(limit);
        const { db, workspaceId, workerId, loopId, engine } = await setup();
        try {
            if (limit === 0) await db.test_set_workspace_settings.run({ id: workspaceId, settings: JSON.stringify({ maxCommands: 0 }) });
            await seedEntryWithChannel(db, { workspaceId, pathname: "/alpha.md", content: "alpha" });
            await seedEntryWithChannel(db, { workspaceId, pathname: "/beta.md", content: "beta" });
            const source = "```READ (worker:///alpha.md) (worker:///beta.md)\n```\n\n```NOTE\nafter the group\n```\n\n```KILL\n```";
            const provider = new Mock({ contextWindow: 100_000, responses: [response(source)] });
            const result = await engine.runTurn({ provider, workspaceId, workerId, loopId, messages: [{ role: "user", content: "Read both resources." }] });
            const rows = await db.test_log_entries_by_turn.all<{ op: string | null; attrs: string; pathname: string; rx: string; status_rx: number }>({ turn_id: result.turnId });
            const reads = rows.filter((row) => row.op === "READ" && !LogEntryProjection.isEmission(row));
            assert.deepEqual(reads.map(({ pathname, status_rx }) => [pathname, status_rx]),
                [["/alpha.md", 200], ["/beta.md", 200]].slice(0, limit));
            assert.equal(rows.some(({ op }) => op === "NOTE"), false);
            assert.ok(rows.some(({ op }) => op === "KILL"), "lifecycle intent is never silently dropped by the action cap");
            const error = rows.map(({ rx }) => JSON.parse(rx)).find((rx) => rx.problem?.type.endsWith("max-commands-exceeded"));
            assert.ok(error !== undefined, "omitted operations have the ordinary durable limit notice");
            assert.equal(error.problem.omittedOperations, 3 - limit);
            assert.notEqual(result.status, 200, "dropped work cannot be reported as completed");
        } finally {
            await db.close();
            if (original === undefined) delete process.env.PLURNK_SERVICE_MAX_COMMANDS;
            else process.env.PLURNK_SERVICE_MAX_COMMANDS = original;
        }
    });
}
