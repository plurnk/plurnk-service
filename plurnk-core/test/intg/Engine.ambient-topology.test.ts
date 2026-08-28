// Topology-scoped occurrence delivery: {§actor-boundary-lineage-attention},
// {§actor-boundary-commons-broadcast}, and {§machine-processes-fork-pending-activity}.

import test from "node:test";
import assert from "node:assert/strict";
import { Mock } from "@plurnk/plurnk-providers";
import {
    PlanValue,
    type KillStatement,
    type PlanStatement,
    type ReadStatement,
    type SendStatement,
    type UrlPath,
} from "@plurnk/plurnk-contracts";
import Engine from "../../src/core/Engine.ts";
import Fork from "../../src/core/fork.ts";
import SchemeRegistry from "../../src/core/SchemeRegistry.ts";
import { copyStmt, editStmt, fullReplace, moveStmt, sendStmt } from "./_dsl.ts";
import {
    insertLoop,
    insertTurn,
    insertWorker,
    insertWorkspace,
    openMigrated,
} from "./_helpers.ts";

const messages = [
    { role: "system" as const, content: "You are an agent." },
    { role: "user" as const, content: "continue" },
];

const continueResponse = () => ({
    assistant: {
        content: "",
        reasoning: null,
        ops: [{
            op: "SEND",
            annotation: null,
            delimiter: "",
            metadata: null,
            signal: 102,
            target: null,
            lineMarker: null,
            body: { raw: "continue", json: null },
            position: { line: 1, column: 1 },
        } as SendStatement],
    },
});

const plan = (body: string): PlanStatement => ({
    metadata: null,
    op: "PLAN",
    annotation: null,
    delimiter: "",
    signal: null,
    target: null,
    lineMarker: null,
    body: PlanValue.admit(body),
    position: { line: 1, column: 1 },
});

const path = (scheme: string, pathname: string): UrlPath => ({
    kind: "url",
    raw: `${scheme}://${pathname}`,
    scheme,
    username: null,
    password: null,
    hostname: null,
    port: null,
    pathname,
    query: null,
    fragment: null,
});

const read = (target: UrlPath): ReadStatement => ({
    metadata: null,
    op: "READ",
    annotation: null,
    delimiter: "",
    signal: null,
    target,
    lineMarker: null,
    body: null,
    position: { line: 1, column: 1 },
});

const kill = (target: UrlPath): KillStatement => ({
    metadata: null,
    op: "KILL",
    annotation: null,
    delimiter: "",
    signal: null,
    target,
    lineMarker: null,
    body: null,
    position: { line: 1, column: 1 },
});

test("direct-child activity reaches its parent without leaking to a grandparent or independent root", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `lineage-activity-${crypto.randomUUID()}`);
        const grandparent = await insertWorker(db, workspaceId, null, "grandparent");
        const parent = await insertWorker(db, workspaceId, grandparent, "parent");
        const child = await insertWorker(db, workspaceId, parent, "child");
        const independent = await insertWorker(db, workspaceId, null, "independent");
        const grandparentLoop = await insertLoop(db, grandparent, 1, "observe");
        const parentLoop = await insertLoop(db, parent, 1, "observe");
        const independentLoop = await insertLoop(db, independent, 1, "observe");
        const childLoop = await insertLoop(db, child, 1, "work");
        const childTurn = await insertTurn(db, childLoop, 1);
        const engine = new Engine({ db, schemes: new SchemeRegistry() });
        const provider = new Mock({
            contextWindow: 100_000,
            responses: Array.from({ length: 6 }, continueResponse),
        });

        await engine.runTurn({ provider, workspaceId, workerId: grandparent, loopId: grandparentLoop, messages, turnNumber: 1 });
        await engine.runTurn({ provider, workspaceId, workerId: parent, loopId: parentLoop, messages, turnNumber: 1 });
        await engine.runTurn({ provider, workspaceId, workerId: independent, loopId: independentLoop, messages, turnNumber: 1 });

        assert.equal((await engine.dispatch({
            statement: plan("Remember the direct-child finding."),
            workspaceId,
            workerId: child,
            loopId: childLoop,
            turnId: childTurn,
            sequence: 1,
            origin: "model",
        })).status, 200);
        assert.equal((await engine.dispatch({
            statement: read(path("missing", "/evidence")),
            workspaceId,
            workerId: child,
            loopId: childLoop,
            turnId: childTurn,
            sequence: 2,
            origin: "model",
        })).status, 501);

        await engine.runTurn({ provider, workspaceId, workerId: parent, loopId: parentLoop, messages, turnNumber: 2 });
        await engine.runTurn({ provider, workspaceId, workerId: grandparent, loopId: grandparentLoop, messages, turnNumber: 2 });
        await engine.runTurn({ provider, workspaceId, workerId: independent, loopId: independentLoop, messages, turnNumber: 2 });

        const observedFromChild = async (workerId: number) => (await db.engine_render_log.all<{
            op: string;
            origin: string;
            source: string | null;
            folded: string;
        }>({ worker_id: workerId })).filter(({ origin, source }) => origin === "_plurnk" && source === "worker://child");

        assert.deepEqual(
            (await observedFromChild(parent)).map(({ op }) => op),
            ["PLAN", "READ"],
            "the parent receives every final op-bearing child activity in causal order",
        );
        assert.ok(
            (await observedFromChild(parent)).every(({ folded }) => folded === "[[1,-1]]"),
            "intermediate child activity is born folded",
        );
        assert.deepEqual(await observedFromChild(grandparent), [], "observer rows never recursively republish to the grandparent");
        assert.deepEqual(await observedFromChild(independent), [], "an independent root receives no lineage activity");
    } finally {
        await db.close();
    }
});

test("a delegated prompt reaches the parent as ordinary folded child activity", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `lineage-prompt-${crypto.randomUUID()}`);
        const parent = await insertWorker(db, workspaceId, null, "parent");
        const child = await insertWorker(db, workspaceId, parent, "child");
        const parentLoop = await insertLoop(db, parent, 1, "observe");
        const childLoop = await insertLoop(db, child, 1, "inspect the delegated evidence");
        const engine = new Engine({ db, schemes: new SchemeRegistry() });

        await engine.runTurn({
            provider: new Mock({ contextWindow: 100_000, responses: [continueResponse()] }),
            workspaceId,
            workerId: child,
            loopId: childLoop,
            messages,
            turnNumber: 1,
        });
        await engine.runTurn({
            provider: new Mock({ contextWindow: 100_000, responses: [continueResponse()] }),
            workspaceId,
            workerId: parent,
            loopId: parentLoop,
            messages,
            turnNumber: 1,
        });

        const rows = await db.engine_render_log.all<{
            op: string;
            origin: string;
            source: string | null;
            rx: string;
            folded: string;
        }>({ worker_id: parent });
        const prompt = rows.find(({ op, origin, source }) => op === "prompt" && origin === "_plurnk" && source === "worker://child");
        assert.ok(prompt, "the real prompt-publication path reaches the direct parent");
        assert.match(prompt.rx, /inspect the delegated evidence/);
        assert.equal(prompt.folded, "[[1,-1]]");
    } finally {
        await db.close();
    }
});

test("a fork inherits parent activity pending at its snapshot but not later sibling activity", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `fork-activity-${crypto.randomUUID()}`);
        const parent = await insertWorker(db, workspaceId, null, "parent");
        const sibling = await insertWorker(db, workspaceId, parent, "sibling");
        const parentLoop = await insertLoop(db, parent, 1, "observe");
        const siblingLoop = await insertLoop(db, sibling, 1, "work");
        const siblingTurn = await insertTurn(db, siblingLoop, 1);
        const engine = new Engine({ db, schemes: new SchemeRegistry() });
        const parentProvider = new Mock({ contextWindow: 100_000, responses: [continueResponse(), continueResponse()] });

        await engine.runTurn({
            provider: parentProvider,
            workspaceId,
            workerId: parent,
            loopId: parentLoop,
            messages,
            turnNumber: 1,
        });
        await engine.dispatch({
            statement: plan("pending before fork"),
            workspaceId,
            workerId: sibling,
            loopId: siblingLoop,
            turnId: siblingTurn,
            sequence: 1,
            origin: "model",
        });

        const branch = await Fork.fork(db, parent, "branch", () => "none");
        const branchLoop = await insertLoop(db, branch, 2, "continue");

        await engine.dispatch({
            statement: read(path("missing", "/after-fork")),
            workspaceId,
            workerId: sibling,
            loopId: siblingLoop,
            turnId: siblingTurn,
            sequence: 2,
            origin: "model",
        });

        await engine.runTurn({
            provider: new Mock({ contextWindow: 100_000, responses: [continueResponse()] }),
            workspaceId,
            workerId: branch,
            loopId: branchLoop,
            messages,
            turnNumber: 1,
        });
        await engine.runTurn({
            provider: parentProvider,
            workspaceId,
            workerId: parent,
            loopId: parentLoop,
            messages,
            turnNumber: 2,
        });

        const childOps = async (workerId: number) => (await db.engine_render_log.all<{
            op: string;
            origin: string;
            source: string | null;
        }>({ worker_id: workerId }))
            .filter(({ origin, source }) => origin === "_plurnk" && source === "worker://sibling")
            .map(({ op }) => op);

        assert.deepEqual(await childOps(branch), ["PLAN"], "the branch receives only the pending parent event inside its fork boundary");
        assert.deepEqual(await childOps(parent), ["PLAN", "READ"], "the parent independently receives both child events");
    } finally {
        await db.close();
    }
});

test("commons mutations broadcast one occurrence identity and deduplicate the direct parent audience", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `commons-audience-${crypto.randomUUID()}`);
        const parent = await insertWorker(db, workspaceId, null, "parent");
        const child = await insertWorker(db, workspaceId, parent, "child");
        const independent = await insertWorker(db, workspaceId, null, "independent");
        const parentLoop = await insertLoop(db, parent, 1, "observe");
        const independentLoop = await insertLoop(db, independent, 1, "observe");
        const childLoop = await insertLoop(db, child, 1, "mutate");
        const childTurn = await insertTurn(db, childLoop, 1);
        const engine = new Engine({ db, schemes: new SchemeRegistry() });
        const dispatch = (statement: Parameters<Engine["dispatch"]>[0]["statement"], sequence: number) => engine.dispatch({
            statement,
            workspaceId,
            workerId: child,
            loopId: childLoop,
            turnId: childTurn,
            sequence,
            origin: "model",
        });

        assert.equal((await dispatch(editStmt(path("worker", "/source"), "shared"), 1)).status, 201);
        assert.ok([200, 201].includes((await dispatch(copyStmt(path("worker", "/source"), path("worker", "/copy")), 2)).status));
        assert.ok([200, 201].includes((await dispatch(moveStmt(path("worker", "/copy"), path("worker", "/moved")), 3)).status));
        assert.equal((await dispatch(kill(path("worker", "/moved")), 4)).status, 200);
        assert.equal((await dispatch(editStmt(path("worker", "/doomed"), "temporary"), 5)).status, 201);
        assert.equal((await dispatch(sendStmt(410, path("worker", "/doomed")), 6)).status, 200);
        assert.equal((await dispatch(editStmt(path("worker", "/source"), "shared", null, fullReplace), 7)).status, 304);

        const late = await insertWorker(db, workspaceId, null, "late");
        const lateLoop = await insertLoop(db, late, 1, "observe");
        const provider = new Mock({ contextWindow: 100_000, responses: [continueResponse(), continueResponse(), continueResponse()] });
        await engine.runTurn({ provider, workspaceId, workerId: parent, loopId: parentLoop, messages, turnNumber: 1 });
        await engine.runTurn({ provider, workspaceId, workerId: independent, loopId: independentLoop, messages, turnNumber: 1 });
        await engine.runTurn({ provider, workspaceId, workerId: late, loopId: lateLoop, messages, turnNumber: 1 });

        type Row = { op: string; origin: string; source: string | null; ambient_event_id: number | null; status_rx: number };
        const mutations = async (workerId: number) => (await db.test_log_entries_by_worker.all<Row>({ worker_id: workerId }))
            .filter(({ op }) => ["EDIT", "COPY", "MOVE", "KILL", "SEND"].includes(op));
        const source = await mutations(child);
        const parentRows = (await mutations(parent)).filter(({ source }) => source === "worker://child");
        const independentRows = (await mutations(independent)).filter(({ source }) => source === "worker://child");
        const lateRows = (await mutations(late)).filter(({ source }) => source === "worker://child");

        assert.deepEqual(parentRows.map(({ op }) => op), ["EDIT", "COPY", "MOVE", "KILL", "EDIT", "SEND", "EDIT"], "the parent gets one row per child operation, not lineage plus broadcast duplicates");
        assert.deepEqual(independentRows.map(({ op }) => op), ["EDIT", "COPY", "MOVE", "KILL", "EDIT", "SEND"], "every mutation kind that lands a commons effect broadcasts");
        assert.equal(parentRows.at(-1)?.status_rx, 304, "the parent still supervises its child's no-op operation");
        assert.ok(!independentRows.some(({ status_rx }) => status_rx === 304), "a no-op does not fabricate a commons state-change broadcast");
        assert.deepEqual(lateRows, [], "a worker created after the mutations does not inherit broadcast history");
        assert.deepEqual(
            parentRows.map(({ ambient_event_id }) => ambient_event_id),
            source.map(({ ambient_event_id }) => ambient_event_id),
            "the parent rows retain the source occurrence identities",
        );
        assert.deepEqual(
            independentRows.map(({ ambient_event_id }) => ambient_event_id),
            source.slice(0, -1).map(({ ambient_event_id }) => ambient_event_id),
            "the workspace audience observes those same identities",
        );
        assert.ok(source.every(({ ambient_event_id }) => ambient_event_id !== null));
        await db.test_workspaces_delete.run({ id: workspaceId });
        assert.equal(
            (await db.test_workers_count.get<{ n: number }>())?.n,
            0,
            "workspace teardown cascades the complete occurrence graph",
        );
    } finally {
        await db.close();
    }
});
