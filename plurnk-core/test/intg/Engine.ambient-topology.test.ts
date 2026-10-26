// Topology-scoped occurrence delivery: {§actor-boundary-lineage-attention},
// {§actor-boundary-commons-broadcast}, and {§machine-processes-fork-pending-activity}.

import test from "node:test";
import assert from "node:assert/strict";
import { Mock } from "@plurnk/plurnk-providers";
import {
    type KillStatement,
    type NoteStatement,
    type UrlPath,
} from "@plurnk/plurnk-contracts";
import Turn from "../../src/core/Turn.ts";
import Engine from "../../src/core/Engine.ts";
import Fork from "../../src/core/fork.ts";
import SchemeRegistry from "../../src/core/SchemeRegistry.ts";
import { copyStmt, editStmt, fullReplace, moveStmt } from "./_dsl.ts";
import { insertLoop, insertTurn, insertSession, insertWorkspace, openMigrated } from "./_db.ts";
import { logEntries } from "./_packet.ts";

const messages = [
    { role: "system" as const, content: "You are an agent." },
    { role: "user" as const, content: "continue" },
];

const continueResponse = () => ({
    assistant: {
        content: "",
        reasoning: null,
        ops: [{
            op: "NOTE",
            aside: null,
            metadata: null,
            target: null,
            lineMarker: null,
            body: "continue",
            position: { line: 1, column: 1 },
        } as NoteStatement],
    },
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

const kill = (target: UrlPath): KillStatement => ({
    metadata: null,
    op: "KILL",
    aside: null,
    target,
    lineMarker: null,
    matcher: null, body: null,
    position: { line: 1, column: 1 },
});

test("{§actor-boundary-lineage-attention} direct-child activity reaches its parent without leaking to a grandparent or independent root", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `lineage-activity-${crypto.randomUUID()}`);
        const grandparent = await insertSession(db, workspaceId, null, "grandparent");
        const parent = await insertSession(db, workspaceId, grandparent, "parent");
        const child = await insertSession(db, workspaceId, parent, "child");
        const independent = await insertSession(db, workspaceId, null, "independent");
        const grandparentLoop = await insertLoop(db, grandparent, 1, "observe");
        const parentLoop = await insertLoop(db, parent, 1, "observe");
        const independentLoop = await insertLoop(db, independent, 1, "observe");
        const childLoop = await insertLoop(db, child, 1, "work");
        const { id: childTurn } = await Turn.open(db, { loopId: childLoop, producer: "model", kind: "inference" });
        const engine = new Engine({ db, schemes: new SchemeRegistry() });
        const provider = new Mock({
            contextWindow: 100_000,
            responses: Array.from({ length: 6 }, continueResponse),
        });

        await engine.runTurn({ provider, workspaceId, sessionId: grandparent, loopId: grandparentLoop, messages, turnNumber: 1 });
        await engine.runTurn({ provider, workspaceId, sessionId: parent, loopId: parentLoop, messages, turnNumber: 1 });
        await engine.runTurn({ provider, workspaceId, sessionId: independent, loopId: independentLoop, messages, turnNumber: 1 });

        assert.equal((await engine.dispatch({
            statement: editStmt({ ...path("session", "/finding.md"), hostname: "child", raw: "session://child/finding.md" }, "Record the direct-child finding."),
            workspaceId,
            sessionId: child,
            loopId: childLoop,
            turnId: childTurn,
            sequence: 1,
            origin: "model",
        })).status, 201);
        assert.equal((await engine.dispatch({
            statement: editStmt(path("missing", "/evidence"), "A failed action."),
            workspaceId,
            sessionId: child,
            loopId: childLoop,
            turnId: childTurn,
            sequence: 2,
            origin: "model",
        })).status, 501);

        await engine.runTurn({ provider, workspaceId, sessionId: parent, loopId: parentLoop, messages, turnNumber: 2 });
        await engine.runTurn({ provider, workspaceId, sessionId: grandparent, loopId: grandparentLoop, messages, turnNumber: 2 });
        await engine.runTurn({ provider, workspaceId, sessionId: independent, loopId: independentLoop, messages, turnNumber: 2 });

        const observedFromChild = async (sessionId: number) => (await db.engine_render_log.all<{
            op: string;
            origin: string;
            source: string | null;
            initial_folded: string;
            folded: string;
        }>({ session_id: sessionId })).filter(({ origin, source }) => origin === "_plurnk" && source === "session://child");

        assert.deepEqual(
            (await observedFromChild(parent)).map(({ op }) => op),
            ["EDIT", "EDIT"],
            "the parent receives successful and failed child actions in causal order",
        );
        assert.ok(
            (await observedFromChild(parent)).every(({ initial_folded, folded }) => initial_folded === "[[1,-1]]" && folded === "[]"),
            "intermediate child activity is born body-suppressed, not trimmed",
        );
        assert.deepEqual(await observedFromChild(grandparent), [], "observer rows never recursively republish to the grandparent");
        assert.deepEqual(await observedFromChild(independent), [], "an independent root receives no lineage activity");
    } finally {
        await db.close();
    }
});

test("{§env-delta-child-activity} received messages remain local observations, not child-authored activity", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `lineage-prompt-${crypto.randomUUID()}`);
        const parent = await insertSession(db, workspaceId, null, "parent");
        const child = await insertSession(db, workspaceId, parent, "child");
        await insertSession(db, workspaceId, null, "peer");
        const parentLoop = await insertLoop(db, parent, 1, "observe");
        const childLoop = await insertLoop(db, child, 1, "inspect the delegated evidence");
        const engine = new Engine({ db, schemes: new SchemeRegistry() });

        await engine.runTurn({
            provider: new Mock({ contextWindow: 100_000, responses: [continueResponse()] }),
            workspaceId,
            sessionId: child,
            loopId: childLoop,
            messages,
            turnNumber: 1,
        });
        const arrivals = [
            { source: null, body: "inspect the delegated evidence" },
            { source: "session://parent", body: "An updated request from the parent." },
            { source: "session://peer", body: "An unrelated peer's request." },
            { source: "acp://operator/threads/child/messages/m1", body: "An external client's request." },
        ];
        for (const { source, body } of arrivals.slice(1)) {
            assert.ok(await engine.injectIntoLoop(childLoop, body, [], source!));
        }
        await engine.runTurn({
            provider: new Mock({ contextWindow: 100_000, responses: [continueResponse()] }),
            workspaceId,
            sessionId: child,
            loopId: childLoop,
            messages,
            turnNumber: 2,
        });
        const childRows = await db.engine_render_log.all<{
            attrs: string;
            source: string | null;
            tx: string;
        }>({ session_id: child });
        assert.deepEqual(
            childRows.filter(({ attrs }) => JSON.parse(attrs).kind === "message")
                .map(({ source, tx }) => ({ source, body: JSON.parse(tx).body.raw })),
            arrivals,
            "initial and mid-loop messages retain their original sender and body in the recipient's log",
        );
        await engine.runTurn({
            provider: new Mock({ contextWindow: 100_000, responses: [continueResponse()] }),
            workspaceId,
            sessionId: parent,
            loopId: parentLoop,
            messages,
            turnNumber: 1,
        });

        const rows = await db.engine_render_log.all<{
            op: string;
            origin: string;
            source: string | null;
        }>({ session_id: parent });
        assert.deepEqual(
            rows.filter(({ origin, source }) => origin === "_plurnk" && source === "session://child"),
            [],
            "receiving a request does not become an action attributed to its recipient",
        );
    } finally {
        await db.close();
    }
});

test("{§actor-boundary-lineage-attention} a fork inherits parent activity pending at its snapshot but not later sibling activity", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `fork-activity-${crypto.randomUUID()}`);
        const parent = await insertSession(db, workspaceId, null, "parent");
        const sibling = await insertSession(db, workspaceId, parent, "sibling");
        const parentLoop = await insertLoop(db, parent, 1, "observe");
        const siblingLoop = await insertLoop(db, sibling, 1, "work");
        const siblingTurn = await insertTurn(db, siblingLoop, 1);
        const engine = new Engine({ db, schemes: new SchemeRegistry() });
        const parentProvider = new Mock({ contextWindow: 100_000, responses: [continueResponse(), continueResponse()] });

        await engine.runTurn({
            provider: parentProvider,
            workspaceId,
            sessionId: parent,
            loopId: parentLoop,
            messages,
            turnNumber: 1,
        });
        assert.equal((await engine.dispatch({
            statement: editStmt({ ...path("session", "/finding.md"), hostname: "sibling", raw: "session://sibling/finding.md" }, "pending before fork"),
            workspaceId,
            sessionId: sibling,
            loopId: siblingLoop,
            turnId: siblingTurn,
            sequence: 1,
            origin: "model",
        })).status, 201);

        const branch = await Fork.fork(db, parent, "branch");
        const branchLoop = await insertLoop(db, branch, 2, "continue");

        assert.equal((await engine.dispatch({
            statement: editStmt(path("missing", "/after-fork"), "A failed action."),
            workspaceId,
            sessionId: sibling,
            loopId: siblingLoop,
            turnId: siblingTurn,
            sequence: 2,
            origin: "model",
        })).status, 501);

        await engine.runTurn({
            provider: new Mock({ contextWindow: 100_000, responses: [continueResponse()] }),
            workspaceId,
            sessionId: branch,
            loopId: branchLoop,
            messages,
            turnNumber: 1,
        });
        await engine.runTurn({
            provider: parentProvider,
            workspaceId,
            sessionId: parent,
            loopId: parentLoop,
            messages,
            turnNumber: 2,
        });

        const childOps = async (sessionId: number) => (await db.engine_render_log.all<{
            op: string;
            origin: string;
            source: string | null;
        }>({ session_id: sessionId }))
            .filter(({ origin, source }) => origin === "_plurnk" && source === "session://sibling")
            .map(({ op }) => op);

        assert.deepEqual(await childOps(branch), ["EDIT"], "the branch receives only the pending parent event inside its fork boundary");
        assert.deepEqual(await childOps(parent), ["EDIT", "EDIT"], "the parent independently receives both child events");
    } finally {
        await db.close();
    }
});

test("{§env-delta-no-coalescing} {§env-delta-commons-mutation} commons mutations broadcast one occurrence identity and deduplicate the direct parent audience", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `commons-audience-${crypto.randomUUID()}`);
        const parent = await insertSession(db, workspaceId, null, "parent");
        const child = await insertSession(db, workspaceId, parent, "child");
        const independent = await insertSession(db, workspaceId, null, "independent");
        const parentLoop = await insertLoop(db, parent, 1, "observe");
        const independentLoop = await insertLoop(db, independent, 1, "observe");
        const childLoop = await insertLoop(db, child, 1, "mutate");
        const childTurn = await insertTurn(db, childLoop, 1);
        const engine = new Engine({ db, schemes: new SchemeRegistry() });
        const dispatch = (statement: Parameters<Engine["dispatch"]>[0]["statement"], sequence: number) => engine.dispatch({
            statement,
            workspaceId,
            sessionId: child,
            loopId: childLoop,
            turnId: childTurn,
            sequence,
            origin: "model",
        });

        assert.equal((await dispatch(editStmt(path("workspace", "/source"), "shared"), 1)).status, 201);
        assert.ok([200, 201].includes((await dispatch(copyStmt(path("workspace", "/source"), path("workspace", "/copy")), 2)).status));
        assert.ok([200, 201].includes((await dispatch(moveStmt(path("workspace", "/copy"), path("workspace", "/moved")), 3)).status));
        assert.equal((await dispatch(kill(path("workspace", "/moved")), 4)).status, 200);
        assert.equal((await dispatch(editStmt(path("workspace", "/doomed"), "temporary"), 5)).status, 201);
        assert.equal((await dispatch(kill(path("workspace", "/doomed")), 6)).status, 200);
        assert.equal((await dispatch(editStmt(path("workspace", "/source"), "shared", fullReplace), 7)).status, 304);

        const late = await insertSession(db, workspaceId, null, "late");
        const lateLoop = await insertLoop(db, late, 1, "observe");
        const provider = new Mock({ contextWindow: 100_000, responses: [continueResponse(), continueResponse(), continueResponse()] });
        const parentTurn = await engine.runTurn({ provider, workspaceId, sessionId: parent, loopId: parentLoop, messages, turnNumber: 1 });
        await engine.runTurn({ provider, workspaceId, sessionId: independent, loopId: independentLoop, messages, turnNumber: 1 });
        await engine.runTurn({ provider, workspaceId, sessionId: late, loopId: lateLoop, messages, turnNumber: 1 });

        // {§log-address-metadata}: the real parent packet retains both operands and the actor.
        const storedPacket = await db.test_get_packet.get<{ packet: string }>({ id: parentTurn.turnId });
        const activity = logEntries(JSON.parse(storedPacket!.packet)).filter(({ source }) => source === "session://child");
        for (const [op, from, to] of [["COPY", "source", "copy"], ["MOVE", "copy", "moved"]]) {
            const receipt = activity.find(({ logPath }) => logPath.endsWith(`/${op}`));
            assert.ok(receipt, `the parent sees the child's ${op}`);
            assert.equal(receipt.source, "session://child");
            assert.equal(receipt.from, `workspace:///${from}`);
            assert.equal(receipt.to, `workspace:///${to}`);
            assert.equal(receipt.path, undefined);
            assert.equal(receipt.destination, undefined);
        }

        type Row = { op: string; origin: string; source: string | null; ambient_event_id: number | null; status_rx: number };
        const mutations = async (sessionId: number) => (await db.test_log_entries_by_session.all<Row>({ session_id: sessionId }))
            .filter(({ op }) => ["EDIT", "COPY", "MOVE", "KILL", "SEND"].includes(op));
        const source = await mutations(child);
        const parentRows = (await mutations(parent)).filter((row) => row.source === "session://child");
        const independentRows = (await mutations(independent)).filter((row) => row.source === "session://child");
        const lateRows = (await mutations(late)).filter((row) => row.source === "session://child");

        assert.deepEqual(parentRows.map(({ op }) => op), ["EDIT", "COPY", "MOVE", "KILL", "EDIT", "KILL", "EDIT"], "the parent gets one row per child operation, not lineage plus broadcast duplicates");
        assert.deepEqual(independentRows.map(({ op }) => op), ["EDIT", "COPY", "MOVE", "KILL", "EDIT", "KILL"], "every mutation kind that lands a commons effect broadcasts");
        assert.equal(parentRows.at(-1)?.status_rx, 304, "the parent still supervises its child's no-op operation");
        assert.ok(!independentRows.some(({ status_rx }) => status_rx === 304), "a no-op does not fabricate a commons state-change broadcast");
        assert.deepEqual(lateRows, [], "a session created after the mutations does not inherit broadcast history");
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
            (await db.test_sessions_count.get<{ n: number }>())?.n,
            0,
            "workspace teardown cascades the complete occurrence graph",
        );
    } finally {
        await db.close();
    }
});
