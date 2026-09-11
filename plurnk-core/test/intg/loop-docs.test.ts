import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { Lexer } from "marked";
import Engine from "../../src/core/Engine.ts";
import RuntimeWorker from "../../src/core/RuntimeWorker.ts";
import SchemeRegistry from "../../src/core/SchemeRegistry.ts";
import LoopDocs from "../../src/server/loopDocs.ts";
import Daemon from "../../src/server/Daemon.ts";
import Results from "../../src/core/results.ts";
import { PlurnkParser } from "@plurnk/plurnk-contracts";
import { Mock } from "@plurnk/plurnk-providers";
import { dispositionStmt } from "./_dsl.ts";
import { DEFAULT_MIMETYPES, insertLoop, insertWorker, insertWorkspace, openMigrated, testExecutors } from "./_helpers.ts";

class FixtureEngine extends Engine {
    documents: Array<{ pathname: string; content: string }> = [];

    override async referenceEntries(): Promise<Array<{ pathname: string; content: string }>> {
        return this.documents;
    }
}

test("{§application-worker-observation} maintenance preserves work lifecycle and scheduler history", async () => {
    const db = await openMigrated();
    const daemon = new Daemon({ db });
    try {
        const engine = new FixtureEngine({ db, schemes: new SchemeRegistry(), mimetypes: DEFAULT_MIMETYPES });
        const workspaceId = await insertWorkspace(db, "maintenance-status");
        for (const [status, lifecycle] of [[null, "idle"], [100, "queued"], [102, "running"], [202, "parked"], [200, "completed"], [500, "failed"]] as const) {
            const workerId = await insertWorker(db, workspaceId, null, `worker-${lifecycle}`, "model");
            const loopId = status === null ? null : await insertLoop(db, workerId, 1, "do the work");
            if (loopId !== null) {
                await db.test_set_loop_status.run({
                    id: loopId,
                    status,
                    terminal_result: status === 500 ? JSON.stringify(Results.attachInstance(
                        Results.failure("engine:fixture", "failed", 500, "Work failed."), `worker://worker-${lifecycle}`,
                    ))
                        : status === 200 ? JSON.stringify({ status: 200 }) : null,
                });
            }
            engine.documents = [{ pathname: "/_plurnk/plurnk/tool.md", content: "# Tool\n\nReady." }];
            await LoopDocs.materialize(engine, db, workspaceId);
            const worker = await daemon.readWorker({ workspaceId, identity: { id: workerId } });
            assert.equal(worker?.lifecycle, lifecycle, "housekeeping does not replace work status");
            assert.equal((await daemon.listWorkers(workspaceId)).find(({ id }) => id === workerId)?.lifecycle, lifecycle);
            assert.deepEqual((await daemon.listWorkerLoops({ workspaceId, workerId })).map(({ id }) => id), loopId === null ? [] : [loopId],
                "status snapshots see work, not administrative housekeeping loops");
            const loops = await db.test_loop_queue_by_worker.all<{ id: number }>({ worker_id: workerId });
            assert.deepEqual(loops.map(({ id }) => id), loopId === null ? [] : [loopId]);
            const maintenance = await db.test_get_loop_by_worker.get<{ id: number }>({ worker_id: await RuntimeWorker.ensure(db, workspaceId) });
            assert.ok(maintenance);
            const turns = await db.test_list_turns_in_loop.all<{ kind: string }>({ loop_id: maintenance.id });
            assert.deepEqual(turns.map(({ kind }) => kind), ["maintenance"], "maintenance remains ordinary durable history");
        }
    } finally {
        await daemon.stop();
        await db.close();
    }
});

test("{§env-delta-child-termination} generated child documentation is durable without publishing a task conclusion", async () => {
    const db = await openMigrated();
    try {
        const engine = new FixtureEngine({ db, schemes: new SchemeRegistry(), mimetypes: DEFAULT_MIMETYPES });
        const workspaceId = await insertWorkspace(db, "child-docs-conclusion");
        const parentId = await insertWorker(db, workspaceId, null, "parent");
        const childId = await insertWorker(db, workspaceId, parentId, "child");
        const parentLoopId = await insertLoop(db, parentId, 1, "observe child");
        engine.documents = [{ pathname: "/_plurnk/plurnk/tool.md", content: "# Tool\n\nReady to use." }];

        await LoopDocs.materialize(engine, db, workspaceId);
        assert.equal(await db.test_get_loop_by_worker.get({ worker_id: childId }), undefined);
        const adminLoop = await db.test_get_loop_by_worker.get<{ id: number }>({ worker_id: await RuntimeWorker.ensure(db, workspaceId) });
        assert.ok(adminLoop);
        assert.equal((await db.test_get_loop_status.get<{ status: number }>({ id: adminLoop.id }))?.status, 200,
            "the real maintenance program concluded");
        const turns = await db.test_list_turns_in_loop.all<{ id: number; producer: string; kind: string; status: number }>({ loop_id: adminLoop.id });
        assert.deepEqual(turns.map(({ producer, kind, status }) => ({ producer, kind, status })), [
            { producer: "_plurnk", kind: "maintenance", status: 200 },
        ]);
        const doc = await db.test_get_channel_by_pathname_scheme.get<{ content: string }>({
            pathname: "/_plurnk/plurnk/tool.md", scheme: "worker", name: "body",
        });
        assert.equal(doc?.content, engine.documents[0]!.content, "the program actually materialized its resource");
        const source = await db.test_log_sequencees_by_turn.all<{ op: string; status_rx: number }>({ turn_id: turns[0]!.id });
        assert.ok(source.some(({ op, status_rx }) => op === "EDIT" && status_rx === 201), "the source operation receipt remains durable");
        assert.equal(await db.engine_worker_has_undelivered_child_term.get({ worker_id: parentId }), undefined,
            "housekeeping is not an unobserved child result that can wake waiting work or refuse completion");

        const result = await engine.runTurn({
            provider: new Mock({ contextWindow: 100000, responses: [{ assistant: { content: "", reasoning: null, ops: [dispositionStmt("completed")] } }] }),
            workspaceId, workerId: parentId, loopId: parentLoopId,
            messages: [{ role: "system", content: "Observe the child." }, { role: "user", content: "continue" }],
        });
        assert.equal(result.status, 200);
        const rows = await db.engine_render_log.all<{ source: string | null }>({ worker_id: parentId });
        assert.deepEqual(rows.filter(({ source }) => source === "worker://child"), [],
            "the parent's real packet path contains no invented child deliverable");
    } finally { await db.close(); }
});

test("{§schemes-self-doc-materialization} worker documentation materialization removes stale generated entries", async () => {
    const db = await openMigrated();
    try {
        const engine = new FixtureEngine({
            db,
            schemes: new SchemeRegistry(),
            mimetypes: DEFAULT_MIMETYPES,
        });
        const workspaceId = await insertWorkspace(db, `loop-docs-${crypto.randomUUID()}`);
        await insertWorker(db, workspaceId);
        const entry = (pathname: string) => db.crud_find_workspace_entry.get<{ id: number }>({
            workspace_id: workspaceId,
            scheme: "worker",
            authority: "",
            pathname,
        });

        engine.documents = [
            { pathname: "/_plurnk/plurnk/retired.md", content: "# Retired" },
            { pathname: "/_plurnk/plurnk/tool-retired.md", content: "# Retired tool" },
        ];
        await LoopDocs.materialize(engine, db, workspaceId);
        assert.notEqual(await entry("/_plurnk/plurnk/retired.md"), undefined);
        assert.notEqual(await entry("/_plurnk/plurnk/tool-retired.md"), undefined);

        engine.documents = [
            { pathname: "/_plurnk/plurnk/current.md", content: "# Current" },
            { pathname: "/_plurnk/plurnk/tool-current.md", content: "# Current tool" },
        ];
        await LoopDocs.materialize(engine, db, workspaceId);
        assert.equal(await entry("/_plurnk/plurnk/retired.md"), undefined);
        assert.equal(await entry("/_plurnk/plurnk/tool-retired.md"), undefined);
        assert.notEqual(await entry("/_plurnk/plurnk/current.md"), undefined);
        assert.notEqual(await entry("/_plurnk/plurnk/tool-current.md"), undefined);
    } finally {
        await db.close();
    }
});

for (const runtime of ["jq", "sqlite"]) test(`{§exec-executor-slot}: installed ${runtime} examples and fenced README programs preserve executor/target ownership`, async (t) => {
    const executors = await testExecutors();
    if (!executors.availableRuntimes().includes(runtime)) return t.skip(`${runtime} is not installed`);
    const db = await openMigrated();
    try {
        const engine = new Engine({ db, schemes: new SchemeRegistry(), mimetypes: DEFAULT_MIMETYPES });
        engine.setExecutors(executors);
        const workspaceId = await insertWorkspace(db, `${runtime}-doc-invocations`);
        await insertWorker(db, workspaceId);
        await LoopDocs.materialize(engine, db, workspaceId);
        const doc = await db.test_get_channel_by_pathname_scheme.get<{ content: string }>({
            pathname: `/_plurnk/plurnk/${runtime}.md`, scheme: "worker", name: "body",
        });
        assert.ok(doc, "the installed executor's documentation reaches the worker");
        const readme = await readFile(new URL("README.md", import.meta.resolve(`@plurnk/plurnk-execs-${runtime}/package.json`)), "utf8");
        const examples = [doc.content, readme].flatMap((content) => Lexer.lex(content)
            .filter((token) => token.type === "code" && token.lang?.split(/[ \t]/)[0] === runtime));
        assert.ok(examples.length > 0, `${runtime} has executable examples`);
        const execs = examples.flatMap(({ raw }) => {
            const parsed = PlurnkParser.parseStatements(raw);
            assert.equal(parsed.unparsedTail, undefined, raw);
            assert.equal(parsed.items.length, 1, raw);
            assert.equal(parsed.items[0]?.kind, "statement", raw);
            return parsed.items.flatMap((item) => item.kind === "statement" && item.statement.op === "EXEC" ? [item.statement] : []);
        });
        assert.ok(execs.length > 0);
        assert.ok(execs.every(({ executor }) => executor === runtime), `${runtime} is the executor, never the input target`);
        assert.ok(execs.some(({ target }) => target === null), `${runtime} demonstrates the no-target form`);
        assert.ok(execs.some(({ target }) => target?.kind === "local"), `${runtime} demonstrates a data file target`);
        const runtimeSources = execs.flatMap(({ target }) => target?.kind === "url" && executors.availableRuntimes().includes(target.scheme) ? [target] : []);
        if (runtime === "jq") assert.ok(runtimeSources.length > 0, "jq demonstrates filtering another runtime's output");
        for (const target of runtimeSources) {
            assert.match(target.pathname, /^\/[a-f0-9]{8}$/, `${runtime} uses an address independent of log coordinates`);
        }
    } finally { await db.close(); }
});

test("{§schemes-self-doc-materialization} an unchanged generated surface dispatches nothing on re-materialization", async () => {
    const db = await openMigrated();
    try {
        const engine = new FixtureEngine({
            db,
            schemes: new SchemeRegistry(),
            mimetypes: DEFAULT_MIMETYPES,
        });
        const workspaceId = await insertWorkspace(db, `loop-docs-idem-${crypto.randomUUID()}`);
        await insertWorker(db, workspaceId);
        engine.documents = [
            { pathname: "/_plurnk/plurnk/stable.md", content: "# Stable" },
        ];
        await LoopDocs.materialize(engine, db, workspaceId);
        const runtime = await db.worker_resolve_by_name.get<{ id: number }>({ workspace_id: workspaceId, name: "plurnk" });
        assert.ok(runtime !== undefined, "maintenance has its actual runtime actor");
        const before = await db.test_get_loop_by_worker.get<{ id: number }>({ worker_id: runtime.id });
        assert.ok(before !== undefined, "initial materialization recorded a maintenance loop");

        await LoopDocs.materialize(engine, db, workspaceId);
        const after = await db.test_get_loop_by_worker.get<{ id: number }>({ worker_id: runtime.id });
        assert.equal(after?.id, before?.id, "the unchanged surface re-dispatches nothing — no new _plurnk turn, no 304 churn");
    } finally {
        await db.close();
    }
});

test("{§exec-stream-page}: materialized shell documentation demonstrates scoped READ of an EXEC stream", async () => {
    const db = await openMigrated();
    try {
        const engine = new Engine({ db, schemes: new SchemeRegistry(), mimetypes: DEFAULT_MIMETYPES });
        engine.setExecutors(await testExecutors());
        const workspaceId = await insertWorkspace(db, "shell-doc-stream-read");
        await insertWorker(db, workspaceId);
        await LoopDocs.materialize(engine, db, workspaceId);
        const doc = await db.test_get_channel_by_pathname_scheme.get<{ content: string }>({
            pathname: "/_plurnk/plurnk/sh.md", scheme: "worker", name: "body",
        });
        assert.ok(doc, "the installed shell's documentation reaches the worker");
        const examples = Lexer.lex(doc.content).flatMap((token) =>
            token.type === "code" && token.lang?.startsWith("READ ") ? [token.raw] : []);
        const reads = examples.flatMap((source) => {
            const parsed = PlurnkParser.parseStatements(source);
            assert.equal(parsed.unparsedTail, undefined, source);
            assert.equal(parsed.items.length, 1, source);
            assert.equal(parsed.items[0]?.kind, "statement", source);
            return parsed.items.flatMap((item) => item.kind === "statement" && item.statement.op === "READ" ? [item.statement] : []);
        });
        assert.ok(reads.length > 0, "the doc demonstrates fetching beyond the terminal observation");
        for (const read of reads) {
            assert.equal(read.target?.kind, "url");
            if (read.target?.kind !== "url") throw new Error("The stream example must address a resource");
            assert.equal(read.target.scheme, "sh");
            assert.match(read.target.pathname, /^\/[a-f0-9]{8}$/);
            assert.equal(read.target.fragment, "stdout");
            assert.equal(read.lineMarker?.marks.length, 2, "the example selects a line interval");
        }
    } finally { await db.close(); }
});
