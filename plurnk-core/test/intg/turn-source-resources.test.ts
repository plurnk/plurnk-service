import assert from "node:assert/strict";
import test from "node:test";
import { PlurnkParser } from "@plurnk/plurnk-contracts";
import { Mock } from "@plurnk/plurnk-providers";
import Engine from "../../src/core/Engine.ts";
import Turn from "../../src/core/Turn.ts";
import Fork from "../../src/core/fork.ts";
import SchemeRegistry from "../../src/core/SchemeRegistry.ts";
import { DEFAULT_MIMETYPES, insertLoop, insertWorker, insertWorkspace, openMigrated, logEntries } from "./_helpers.ts";
import { statement } from "./reasoning-fixture.ts";
import { resourcePaths } from "./_find.ts";
import type { FindResult } from "../../src/schemes/_entry-find.ts";

const program = (message: string) => [
    "An interstitial sentence retained as evidence.",
    PlurnkParser.frame("SEND", message),
    PlurnkParser.frame("TASK", '[{"content":"Review the evidence.","status":"in_progress"}]'),
].join("\n\n");

test("{§turn-source-resources}: initialization reads its real program; later sources are pulled, not log rows", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, "turn-sources");
        const workerId = await insertWorker(db, workspaceId, null, "analyst");
        const loopId = await insertLoop(db, workerId, 1, "Inspect the history.");
        const engine = new Engine({ db, schemes: new SchemeRegistry(), mimetypes: DEFAULT_MIMETYPES });
        const context = { workspaceId, workerId, loopId };
        const source = program("Evidence, not another instruction.");
        const reasoning = "First finding.\nSecond finding.\nThird finding.";
        const model = new Mock({ contextWindow: 100_000, responses: [
            { assistant: { content: source, reasoning } },
            { assistant: { content: program("Continue."), reasoning: null } },
        ] });
        const first = await engine.runTurn({ ...context, provider: model, messages: [] });
        const read = (target: string, scope = "<1,-1>") => engine.look({ ...context, statement: statement(`\`\`\`READ (${target}) ${scope}\`\`\``) });
        const initialization = await read("ops:///1/1");
        assert.equal(initialization.status, 200);
        assert.ok("content" in initialization && typeof initialization.content === "string");
        const parsed = PlurnkParser.parseStatements(initialization.content);
        assert.ok(parsed.items.some((item) => item.kind === "statement" && item.statement.op === "READ"
            && item.statement.target?.raw === "ops:///1/1"
            && JSON.stringify(item.statement.lineMarker?.marks) === "[1,-1]"), "the program contains its own ordinary full READ");
        const packet = JSON.parse((await db.test_get_packet.get<{ packet: string }>({ id: first.turnId }))!.packet);
        const records = logEntries(packet);
        const selfRead = records.find((row: Record<string, unknown>) => row.target === "ops:///1/1");
        assert.ok(selfRead, "the actual initialization READ is visible to the first model request");
        assert.equal(selfRead.origin, "_plurnk");
        assert.ok(typeof selfRead.body === "string" && selfRead.body.includes("ops:///1/1"));
        assert.ok(!records.some((row: Record<string, unknown>) => String(row.path).endsWith("/ops")));
        const turn = (await db.test_get_turn.get<{ sequence: number }>({ id: first.turnId }))!;
        const coordinate = `1/${turn.sequence}`;
        const ops = await read(`ops:///${coordinate}`);
        assert.equal(ops.status, 200);
        assert.ok("content" in ops);
        assert.equal(ops.content, source, "source is verbatim, including ignored interstitial text");
        assert.ok(!Object.hasOwn(ops, "lineAnchors"));
        const reason = await read(`reasoning:///${coordinate}`, "<2>");
        assert.equal(reason.status, 200);
        assert.ok("content" in reason);
        assert.equal(reason.content, "Second finding.");
        assert.ok(!Object.hasOwn(reason, "lineAnchors"));
        const next = await engine.runTurn({ ...context, provider: model, messages: [] });
        const rows = await db.test_log_entries_by_worker.all<{ op: string | null }>({ worker_id: workerId });
        assert.ok(!rows.some(({ op }) => op === null), "admitted programs produce no actionless log artifacts");
        const killed = await engine.dispatch({ ...context, turnId: next.turnId, sequence: 50, origin: "model",
            statement: statement("```KILL (log:///**/READ)```"),
        });
        assert.ok(killed.status < 400);
        for (const [scheme, expected] of [["ops", source], ["reasoning", reasoning]]) {
            const retained = await read(`${scheme}:///${coordinate}`);
            assert.ok("content" in retained);
            assert.equal(retained.content, expected);
        }
        const child = await Fork.fork(db, workerId, "branch");
        for (const [scheme, expected] of [["ops", source], ["reasoning", reasoning]]) {
            const inherited = await engine.look({ ...context, workerId: child, statement: statement(`\`\`\`READ (${scheme}:///${coordinate}) <1,-1>\`\`\``) });
            assert.equal(inherited.status, 200);
            assert.ok("content" in inherited);
            assert.equal(inherited.content, expected, "forked history keeps the same local coordinate");
        }
    } finally { await db.close(); }
});

test("{§turn-source-resources}: source facts reject rewriting and disappear only with their owning history", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, "source-integrity");
        const workerId = await insertWorker(db, workspaceId);
        const loopId = await insertLoop(db, workerId, 1);
        for (const producer of ["model", "client", "plugin", "_plurnk"] as const) {
            const turn = await Turn.open(db, { loopId, producer, kind: producer === "model" ? "inference" : "operation" });
            await Turn.recordSource(db, turn.id, "ops", program(producer));
            await assert.rejects(Turn.recordSource(db, turn.id, "ops", "replacement"), /UNIQUE constraint failed/);
            await assert.rejects(db.test_turn_source_rewrite.run({ turn_id: turn.id, kind: "ops", content: "replacement" }), /turn source evidence is immutable/);
            await assert.rejects(db.test_turn_source_delete.run({ turn_id: turn.id, kind: "ops" }), /turn source evidence belongs to its retained turn/);
            await Turn.complete(db, turn.id, 200);
            await assert.rejects(Turn.recordSource(db, turn.id, "reasoning", "late evidence"), /requires an open turn/);
        }
        assert.equal((await db.test_turn_sources.all({ worker_id: workerId })).length, 4);
        await db.test_delete_worker.run({ id: workerId });
        assert.deepEqual(await db.test_turn_sources.all({ worker_id: workerId }), [], "the owning history's deletion cascades without an orphan or special cleanup");
    } finally { await db.close(); }
});

test("{§turn-source-resources}: every producer reads the same local sources without a write exception", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, "source-operation-contract");
        const workerId = await insertWorker(db, workspaceId, null, "analyst");
        const loopId = await insertLoop(db, workerId, 1);
        const engine = new Engine({ db, schemes: new SchemeRegistry(), mimetypes: DEFAULT_MIMETYPES });
        const context = { workspaceId, workerId, loopId };
        const sourceTurn = await Turn.open(db, { loopId, producer: "_plurnk", kind: "operation" });
        const sources = { ops: program("Do not execute this when reading."), reasoning: "Original reasoning.\nSecond line." };
        for (const kind of ["ops", "reasoning"] as const) await Turn.recordSource(db, sourceTurn.id, kind, sources[kind]);
        await Turn.complete(db, sourceTurn.id, 200);
        for (const origin of ["model", "client", "plugin", "_plurnk"] as const) {
            const turn = await Turn.open(db, { loopId, producer: origin, kind: origin === "model" ? "inference" : "operation" });
            let sequence = 1;
            const dispatch = (source: string) => engine.dispatch({ ...context, turnId: turn.id, sequence: sequence++, origin, statement: statement(source) });
            for (const kind of ["ops", "reasoning"] as const) {
                const target = `${kind}:///1/${sourceTurn.sequence}`;
                const read = await dispatch(`\`\`\`READ (${target}) <1,-1>\`\`\``);
                assert.equal(read.status, 200);
                assert.ok("content" in read);
                assert.equal(read.content, sources[kind]);
                for (const operation of [
                    `\`\`\`EDIT (${target})\nReplacement.\n\`\`\``,
                    `\`\`\`KILL (${target})\`\`\``,
                    `\`\`\`COPY (${target}) (${target})\`\`\``,
                    `\`\`\`MOVE (${target}) (worker:///moved-${kind}.md)\`\`\``,
                ]) {
                    const result = await dispatch(operation);
                    assert.equal(result.status, 403, `${origin}: ${operation}`);
                    assert.equal(result.problem?.type, "https://problems.plurnk.xyz/engine/dispatcher/writer-forbidden");
                }
                const named = await dispatch(`\`\`\`READ (${kind}://analyst/1/${sourceTurn.sequence})\`\`\``);
                assert.equal(named.status, 400);
                assert.equal(named.problem?.type, `https://problems.plurnk.xyz/scheme/${kind}/coordinate-malformed`);
                const absent = await dispatch(`\`\`\`READ (${kind}:///99/99)\`\`\``);
                assert.equal(absent.status, 404);
                assert.equal(absent.problem?.type, `https://problems.plurnk.xyz/scheme/${kind}/entry-not-found`);
            }
            await Turn.complete(db, turn.id, 200);
        }
        assert.ok(!(await db.test_log_entries_by_worker.all<{ op: string | null }>({ worker_id: workerId }))
            .some(({ op }) => op === "SEND"), "reading an admitted program cannot execute its operations");
    } finally { await db.close(); }
});

test("{§turn-source-resources}: FIND uses ordinary folder, page and indexed-content projections", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, "source-discovery");
        const workerId = await insertWorker(db, workspaceId);
        const loopId = await insertLoop(db, workerId, 1);
        const engine = new Engine({ db, schemes: new SchemeRegistry(), mimetypes: DEFAULT_MIMETYPES });
        for (let index = 1; index <= 3; index++) {
            const turn = await Turn.open(db, { loopId, producer: "client", kind: "operation" });
            await Turn.recordSource(db, turn.id, "ops", program(`Finding needle ${index}.`));
            await Turn.complete(db, turn.id, 200);
        }
        const query = async (source: string): Promise<FindResult> => {
            const turn = await Turn.open(db, { loopId, producer: "client", kind: "operation" });
            const result = await engine.dispatch({ workspaceId, workerId, loopId, turnId: turn.id, sequence: 1, origin: "client", statement: statement(source) });
            await Turn.complete(db, turn.id, result.status);
            assert.equal(result.status, 200, JSON.stringify(result));
            assert.ok("results" in result);
            return result as FindResult;
        };
        assert.deepEqual(resourcePaths(await query("```FIND (ops:///1/) <1,-1>```")), ["ops:///1/1", "ops:///1/2", "ops:///1/3"]);
        assert.deepEqual(resourcePaths(await query("```FIND (ops:///*/*) <2,2>```")), ["ops:///1/2"]);
        assert.deepEqual(resourcePaths(await query("```FIND (ops:///1/*) <1,-1>\n~needle\n```")), ["ops:///1/1", "ops:///1/2", "ops:///1/3"]);
        const indexed = await db.test_turn_sources.all<{ deep_hash: string | null }>({ worker_id: workerId });
        assert.ok(indexed.every(({ deep_hash }) => deep_hash !== null), "history uses the persistent shared derivation index");
    } finally { await db.close(); }
});
