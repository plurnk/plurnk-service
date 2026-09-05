import assert from "node:assert/strict";
import test from "node:test";
import { Mock } from "@plurnk/plurnk-providers";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Translator } from "@plurnk/plurnk-agui";
import Engine from "../../src/core/Engine.ts";
import SchemeRegistry from "../../src/core/SchemeRegistry.ts";
import Fork from "../../src/core/fork.ts";
import Digest from "../../src/digest/Digest.ts";
import LogEntry from "../../src/server/logEntry.ts";
import { DEFAULT_MIMETYPES, insertLoop, insertWorker, insertWorkspace, openMigrated } from "./_helpers.ts";
import { parseLogRecords } from "../LogRecords.ts";
import { statement, original, provider, type Resource, type Read } from "./reasoning-fixture.ts";

test("{§reasoning-history}: source EDIT and receipt KILL keep ordinary resource/history semantics", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, "reasoning-resources");
        const workerId = await insertWorker(db, workspaceId);
        const loopId = await insertLoop(db, workerId, 1);
        const engine = new Engine({ db, schemes: new SchemeRegistry(), mimetypes: DEFAULT_MIMETYPES });
        const context = { workspaceId, workerId, loopId };
        const first = await engine.runTurn({ ...context, provider: provider(original), messages: [] });
        const resources = await db.test_reasoning_resources.all<Resource>({ worker_id: workerId });
        const turn = await db.test_get_turn.get<{ sequence: number }>({ id: first.turnId });
        assert.deepEqual(resources, [{ pathname: `/1/${turn!.sequence}/1`, content: original }]);
        const target = `reasoning://${resources[0]!.pathname}`;
        const next = await engine.runTurn({ ...context, provider: provider(), messages: [] });
        const reads = await db.test_reasoning_reads.all<Read>({ worker_id: workerId });
        assert.equal(reads.length, 1);
        const read = reads[0]!;
        assert.equal(read.origin, "_plurnk");
        assert.deepEqual(JSON.parse(read.lineMarker), { marks: [1, -1] });
        const result = JSON.parse(read.rx) as { content: string; lineAnchors: string[] };
        assert.equal(result.content, original);
        assert.equal(result.lineAnchors.length, 30);
        const receipt = `log:///${read.loop_seq}/${read.turn_seq}/${read.sequence}/READ`;
        let sequence = 50;
        const dispatch = (source: string) => engine.dispatch({ ...context, statement: statement(source), turnId: next.turnId, sequence: sequence++, origin: "model" });
        assert.equal((await dispatch(`### EDIT0 (${target}) <${result.lineAnchors[0]}>\nRetained determination.`)).status, 200);
        assert.equal((await dispatch(`### EDIT0 (${target}) <${result.lineAnchors[0]}>\nStale overwrite.`)).status, 409);
        assert.equal((await dispatch(`### KILL0 (${receipt}) <17,-1>`)).status, 200);
        const revised = await engine.look({ ...context, statement: statement(`### READ0 (${target}) <1,-1>`) });
        assert.ok("content" in revised && typeof revised.content === "string");
        assert.match(revised.content, /^Retained determination\./);
        const history = await engine.look({ ...context, statement: statement(`### READ0 (${receipt}) <1,-1>`) });
        assert.ok("content" in history);
        assert.equal(history.content, original, "editing the source cannot rewrite its receipt");
        assert.equal((await dispatch(`### KILL0 (${receipt})`)).status, 200);
        assert.equal((await engine.look({ ...context, statement: statement(`### READ0 (${target}) <1,-1>`) })).status, 200);
        assert.equal((await dispatch(`### KILL0 (${target})`)).status, 200);
        assert.equal((await engine.look({ ...context, statement: statement(`### READ0 (${target})`) })).status, 404);
        const packet = await db.test_get_packet.get<{ packet: string }>({ id: first.turnId });
        assert.equal(JSON.parse(packet!.packet).assistant.reasoning, original);
    } finally { await db.close(); }
});

for (const limit of [-1, 0, 8]) test(`{§reasoning-initial-read}: configured ${limit} controls feedback, not source retention`, async () => {
    const prior = process.env.PLURNK_REASONING_VIEW_LINES;
    process.env.PLURNK_REASONING_VIEW_LINES = String(limit);
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `reasoning-limit-${limit}`);
        const workerId = await insertWorker(db, workspaceId);
        const loopId = await insertLoop(db, workerId, 1);
        const engine = new Engine({ db, schemes: new SchemeRegistry(), mimetypes: DEFAULT_MIMETYPES });
        const context = { workspaceId, workerId, loopId };
        await engine.runTurn({ ...context, provider: provider(original), messages: [] });
        const next = await engine.runTurn({ ...context, provider: provider(), messages: [] });
        assert.equal((await db.test_reasoning_resources.all<Resource>({ worker_id: workerId }))[0]?.content, original);
        const reads = await db.test_reasoning_reads.all<Read>({ worker_id: workerId });
        assert.equal(reads.length, limit === 0 ? 0 : 1);
        if (limit === 0) {
            const resource = (await db.test_reasoning_resources.all<Resource>({ worker_id: workerId }))[0]!;
            const explicit = await engine.dispatch({ ...context, turnId: next.turnId, sequence: 80, origin: "model",
                statement: statement(`### READ0 (reasoning://${resource.pathname}) <17,30>`),
            });
            assert.equal(explicit.status, 200);
            assert.ok("content" in explicit);
            assert.equal(explicit.content, original.split("\n").slice(16).join("\n"), "opting out of automatic feedback does not restrict explicit READs");
        }
        if (limit !== 0) {
            assert.deepEqual(JSON.parse(reads[0]!.lineMarker), { marks: [1, limit] });
            const packet = JSON.parse((await db.test_get_packet.get<{ packet: string }>({ id: next.turnId }))!.packet);
            const log = packet.sections.find(({ name }: { name: string }) => name === "log").content;
            assert.match(log, /^### log:\/\/\/\d+\/\d+\/\d+\/READ\n\{"target":"reasoning:\/\/\//m, "{§log-wire-format} the assembled reasoning receipt leads with its source target");
            const record = parseLogRecords(log).find(({ path }) => typeof path === "string" && path.endsWith(`/${reads[0]!.sequence}/READ`));
            assert.ok(record);
            assert.match(String(record.body), /1:Finding 1:/);
            if (limit === 8) {
                assert.doesNotMatch(String(record.body), /9:Finding 9:/);
                assert.deepEqual(record.range, { unit: "line", total: 30, requested: [1, 8], returned: [1, 8] });
            }
        }
    } finally {
        await db.close();
        if (prior === undefined) delete process.env.PLURNK_REASONING_VIEW_LINES;
        else process.env.PLURNK_REASONING_VIEW_LINES = prior;
    }
});

test("{§reasoning-history}: ordinary search, FORK snapshots, restart, and forensic replay remain independent", async () => {
    const dir = await mkdtemp(join(tmpdir(), "plurnk-reasoning-resources-"));
    const dbPath = join(dir, "plurnk.db");
    let db = await openMigrated(dbPath);
    try {
        const workspaceId = await insertWorkspace(db, "reasoning-lifecycle");
        const workerId = await insertWorker(db, workspaceId);
        const unrelatedId = await insertWorker(db, workspaceId, null, "unrelated");
        const loopId = await insertLoop(db, workerId, 1);
        const schemes = new SchemeRegistry();
        let engine = new Engine({ db, schemes, mimetypes: DEFAULT_MIMETYPES });
        const context = { workspaceId, workerId, loopId };
        const producing = await engine.runTurn({ ...context, provider: provider(original), messages: [] });
        const resource = (await db.test_reasoning_resources.all<Resource>({ worker_id: workerId }))[0]!;
        const target = `reasoning://${resource.pathname}`;
        let sequence = 20;
        const dispatch = (source: string) => engine.dispatch({ ...context,
            statement: statement(source), turnId: producing.turnId, sequence: sequence++, origin: "model",
        });
        assert.equal((await engine.look({ ...context, workerId: unrelatedId, statement: statement(`### READ0 (${target})`) })).status, 404);
        assert.equal((await dispatch(`### EDIT0 (${target}) <1>\nRetained determination.`)).status, 200);
        const found = await dispatch(`### FIND0 (${target})\n~Retained`);
        assert.equal(found.status, 200, JSON.stringify(found));
        assert.ok("matchLocationCount" in found);
        assert.equal(found.matchLocationCount, 1);
        const forkId = await Fork.fork(db, workerId, "reasoning-branch", {}, (scheme) => schemes.entryInheritanceForStoredScheme(scheme, workerId));
        const forkLoop = await db.test_get_loop_by_worker.get<{ id: number }>({ worker_id: forkId });
        assert.ok(forkLoop);
        const forkContext = { workspaceId, workerId: forkId, loopId: forkLoop.id };
        const branched = await engine.runTurn({ ...forkContext, provider: provider(), messages: [] });
        assert.equal((await db.test_reasoning_reads.all<Read>({ worker_id: forkId })).length, 1,
            "a pending source is observed by the fork without cloning provider accounting");
        assert.equal((await engine.dispatch({ ...forkContext, turnId: branched.turnId, sequence: 30, origin: "model",
            statement: statement(`### EDIT0 (${target}) <1>\nBranch-only decision.`),
        })).status, 200);
        assert.match((await db.test_reasoning_resources.all<Resource>({ worker_id: workerId }))[0]!.content, /^Retained determination\./);
        assert.equal((await dispatch(`### EDIT0 (${target}) <1>\nRevised conclusion.`)).status, 200);
        const outdated = await dispatch(`### FIND0 (${target})\n~Retained`);
        assert.equal(outdated.status, 204, JSON.stringify(outdated));
        assert.ok("matchLocationCount" in outdated);
        assert.equal(outdated.matchLocationCount, 0, "FTS reflects the current source, not its former content");
        assert.equal((await dispatch(`### FIND0 (${target})\n~Revised`)).status, 200);
        const next = await engine.runTurn({ ...context, provider: provider(), messages: [] });
        const observations = await db.test_reasoning_reads.all<Read>({ worker_id: workerId });
        const read = observations.find(({ ambient_event_id }) => ambient_event_id === null);
        assert.ok(read, "a child's ambient READ must not stand in for observing the parent's independent reasoning source");
        assert.match(JSON.parse(read.rx).content, /^Revised conclusion\./);
        assert.equal((await engine.dispatch({ ...context, turnId: next.turnId, sequence: 30, origin: "model",
            statement: statement(`### KILL0 (log:///${read.loop_seq}/${read.turn_seq}/${read.sequence}/READ)`),
        })).status, 200);
        const forkAfterRead = await Fork.fork(db, workerId, "already-observed", {}, (scheme) => schemes.entryInheritanceForStoredScheme(scheme, workerId));
        await db.close();
        db = await openMigrated(dbPath);
        engine = new Engine({ db, schemes: new SchemeRegistry(), mimetypes: DEFAULT_MIMETYPES });
        assert.match((await db.test_reasoning_resources.all<Resource>({ worker_id: forkId }))[0]!.content, /^Branch-only decision\./);
        const secondForkLoop = await db.test_get_loop_by_worker.get<{ id: number }>({ worker_id: forkAfterRead });
        assert.ok(secondForkLoop);
        await engine.runTurn({ workspaceId, workerId: forkAfterRead, loopId: secondForkLoop.id, provider: provider(), messages: [] });
        assert.equal((await db.test_reasoning_reads.all<Read>({ worker_id: forkAfterRead })).filter(({ ambient_event_id }) => ambient_event_id === null).length, 1,
            "fork and restart preserve once-only delivery even when the old receipt is KILLed");
        assert.equal((await dispatch(`### KILL0 (${target})`)).status, 200);
        const ids = await db.test_log_entries_by_turn.all<{ id: number }>({ turn_id: producing.turnId });
        const journal = await Promise.all(ids.map(({ id }) => LogEntry.fetchLogEntry(db, id)));
        const snapshot = new Translator({ threadId: "history", runId: "reattach" }).replay(journal)
            .find(({ type }) => type === "MESSAGES_SNAPSHOT");
        assert.ok(snapshot?.type === "MESSAGES_SNAPSHOT");
        assert.deepEqual(snapshot.messages.filter(({ role }) => role === "reasoning").map((message) => "content" in message ? message.content : null), [original]);
        const digestDir = join(dir, "digest");
        Digest.run({ dbPath, digestDir, workerId });
        const evidence = await readFile(join(digestDir, "reasoning.md"), "utf8");
        assert.ok(evidence.includes(original));
        assert.ok(!evidence.includes("Revised conclusion."), "the mutable source never substitutes for forensic reasoning");
    } finally {
        await db.close();
        await rm(dir, { recursive: true, force: true });
    }
});

test("{§reasoning-history}: only exposed final reasoning becomes a resource, with its actual call coordinate", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, "reasoning-admission");
        const workerId = await insertWorker(db, workspaceId);
        const loopId = await insertLoop(db, workerId, 1);
        const engine = new Engine({ db, schemes: new SchemeRegistry(), mimetypes: DEFAULT_MIMETYPES });
        const context = { workspaceId, workerId, loopId, messages: [] };
        for (const reasoning of [null, ""]) await engine.runTurn({ ...context, provider: provider(reasoning) });
        assert.deepEqual(await db.test_reasoning_resources.all({ worker_id: workerId }), []);
        const source = "## PLAN0\n[]\n### SEND0 (NEXT)\nContinue.";
        const admitted = await engine.runTurn({ ...context, provider: new Mock({ contextWindow: 100_000, responses: [
            { assistant: { content: "invalid program", reasoning: "Private rejected reasoning." } },
            { assistant: { content: source, reasoning: "Admitted reasoning." } },
        ] }) });
        assert.equal(admitted.emissionAttempts, 2);
        const failed = await engine.runTurn({ ...context, provider: new Mock({ contextWindow: 100_000, responses: [
            { assistant: { content: "first invalid program", reasoning: "First private reasoning." } },
            { assistant: { content: "second invalid program", reasoning: "Second private reasoning." } },
            { assistant: { content: "last invalid program", reasoning: "Final rejected reasoning." } },
        ] }) });
        assert.equal(failed.emissionExhausted, true);
        const rows = await db.test_reasoning_resources.all<Resource>({ worker_id: workerId });
        assert.deepEqual(rows.map(({ content }) => content), ["Admitted reasoning.", "Final rejected reasoning."]);
        assert.ok(rows[0]!.pathname.endsWith("/2"));
        assert.ok(rows[1]!.pathname.endsWith("/3"));
        const attempts = await db.test_turn_attempts.all<{ accepted: number }>({ turn_id: failed.turnId });
        assert.deepEqual(attempts.map(({ accepted }) => accepted), [0, 0, 0]);
    } finally { await db.close(); }
});
