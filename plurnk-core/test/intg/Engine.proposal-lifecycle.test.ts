import test, { describe, type TestContext } from "node:test";
import assert from "node:assert/strict";
import Engine from "../../src/core/Engine.ts";
import SchemeRegistry from "../../src/core/SchemeRegistry.ts";
import EvidenceReader from "../../src/evidence/EvidenceReader.ts";
import Daemon from "../../src/server/Daemon.ts";
import type Exec from "../../src/schemes/Exec.ts";
import FunctionalityManager, { plurnkRuntimeDecl } from "../../src/server/FunctionalityManager.ts";
import type Functionality from "../../src/server/Functionality.ts";
import StreamMock from "./_stream-mock.ts";
import ExecutorRegistry from "../../src/core/ExecutorRegistry.ts";
import { ownSession, serverProposals, TEST_OWNER } from "./_approval.ts";
import { OperationFailureError } from "../../src/core/results.ts";
import { type EditStatement, type ProposalResolution, type FunctionalityListResult, type PlurnkStatement, type ExecStatement } from "@plurnk/plurnk-contracts";
import { type Db } from "../../src/core/Db.ts";
import { type SchemeManifest } from "../../src/core/scheme-types.ts";
import { openMigrated, insertWorkspace, insertSession, insertLoop, insertTurn, rootWorkspace } from "./_db.ts";
import { parseDsl, fixtureExecutors, makeMockResponse } from "./_mock.ts";
import { sendStmt, urlPath, localPath } from "./_dsl.ts";
import { type ProposalApplyRequest } from "@plurnk/plurnk-schemes";
import { mkdtemp, readFile, rm, mkdir, readdir, realpath, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { Digest } from "@plurnk/plurnk-digest";
import { HARNESS_WAIT_MS, waitForDb, withDaemon } from "./_rpc.ts";
import { Module as McpModule } from "@plurnk/plurnk-mcp";
import { PlurnkParser } from "@plurnk/plurnk-parser";
import { awaitExecOutcome, executionAddress } from "./_execs.ts";
import { MCP_CONTROLS, mcpFixture, stdioEntry } from "./_mcp-config.ts";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { hermeticGitEnv } from "../../src/core/git-env.ts";
import { modelOperation, namedModelSession } from "./_sessions.ts";

describe("Engine.proposal-lifecycle", () => {
// Proposal lifecycle (SPEC.md {§engine-rails} + {§methods}). When a scheme returns
// status 202, the engine writes a state='proposed' log entry and pauses
// dispatch until Engine.resolveProposal feeds back a decision. These tests
// exercise the pause/resume machinery + the log-render visibility filter
// against a tiny test scheme that always proposes.




















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

test("{§proposal}: original approval is durable before a failing effect and cannot be rewritten", async () => {
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

test("{§proposal}: an unrecordable approval cannot execute", async (t) => {
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

test("{§digest-evidence-reader}: curation retains original approval in the report until its history is deleted", async () => {
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

test("{§proposal}: effect-policy acceptance records runtime authority before applying", async (t) => {
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

test("{§proposal}: creation and client-visible settlement are distinct proposal events", async () => {
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

test("{§operation-results} proposal: resolveProposal for unknown id throws", () => {
    return openMigrated().then(async (db) => {
        try {
            const ctx = await setupEngine(db);
            assert.throws(() => ctx.engine.resolveProposal(99999, { decision: "accept" }), (error) => {
                assert.ok(error instanceof OperationFailureError);
                assert.equal(error.result.problem.type, "https://problems.plurnk.xyz/proposal/resolution/proposal-not-pending");
                assert.equal(error.result.problem.logEntryId, 99999);
                assert.equal(error.result.problem.recovery, "Refresh pending proposals before resolving one."); // {§operation-results}
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

test("{§proposal}: a WAIT over live work parks without a proposal", async () => {
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
});

describe("mcp-storage-composition", () => {
// {§mcp-configuration}













type Placement = { cwd: string };

// An empty project directory for the workspace, removed with the test.
const projectDirectory = async (t: TestContext): Promise<string> => {
    const scratch = await mkdtemp(join(tmpdir(), "plurnk-mcp-placement-"));
    t.after(() => rm(scratch, { recursive: true, force: true }));
    const project = join(scratch, "project");
    await mkdir(project);
    return project;
};

test("{§mcp-configuration} a stdio tool runs in retained workspace state and writes nothing into the project", { timeout: 30000 }, async (t) => {
    const project = await projectDirectory(t);
    const { hostPaths, env: mcpEnv } = await mcpFixture(t, { fixture: stdioEntry("echo-server.mjs", { PLURNK_MCP_TEST_WHERE: "1" }) });
    const db = await openMigrated();
    const daemon = new Daemon({ db, provider: null, hostPaths });
    daemon.registerModule(McpModule.init({ env: { ...mcpEnv, ...MCP_CONTROLS } }), "@plurnk/plurnk-mcp");
    try {
        await daemon.start();
        const { workspaceId } = await daemon.createWorkspace({ name: "placement", projectRoot: project });
        const source = PlurnkParser.frame("fixture (where)", "{}");
        const parsed = PlurnkParser.parseStatements(source, { executors: fixtureExecutors(source) }).items[0];
        assert.equal(parsed?.kind, "statement");
        if (parsed?.kind !== "statement") throw new Error("Expected the tool operation");
        // A person's operation is that person's decision already ({§proposal-disposition}).
        const [invoked] = await daemon.dispatchClientAction({ workspaceId, actor: TEST_OWNER, statements: [parsed.statement] });
        assert.equal(invoked.status, 200);
        const placed = await awaitExecOutcome(db, { workspaceId, scheme: "fixture", channel: "body", timeoutMs: 10000 }) as Placement;
        const directory = await daemon.workspaceStateDirectory(workspaceId, "@plurnk/plurnk-mcp/fixture");
        assert.deepEqual(placed, { cwd: await realpath(directory) });
        assert.equal((await stat(directory)).mode & 0o777, 0o700, "workspace state is private and created before launch");
        await daemon.invokeModuleAction("workspace.mcp.disable", { alias: "fixture" }, { scope: "workspace", workspaceId });
        assert.ok((await stat(directory)).isDirectory(), "disabling the connection retains its state directory");
        assert.deepEqual(await readdir(project), [], "the launch and the tool write nothing into the project");
    } finally {
        await daemon.stop();
        await db.close();
    }
});

test("{§mcp-configuration} an inaccessible state directory leaves the server unavailable and never falls back to the project", { timeout: 15000 }, async (t) => {
    const project = await projectDirectory(t);
    const marker = join(dirname(project), "starts.txt");
    const { hostPaths, env: mcpEnv } = await mcpFixture(t, { fixture: stdioEntry("echo-server.mjs", { PLURNK_MCP_TEST_START_MARKER: marker }) });
    await mkdir(hostPaths.stateDir, { recursive: true });
    await writeFile(join(hostPaths.stateDir, "workspaces"), "occupied");
    const db = await openMigrated();
    const daemon = new Daemon({ db, provider: null, hostPaths });
    daemon.registerModule(McpModule.init({ env: { ...mcpEnv, ...MCP_CONTROLS } }), "@plurnk/plurnk-mcp");
    try {
        await daemon.start();
        const { workspaceId } = await daemon.createWorkspace({ name: "blocked-mcp-state", projectRoot: project });
        const invoke = (verb: string, params: Record<string, unknown> = {}) => daemon.invokeModuleAction(`workspace.mcp.${verb}`, params, { scope: "workspace", workspaceId });
        await assert.rejects(invoke("enable", { alias: "fixture" }), (error: unknown) => {
            assert.ok(error instanceof Error);
            assert.equal(error.message, "Configured MCP server 'fixture' is unavailable.");
            assert.ok(error.cause instanceof Error);
            assert.equal((error.cause as NodeJS.ErrnoException).code, "ENOTDIR");
            assert.equal((error.cause as NodeJS.ErrnoException).syscall, "mkdir");
            return true;
        });
        assert.equal((await invoke("list") as FunctionalityListResult).definitions[0]?.state, "unavailable");
        await assert.rejects(stat(marker), { code: "ENOENT" }, "the subprocess never starts without its state directory");
        assert.deepEqual(await readdir(project), [], "nothing falls back to the project");
    } finally {
        await daemon.stop();
        await db.close();
    }
});
});

describe("members-auto-add", () => {
// {§membership-auto-add}: the matrix — READ and FIND, an exact path and a glob, each row of the universe
// table, with the knob on and off, the model's scope open and closed, and the proposal settled by policy or
// by a reviewer. A read of content proposes the admission; acceptance admits and reads; rejection admits
// nothing; a listing admits nothing; nothing unadmitted shows its content; the client's reads never admit.
















const execFileP = promisify(execFile);

const parseOne = (input: string): PlurnkStatement => {
    const parsed = PlurnkParser.parseStatements(input, { executors: fixtureExecutors(input) });
    const item = parsed.items.find((x) => x.kind === "statement");
    if (item?.kind !== "statement") throw new Error(`no statement parsed from ${input}`);
    return item.statement;
};

// tracked: README.md. Untracked and unignored: loose.md, loose2.md (excluded by definition), docs/guide.md,
// blob.bin. Ignored: ignored.log. A directory: docs.
const project = async (): Promise<string> => {
    const root = await mkdtemp(join(tmpdir(), "plurnk-auto-add-"));
    const git = (args: string[]) => execFileP("git", args, { cwd: root, env: hermeticGitEnv() });
    await git(["init", "-q"]);
    await writeFile(join(root, ".gitignore"), "ignored.log\n");
    await writeFile(join(root, "README.md"), "# tracked\nalpha\n");
    await git(["add", ".gitignore", "README.md"]);
    await git(["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", "commit", "-q", "--no-verify", "-m", "chore: seed"]);
    await writeFile(join(root, "loose.md"), "# loose\nalpha\n");
    await writeFile(join(root, "loose2.md"), "# loose two\nalpha\n");
    await writeFile(join(root, "ignored.log"), "alpha secret\n");
    await mkdir(join(root, "docs"), { recursive: true });
    await writeFile(join(root, "docs", "guide.md"), "# guide\nbeta\n");
    await writeFile(join(root, "blob.bin"), Buffer.from([0, 255, 129, 10, 0, 1]));
    return root;
};

const memberOf = async (db: Db, workspaceId: number, pathname: string): Promise<boolean> =>
    (await db.crud_find_workspace_entry.get<{ id: number }>({ workspace_id: workspaceId, scheme: "file", authority: "", pathname })) !== undefined;

type Definition = { alias: string; origin: string; state: string; definition?: { glob: string; provenance?: { kind: string } } };

const harness = async (t: TestContext, env: Record<string, string>) => {
    serverProposals(t, "accept");
    const root = await project();
    const db = await openMigrated();
    const daemon = new Daemon({ db, provider: null });
    const notices: string[] = [];
    type Proposal = { logEntryId: number; op: string; body?: string };
    const proposals: Proposal[] = [];
    const waiting: Array<(proposal: Proposal) => void> = [];
    daemon.subscribeToEvents((_workspaceId, method, params) => {
        if (method === "loop/proposal") {
            const proposal = params as Proposal;
            const waiter = waiting.shift();
            if (waiter === undefined) proposals.push(proposal); else waiter(proposal);
            return;
        }
        if (method !== "notice/event") return;
        const text = JSON.stringify(params);
        if (text.includes("member_added")) notices.push(text);
    });
    // {§proposal} — under review the dispatch pauses on the proposal until a decision arrives.
    const nextProposal = (): Promise<Proposal> => {
        const queued = proposals.shift();
        return queued !== undefined ? Promise.resolve(queued) : new Promise((resolve) => { waiting.push(resolve); });
    };
    const workspaceId = await insertWorkspace(db, `auto-add-${crypto.randomUUID()}`);
    await rootWorkspace(db, workspaceId, root);
    const sessionId = await insertSession(db, workspaceId, null, "model", "model");
    const restore = await (async () => {
        const overrides = {
            PLURNK_SERVICE_GIT_ALLOWED: "1", PLURNK_SERVICE_GIT_AUTO: "1", PLURNK_SERVICE_MEMBERS_MODEL_SCOPE: "namespace",
            PLURNK_MEMBERS_ENABLED: "1", PLURNK_MEMBERS_no_two: "!loose2.md", PLURNK_MEMBERS_AUTO_ADD: "1", ...env,
        };
        const prior = new Map(Object.keys(overrides).map((key) => [key, process.env[key]]));
        for (const [key, value] of Object.entries(overrides)) process.env[key] = value;
        return () => { for (const [key, value] of prior) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } };
    })();
    await daemon.start();
    t.after(async () => { await daemon.stop(); await db.close(); restore(); await rm(root, { recursive: true, force: true }); });
    const model = (program: string) => modelOperation(daemon, db, { workspaceId, sessionId, statement: parseOne(program) });
    const client = async (program: string) => (await daemon.dispatchClientAction({ workspaceId, actor: TEST_OWNER, statements: [parseOne(program)] }))[0];
    const definitions = async (): Promise<Definition[]> =>
        (await daemon.invokeModuleAction("workspace.members.list", {}, { scope: "workspace", workspaceId }) as { definitions: Definition[] }).definitions;
    const member = (pathname: string) => memberOf(db, workspaceId, pathname);
    const paths = (result: { results?: unknown }): string => JSON.stringify(result.results ?? []);
    const review = async (program: string, decision: "accept" | "reject"): Promise<{ result: unknown; proposal: Proposal }> => {
        const pending = model(program);
        const proposal = await nextProposal();
        await daemon.engine.resolveProposal(proposal.logEntryId, { decision }, TEST_OWNER);
        return { result: await pending, proposal };
    };
    // A person reviews: the session is owned by an interactive client, and the server disposition is review.
    const attend = async (): Promise<void> => { await ownSession(db, workspaceId, sessionId); serverProposals(t, "review"); };
    return { db, daemon, workspaceId, sessionId, notices, model, client, definitions, member, paths, review, attend };
};

test("{§membership-auto-add} READ: an untracked file is admitted as the Session's own definition and read; ignored, excluded, beyond-root and directory targets are not", { timeout: 60_000 }, async (t) => {
    const h = await harness(t, {});
    const read = await h.model("````READ (loose.md)````") as { status: number; content?: string | null };
    assert.equal(read.status, 200, JSON.stringify(read));
    assert.match(String(read.content), /# loose/u, "the admitted file is read in the same operation");
    assert.equal(await h.member("loose.md"), true);
    const admitted = (await h.definitions()).find(({ alias }) => alias === "loose.md");
    assert.equal(admitted?.origin, "workspace");
    assert.equal(admitted?.definition?.provenance?.kind, "model-proposal", "the admission is the model's own add");
    assert.equal(admitted?.state, "active");
    assert.equal(h.notices.length, 1, `one member_added notice: ${JSON.stringify(h.notices)}`);
    assert.match(h.notices[0], /'loose\.md' is now a member of this workspace\./u);
    assert.match(h.notices[0], /"level":"warn"/u);
    assert.doesNotMatch(h.notices[0], /"directive"/u, "the notice carries no directive");

    for (const [program, code, pathname] of [
        ["````READ (ignored.log)````", "entry-not-member", "ignored.log"],
        ["````READ (loose2.md)````", "entry-not-member", "loose2.md"],
        ["````READ (../outside.md)````", "entry-not-found", "../outside.md"],
        ["````READ (docs)````", "path-is-directory", "docs"],
    ] as const) {
        const refused = await h.model(program) as { status: number; problem?: { type?: string } };
        assert.equal(refused.status, 404, `${program}: ${JSON.stringify(refused)}`);
        assert.match(refused.problem?.type ?? "", new RegExp(`/${code}$`, "u"), program);
        assert.equal(await h.member(pathname), false, `${pathname} is never admitted`);
    }
    assert.equal(h.notices.length, 1, "the refusals announce nothing");
});

test("{§membership-auto-add} READ by glob: the universe fans out, and each untracked file read is admitted", { timeout: 60_000 }, async (t) => {
    const h = await harness(t, {});
    await h.model("````READ (*.md) <1,2>````");
    assert.equal(await h.member("loose.md"), true, "the untracked file the glob reached was admitted");
    assert.equal(await h.member("loose2.md"), false, "an excluded file is outside the universe");
    assert.equal(await h.member("ignored.log"), false);
    assert.equal(h.notices.length, 1);
});

test("{§membership-auto-add} FIND: a listing shows the universe without admitting; a text match admits; indexed dialects and binary candidates see members only", { timeout: 60_000 }, async (t) => {
    const h = await harness(t, {});
    const listed = await h.model("````FIND (*)````") as { status: number; results?: unknown };
    assert.equal(listed.status, 200, JSON.stringify(listed));
    const listing = h.paths(listed);
    for (const shown of ["README.md", "loose.md", "blob.bin"]) assert.match(listing, new RegExp(`"${shown}"`, "u"), `${shown} is listed`);
    for (const hidden of ["ignored.log", "loose2.md"]) assert.doesNotMatch(listing, new RegExp(hidden, "u"), `${hidden} is outside the universe`);
    assert.match(listing, /"aside":"untracked"/u, "a listed candidate is marked untracked");
    assert.equal(await h.member("loose.md"), false, "listing admits nothing");
    assert.equal(h.notices.length, 0);

    const exact = await h.model("````FIND (loose.md)````") as { status: number };
    assert.equal(exact.status, 200, "an exact FIND of a candidate lists it rather than missing");
    assert.equal(await h.member("loose.md"), false);

    const fulltext = await h.model("````FIND (*) ~alpha````") as { status: number; results?: unknown };
    assert.equal(fulltext.status, 200, JSON.stringify(fulltext));
    assert.match(h.paths(fulltext), /README\.md/u);
    assert.doesNotMatch(h.paths(fulltext), /loose\.md/u, "an indexed dialect sees members only");
    assert.equal(await h.member("loose.md"), false);

    const matched = await h.model("````FIND (*.md) loose````") as { status: number; results?: unknown };
    assert.equal(matched.status, 200, JSON.stringify(matched));
    assert.match(h.paths(matched), /loose\.md/u, "the candidate whose text matched is in the result");
    assert.doesNotMatch(h.paths(matched), /README\.md|loose2\.md/u);
    assert.equal(await h.member("loose.md"), true, "a text match admits");
    assert.equal(await h.member("docs/guide.md"), false, "an unmatched candidate stays out");
    assert.equal(h.notices.length, 1);
    assert.match(h.notices[0], /'loose\.md' is now a member/u);

    const nested = await h.model("````FIND (docs/*.md) beta````") as { status: number; results?: unknown };
    assert.equal(nested.status, 200);
    assert.equal(await h.member("docs/guide.md"), true, "a scoped glob reaches its directory's candidates");
    assert.equal(h.notices.length, 2);
});

test("{§membership-auto-add} scope none: the universe is listed, nothing is admitted, and no unadmitted content shows", { timeout: 60_000 }, async (t) => {
    const h = await harness(t, { PLURNK_SERVICE_MEMBERS_MODEL_SCOPE: "none" });
    const read = await h.model("````READ (loose.md)````") as { status: number; problem?: { type?: string; recovery?: string } };
    assert.equal(read.status, 404);
    assert.match(read.problem?.type ?? "", /entry-not-member$/u);
    assert.equal(await h.member("loose.md"), false);
    const listed = await h.model("````FIND (*)````") as { status: number; results?: unknown };
    assert.match(h.paths(listed), /loose\.md/u, "occupancy inside the root is not secret");
    const matched = await h.model("````FIND (*.md) loose````") as { status: number; results?: unknown };
    assert.equal(matched.status, 204, "the only match was on what the scope refuses to admit, so nothing matched");
    assert.doesNotMatch(h.paths(matched), /loose\.md/u, "a match on what the scope refuses to admit is not shown");
    assert.equal(await h.member("loose.md"), false);
    assert.equal(h.notices.length, 0);
});

test("{§membership-auto-add} knob off: today's contract holds unchanged", { timeout: 60_000 }, async (t) => {
    const h = await harness(t, { PLURNK_MEMBERS_AUTO_ADD: "0" });
    const read = await h.model("````READ (loose.md)````") as { status: number; problem?: { type?: string; recovery?: string } };
    assert.equal(read.status, 404);
    assert.match(read.problem?.type ?? "", /entry-not-member$/u);
    assert.equal(read.problem?.recovery, "Admit it with `plurnk (members)` and a `{\"verb\": \"add\", \"files\": [\"<path>\"]}` body.");
    const listed = await h.model("````FIND (*)````") as { status: number; results?: unknown };
    assert.doesNotMatch(h.paths(listed), /loose\.md/u, "members only");
    const matched = await h.model("````FIND (*.md) loose````") as { status: number; results?: unknown };
    assert.doesNotMatch(h.paths(matched), /loose\.md/u);
    assert.equal(await h.member("loose.md"), false);
    assert.equal(h.notices.length, 0);
});

test("{§membership-auto-add} {§proposal} under review, a READ proposes the admission: accepted, it admits and reads; rejected, it admits nothing", { timeout: 60_000 }, async (t) => {
    const h = await harness(t, {});
    await h.attend();
    const listed = await h.model("````FIND (*)````") as { status: number; results?: unknown };
    assert.match(h.paths(listed), /loose\.md/u, "the universe is listed under review; listing proposes nothing");
    assert.equal(await h.member("loose.md"), false);

    const accepted = await h.review("````READ (loose.md)````", "accept");
    assert.equal(accepted.proposal.op, "READ");
    assert.equal(accepted.proposal.body, JSON.stringify({ files: ["loose.md"] }), "the review material is the definition the acceptance admits");
    const read = accepted.result as { status: number; content?: string | null };
    assert.equal(read.status, 200, JSON.stringify(read));
    assert.match(String(read.content), /# loose/u, "the accepted admission reads the file in the same operation");
    assert.equal(await h.member("loose.md"), true);
    assert.equal((await h.definitions()).find(({ alias }) => alias === "loose.md")?.definition?.provenance?.kind, "model-proposal");
    assert.equal(h.notices.length, 1, "one member_added notice");

    const rejected = await h.review("````READ (docs/guide.md)````", "reject");
    const refused = rejected.result as { status: number; outcome?: string; problem?: { detail?: string } };
    assert.equal(refused.status, 400, JSON.stringify(refused));
    assert.equal(refused.outcome, "rejected", "{§proposal}");
    assert.match(String(refused.problem?.detail), /rejected/u, "{§proposal}: the detail names the outcome");
    assert.equal(await h.member("docs/guide.md"), false, "a rejected admission admits nothing");
    assert.equal(h.notices.length, 1, "and announces nothing");
    const again = await h.review("````READ (docs/guide.md) <1,1>````", "reject");
    assert.equal(again.proposal.op, "READ", "a rejection does not retire the file from the universe: the next read proposes again");
    assert.equal((again.result as { status: number }).status, 400);
});

test("{§membership-auto-add} under review, a text FIND proposes the admission of what it matched; accepted, the selection runs over the members", { timeout: 60_000 }, async (t) => {
    const h = await harness(t, {});
    await h.attend();
    const { result, proposal } = await h.review("````FIND (docs/*.md) beta````", "accept");
    assert.equal(proposal.op, "FIND");
    assert.equal(proposal.body, JSON.stringify({ files: ["docs/guide.md"] }));
    const found = result as { status: number; results?: unknown };
    assert.equal(found.status, 200, JSON.stringify(found));
    assert.match(h.paths(found), /docs\/guide\.md/u, "the admitted file's match shows its evidence");
    assert.equal(await h.member("docs/guide.md"), true);
    assert.equal(h.notices.length, 1);
});

test("{§membership-auto-add} a client's READ never admits on the Session's behalf", { timeout: 60_000 }, async (t) => {
    const h = await harness(t, {});
    const read = await h.client("````READ (loose.md)````") as { status: number };
    assert.equal(read.status, 404);
    assert.equal(await h.member("loose.md"), false);
    assert.equal(h.notices.length, 0);
});
});

describe("question-tool", () => {
// {§question-tool} — the assembled proof: the question executor through the real
// Exec scheme pauses on the shared client-interaction lifecycle and resumes
// with the standard ElicitResult in its results channel.

















const execStmt = (body: string): ExecStatement => ({
    metadata: null,
    runtime: "plurnk", aside: null, target: localPath("question"), lineMarker: null, body, position: { line: 1, column: 1 },
});

test("{§question-tool}: dispatched plurnk (question) returns the answer", async () => {
    const db = await openMigrated();
    const schemes = new SchemeRegistry();
    const exec = schemes.get("exec") as Exec;
    const engine = new Engine({ db, schemes });
    engine.setExecutors(await ExecutorRegistry.build({ cwd: process.cwd() }));
    engine.registerRuntimes([{
        tag: "plurnk",
        entry: {
            executor: new FunctionalityManager({
                coordinator: {} as unknown as Functionality,
                entries: [],
                includeQuestion: true,
            }),
            namespaceOwner: { kind: "module", name: "core" },
            glyph: plurnkRuntimeDecl.glyph,
            summary: plurnkRuntimeDecl.summary,
            invocation: plurnkRuntimeDecl.invocation,
            details: plurnkRuntimeDecl.details ?? "",
            ...(plurnkRuntimeDecl.resourcesPath === undefined ? {} : { resourcesPath: plurnkRuntimeDecl.resourcesPath }),
            ...(plurnkRuntimeDecl.expandTools === undefined ? {} : { expandTools: plurnkRuntimeDecl.expandTools }),
            available: true,
            detail: "in-process",
        },
    }]);
    try {
        const workspaceId = await insertWorkspace(db, `question-${crypto.randomUUID()}`);
        const sessionId = await insertSession(db, workspaceId);
        await ownSession(db, workspaceId, sessionId);
        const loopId = await insertLoop(db, sessionId, 1, "question");
        const turnId = await insertTurn(db, loopId, 1, 102);

        let logEntryId = -1;
        const dispatched = engine.dispatch({
            statement: execStmt(JSON.stringify({
                message: "Which branch?",
                requestedSchema: { type: "object", properties: { branch: { type: "string", enum: ["main", "feat/x"] } }, required: ["branch"] },
            })),
            workspaceId, sessionId, loopId, turnId, sequence: 1, origin: "model",
            onDispatch: (id) => { logEntryId = id; },
        });

        const pending = await (async () => {
            for (let i = 0; i < 100; i++) {
                const list = await engine.pendingClientInteractions(workspaceId);
                if (list.length > 0) return list[0];
                await new Promise((resolve) => setTimeout(resolve, 20));
            }
            return undefined;
        })();
        assert.ok(pending !== undefined, "the question produced one durable pending interaction");
        assert.equal(pending.request.toolName, "question");
        assert.equal(pending.request.message, "Which branch?");

        await engine.resolveClientInteraction(pending.interactionId, {
            action: "accept",
            content: { branch: "main" },
        }, { workspaceId, address: TEST_OWNER });
        const result = await dispatched;
        await exec.idle();
        assert.equal(result.status, 200);

        const log = await db.test_get_log_entry_by_id.get<{ attrs: string }>({ id: logEntryId });
        const { pathname } = JSON.parse(log?.attrs ?? "{}") as { pathname: string };
        const entry = await db.test_get_entry_by_pathname_scheme.get<{ id: number }>({ scheme: "plurnk", pathname });
        assert.ok(entry, "the question output entry is addressed under the runtime tag");
        const results = await db.test_get_channel.get<{ content: string; state: string }>({ entry_id: entry.id, name: "results" });
        assert.equal(results?.state, "closed");
        assert.deepEqual(JSON.parse(results?.content ?? "null"), { action: "accept", content: { branch: "main" } });
    } finally {
        await exec.idle();
        await db.close();
    }
});

for (const timing of ["before park", "after park"] as const) {
    for (const action of ["accept", "cancel"] as const) {
        test(`{§question-tool}: ${action} ${timing} resumes the same waiting loop`, async () => {
            const previous = process.env.PLURNK_SERVICE_OPTIMISTIC_WAIT_MS;
            process.env.PLURNK_SERVICE_OPTIMISTIC_WAIT_MS = timing === "before park" ? "1000" : "0";
            const body = JSON.stringify({ message: "Which branch?", requestedSchema: {
                type: "object", properties: { branch: { type: "string" }, notes: { type: "string" } },
            } });
            const provider = new StreamMock({ contextWindow: 100_000, responses: [
                makeMockResponse(`\`\`\`\`plurnk (question)
${body}
\`\`\`\`
\`\`\`\`WAIT
Waiting for your answer.
\`\`\`\``),
                makeMockResponse("````SEND [200]\nThe answer arrived.\n````"),
            ] });
            try {
                await withDaemon(provider, async (db, daemon) => {
                    const workspace = await daemon.createWorkspace({ name: `question-${timing}-${action}` });
                    const sessionId = await namedModelSession(daemon, workspace.workspaceId, "main");
                    await ownSession(db, workspace.workspaceId, sessionId);
                    const run = await daemon.runLoop({ workspaceId: workspace.workspaceId, sessionId, prompt: "Ask me." });
                    const pending = await waitForDb(
                        () => daemon.pendingClientInteractions(workspace.workspaceId),
                        (rows) => rows.length === 1,
                    );
                    if (timing === "after park") await waitForDb(
                        () => db.test_get_loop_status.get<{ status: number }>({ id: run.loopId }),
                        (row) => row?.status === 202,
                    );
                    await daemon.resolveClientInteraction(pending[0].interactionId, action === "accept"
                        ? { action: "accept", content: { branch: "main" } }
                        : { action: "cancel" }, { workspaceId: workspace.workspaceId, address: TEST_OWNER });
                    await waitForDb(
                        () => db.test_get_loop_status.get<{ status: number }>({ id: run.loopId }),
                        (row) => row?.status === 200,
                    );
                    assert.equal(provider.remaining, 0, "exactly one continuation receives the answer");
                    const turns = await db.test_list_turns_in_loop.all<{ producer: string }>({ loop_id: run.loopId });
                    assert.equal(turns.filter(({ producer }) => producer === "model").length, 2,
                        "both model turns belong to the original loop, independently of harness observation turns");
                    assert.deepEqual(await daemon.pendingClientInteractions(workspace.workspaceId), []);
                    const rows = await db.test_log_entries_by_loop.all<{ op: string; rx: string }>({ loop_id: run.loopId });
                    const answer = rows.find((row) => row.op === "READ" && JSON.parse(row.rx).content?.includes(`"${action}"`));
                    assert.ok(answer, "the answer or cancellation is materialized in the resumed loop");
                    const entry = await db.test_get_entry_by_pathname_scheme.get<{ id: number }>({
                        scheme: "plurnk", pathname: new URL(await executionAddress(db, (await db.test_turn_id_by_seq.get<{ id: number }>({ loop_id: run.loopId, sequence: 2 }))!.id, 2)).pathname,
                    });
                    assert.ok(entry);
                    const channel = await db.test_get_channel.get<{ content: string }>({ entry_id: entry.id, name: "results" });
                    assert.deepEqual(JSON.parse(channel?.content ?? "null"), action === "accept"
                        ? { action: "accept", content: { branch: "main" } }
                        : { action: "cancel" });
                });
            } finally {
                if (previous === undefined) delete process.env.PLURNK_SERVICE_OPTIMISTIC_WAIT_MS;
                else process.env.PLURNK_SERVICE_OPTIMISTIC_WAIT_MS = previous;
            }
        });
    }
}

test("{§question-tool}: cancelling the session concludes a pending question as cancellation, not an executor crash", async () => {
    const provider = new StreamMock({ contextWindow: 100_000, responses: [makeMockResponse(
        "````plurnk (question)\n{\"message\":\"Which branch?\",\"requestedSchema\":{\"type\":\"object\",\"properties\":{\"branch\":{\"type\":\"string\"}}}}\n````\n````WAIT\nAwaiting an answer.\n````",
    )] });
    await withDaemon(provider, async (db, daemon) => {
        const { workspaceId } = await daemon.createWorkspace({ name: "question-user-cancel" });
        const sessionId = await namedModelSession(daemon, workspaceId, "main");
        await ownSession(db, workspaceId, sessionId);
        const run = await daemon.runLoop({ workspaceId, sessionId, prompt: "Ask me." });
        await waitForDb(() => daemon.pendingClientInteractions(workspaceId), (rows) => rows.length === 1);
        await daemon.cancelSession({ workspaceId, sessionId, reason: "user_escape" });
        const loop = await db.test_get_loop_status.get<{ status: number }>({ id: run.loopId });
        assert.equal(loop?.status, 499);
        assert.deepEqual(await daemon.pendingClientInteractions(workspaceId), []);
        const entry = await db.test_get_entry_by_pathname_scheme.get<{ id: number }>({ scheme: "plurnk", pathname: new URL(await executionAddress(db, (await db.test_turn_id_by_seq.get<{ id: number }>({ loop_id: run.loopId, sequence: 2 }))!.id, 2)).pathname });
        assert.ok(entry);
        const channel = await waitForDb(
            () => db.test_get_channel_terminal.get<{ producer_result: string }>({ entry_id: entry.id, name: "results" }),
            (row) => row?.producer_result != null,
        );
        const result = JSON.parse(channel?.producer_result ?? "null");
        assert.equal(result?.status, 499);
        assert.equal(result?.problem?.type, "https://problems.plurnk.xyz/scheme/exec/execution-cancelled");
    });
});

test("{§proposal-projection}: KILL ends the question's own waiter without cancelling its loop", async (approvalContext) => {
    serverProposals(approvalContext, "accept");
    const provider = new StreamMock({ contextWindow: 100_000, responses: [
        makeMockResponse("````plurnk (question)\n{\"message\":\"Which branch?\",\"requestedSchema\":{\"type\":\"object\",\"properties\":{\"branch\":{\"type\":\"string\"}}}}\n````\n````NOTE\nContinue while the question is pending.\n````"),
        makeMockResponse("````KILL ($STREAM)````\n````NOTE\nCancel the question.\n````"),
        makeMockResponse("````SEND [200]\nDone.\n````"),
    ] });
    await withDaemon(provider, async (db, daemon) => {
        const { workspaceId } = await daemon.createWorkspace({ name: "question-exec-cancel" });
        const sessionId = await namedModelSession(daemon, workspaceId, "main");
        await ownSession(db, workspaceId, sessionId);
        const run = await daemon.runLoop({ workspaceId, sessionId, prompt: "Ask, then cancel the question." });
        await waitForDb(() => db.test_get_loop_status.get<{ status: number }>({ id: run.loopId }), (row) => row?.status === 200, { timeoutMs: 15_000 });
        assert.equal(provider.remaining, 0);
        assert.deepEqual(await daemon.pendingClientInteractions(workspaceId), []);
        const entry = await db.test_get_entry_by_pathname_scheme.get<{ id: number }>({ scheme: "plurnk", pathname: new URL(await executionAddress(db, (await db.test_turn_id_by_seq.get<{ id: number }>({ loop_id: run.loopId, sequence: 2 }))!.id, 2)).pathname });
        assert.ok(entry);
        const channel = await db.test_get_channel_terminal.get<{ producer_result: string }>({ entry_id: entry.id, name: "results" });
        const result = JSON.parse(channel?.producer_result ?? "null");
        assert.deepEqual(result, { status: 200 }, "{§stream-control}: the question its holder killed concludes as asked");
    });
});
});
