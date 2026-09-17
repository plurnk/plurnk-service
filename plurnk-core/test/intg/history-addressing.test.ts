import assert from "node:assert/strict";
import test from "node:test";
import { PlurnkParser } from "@plurnk/plurnk-parser";
import { Mock } from "@plurnk/plurnk-providers";
import Engine from "../../src/core/Engine.ts";
import Turn from "../../src/core/Turn.ts";
import Fork from "../../src/core/fork.ts";
import SchemeRegistry from "../../src/core/SchemeRegistry.ts";
import Exec from "../../src/schemes/Exec.ts";
import { DEFAULT_MIMETYPES, insertLoop, insertWorker, insertWorkspace, openMigrated, testExecutors } from "./_helpers.ts";
import { statement } from "./reasoning-fixture.ts";
import { resourcePaths } from "./_find.ts";
import type { FindResult } from "../../src/schemes/_entry-find.ts";

const frame = PlurnkParser.frame;
const program = (name: string) => `${frame("NOTE", `${name} source`)}\n\n${frame(`READ (note://${name}/1/1/1)`, null)}`;

test("{§turn-source-resources}: shared addresses retain identity across workers, curation, copying and forks", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, "shared-history");
        const parent = await insertWorker(db, workspaceId, null, "parent");
        const child = await insertWorker(db, workspaceId, parent, "child_A");
        const parentLoop = await insertLoop(db, parent, 1);
        const childLoop = await insertLoop(db, child, 1);
        const engine = new Engine({ db, schemes: new SchemeRegistry(), mimetypes: DEFAULT_MIMETYPES });
        for (const [workerId, loopId, name] of [[parent, parentLoop, "parent"], [child, childLoop, "child_A"]] as const) {
            const turn = await Turn.open(db, { loopId, producer: "model", kind: "inference" });
            await Turn.recordSource(db, turn.id, "ops", program(name));
            await Turn.recordSource(db, turn.id, "reasoning", `${name} reasoning`);
            const result = await engine.dispatch({ workspaceId, workerId, loopId, turnId: turn.id, sequence: 1,
                origin: "model", statement: statement(frame("NOTE", `${name} note`)) });
            assert.equal(result.status, 200);
            assert.equal("resource" in result && result.resource, `note://${name}/1/1/1`);
            await Turn.complete(db, turn.id, 200);
        }
        const look = async (source: string, workerId = parent, loopId = parentLoop) => {
            const operation = statement(source);
            if (operation.op === "READ") return engine.look({ workspaceId, workerId, loopId, statement: operation });
            const turn = await Turn.open(db, { loopId, producer: "model", kind: "inference" });
            const result = await engine.dispatch({ workspaceId, workerId, loopId, turnId: turn.id, sequence: 1,
                origin: "model", statement: operation });
            await Turn.complete(db, turn.id, result.status);
            return result;
        };
        for (const [scheme, path, expected] of [
            ["ops", "1/1", program("child_A")],
            ["reasoning", "1/1", "child_A reasoning"],
            ["note", "1/1/1", "child_A note"],
        ]) {
            const result = await look(frame(`READ (${scheme}://child_A/${path}) <1,-1>`, null));
            assert.equal(result.status, 200, JSON.stringify(result));
            assert.equal("content" in result && result.content, expected);
        }
        const found = await look(frame("FIND (note://*/1/1/*) <1,-1>", null)) as FindResult;
        assert.equal(found.status, 200);
        assert.deepEqual(resourcePaths(found).sort(), ["note://child_A/1/1/1", "note://parent/1/1/1"]);
        const searched = await look(frame("FIND (note://*/1/1/1) <1,-1> /child_A/", null)) as FindResult;
        assert.equal(searched.status, 200, JSON.stringify(searched));
        assert.deepEqual(resourcePaths(searched), ["note://child_A/1/1/1"], "authority glob with an exact path retains a resource catalog");
        const indexed = await look(frame('FIND (ops://*/1/1) <1,-1> [{"pattern":"~source"}]', null)) as FindResult;
        assert.equal(indexed.status, 200, JSON.stringify(indexed));
        assert.deepEqual(resourcePaths(indexed).sort(), ["ops://child_A/1/1", "ops://parent/1/1"], "indexed matches retain both workers at identical coordinates");
        for (const address of ["note:///1/1/1", "note://child_A:80/1/1/1", "note://child_A/1/1/1?q=x"]) {
            const invalid = await look(frame(`READ (${address})`, null));
            assert.equal(invalid.status, 400, address);
            assert.equal(invalid.problem?.type, "https://problems.plurnk.xyz/scheme/note/coordinate-malformed");
        }
        for (const address of ["note://child_a/1/1/1", "note://missing/1/1/1"]) {
            const absent = await look(frame(`READ (${address})`, null));
            assert.equal(absent.status, 404, "worker authorities are exact, not silently case-folded");
        }
        const copied = await look(frame("COPY (note://child_A/1/1/1) (worker:///shared-note.md)", null));
        assert.equal(copied.status, 201, JSON.stringify(copied));
        const copy = await look(frame("READ (worker:///shared-note.md) <1,-1>", null));
        assert.equal("content" in copy && copy.content, "child_A note");
        const trimmed = await look(frame("KILL (log:///1/1/1/NOTE)", null), child, childLoop);
        assert.equal(trimmed.status, 200);
        const retained = await look(frame("READ (note://child_A/1/1/1) <1,-1>", null));
        assert.equal("content" in retained && retained.content, "child_A note");
        const fork = await Fork.fork(db, child, "branch");
        const forkLoop = await insertLoop(db, fork, 2);
        const inherited = await look(frame("READ (note://branch/1/1/1) <1,-1>", null));
        assert.equal("content" in inherited && inherited.content, "child_A note");
        const original = await look(frame("READ (ops://child_A/1/1) <1,-1>", null), fork, forkLoop);
        assert.equal("content" in original && original.content, program("child_A"));
        const forkProgram = await look(frame("READ (ops://branch/1/1) <1,-1>", null));
        assert.equal("content" in forkProgram && forkProgram.content, program("child_A"), "embedded explicit source references are not rewritten by FORK");
        for (const op of ["READ", "FIND", "KILL"]) {
            const qualifiedLog = await look(frame(`${op} (log://child_A/1/1/1/NOTE) <1,-1>`, null));
            assert.equal(qualifiedLog.status, 400, `${op} must not silently substitute the caller's log`);
            assert.equal(qualifiedLog.problem?.type, "https://problems.plurnk.xyz/scheme/log/coordinate-malformed");
        }
        const parentNote = await look(frame("READ (log:///1/1/1/NOTE) <1,-1>", null));
        assert.equal("content" in parentNote && parentNote.content, "parent note", "rejected foreign curation leaves local context intact");
    } finally { await db.close(); }
});

test("{§turn-source-resources}: a SEND shares a note; the recipient deliberately reads its source", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, "note-sharing");
        const parent = await insertWorker(db, workspaceId, null, "parent");
        const child = await insertWorker(db, workspaceId, parent, "child");
        const parentLoop = await insertLoop(db, parent, 1);
        const childLoop = await insertLoop(db, child, 1);
        const engine = new Engine({ db, schemes: new SchemeRegistry(), mimetypes: DEFAULT_MIMETYPES,
            injectWorker: async ({ workerId, sourceLoopId, prompt }) => {
                assert.equal(workerId, parent);
                assert.equal(sourceLoopId, childLoop);
                const message = await db.drain_enqueue_message.get({ loop_id: parentLoop, address: null,
                    source: "worker://child", body: prompt, open_paths: "[]", evidence: "{}" });
                assert.ok(message);
                return { action: "injected_next_turn", loopId: parentLoop };
            },
        });
        const turn = await Turn.open(db, { loopId: childLoop, producer: "model", kind: "inference" });
        const context = { workspaceId, workerId: child, loopId: childLoop, turnId: turn.id, origin: "model" as const };
        const note = await engine.dispatch({ ...context, sequence: 1, statement: statement(frame("NOTE", "The retry condition is idempotent.")) });
        assert.equal(note.status, 200);
        assert.equal("resource" in note && note.resource, "note://child/1/1/1");
        const send = await engine.dispatch({ ...context, sequence: 2, statement: statement(frame("SEND (worker://parent)", "See note://child/1/1/1")) });
        assert.equal(send.status, 200, JSON.stringify(send));
        await Turn.complete(db, turn.id, 102);
        const provider = new Mock({ contextWindow: 100_000, responses: [{ assistant: {
            content: frame("READ (note://child/1/1/1) <1,-1>", null), reasoning: null,
        } }] });
        await engine.runTurn({ workspaceId, workerId: parent, loopId: parentLoop, provider, messages: [] });
        const history = await db.test_log_entries_by_loop.all<{ op: string; source: string; rx: string; tx: string }>({ loop_id: parentLoop });
        assert.ok(history.some(({ op, tx }) => op === "SEND" && tx.includes("See note://child/1/1/1")), "the addressed message reaches the parent's inbox");
        assert.ok(!history.some(({ op, source }) => op === "NOTE" && source === "worker://child"), "source availability is not automatic observation");
        assert.ok(history.some(({ op, rx }) => op === "READ" && JSON.parse(rx).content === "The retry condition is idempotent."), "the parent's READ resolves the exact shared source");
        const otherWorkspace = await insertWorkspace(db, "other-note-sharing");
        const otherWorker = await insertWorker(db, otherWorkspace, null, "parent");
        const otherLoop = await insertLoop(db, otherWorker, 1);
        const isolated = await engine.look({ workspaceId: otherWorkspace, workerId: otherWorker, loopId: otherLoop,
            statement: statement(frame("READ (note://child/1/1/1)", null)) });
        assert.equal(isolated.status, 404, "an explicit authority never crosses the workspace boundary");
    } finally { await db.close(); }
});

for (const exitCode of [0, 7]) test(`{§env-delta-child-activity}: executor exit ${exitCode} is observed by its worker without forwarding output READs`, async () => {
    const db = await openMigrated();
    const schemes = new SchemeRegistry();
    const exec = schemes.get("exec") as Exec;
    try {
        const workspaceId = await insertWorkspace(db, "executor-observation");
        const parent = await insertWorker(db, workspaceId, null, "parent");
        const child = await insertWorker(db, workspaceId, parent, "child");
        const parentLoop = await insertLoop(db, parent, 1);
        const childLoop = await insertLoop(db, child, 1);
        const turn = await Turn.open(db, { loopId: childLoop, producer: "model", kind: "inference" });
        const engine = new Engine({ db, schemes, mimetypes: DEFAULT_MIMETYPES });
        const executors = await testExecutors();
        engine.setExecutors(executors);
        schemes.registerRuntimeSchemes(executors);
        const proposed = Promise.withResolvers<number>();
        const started = engine.dispatch({ workspaceId, workerId: child, loopId: childLoop, turnId: turn.id,
            sequence: 1, origin: "model", onDispatch: proposed.resolve,
            statement: statement(frame("sh", `printf 'child output\\n'; exit ${exitCode}`)),
        });
        engine.resolveProposal(await proposed.promise, { decision: "accept" });
        assert.equal((await started).status, 200);
        await exec.idle();
        await Turn.complete(db, turn.id, 102);
        const continuation = () => new Mock({ contextWindow: 100_000, responses: [{ assistant: { content: frame("NOTE", "Observe."), reasoning: null } }] });
        await engine.runTurn({ workspaceId, workerId: child, loopId: childLoop, provider: continuation(), messages: [] });
        const childRows = await db.test_log_entries_by_loop.all<{ op: string; rx: string; attrs: string }>({ loop_id: childLoop });
        const output = childRows.filter(({ op, attrs }) => op === "READ" && JSON.parse(attrs).terminal === true);
        assert.ok(output.length > 0, "the owner's terminal observation was actually materialized");
        assert.ok(output.some(({ rx }) => JSON.parse(rx).content?.includes("child output")), "the owner retains the output");
        await engine.runTurn({ workspaceId, workerId: parent, loopId: parentLoop, provider: continuation(), messages: [] });
        const observations = (await db.test_log_entries_by_loop.all<{ op: string; source: string; attrs: string }>({ loop_id: parentLoop }))
            .filter(({ source }) => source === "worker://child");
        assert.deepEqual(observations.map(({ op }) => op), ["sh", "SEND"], "the invocation and child conclusion reach the parent; READs and notes do not");
        assert.equal(JSON.parse(observations[1]!.attrs).kind, "loop_termination", "the child's conclusion still uses the lifecycle channel");
    } finally {
        await exec.idle();
        await db.close();
    }
});

test("{§env-delta-child-activity}: WORK and FORK are observable actions; BARE and WAIT stay local", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, "delegation-observation");
        const parent = await insertWorker(db, workspaceId, null, "parent");
        const child = await insertWorker(db, workspaceId, parent, "child");
        const parentLoop = await insertLoop(db, parent, 1);
        const childLoop = await insertLoop(db, child, 1, "Coordinate the work.");
        const engine = new Engine({ db, schemes: new SchemeRegistry(), mimetypes: DEFAULT_MIMETYPES,
            injectWorker: async ({ workerId, prompt }) => {
                const history = await db.test_fork_loops.all({ worker_id: workerId });
                const loopId = await insertLoop(db, workerId, history.length + 1, prompt);
                return { action: "enqueued_new_loop", loopId };
            },
        });
        const provider = new Mock({ contextWindow: 100_000, responses: [{ assistant: {
            content: [frame("WORK (worker://research)", "Research the question."), frame("FORK (worker://review)", "Review the evidence."),
                frame("BARE", "Is the task clear?"), frame("WAIT", "Await both children.")].join("\n\n"), reasoning: null,
        } }] });
        const childProvider = new Mock({ contextWindow: 100_000, responses: [{ assistant: { content: "Yes.", reasoning: null } }] });
        const result = await engine.runTurn({ workspaceId, workerId: child, loopId: childLoop, provider, childProvider, messages: [] });
        assert.equal(result.status, 202);
        const childRows = await db.test_log_entries_by_worker.all<{ op: string; status_rx: number }>({ worker_id: child });
        assert.deepEqual(childRows.filter(({ op }) => ["WORK", "FORK", "BARE", "WAIT"].includes(op))
            .map(({ op, status_rx }) => [op, status_rx]), [["WORK", 200], ["FORK", 200], ["BARE", 200], ["WAIT", 202]]);
        await engine.runTurn({ workspaceId, workerId: parent, loopId: parentLoop, messages: [],
            provider: new Mock({ contextWindow: 100_000, responses: [{ assistant: { content: frame("NOTE", "Observe."), reasoning: null } }] }),
        });
        const observations = (await db.test_log_entries_by_worker.all<{ op: string; source: string }>({ worker_id: parent }))
            .filter(({ source }) => source === "worker://child");
        assert.deepEqual(observations.map(({ op }) => op), ["SEND", "WORK", "FORK"], "only the inbound assignment and topology-changing actions reach the parent");
    } finally { await db.close(); }
});

test("{§env-delta-child-activity}: parent receives actions, never child exploration or log curation", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, "action-observation");
        const parent = await insertWorker(db, workspaceId, null, "parent");
        const child = await insertWorker(db, workspaceId, parent, "child");
        const parentLoop = await insertLoop(db, parent, 1);
        const childLoop = await insertLoop(db, child, 1);
        const turn = await Turn.open(db, { loopId: childLoop, producer: "model", kind: "inference" });
        const engine = new Engine({ db, schemes: new SchemeRegistry(), mimetypes: DEFAULT_MIMETYPES });
        let sequence = 0;
        for (const [source, status] of [
            [frame("NOTE", "A tentative hypothesis, not a parent instruction."), 200],
            [frame("EDIT (worker://child/scratch.md)", "A real change."), 201],
            [frame("READ (worker://child/scratch.md)", null), 200],
            [frame("FIND (worker://child/*)", null), 200],
            [frame("KILL (log:///1/1/1/NOTE)", null), 200],
            [frame("KILL (log:///9/9/9)", null), 404],
            [frame("KILL (worker://child/scratch.md)", null), 200],
            [frame("EDIT (missing:///file)", "A failed action."), 501],
        ] as const) {
            const result = await engine.dispatch({ workspaceId, workerId: child, loopId: childLoop, turnId: turn.id,
                sequence: ++sequence, origin: "model", statement: statement(source) });
            assert.equal(result.status, status, JSON.stringify(result));
        }
        await Turn.complete(db, turn.id, 102);
        await engine.runTurn({ workspaceId, workerId: parent, loopId: parentLoop, messages: [],
            provider: new Mock({ contextWindow: 100_000, responses: [{ assistant: { content: frame("NOTE", "Continue."), reasoning: null } }] }),
        });
        const observed = (await db.test_log_entries_by_worker.all<{ op: string; source: string; status_rx: number }>({ worker_id: parent }))
            .filter(({ source }) => source === "worker://child");
        assert.deepEqual(observed.map(({ op, status_rx }) => [op, status_rx]), [["EDIT", 201], ["KILL", 200], ["EDIT", 501]]);
        const history = await db.test_log_entries_by_worker.all({ worker_id: child });
        assert.equal(history.length, 8, "excluded observations remain durable in the child's history");
    } finally { await db.close(); }
});
