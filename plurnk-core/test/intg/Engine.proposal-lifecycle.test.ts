// Proposal lifecycle (SPEC.md {§engine-rails} + {§methods}). When a scheme returns
// status 202, the engine writes a state='proposed' log entry and pauses
// dispatch until Engine.resolveProposal feeds back a decision. These tests
// exercise the pause/resume machinery + the log-render visibility filter
// against a tiny test scheme that always proposes.

import { ownSession, serverProposals, TEST_OWNER } from "./_approval.ts";
import test from "node:test";
import assert from "node:assert/strict";
import { OperationFailureError } from "../../src/core/results.ts";
import { type EditStatement, type ProposalResolution } from "@plurnk/plurnk-contracts";
import Engine from "../../src/core/Engine.ts";
import SchemeRegistry from "../../src/core/SchemeRegistry.ts";
import type { Db } from "../../src/core/Db.ts";
import type { SchemeManifest } from "../../src/core/scheme-types.ts";
import { openMigrated, insertWorkspace, insertSession, insertLoop, insertTurn } from "./_db.ts";
import { parseDsl } from "./_mock.ts";
import { sendStmt, urlPath } from "./_dsl.ts";
import type { ProposalApplyRequest } from "@plurnk/plurnk-schemes";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Digest } from "@plurnk/plurnk-digest";
import EvidenceReader from "../../src/evidence/EvidenceReader.ts";
import { HARNESS_WAIT_MS } from "./_rpc.ts";

// Minimal proposing scheme. `edit` returns 202 with attrs the test asserts on.
class ProposingTest {
    #beforePropose: (() => Promise<void>) | undefined;

    constructor(beforePropose?: () => Promise<void>) {
        this.#beforePropose = beforePropose;
    }

    static manifest: SchemeManifest = {
        name: "proposing-test",
        channels: {},
        defaultChannel: "body",
        category: "data",
        writableBy: ["model", "client"],
        volatile: false,
        modelVisible: true,
    };
    async editBatch(): Promise<{ status: number; attrs: object; body: string }> {
        await this.#beforePropose?.();
        return {
            status: 202,
            body: "--- proposed-test\n+++ proposed-test\n@@ +x @@",
            attrs: { path: "/proposed-test", patch: "@@ +x @@" },
        };
    }

    async send(): Promise<{ status: number; attrs: object; body: string }> {
        return this.editBatch();
    }
}

const editStmt = (pathname: string, body: string): EditStatement => ({
    metadata: null,
    op: "EDIT", aside: null,
    target: { kind: "url", raw: `proposing-test://${pathname}`, scheme: "proposing-test",
        username: null, password: null, hostname: null, port: null,
        pathname, query: null, fragment: null },
    lineMarker: null, body, matcher: null, position: { line: 1, column: 1 },
});

const setupEngine = async (db: Db, proposing: ProposingTest = new ProposingTest()): Promise<{
    engine: Engine; workspaceId: number; sessionId: number; loopId: number; turnId: number;
}> => {
    const schemes = new SchemeRegistry();
    schemes.register("proposing-test", proposing);
    const engine = new Engine({ db, schemes });
    const workspaceId = await insertWorkspace(db, `prop-${crypto.randomUUID()}`);
    const sessionId = await insertSession(db, workspaceId);
    await ownSession(db, workspaceId, sessionId);
    const loopId = await insertLoop(db, sessionId, 1, "proposal test");
    const turnId = await insertTurn(db, loopId, 1, 102);
    return { engine, workspaceId, sessionId, loopId, turnId };
};

// Deferred promise: resolves when onDispatch fires with the log entry id.
// This is deterministic — no setImmediate race with the DB roundtrip inside
// dispatch's write-log step.
const deferred = <T>(): { promise: Promise<T>; resolve: (v: T) => void } => {
    let resolve!: (v: T) => void;
    const promise = new Promise<T>((res) => { resolve = res; });
    return { promise, resolve };
};

const dispatchAndResolve = async (engine: Engine, ctx: {
    workspaceId: number; sessionId: number; loopId: number; turnId: number;
}, resolution: ProposalResolution): Promise<{ status: number; logEntryId: number }> => {
    const idDeferred = deferred<number>();
    const dispatchPromise = engine.dispatch({
        statement: editStmt("/x", "y"),
        workspaceId: ctx.workspaceId, sessionId: ctx.sessionId, loopId: ctx.loopId, turnId: ctx.turnId,
        sequence: 1, origin: "model",
        onDispatch: (id) => idDeferred.resolve(id),
    });
    const logEntryId = await idDeferred.promise;
    await engine.resolveProposal(logEntryId, resolution, TEST_OWNER);
    const result = await dispatchPromise;
    return { status: result.status, logEntryId };
};

test("{§proposal-decision-evidence}: original approval is durable before a failing effect and cannot be rewritten", async () => {
    const db = await openMigrated();
    try {
        let logEntryId = 0;
        let applications = 0;
        class Applying extends ProposingTest {
            async applyResolution(request: ProposalApplyRequest) {
                applications++;
                const decision = await db.test_proposal_decision.get({ id: logEntryId });
                assert.deepEqual(decision, {
                    decision: "accept", resolver: TEST_OWNER, body: "reviewed body", outcome: "reviewed",
                    decided_at: decision?.decided_at,
                });
                assert.match(String(decision?.decided_at), /^\d{4}-\d{2}-\d{2}T/);
                assert.equal(request.body, "reviewed body");
                return { status: 409, problem: {
                    type: "https://problems.plurnk.xyz/test/conflict", title: "Conflict", status: 409,
                    detail: "The resource changed after review.",
                }, outcome: "changed" };
            }
        }
        const ctx = await setupEngine(db, new Applying());
        const id = deferred<number>();
        const dispatch = ctx.engine.dispatch({ ...ctx, statement: editStmt("/x", "original body"),
            sequence: 1, origin: "model", onDispatch: id.resolve });
        logEntryId = await id.promise;
        await ctx.engine.resolveProposal(logEntryId, { decision: "accept", body: "reviewed body", outcome: "reviewed" }, TEST_OWNER);
        assert.equal((await dispatch).status, 409);
        assert.equal(applications, 1);
        assert.equal((await db.test_proposal_decision.get({ id: logEntryId }))?.decision, "accept");
        assert.equal((await db.test_get_log_entry_by_id.get({ id: logEntryId }))?.outcome, "changed");
        assert.throws(() => ctx.engine.resolveProposal(logEntryId, { decision: "reject" }, TEST_OWNER), /not pending/);
        await assert.rejects(db.test_proposal_decision_rewrite.run({ id: logEntryId }), /proposal decisions are immutable/);
        await assert.rejects(db.test_proposal_decision_delete.run({ id: logEntryId }), /proposal decisions belong to operation history/);
    } finally { await db.close(); }
});

test("{§proposal-decision-evidence}: an unrecordable approval cannot execute", async (t) => {
    const db = await openMigrated();
    try {
        let applications = 0;
        class Applying extends ProposingTest {
            async applyResolution() { applications++; return { status: 200 }; }
        }
        const ctx = await setupEngine(db, new Applying());
        const failure = new Error("fixture decision persistence failure");
        t.mock.method(db.proposal_record_decision, "run", async () => { throw failure; });
        const id = deferred<number>();
        const dispatch = ctx.engine.dispatch({ ...ctx, statement: editStmt("/x", "y"),
            sequence: 1, origin: "model", onDispatch: id.resolve });
        const rejected = assert.rejects(dispatch, (cause) => cause === failure);
        const logEntryId = await id.promise;
        await assert.rejects(ctx.engine.resolveProposal(logEntryId, { decision: "accept" }, TEST_OWNER), (cause) => cause === failure);
        await rejected;
        assert.equal(applications, 0);
        assert.equal(await db.test_proposal_decision.get({ id: logEntryId }), undefined);
        const row = await db.test_get_log_entry_by_id.get({ id: logEntryId });
        assert.equal(row?.state, "failed");
        assert.equal(row?.status_rx, 500);
        assert.match(String(row?.rx), /proposal-decision-unrecorded/);
        assert.deepEqual(ctx.engine.pendingProposalIds(), []);
    } finally { await db.close(); }
});

test("{§digest-proposal-decisions}: curation retains original approval in the report until its history is deleted", async () => {
    const directory = await mkdtemp(join(tmpdir(), "plurnk-proposal-evidence-"));
    const dbPath = join(directory, "plurnk.db");
    const db = await openMigrated(dbPath);
    try {
        const ctx = await setupEngine(db);
        const { logEntryId } = await dispatchAndResolve(ctx.engine, ctx, {
            decision: "accept", body: "reviewed override", outcome: "reviewed",
        });
        const decision = await db.test_proposal_decision.get({ id: logEntryId });
        const [statement] = parseDsl("````KILL (log:///1/1/1/EDIT)\n````");
        assert.ok(statement);
        assert.equal((await ctx.engine.dispatch({ ...ctx, statement, sequence: 2, origin: "model" })).status, 200);
        const digestDir = join(directory, "digest");
        Digest.run({ openEvidence: EvidenceReader.open, dbPath, digestDir });
        const report = JSON.parse(await readFile(join(digestDir, "digest.json"), "utf8"));
        const row = report.log_entries.find((entry: { id: number }) => entry.id === logEntryId);
        assert.equal(row.projection.active, false);
        assert.deepEqual(row.proposalDecision, decision);
        const markdown = await readFile(join(digestDir, "digest.md"), "utf8");
        assert.match(markdown, /decision=accept resolver=test:\/\/primary at=.*body override recorded outcome=reviewed/);
        await db.test_delete_session.run({ id: ctx.sessionId });
        assert.equal(await db.test_proposal_decision.get({ id: logEntryId }), undefined);
    } finally {
        await db.close();
        await rm(directory, { recursive: true, force: true });
    }
});

test("{§proposal-decision-evidence}: effect-policy acceptance records runtime authority before applying", async (t) => {
    const prior = process.env.PLURNK_SERVICE_EFFECT_HOST;
    process.env.PLURNK_SERVICE_EFFECT_HOST = "auto";
    t.after(() => {
        if (prior === undefined) delete process.env.PLURNK_SERVICE_EFFECT_HOST;
        else process.env.PLURNK_SERVICE_EFFECT_HOST = prior;
    });
    const db = await openMigrated();
    try {
        let logEntryId = 0;
        let applied = false;
        class Auto extends ProposingTest {
            override async editBatch() { return { ...await super.editBatch(), attrs: { effect: "host" } }; }
            async applyResolution() {
                const decision = await db.test_proposal_decision.get({ id: logEntryId });
                assert.equal(decision?.decision, "accept");
                assert.equal(decision?.resolver, "_plurnk");
                applied = true;
                return { status: 200 };
            }
        }
        const ctx = await setupEngine(db, new Auto());
        const result = await ctx.engine.dispatch({ ...ctx, statement: editStmt("/x", "y"),
            sequence: 1, origin: "model", onDispatch: (id) => { logEntryId = id; } });
        assert.equal(result.status, 200);
        assert.equal(applied, true);
    } finally { await db.close(); }
});

test("{§proposal-projection}: a pending proposal names its session and log coordinate, and the operator's decision deadline only when one is set", async (t) => {
    const original = process.env.PLURNK_SERVICE_PROPOSAL_TIMEOUT_MS;
    t.after(() => {
        if (original === undefined) delete process.env.PLURNK_SERVICE_PROPOSAL_TIMEOUT_MS;
        else process.env.PLURNK_SERVICE_PROPOSAL_TIMEOUT_MS = original;
    });
    const db = await openMigrated();
    try {
        for (const timeout of ["", "60000"]) {
            process.env.PLURNK_SERVICE_PROPOSAL_TIMEOUT_MS = timeout;
            const schemes = new SchemeRegistry();
            schemes.register("proposing-test", new ProposingTest());
            const engine = new Engine({ db, schemes });
            const workspaceId = await insertWorkspace(db, `prop-${crypto.randomUUID()}`);
            const sessionId = await insertSession(db, workspaceId, null, "reviewed-session");
            await ownSession(db, workspaceId, sessionId);
            const loopId = await insertLoop(db, sessionId, 2, "proposal projection");
            const turnId = await insertTurn(db, loopId, 3, 102);
            const announced = deferred<void>();
            engine.onProposalPending(() => announced.resolve());
            const dispatched = deferred<number>();
            const before = Date.now();
            const pending = engine.dispatch({ statement: editStmt("/x", "y"), workspaceId, sessionId, loopId, turnId, sequence: 4, origin: "model",
                onDispatch: (id) => dispatched.resolve(id) });
            const logEntryId = await dispatched.promise;
            await announced.promise;
            const [projection] = await engine.pendingProposals(workspaceId);
            assert.deepEqual([projection?.logEntryId, projection?.sessionId, projection?.session, projection?.coordinate],
                [logEntryId, sessionId, "reviewed-session", "2/3/4"], "the session by name and the row by its log coordinate");
            if (timeout === "") assert.equal(projection !== undefined && Object.hasOwn(projection, "expiresAt"), false, "an untimed wait has no deadline");
            else {
                const deadline = Date.parse(projection?.expiresAt ?? "");
                assert.ok(deadline >= before + 60_000 && deadline <= Date.now() + 60_000, `the deadline is the operator's wait from the proposal: ${projection?.expiresAt}`);
            }
            await engine.resolveProposal(logEntryId, { decision: "reject" }, TEST_OWNER);
            await pending;
        }
    } finally { await db.close(); }
});

test("{§engine-rails} proposal: 202 scheme result pauses; accept resolves to 200", async () => {
    const db = await openMigrated();
    try {
        const ctx = await setupEngine(db);
        const { status, logEntryId } = await dispatchAndResolve(ctx.engine, ctx, { decision: "accept" });
        assert.equal(status, 200, "post-resolution status should be 200 (accepted)");

        const row = await db.test_get_log_entry_by_id.get<{ state: string; status_rx: number; outcome: string | null }>({ id: logEntryId });
        assert.equal(row?.state, "resolved");
        assert.equal(row?.status_rx, 200);
        assert.equal(row?.outcome, null);
        const decision = await db.test_proposal_decision.get({ id: logEntryId });
        assert.equal(decision?.decision, "accept");
        assert.equal(decision?.resolver, TEST_OWNER);
    } finally { await db.close(); }
});

test("{§proposal-proposed-hidden}: creation and client-visible settlement are distinct proposal events", async () => {
    const db = await openMigrated();
    try {
        const ctx = await setupEngine(db);
        const created: number[] = [];
        const settled: number[] = [];
        const idDeferred = deferred<number>();
        const settlementStarted = deferred<void>();
        const releaseSettlement = deferred<void>();
        let dispatchCompleted = false;
        const pending = ctx.engine.dispatch({
            statement: editStmt("/x", "y"),
            workspaceId: ctx.workspaceId,
            sessionId: ctx.sessionId,
            loopId: ctx.loopId,
            turnId: ctx.turnId,
            sequence: 1,
            origin: "model",
            onDispatch: (id) => {
                created.push(id);
                idDeferred.resolve(id);
            },
            onSettled: async (id) => {
                settled.push(id);
                settlementStarted.resolve(undefined);
                await releaseSettlement.promise;
            },
        });
        void pending.then(() => { dispatchCompleted = true; });

        const logEntryId = await idDeferred.promise;
        assert.deepEqual(created, [logEntryId], "the durable proposal identity is available to its resolver");
        assert.deepEqual(settled, [], "a proposed row is not yet client-visible settlement evidence");

        ctx.engine.resolveProposal(logEntryId, { decision: "accept" });
        await settlementStarted.promise;
        await Promise.resolve();
        assert.equal(dispatchCompleted, false, "dispatch waits for client-visible settlement delivery");
        releaseSettlement.resolve(undefined);
        assert.equal((await pending).status, 200);
        assert.deepEqual(settled, [logEntryId], "the terminal proposal row publishes exactly once after settlement");
    } finally { await db.close(); }
});
test("{§engine-rails} proposal: reject transitions to state='failed', status=400, outcome='rejected'", async () => {
    const db = await openMigrated();
    try {
        const ctx = await setupEngine(db);
        const { status, logEntryId } = await dispatchAndResolve(ctx.engine, ctx, { decision: "reject" });
        assert.equal(status, 400);
        const row = await db.test_get_log_entry_by_id.get<{ state: string; status_rx: number; outcome: string | null }>({ id: logEntryId });
        assert.equal(row?.state, "failed");
        assert.equal(row?.status_rx, 400);
        assert.equal(row?.outcome, "rejected");
        assert.equal((await db.test_proposal_decision.get({ id: logEntryId }))?.decision, "reject");
    } finally { await db.close(); }
});

test("{§engine-rails} proposal: cancel transitions to state='cancelled', status=499, outcome='loop_aborted'", async () => {
    const db = await openMigrated();
    try {
        const ctx = await setupEngine(db);
        const { status, logEntryId } = await dispatchAndResolve(ctx.engine, ctx, { decision: "cancel" });
        assert.equal(status, 499);
        const row = await db.test_get_log_entry_by_id.get<{ state: string; status_rx: number; outcome: string | null }>({ id: logEntryId });
        assert.equal(row?.state, "cancelled");
        assert.equal(row?.status_rx, 499);
        assert.equal(row?.outcome, "loop_aborted");
        assert.equal((await db.test_proposal_decision.get({ id: logEntryId }))?.decision, "cancel");
    } finally { await db.close(); }
});

test("{§engine-rails} proposal: caller-supplied outcome overrides the default", async () => {
    const db = await openMigrated();
    try {
        const ctx = await setupEngine(db);
        const { logEntryId } = await dispatchAndResolve(ctx.engine, ctx, {
            decision: "reject", outcome: "policy_veto",
        });
        const row = await db.test_get_log_entry_by_id.get<{ outcome: string | null }>({ id: logEntryId });
        assert.equal(row?.outcome, "policy_veto");
    } finally { await db.close(); }
});

test("{§engine-rails} proposal: attrs from scheme persist into log_entries.attrs JSON", async () => {
    const db = await openMigrated();
    try {
        const ctx = await setupEngine(db);
        const { logEntryId } = await dispatchAndResolve(ctx.engine, ctx, { decision: "accept" });
        const row = await db.test_get_log_entry_by_id.get<{ attrs: string }>({ id: logEntryId });
        const parsed = JSON.parse(row?.attrs ?? "{}") as { path?: string; patch?: string };
        assert.equal(parsed.path, "/proposed-test");
        assert.equal(parsed.patch, "@@ +x @@");
    } finally { await db.close(); }
});

test("{§lifecycle-terms} proposal: status=202 + state='proposed' rows hidden from the log section render", async () => {
    const db = await openMigrated();
    try {
        const ctx = await setupEngine(db);
        // Dispatch but DON'T resolve — entry stays in proposed state.
        const idDeferred = deferred<number>();
        const pending = ctx.engine.dispatch({
            statement: editStmt("/x", "y"),
            workspaceId: ctx.workspaceId, sessionId: ctx.sessionId, loopId: ctx.loopId, turnId: ctx.turnId,
            sequence: 1, origin: "model",
            onDispatch: (id) => idDeferred.resolve(id),
        });
        const logEntryId = await idDeferred.promise;

        // Render the log — proposed entry should be invisible.
        // engine_render_log selects the session's own log rows per SPEC {§lifecycle-terms}.
        const rendered = await db.engine_render_log.all<{ status_rx: number; state: string }>({ session_id: ctx.sessionId });
        const proposedVisible = rendered.find((r) => r.status_rx === 202 && r.state === "proposed");
        assert.equal(proposedVisible, undefined, "proposed entries must be invisible to log render");

        // Now resolve and re-render — entry should surface.
        ctx.engine.resolveProposal(logEntryId, { decision: "accept" });
        await pending;
        const rerendered = await db.engine_render_log.all<{ status_rx: number; state: string }>({ session_id: ctx.sessionId });
        const resolvedVisible = rerendered.find((r) => r.state === "resolved");
        assert.notEqual(resolvedVisible, undefined, "resolved entries must surface in log render");
        assert.equal(resolvedVisible?.status_rx, 200);
    } finally { await db.close(); }
});

test("{§problems-functionality} proposal: resolveProposal for unknown id throws", () => {
    return openMigrated().then(async (db) => {
        try {
            const ctx = await setupEngine(db);
            assert.throws(() => ctx.engine.resolveProposal(99999, { decision: "accept" }), (error) => {
                assert.ok(error instanceof OperationFailureError);
                assert.equal(error.result.problem.type, "https://problems.plurnk.xyz/proposal/resolution/proposal-not-pending");
                assert.equal(error.result.problem.logEntryId, 99999);
                assert.equal(error.result.problem.recovery, "Refresh pending proposals before resolving one."); // {§problems-functionality}
                return true;
            });
        } finally { await db.close(); }
    });
});

test("{§engine-rails} proposal: pendingProposalIds reports waiting entries", async () => {
    const db = await openMigrated();
    try {
        const ctx = await setupEngine(db);
        const idDeferred = deferred<number>();
        const pending = ctx.engine.dispatch({
            statement: editStmt("/x", "y"),
            workspaceId: ctx.workspaceId, sessionId: ctx.sessionId, loopId: ctx.loopId, turnId: ctx.turnId,
            sequence: 1, origin: "model",
            onDispatch: (id) => idDeferred.resolve(id),
        });
        const logEntryId = await idDeferred.promise;
        assert.deepEqual(ctx.engine.pendingProposalIds(), [logEntryId]);

        ctx.engine.resolveProposal(logEntryId, { decision: "accept" });
        await pending;
        assert.deepEqual(ctx.engine.pendingProposalIds(), []);
    } finally { await db.close(); }
});

test("{§engine-rails} proposal: onProposalPending listener fires with the right payload", async () => {
    const db = await openMigrated();
    try {
        const ctx = await setupEngine(db);
        const seen: { logEntryId: number; op: string; attrs: object; target: { scheme: string | null; pathname: string | null } }[] = [];
        ctx.engine.onProposalPending((event) => {
            seen.push({ logEntryId: event.logEntryId, op: event.op, attrs: event.attrs, target: event.target });
        });
        const { logEntryId } = await dispatchAndResolve(ctx.engine, ctx, { decision: "accept" });
        assert.equal(seen.length, 1);
        assert.equal(seen[0]?.logEntryId, logEntryId);
        assert.equal(seen[0]?.op, "EDIT");
        assert.equal(seen[0]?.target.scheme, "proposing-test");
        assert.equal(seen[0]?.target.pathname, "/x");
        const attrs = seen[0]?.attrs as { path: string; patch: string };
        assert.equal(attrs.path, "/proposed-test");
        assert.equal(attrs.patch, "@@ +x @@");
    } finally { await db.close(); }
});

test("{§proposal-202-pauses}: a WAIT over live work parks without a proposal", async () => {
    const db = await openMigrated();
    try {
        const ctx = await setupEngine(db);
        const childId = await insertSession(db, ctx.workspaceId, ctx.sessionId, "child");
        await insertLoop(db, childId, 1, "live child work");
        const proposed: number[] = [];
        ctx.engine.onProposalPending((event) => { proposed.push(event.logEntryId); });

        const sendParked = parseDsl("````WAIT\nawaiting your reply\n````").find((s) => s.op === "WAIT");
        assert.ok(sendParked, "fixture: the broadcast park parsed as a statement");
        const parkDeferred = deferred<number>();
        const parkResult = await ctx.engine.dispatch({
            statement: sendParked,
            workspaceId: ctx.workspaceId, sessionId: ctx.sessionId, loopId: ctx.loopId, turnId: ctx.turnId,
            sequence: 1, origin: "model",
            onDispatch: (id) => parkDeferred.resolve(id),
        });
        const parkId = await parkDeferred.promise;

        assert.equal(parkResult.status, 202, "the wait parks without blocking its dispatch");
        // ...the entry is a resolved row, not a proposed one...
        const parkRow = await db.test_get_log_entry_by_id.get<{ state: string; status_rx: number }>({ id: parkId });
        assert.equal(parkRow?.state, "resolved", "the wait SEND is a resolved row, not a proposed entry");
        assert.equal(parkRow?.status_rx, 202);
        // ...and no loop/proposal was announced for it.
        assert.ok(!proposed.includes(parkId), "no proposal announced for the broadcast wait");

        // Negative control: a genuine side-effecting EDIT[202] DOES propose — proving the
        // listener is live and the SEND is exempt by op, not by a dead listener. Assert
        // only after the dispatch fully resolves, so onProposalPending has already run.
        const editDeferred = deferred<number>();
        const editPending = ctx.engine.dispatch({
            statement: editStmt("/x", "y"),
            workspaceId: ctx.workspaceId, sessionId: ctx.sessionId, loopId: ctx.loopId, turnId: ctx.turnId,
            sequence: 2, origin: "model",
            onDispatch: (id) => editDeferred.resolve(id),
        });
        const editId = await editDeferred.promise;
        ctx.engine.resolveProposal(editId, { decision: "accept" });
        await editPending;
        assert.ok(proposed.includes(editId), "the side-effecting EDIT[202] IS announced as a proposal");
    } finally { await db.close(); }
});

test("{§session-ownership} proposal: server acceptance is core-owned and needs no daemon listener", async (t) => {
    const original = process.env.PLURNK_SERVICE_PROPOSAL_TIMEOUT_MS;
    t.after(() => {
        if (original === undefined) delete process.env.PLURNK_SERVICE_PROPOSAL_TIMEOUT_MS;
        else process.env.PLURNK_SERVICE_PROPOSAL_TIMEOUT_MS = original;
    });
    process.env.PLURNK_SERVICE_PROPOSAL_TIMEOUT_MS = "25";
    const db = await openMigrated();
    try {
        const ctx = await setupEngine(db);
        serverProposals(t, "accept");

        const idDeferred = deferred<number>();
        const result = await ctx.engine.dispatch({
            statement: editStmt("/x", "y"),
            workspaceId: ctx.workspaceId, sessionId: ctx.sessionId, loopId: ctx.loopId, turnId: ctx.turnId,
            sequence: 1, origin: "model",
            onDispatch: (id) => idDeferred.resolve(id),
        });
        const logEntryId = await idDeferred.promise;
        assert.equal(result.status, 200, "loop acceptance produces status 200");
        const decision = await db.test_proposal_decision.get({ id: logEntryId });
        assert.equal(decision?.decision, "accept");
        assert.equal(decision?.resolver, "_plurnk");
        const row = await db.test_get_log_entry_by_id.get<{ state: string; outcome: string | null }>({ id: logEntryId });
        assert.equal(row?.state, "resolved");
        assert.equal(row?.outcome, null);
    } finally { await db.close(); }
});

test("{§engine-rails} proposal: an observational failure is visible and cannot derail loop-owned settlement", async (t) => {
    const diagnostics: unknown[][] = [];
    t.mock.method(console, "error", (...args: unknown[]) => { diagnostics.push(args); });
    const db = await openMigrated();
    try {
        const ctx = await setupEngine(db);
        serverProposals(t, "accept");
        const observerCause = new Error("observer failed");
        ctx.engine.onProposalPending(() => { throw observerCause; });

        const result = await ctx.engine.dispatch({
            statement: editStmt("/x", "y"),
            workspaceId: ctx.workspaceId,
            sessionId: ctx.sessionId,
            loopId: ctx.loopId,
            turnId: ctx.turnId,
            sequence: 1,
            origin: "model",
        });

        assert.equal(result.status, 200);
        assert.deepEqual(ctx.engine.pendingProposalIds(), [], "observer isolation cannot leave an automatic proposal pending");
        assert.equal(diagnostics.length, 1, "the isolated failure is reported rather than swallowed");
        assert.equal(diagnostics[0]?.[1], observerCause, "the complete cause reaches diagnostics");
    } finally { await db.close(); }
});

test("{§engine-rails} proposal: a policy-preparation failure preserves its cause and terminalizes the durable row", async (t) => {
    const db = await openMigrated();
    try {
        const ctx = await setupEngine(db, new ProposingTest(async () => {
            const previous = process.env.PLURNK_SERVICE_PROPOSALS;
            t.after(() => { process.env.PLURNK_SERVICE_PROPOSALS = previous; });
            process.env.PLURNK_SERVICE_PROPOSALS = "sometimes";
        }));
        let logEntryId: number | undefined;
        await assert.rejects(
            ctx.engine.dispatch({
                statement: sendStmt(urlPath("proposing-test", "/x"), "y"),
                workspaceId: ctx.workspaceId,
                sessionId: ctx.sessionId,
                loopId: ctx.loopId,
                turnId: ctx.turnId,
                sequence: 1,
                origin: "model",
                onDispatch: (id) => { logEntryId = id; },
            }),
            (error: unknown) => {
                assert.ok(error instanceof Error);
                assert.ok(error instanceof OperationFailureError);
                assert.equal(error.result.problem?.key, "PLURNK_SERVICE_PROPOSALS");
                return true;
            },
        );
        assert.notEqual(logEntryId, undefined);
        assert.deepEqual(ctx.engine.pendingProposalIds(), []);
        const row = await db.test_get_log_entry_by_id.get<{
            state: string;
            status_rx: number;
            outcome: string | null;
            rx: string;
        }>({ id: logEntryId! });
        assert.equal(row?.state, "failed");
        assert.equal(row?.status_rx, 500);
        assert.equal(row?.outcome, "policy_failed");
        assert.match(row?.rx ?? "", /proposal-policy-failed/);
    } finally { await db.close(); }
});

test("{§engine-rails} proposal: invalid explicit timeout fails hard without orphaning the durable stopped world", async (t) => {
    const original = process.env.PLURNK_SERVICE_PROPOSAL_TIMEOUT_MS;
    t.after(() => {
        if (original === undefined) delete process.env.PLURNK_SERVICE_PROPOSAL_TIMEOUT_MS;
        else process.env.PLURNK_SERVICE_PROPOSAL_TIMEOUT_MS = original;
    });
    process.env.PLURNK_SERVICE_PROPOSAL_TIMEOUT_MS = "invalid";
    const db = await openMigrated();
    try {
        const ctx = await setupEngine(db);
        let logEntryId: number | undefined;
        const dispatched = ctx.engine.dispatch({
            statement: editStmt("/x", "y"),
            workspaceId: ctx.workspaceId,
            sessionId: ctx.sessionId,
            loopId: ctx.loopId,
            turnId: ctx.turnId,
            sequence: 1,
            origin: "model",
            onDispatch: (id) => { logEntryId = id; },
        });
        const observed = dispatched.then(
            (result) => ({ kind: "fulfilled" as const, result }),
            (error: unknown) => ({ kind: "rejected" as const, error }),
        );
        // Nothing resolves the proposal: a dispatch still unsettled at the harness bound is an indefinite wait.
        const outcome = await Promise.race([
            observed,
            new Promise<{ kind: "pending" }>((resolve) => setTimeout(() => resolve({ kind: "pending" }), HARNESS_WAIT_MS).unref()),
        ]);
        if (outcome.kind === "pending") {
            const [pendingId] = ctx.engine.pendingProposalIds();
            if (pendingId !== undefined) ctx.engine.resolveProposal(pendingId, { decision: "cancel" });
            await observed;
        }

        assert.equal(outcome.kind, "rejected", "invalid explicit configuration cannot become an indefinite wait");
        if (outcome.kind !== "rejected") return;
        assert.match(String(outcome.error), /PLURNK_SERVICE_PROPOSAL_TIMEOUT_MS.*"invalid"/);
        assert.notEqual(logEntryId, undefined);
        assert.deepEqual(ctx.engine.pendingProposalIds(), []);
        const row = await db.test_get_log_entry_by_id.get<{
            state: string;
            status_rx: number;
            outcome: string | null;
        }>({ id: logEntryId! });
        assert.equal(row?.state, "failed");
        assert.equal(row?.status_rx, 500);
        assert.equal(row?.outcome, "policy_failed");
    } finally { await db.close(); }
});

test("{§engine-rails} proposal: the default review disposition does not approve without a resolver", async (t) => {
    // Tight timeout so the test doesn't wait the full 5m default.
    const original = process.env.PLURNK_SERVICE_PROPOSAL_TIMEOUT_MS;
    t.after(() => {
        if (original === undefined) delete process.env.PLURNK_SERVICE_PROPOSAL_TIMEOUT_MS;
        else process.env.PLURNK_SERVICE_PROPOSAL_TIMEOUT_MS = original;
    });
    process.env.PLURNK_SERVICE_PROPOSAL_TIMEOUT_MS = "100";
    const db = await openMigrated();
    try {
        const ctx = await setupEngine(db);
        const idDeferred = deferred<number>();
        const result = await ctx.engine.dispatch({
            statement: editStmt("/x", "y"),
            workspaceId: ctx.workspaceId, sessionId: ctx.sessionId, loopId: ctx.loopId, turnId: ctx.turnId,
            sequence: 1, origin: "model",
            onDispatch: (id) => idDeferred.resolve(id),
        });
        const logEntryId = await idDeferred.promise;
        // Review has no resolver → timeout fires → 499/cancelled/timeout.
        assert.equal(result.status, 499);
        const row = await db.test_get_log_entry_by_id.get<{ state: string; outcome: string | null }>({ id: logEntryId });
        assert.equal(row?.state, "cancelled");
        assert.equal(row?.outcome, "timeout");
    } finally { await db.close(); }
});

test("{§engine-rails} proposal: timeout fires after PLURNK_SERVICE_PROPOSAL_TIMEOUT_MS", async (t) => {
    const original = process.env.PLURNK_SERVICE_PROPOSAL_TIMEOUT_MS;
    t.after(() => {
        if (original === undefined) delete process.env.PLURNK_SERVICE_PROPOSAL_TIMEOUT_MS;
        else process.env.PLURNK_SERVICE_PROPOSAL_TIMEOUT_MS = original;
    });
    process.env.PLURNK_SERVICE_PROPOSAL_TIMEOUT_MS = "50";  // 50ms — fast for tests
    const db = await openMigrated();
    try {
        const ctx = await setupEngine(db);
        const idDeferred = deferred<number>();
        // No resolveProposal call — wait for the timeout to fire and route
        // through the same applyResolution path as a manual cancel.
        const result = await ctx.engine.dispatch({
            statement: editStmt("/x", "y"),
            workspaceId: ctx.workspaceId, sessionId: ctx.sessionId, loopId: ctx.loopId, turnId: ctx.turnId,
            sequence: 1, origin: "model",
            onDispatch: (id) => idDeferred.resolve(id),
        });
        const logEntryId = await idDeferred.promise;
        assert.equal(result.status, 499, "timeout produces a cancelled resolution → status 499");
        const decision = await db.test_proposal_decision.get({ id: logEntryId });
        assert.equal(decision?.decision, "cancel");
        assert.equal(decision?.resolver, "_plurnk");
        assert.equal(decision?.outcome, "timeout");
        const row = await db.test_get_log_entry_by_id.get<{ state: string; outcome: string | null }>({ id: logEntryId });
        assert.equal(row?.state, "cancelled");
        assert.equal(row?.outcome, "timeout");
    } finally { await db.close(); }
});

test("{§engine-rails} the shipped empty default is indefinite — a stopped world waits for its human", async (t) => {
    // Absence is not an answer: with the knob unset, a pending proposal outlives any would-be
    // window and resolves only when the human does. The operator-bounded lane above keeps its test.
    const original = process.env.PLURNK_SERVICE_PROPOSAL_TIMEOUT_MS;
    t.after(() => {
        if (original === undefined) delete process.env.PLURNK_SERVICE_PROPOSAL_TIMEOUT_MS;
        else process.env.PLURNK_SERVICE_PROPOSAL_TIMEOUT_MS = original;
    });
    process.env.PLURNK_SERVICE_PROPOSAL_TIMEOUT_MS = "";
    const db = await openMigrated();
    try {
        const ctx = await setupEngine(db);
        const idDeferred = deferred<number>();
        const dispatchPromise = ctx.engine.dispatch({
            statement: editStmt("/x", "y"),
            workspaceId: ctx.workspaceId, sessionId: ctx.sessionId, loopId: ctx.loopId, turnId: ctx.turnId,
            sequence: 1, origin: "model",
            onDispatch: (id) => idDeferred.resolve(id),
        });
        const logEntryId = await idDeferred.promise;
        // No window expires a proposal: the world stays stopped.
        await new Promise((r) => setTimeout(r, 250));
        const pending = await db.test_get_log_entry_by_id.get<{ state: string }>({ id: logEntryId });
        assert.equal(pending?.state, "proposed", "still stopped — no synthetic cancel, however long the human takes");
        ctx.engine.resolveProposal(logEntryId, { decision: "accept" });
        const result = await dispatchPromise;
        assert.equal(result.status, 200, "the human's answer, whenever it arrives, is the only resolution");
    } finally { await db.close(); }
});
