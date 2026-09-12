import assert from "node:assert/strict";
import test from "node:test";
import { Mock } from "@plurnk/plurnk-providers";
import { PlurnkParser } from "@plurnk/plurnk-contracts";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Translator } from "@plurnk/plurnk-agui";
import Engine from "../../src/core/Engine.ts";
import Turn from "../../src/core/Turn.ts";
import SchemeRegistry from "../../src/core/SchemeRegistry.ts";
import Fork from "../../src/core/fork.ts";
import Digest from "../../src/digest/Digest.ts";
import LogEntry from "../../src/server/logEntry.ts";
import { DEFAULT_MIMETYPES, insertLoop, insertWorker, insertWorkspace, openMigrated } from "./_helpers.ts";
import { parseLogRecords } from "../LogRecords.ts";
import { statement, original, provider, type Resource, type Read } from "./reasoning-fixture.ts";

test("{§reasoning-history}: model sources are read-only and hash-free; log observations remain curatable", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, "reasoning-resources");
        const workerId = await insertWorker(db, workspaceId, null, "alice");
        const loopId = await insertLoop(db, workerId, 1);
        const engine = new Engine({ db, schemes: new SchemeRegistry(), mimetypes: DEFAULT_MIMETYPES });
        const context = { workspaceId, workerId, loopId };
        const first = await engine.runTurn({ ...context, provider: provider(original,
            PlurnkParser.frame("READ (reasoning:///1/2) <1,-1>", null)), messages: [] });
        const resources = await db.test_model_reasoning_resources.all<Resource>({ worker_id: workerId });
        const turn = await db.test_get_turn.get<{ sequence: number }>({ id: first.turnId });
        assert.deepEqual(resources, [{ pathname: `/1/${turn!.sequence}`, content: original }]);
        const target = `reasoning://${resources[0]!.pathname}`;
        const next = await engine.runTurn({ ...context, provider: provider(), messages: [] });
        const reads = (await db.test_reasoning_reads.all<Read>({ worker_id: workerId })).filter(({ pathname }) => pathname === "/1/2");
        assert.equal(reads.length, 1);
        const read = reads[0]!;
        assert.equal(read.origin, "model");
        assert.deepEqual(JSON.parse(read.lineMarker), { marks: [1, -1] });
        const result = JSON.parse(read.rx) as { content: string; lineAnchors?: string[] };
        assert.equal(result.content, original);
        assert.equal(Object.hasOwn(result, "lineAnchors"), false, "read-only sources do not advertise editable anchors");
        assert.equal(Object.hasOwn(result, "lineNumberWidth"), false);
        const receipt = `log:///${read.loop_seq}/${read.turn_seq}/${read.sequence}/READ`;
        let sequence = 50;
        const dispatch = (source: string) => engine.dispatch({ ...context, statement: statement(source), turnId: next.turnId, sequence: sequence++, origin: "model" });
        const copy = "worker://alice/reasoning-notes.txt";
        assert.equal((await dispatch(`\`\`\`COPY (${target}) (${copy})\`\`\``)).status, 201);
        const copied = await db.test_get_channel_by_pathname.get<{ content: string; mimetype: string }>({ pathname: "/reasoning-notes.txt", name: "body" });
        assert.equal(copied?.content, original);
        assert.equal(copied?.mimetype, "text/markdown", "COPY uses the destination type without rewriting reasoning text");
        assert.equal((await dispatch(`\`\`\`COPY (${target}) <2,3> (worker://alice/reasoning-slice.md)\`\`\``)).status, 201);
        const slice = await db.test_get_channel_by_pathname.get<{ content: string; mimetype: string }>({ pathname: "/reasoning-slice.md", name: "body" });
        assert.equal(slice?.content, "Finding 2: evidence 2.\nFinding 3: evidence 3.\n", "COPY includes the selected lines' original terminators");
        assert.equal(slice?.mimetype, "text/markdown");
        for (const program of [
            `\`\`\`EDIT (${target}) <1>
Revised determination.
\`\`\``,
            "```EDIT (reasoning:///9/9)\nInvented history.\n```",
            `\`\`\`KILL (${target})\`\`\``,
            `\`\`\`KILL (${target}) <2>\`\`\``,
            `\`\`\`COPY (${copy}) (${target}) <1,-1>\`\`\``,
            `\`\`\`MOVE (${target}) (worker://alice/moved-reasoning.txt)\`\`\``,
            `\`\`\`MOVE (${copy}) (${target}) <1,-1>\`\`\``,
        ]) {
            const denied = await dispatch(program);
            assert.equal(denied.status, 403, program);
            assert.equal(denied.problem?.type, "https://problems.plurnk.xyz/engine/dispatcher/writer-forbidden", program);
        }
        assert.deepEqual(await db.test_model_reasoning_resources.all<Resource>({ worker_id: workerId }), resources);
        const explicit = await dispatch(`\`\`\`READ (${target}) <2,3>\`\`\``);
        assert.equal(explicit.status, 200);
        assert.ok("content" in explicit);
        assert.equal(explicit.content, original.split("\n").slice(1, 3).join("\n"));
        assert.equal(Object.hasOwn(explicit, "lineAnchors"), false);
        const anchored = await dispatch(`\`\`\`READ (${target}) <@abcde>\`\`\``);
        assert.equal(anchored.status, 400);
        assert.equal(anchored.problem?.type, "https://problems.plurnk.xyz/scheme/reasoning/line-anchor-unsupported");
        const editable = await engine.look({ ...context, statement: statement(`\`\`\`READ (${copy}) <1,-1>\`\`\``) });
        assert.equal(editable.status, 200, "a denied MOVE preserves its writable source");
        assert.ok("lineAnchors" in editable && Array.isArray(editable.lineAnchors));
        assert.equal(editable.lineAnchors.length, 30, "an ordinary editable copy still publishes anchors");
        const history = await engine.look({ ...context, statement: statement(`\`\`\`READ (${receipt}) <1,-1>\`\`\``) });
        assert.ok("content" in history && "lineAnchors" in history && Array.isArray(history.lineAnchors));
        assert.equal(history.content, original);
        assert.equal(history.lineAnchors.length, 30, "explicit log READs retain anchors for line curation");
        assert.equal((await dispatch(`\`\`\`KILL (${receipt}) <${history.lineAnchors[1]}>\`\`\``)).status, 200);
        assert.equal((await dispatch(`\`\`\`KILL (${receipt}) <17,-1>\`\`\``)).status, 200);
        const curtailed = (await db.test_reasoning_reads.all<Read>({ worker_id: workerId })).find(({ id }) => id === read.id);
        assert.ok(curtailed);
        assert.equal(curtailed.active, 1);
        assert.notEqual(curtailed.folded, "[]", "scoped log curation changes its projection");
        assert.equal(JSON.parse(curtailed.rx).content, original, "curation preserves durable observations");
        assert.equal((await dispatch(`\`\`\`KILL (${receipt})\`\`\``)).status, 200);
        assert.deepEqual(await db.test_model_reasoning_resources.all<Resource>({ worker_id: workerId }), resources);
        await engine.runTurn({ ...context, provider: provider(), messages: [] });
        const after = await db.test_reasoning_reads.all<Read>({ worker_id: workerId });
        assert.equal(after.filter(({ origin }) => origin === "_plurnk").length, 1, "log curation cannot cause automatic redelivery");
        assert.equal(after.find(({ id }) => id === read.id)?.active, 0);
        const packet = await db.test_get_packet.get<{ packet: string }>({ id: first.turnId });
        assert.equal(JSON.parse(packet!.packet).assistant.reasoning, original);
    } finally { await db.close(); }
});

for (const limit of [-1, 0, 1, 8]) test(`{§reasoning-initial-read}: configured ${limit} controls the authored example, not source retention`, async () => {
    const prior = process.env.PLURNK_REASONING_VIEW_LINES;
    process.env.PLURNK_REASONING_VIEW_LINES = String(limit);
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `reasoning-limit-${limit}`);
        const workerId = await insertWorker(db, workspaceId, null, "alice");
        const loopId = await insertLoop(db, workerId, 1);
        const engine = new Engine({ db, schemes: new SchemeRegistry(), mimetypes: DEFAULT_MIMETYPES });
        const context = { workspaceId, workerId, loopId };
        await engine.runTurn({ ...context, provider: provider(original), messages: [] });
        const next = await engine.runTurn({ ...context, provider: provider(), messages: [] });
        assert.equal((await db.test_model_reasoning_resources.all<Resource>({ worker_id: workerId }))[0]?.content, original);
        const reads = await db.test_reasoning_reads.all<Read>({ worker_id: workerId });
        assert.equal(reads.length, limit === 0 ? 0 : 1);
        if (limit === 0) {
            const resource = (await db.test_model_reasoning_resources.all<Resource>({ worker_id: workerId }))[0]!;
            const explicit = await engine.dispatch({ ...context, turnId: next.turnId, sequence: 80, origin: "model",
                statement: statement(`\`\`\`READ (reasoning://${resource.pathname}) <17,30>\`\`\``),
            });
            assert.equal(explicit.status, 200);
            assert.ok("content" in explicit);
            assert.equal(explicit.content, original.split("\n").slice(16).join("\n"), "omitting the initialization example does not restrict explicit READs");
            assert.equal(Object.hasOwn(explicit, "lineAnchors"), false);
        }
        if (limit !== 0) {
            assert.deepEqual(JSON.parse(reads[0]!.lineMarker), { marks: [1, limit] });
            const packet = JSON.parse((await db.test_get_packet.get<{ packet: string }>({ id: next.turnId }))!.packet);
            const log = packet.sections.find(({ name }: { name: string }) => name === "log").content;
            assert.match(log, /^### log:\/\/\/\d+\/\d+\/\d+\/READ\n\{"target":"reasoning:\/\/\//m, "{§log-wire-format} the assembled reasoning receipt leads with its source target");
            const record = parseLogRecords(log).find(({ path }) => path === `log:///${reads[0]!.loop_seq}/${reads[0]!.turn_seq}/${reads[0]!.sequence}/READ`);
            assert.ok(record);
            assert.equal(record.aside, "inspect this turn's reasoning");
            assert.equal(record.target, "reasoning:///1/1");
            assert.match(String(record.body), /^\s*1:This harness-generated turn/m);
            assert.doesNotMatch(String(record.body), /Finding 1:/, "the model's original reasoning is not automatically pushed into the log");
            assert.doesNotMatch(String(record.body), /^@[A-Za-z0-9]+\s+\d+:/m, "the materialized read-only projection has no hashes");
            if (limit === 1) {
                assert.doesNotMatch(String(record.body), /2:In turn/);
                assert.deepEqual(record.range, { unit: "line", total: 5, requested: [1, 1], returned: [1, 1] });
            }
        }
    } finally {
        await db.close();
        if (prior === undefined) delete process.env.PLURNK_REASONING_VIEW_LINES;
        else process.env.PLURNK_REASONING_VIEW_LINES = prior;
    }
});

test("{§reasoning-history}: immutable sources support search, FORK, restart, and independent receipt curation", async () => {
    const dir = await mkdtemp(join(tmpdir(), "plurnk-reasoning-resources-"));
    const dbPath = join(dir, "plurnk.db");
    let db = await openMigrated(dbPath);
    try {
        const workspaceId = await insertWorkspace(db, "reasoning-lifecycle");
        const workerId = await insertWorker(db, workspaceId, null, "alice");
        const unrelatedId = await insertWorker(db, workspaceId, null, "unrelated");
        const loopId = await insertLoop(db, workerId, 1);
        const schemes = new SchemeRegistry();
        let engine = new Engine({ db, schemes, mimetypes: DEFAULT_MIMETYPES });
        const context = { workspaceId, workerId, loopId };
        const producing = await engine.runTurn({ ...context, provider: provider(original,
            `${PlurnkParser.frame("READ (reasoning:///1/2) <1,-1>", null)}\n\n${PlurnkParser.frame("SEND", "Ready.")}`), messages: [] });
        const resource = (await db.test_model_reasoning_resources.all<Resource>({ worker_id: workerId }))[0]!;
        const target = `reasoning://${resource.pathname}`;
        let sequence = 20;
        const dispatch = (source: string) => engine.dispatch({ ...context,
            statement: statement(source), turnId: producing.turnId, sequence: sequence++, origin: "model",
        });
        const clientDispatch = async (source: string, owner = context) => {
            const turn = await Turn.open(db, { loopId: owner.loopId, producer: "client", kind: "operation" });
            const result = await engine.dispatch({ ...owner, statement: statement(source), turnId: turn.id, sequence: 1, origin: "client" });
            await Turn.complete(db, turn.id, result.status);
            return result;
        };
        assert.equal((await engine.look({ ...context, workerId: unrelatedId, statement: statement(`\`\`\`READ (${target})\`\`\``) })).status, 404,
            "a local coordinate does not invent history for another worker");
        assert.equal((await clientDispatch(`\`\`\`EDIT (${target}) <1>
Retained determination.
\`\`\``)).status, 403);
        const found = await dispatch(`\`\`\`FIND (${target}) [{"pattern":"~\\"Finding 2\\""}]\`\`\``);
        assert.equal(found.status, 200, JSON.stringify(found));
        assert.ok("matchLocationCount" in found);
        assert.equal(found.matchLocationCount, 1);
        const forkId = await Fork.fork(db, workerId, "reasoning-branch");
        const forkLoop = await db.test_get_loop_by_worker.get<{ id: number }>({ worker_id: forkId });
        assert.ok(forkLoop);
        const forkContext = { workspaceId, workerId: forkId, loopId: forkLoop.id };
        await engine.runTurn({ ...forkContext, provider: provider(), messages: [] });
        assert.equal((await db.test_reasoning_reads.all<Read>({ worker_id: forkId })).filter(({ pathname }) => pathname === "/1/2").length, 1,
            "the fork inherits the existing ordinary observation without requesting another");
        assert.equal((await clientDispatch(`\`\`\`EDIT (${target}) <1>
Branch-only decision.
\`\`\``, forkContext)).status, 403);
        assert.equal((await db.test_model_reasoning_resources.all<Resource>({ worker_id: workerId }))[0]!.content, original);
        const stillFound = await dispatch(`\`\`\`FIND (${target}) [{"pattern":"~\\"Finding 2\\""}]\`\`\``);
        assert.equal(stillFound.status, 200, "denied writes leave indexed source unchanged");
        const next = await engine.runTurn({ ...context, provider: provider(), messages: [] });
        const observations = await db.test_reasoning_reads.all<Read>({ worker_id: workerId });
        const read = observations.find(({ pathname, ambient_event_id }) => pathname === "/1/2" && ambient_event_id === null);
        assert.ok(read, "a child's ambient READ must not stand in for observing the parent's independent reasoning source");
        assert.equal(JSON.parse(read.rx).content, original);
        assert.equal((await engine.dispatch({ ...context, turnId: next.turnId, sequence: 30, origin: "model",
            statement: statement(`\`\`\`KILL (log:///${read.loop_seq}/${read.turn_seq}/${read.sequence}/READ)\`\`\``),
        })).status, 200);
        const forkAfterRead = await Fork.fork(db, workerId, "already-observed");
        await db.close();
        db = await openMigrated(dbPath);
        engine = new Engine({ db, schemes: new SchemeRegistry(), mimetypes: DEFAULT_MIMETYPES });
        assert.equal((await db.test_model_reasoning_resources.all<Resource>({ worker_id: forkId }))[0]!.content, original);
        const secondForkLoop = await db.test_get_loop_by_worker.get<{ id: number }>({ worker_id: forkAfterRead });
        assert.ok(secondForkLoop);
        await engine.runTurn({ workspaceId, workerId: forkAfterRead, loopId: secondForkLoop.id, provider: provider(), messages: [] });
        assert.equal((await db.test_reasoning_reads.all<Read>({ worker_id: forkAfterRead })).filter(({ pathname, ambient_event_id }) => pathname === "/1/2" && ambient_event_id === null).length, 1,
            "fork and restart never automatically reread a KILLed observation");
        assert.equal((await clientDispatch(`\`\`\`KILL (${target})\`\`\``)).status, 403);
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
        assert.ok(!evidence.includes("Revised conclusion."), "denied source edits cannot alter forensic reasoning");
    } finally {
        await db.close();
        await rm(dir, { recursive: true, force: true });
    }
});

test("{§reasoning-history}: only exposed final reasoning becomes a resource at its producing turn", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, "reasoning-admission");
        const workerId = await insertWorker(db, workspaceId, null, "alice");
        const loopId = await insertLoop(db, workerId, 1);
        const engine = new Engine({ db, schemes: new SchemeRegistry(), mimetypes: DEFAULT_MIMETYPES });
        const context = { workspaceId, workerId, loopId, messages: [] };
        for (const reasoning of [null, ""]) await engine.runTurn({ ...context, provider: provider(reasoning) });
        assert.deepEqual(await db.test_model_reasoning_resources.all({ worker_id: workerId }), []);
        const source = "```TASK\n[{\"content\":\"Continue.\",\"status\":\"in_progress\"}]\n```";
        const admitted = await engine.runTurn({ ...context, provider: new Mock({ contextWindow: 100_000, responses: [
            { assistant: { content: "````READ (worker:///invalid-program", reasoning: "Private rejected reasoning." } },
            { assistant: { content: source, reasoning: "Admitted reasoning." } },
        ] }) });
        assert.equal(admitted.emissionAttempts, 2);
        const failed = await engine.runTurn({ ...context, provider: new Mock({ contextWindow: 100_000, responses: [
            { assistant: { content: "````READ (worker:///first-invalid-program", reasoning: "First private reasoning." } },
            { assistant: { content: "````READ (worker:///second-invalid-program", reasoning: "Second private reasoning." } },
            { assistant: { content: "````READ (worker:///last-invalid-program", reasoning: "Final rejected reasoning." } },
        ] }) });
        assert.equal(failed.emissionExhausted, true);
        const rows = await db.test_model_reasoning_resources.all<Resource>({ worker_id: workerId });
        assert.deepEqual(rows.map(({ content }) => content), ["Admitted reasoning.", "Final rejected reasoning."]);
        const admittedTurn = await db.test_get_turn.get<{ sequence: number }>({ id: admitted.turnId });
        const failedTurn = await db.test_get_turn.get<{ sequence: number }>({ id: failed.turnId });
        assert.equal(rows[0]!.pathname, `/1/${admittedTurn!.sequence}`);
        assert.equal(rows[1]!.pathname, `/1/${failedTurn!.sequence}`);
        const attempts = await db.test_turn_attempts.all<{ accepted: number }>({ turn_id: failed.turnId });
        assert.deepEqual(attempts.map(({ accepted }) => accepted), [0, 0, 0]);
    } finally { await db.close(); }
});

test("{§turn-source-resources}: an existing turn without provider reasoning reads empty; a turn that does not exist is 404", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, "reasoning-empty");
        const workerId = await insertWorker(db, workspaceId, null, "alice");
        const loopId = await insertLoop(db, workerId, 1);
        const engine = new Engine({ db, schemes: new SchemeRegistry(), mimetypes: DEFAULT_MIMETYPES });
        const context = { workspaceId, workerId, loopId };
        // The provider returns no reasoning for the model's turn (1/2); the initialization turn (1/1) always has its rationale.
        const silent = await engine.runTurn({ ...context, provider: provider(null,
            `${PlurnkParser.frame("READ (reasoning:///1/2) <1,-1>", null)}\n\n${PlurnkParser.frame("SEND", "Ready.")}`), messages: [] });
        const turn = await db.test_get_turn.get<{ sequence: number }>({ id: silent.turnId });
        assert.equal(turn?.sequence, 2);
        assert.equal((await db.test_model_reasoning_resources.all<Resource>({ worker_id: workerId })).length, 0, "no substitute source is recorded");
        const own = (await db.test_reasoning_reads.all<Read>({ worker_id: workerId })).find(({ pathname, turn_id }) => pathname === "/1/2" && turn_id === silent.turnId);
        assert.ok(own, "the model's READ of its own reasoning coordinate produced a receipt");
        const look = (source: string) => engine.look({ ...context, statement: statement(source) });
        const empty = await look("```READ (reasoning:///1/2) <1,-1>```");
        assert.equal(empty.status, 204, "an existing turn with nothing from the provider reads as the ordinary empty resource");
        assert.ok("content" in empty);
        assert.equal(empty.content, "");
        const program = await look("```READ (ops:///1/2) <1,-1>```");
        assert.equal(program.status, 200);
        assert.ok("content" in program && typeof program.content === "string" && program.content.includes("READ (reasoning:///1/2)"), "the same turn's admitted program is present");
        const future = await look("```READ (reasoning:///1/9) <1,-1>```");
        assert.equal(future.status, 404, "a turn that has not happened is missing, not empty");
        assert.equal(future.problem?.type, "https://problems.plurnk.xyz/scheme/reasoning/entry-not-found");
        assert.equal((await look("```READ (reasoning:///2/1) <1,-1>```")).status, 404, "so is a loop that does not exist");
    } finally { await db.close(); }
});
