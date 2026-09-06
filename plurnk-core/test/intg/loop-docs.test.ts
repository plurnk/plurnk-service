import assert from "node:assert/strict";
import test from "node:test";
import Engine from "../../src/core/Engine.ts";
import SchemeRegistry from "../../src/core/SchemeRegistry.ts";
import LoopDocs from "../../src/server/loopDocs.ts";
import TurnOps from "../../src/core/TurnOps.ts";
import { Mock } from "@plurnk/plurnk-providers";
import { sendStmt } from "./_dsl.ts";
import { DEFAULT_MIMETYPES, insertLoop, insertWorker, insertWorkspace, openMigrated, testExecutors } from "./_helpers.ts";

class FixtureEngine extends Engine {
    documents: Array<{ pathname: string; content: string }> = [];

    override async referenceEntries(): Promise<Array<{ pathname: string; content: string }>> {
        return this.documents;
    }
}

test("{§env-delta-child-termination} generated child documentation is durable without publishing a task conclusion", async () => {
    const db = await openMigrated();
    try {
        const engine = new FixtureEngine({ db, schemes: new SchemeRegistry(), mimetypes: DEFAULT_MIMETYPES });
        const workspaceId = await insertWorkspace(db, "child-docs-conclusion");
        const parentId = await insertWorker(db, workspaceId, null, "parent");
        const childId = await insertWorker(db, workspaceId, parentId, "child");
        const parentLoopId = await insertLoop(db, parentId, 1, "observe child");
        engine.documents = [{ pathname: "/_plurnk/plurnk/tool.md", content: "# Tool\n\nReady to use." }];

        await LoopDocs.materialize(engine, db, workspaceId, childId);
        const adminLoop = await db.test_get_loop_by_worker.get<{ id: number }>({ worker_id: childId });
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
            "housekeeping is not an unobserved child result that can advance WAIT or refuse TERM");

        const result = await engine.runTurn({
            provider: new Mock({ contextWindow: 100000, responses: [{ assistant: { content: "", reasoning: null, ops: [sendStmt(200)] } }] }),
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
        const workerId = await insertWorker(db, workspaceId);
        const entry = (pathname: string) => db.crud_find_workspace_entry.get<{ id: number }>({
            workspace_id: workspaceId,
            owner_id: workerId,
            scheme: "worker",
            authority: "",
            pathname,
        });

        engine.documents = [
            { pathname: "/_plurnk/plurnk/retired.md", content: "# Retired" },
            { pathname: "/_plurnk/plurnk/tool-retired.md", content: "# Retired tool" },
        ];
        await LoopDocs.materialize(engine, db, workspaceId, workerId);
        assert.notEqual(await entry("/_plurnk/plurnk/retired.md"), undefined);
        assert.notEqual(await entry("/_plurnk/plurnk/tool-retired.md"), undefined);

        engine.documents = [
            { pathname: "/_plurnk/plurnk/current.md", content: "# Current" },
            { pathname: "/_plurnk/plurnk/tool-current.md", content: "# Current tool" },
        ];
        await LoopDocs.materialize(engine, db, workspaceId, workerId);
        assert.equal(await entry("/_plurnk/plurnk/retired.md"), undefined);
        assert.equal(await entry("/_plurnk/plurnk/tool-retired.md"), undefined);
        assert.notEqual(await entry("/_plurnk/plurnk/current.md"), undefined);
        assert.notEqual(await entry("/_plurnk/plurnk/tool-current.md"), undefined);
    } finally {
        await db.close();
    }
});

test("{§exec-executor-slot}: materialized jq documentation selects jq for every executable example", async (t) => {
    const executors = await testExecutors();
    if (!executors.availableRuntimes().includes("jq")) return t.skip("jq is not installed");
    const db = await openMigrated();
    try {
        const engine = new Engine({ db, schemes: new SchemeRegistry(), mimetypes: DEFAULT_MIMETYPES });
        engine.setExecutors(executors);
        const workspaceId = await insertWorkspace(db, "jq-doc-invocations");
        const workerId = await insertWorker(db, workspaceId);
        await LoopDocs.materialize(engine, db, workspaceId, workerId);
        const doc = await db.test_get_channel_by_pathname_scheme.get<{ content: string }>({
            pathname: "/_plurnk/plurnk/jq.md", scheme: "worker", name: "body",
        });
        assert.ok(doc, "the installed executor's documentation reaches the worker");
        const examples = [...doc.content.matchAll(/^```example\n([\s\S]*?)\n```/gm)];
        assert.ok(examples.length > 0, "the document has executable examples");
        const execs = examples.flatMap(([, source]) => TurnOps.parseInternal(`## PLAN0\n[]\n${source}\n### SEND0 (NEXT)\nReview the results.`))
            .filter((statement) => statement.op === "EXEC");
        assert.ok(execs.length > 0);
        assert.ok(execs.every(({ executor }) => executor === "jq"), "jq is the executor, never the input target");
        assert.ok(execs.some(({ target }) => target === null), "construction without input remains demonstrated");
        assert.ok(execs.some(({ target }) => target?.raw === "data.json"), "file input remains demonstrated");
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
        const workerId = await insertWorker(db, workspaceId);
        engine.documents = [
            { pathname: "/_plurnk/plurnk/stable.md", content: "# Stable" },
        ];
        await LoopDocs.materialize(engine, db, workspaceId, workerId);
        const before = await db.test_get_loop_by_worker.get<{ id: number }>({ worker_id: workerId });

        await LoopDocs.materialize(engine, db, workspaceId, workerId);
        const after = await db.test_get_loop_by_worker.get<{ id: number }>({ worker_id: workerId });
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
        const workerId = await insertWorker(db, workspaceId);
        await LoopDocs.materialize(engine, db, workspaceId, workerId);
        const doc = await db.test_get_channel_by_pathname_scheme.get<{ content: string }>({
            pathname: "/_plurnk/plurnk/sh.md", scheme: "worker", name: "body",
        });
        assert.ok(doc, "the installed shell's documentation reaches the worker");
        const examples = [...doc.content.matchAll(/^```example\n([\s\S]*?)\n```/gm)];
        const reads = examples.flatMap(([, source]) => TurnOps.parseInternal(`## PLAN0\n[]\n${source}\n### SEND0 (NEXT)\nReview the results.`))
            .filter((statement) => statement.op === "READ");
        assert.ok(reads.length > 0, "the doc demonstrates fetching beyond the terminal observation");
        for (const read of reads) {
            assert.equal(read.target?.kind, "url");
            if (read.target?.kind !== "url") throw new Error("The stream example must address a resource");
            assert.equal(read.target.scheme, "sh");
            assert.match(read.target.pathname, /^\/\d+\/\d+\/\d+\/EXEC$/);
            assert.equal(read.target.fragment, "stdout");
            assert.equal(read.lineMarker?.marks.length, 2, "the example selects a line interval");
        }
    } finally { await db.close(); }
});
