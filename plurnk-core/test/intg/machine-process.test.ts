import test, { describe, type TestContext } from "node:test";
import assert from "node:assert/strict";
import Engine from "../../src/core/Engine.ts";
import SchemeRegistry from "../../src/core/SchemeRegistry.ts";
import Fork from "../../src/core/fork.ts";
import Turn from "../../src/core/Turn.ts";
import SqlRiteCore from "@possumtech/sqlrite/core";
import Envelope from "../../src/server/envelope.ts";
import RuntimeSession from "../../src/core/RuntimeSession.ts";
import { type EditStatement, type LineMarker, type UrlPath, SESSION_NAME } from "@plurnk/plurnk-contracts";
import { providerRequestSettlementParams } from "../../src/core/provider-accounting.ts";
import { openMigrated, insertWorkspace, insertSession, insertLoop, insertTurn, seedEntryWithChannel, insertOperationTurn, MIGRATIONS_DIR } from "./_db.ts";
import { testDeferredProviderCapacity } from "./_provider.ts";
import { findStmt, killStmt, readStmt } from "./_dsl.ts";
import { clientRead } from "./_client-read.ts";
import { PlurnkParser } from "@plurnk/plurnk-parser";
import { fixtureExecutors } from "./_mock.ts";
import { serverProposals } from "./_approval.ts";
import { Mock } from "@plurnk/plurnk-providers";
import { rpcCall, connect, withDaemon, runLoopToTerminal } from "./_rpc.ts";
import { parseLogRecords } from "../LogRecords.ts";
import { packetSection } from "./_packet.ts";
import { type Db } from "../../src/core/Db.ts";
import { createHash } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
// eslint-disable-next-line no-restricted-imports -- this witness writes a released-shape database and reads sqlite_master.
import { DatabaseSync } from "node:sqlite";
import { SqlRiteSync } from "@possumtech/sqlrite";
import { SessionNameError } from "../../src/core/SessionName.ts";

describe("machine-process", () => {
// SPEC {§machine-processes} — behavioral ownership at the real operation seam:
// shared workspace entries, session-owned logs, and fork topology. Dedicated
// membership and session-entry specimens own the overlay and private-scratch rows.













const urlPath = (scheme: string, pathname: string): UrlPath => ({
    kind: "url", raw: `${scheme}://${pathname}`, scheme,
    username: null, password: null, hostname: null, port: null,
    pathname, query: null, fragment: null,
});
const fullReplace: LineMarker = { marks: [1, -1] };
const editStmt = (target: UrlPath, body: string, marker: LineMarker | null = null): EditStatement => ({
    metadata: null,
    op: "EDIT", aside: null, target, lineMarker: marker, body,
    matcher: null, position: { line: 1, column: 1 },
});

test("{§machine-processes} a workspace-commons entry is shared — a second session updates it rather than minting another", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `ws-${crypto.randomUUID()}`);
        const engine = new Engine({ db, schemes: new SchemeRegistry() });
        const spawn = async () => {
            const sessionId = await insertSession(db, workspaceId);
            const loopId = await insertLoop(db, sessionId, 1);
            const turnId = await insertTurn(db, loopId, 1);
            return { sessionId, loopId, turnId };
        };
        const a = await spawn();
        const b = await spawn();
        const target = urlPath("workspace", "/shared.md");
        const resultA = await engine.dispatch({ statement: editStmt(target, "from session A"), workspaceId, sessionId: a.sessionId, loopId: a.loopId, turnId: a.turnId, sequence: 1, origin: "model" });
        const resultB = await engine.dispatch({ statement: editStmt(target, "from session B", fullReplace), workspaceId, sessionId: b.sessionId, loopId: b.loopId, turnId: b.turnId, sequence: 1, origin: "model" });
        // A creates one commons entry (201); B addresses the same commons identity
        // and updates it (200). Private session entries use an owner authority and
        // are deliberately a different contract.
        assert.equal(resultA.status, 201, "session A creates the workspace-commons entry");
        assert.equal(resultB.status, 200, "session B updates the same shared entry instead of minting another");
    } finally { db.close(); }
});

test("{§channels} curating the log leaves the entry catalogued and READ-able, for its author and for a sibling", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `ws-${crypto.randomUUID()}`);
        const engine = new Engine({ db, schemes: new SchemeRegistry() });
        const spawn = async () => {
            const sessionId = await insertSession(db, workspaceId);
            const loopId = await insertLoop(db, sessionId, 1);
            const turnId = await insertTurn(db, loopId, 1);
            return { sessionId, loopId, turnId };
        };
        const author = await spawn();
        const sibling = await spawn();
        const target = urlPath("workspace", "/curated.md");
        const written = await engine.dispatch({ statement: editStmt(target, "the entry itself"), workspaceId, ...author, sequence: 1, origin: "model" });
        assert.equal(written.status, 201);

        // The author retires its own EDIT from context — the model's curation, on the log.
        const curated = await engine.dispatch({
            statement: killStmt(urlPath("log", "/1/1/1")),
            workspaceId, ...author, sequence: 2, origin: "model",
        });
        assert.equal(curated.status, 200, JSON.stringify(curated));

        // The entry is untouched by that: no per-session visible or suppressed state exists to set.
        for (const [who, actor] of [["its author", author], ["a sibling", sibling]] as const) {
            const listed = await engine.dispatch({
                statement: findStmt(urlPath("workspace", "/**")),
                workspaceId, ...actor, sequence: 3, origin: "model",
            });
            assert.equal(listed.status, 200, JSON.stringify(listed));
            assert.match(JSON.stringify(listed.results), /curated\.md/u, `the catalog still lists the entry for ${who}`);
            const read = await clientRead(engine, db, {
                statement: readStmt(target, { marks: [1, -1] }),
                workspaceId, sessionId: actor.sessionId,
            });
            assert.equal(read.status, 200, `the entry still READs for ${who}`);
            assert.equal(read.content, "the entry itself");
        }
    } finally { db.close(); }
});

test("{§machine-processes} a fork copies the parent's log (rows + their suppressed body intervals)", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `ws-${crypto.randomUUID()}`);
        const engine = new Engine({ db, schemes: new SchemeRegistry() });
        const sessionId = await insertSession(db, workspaceId);
        const loopId = await insertLoop(db, sessionId, 1);
        const turnId = await insertTurn(db, loopId, 1);
        await engine.dispatch({ statement: editStmt(urlPath("workspace", "/a.md"), "first"), workspaceId, sessionId, loopId, turnId, sequence: 1, origin: "model" });
        await engine.dispatch({ statement: editStmt(urlPath("workspace", "/b.md"), "second"), workspaceId, sessionId, loopId, turnId, sequence: 2, origin: "model" });
        // Suppress the first row through the real scoped-KILL event path.
        await engine.dispatch({
            statement: killStmt(urlPath("log", "/1/1/1"), { marks: [1, -1] }),
            workspaceId, sessionId, loopId, turnId, sequence: 3, origin: "model",
        });

        const branchSessionId = await Fork.fork(db, sessionId, undefined);

        const shape = (rows: Array<{ op: string; pathname: string; folded: string }>) => rows.map((r) => `${r.op}:${r.pathname}:${r.folded}`);
        const parentLog = await db.engine_render_log.all<{ op: string; pathname: string; folded: string }>({ session_id: sessionId });
        const branchLog = await db.engine_render_log.all<{ op: string; pathname: string; folded: string }>({ session_id: branchSessionId });
        assert.deepEqual(shape(branchLog), shape(parentLog), "the branch's log mirrors the parent's — rows and visibility");
        assert.ok(branchLog.some((r) => r.folded === "[[1,-1]]"), "the row suppressed on the parent stayed suppressed in the branch");
        const effectShape = (rows: Array<{ op: string; operation_sequence: number; target_sequence: number; folded_before: string; folded_after: string }>) =>
            rows.map((row) => `${row.op}:${row.operation_sequence}->${row.target_sequence}:${row.folded_before}->${row.folded_after}`);
        const parentEffects = await db.test_log_curation_effects_by_session.all<{
            op: string; operation_sequence: number; target_sequence: number; folded_before: string; folded_after: string;
        }>({ session_id: sessionId });
        const branchEffects = await db.test_log_curation_effects_by_session.all<{
            op: string; operation_sequence: number; target_sequence: number; folded_before: string; folded_after: string;
        }>({ session_id: branchSessionId });
        assert.deepEqual(effectShape(branchEffects), effectShape(parentEffects), "the branch retains the exact log-curation effect with remapped row identities");
        assert.deepEqual(effectShape(branchEffects), ["KILL:3->1:[]->[[1,-1]]"]);
    } finally { db.close(); }
});

test("{§log-history-projection}: a fork retains killed evidence and its inactive projection", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `ws-${crypto.randomUUID()}`);
        const engine = new Engine({ db, schemes: new SchemeRegistry() });
        const sessionId = await insertSession(db, workspaceId);
        const loopId = await insertLoop(db, sessionId, 1);
        const turnId = await insertTurn(db, loopId, 1);
        await engine.dispatch({
            statement: editStmt(urlPath("workspace", "/retired.md"), "durable evidence"),
            workspaceId, sessionId, loopId, turnId, sequence: 1, origin: "model",
        });
        const [target] = await db.test_log_entries_by_session.all<{ id: number }>({ session_id: sessionId });
        assert.ok(target !== undefined);
        await engine.dispatch({
            statement: killStmt(urlPath("log", "/1/1/1/EDIT")),
            workspaceId, sessionId, loopId, turnId, sequence: 2, origin: "model",
        });

        const branchSessionId = await Fork.fork(db, sessionId, undefined);
        const parentRows = await db.test_log_entries_by_session.all<{ op: string }>({ session_id: sessionId });
        const branchRows = await db.test_log_entries_by_session.all<{ op: string }>({ session_id: branchSessionId });
        assert.deepEqual(parentRows.map(({ op }) => op), ["EDIT", "KILL"]);
        assert.deepEqual(branchRows.map(({ op }) => op), ["EDIT", "KILL"], "the branch keeps both historical events");

        for (const owner of [sessionId, branchSessionId]) {
            const projection = await db.test_get_log_projection.get<{ active: 0 | 1; folded: string }>({
                session_id: owner,
                loop_seq: 1,
                turn_seq: 1,
                sequence: 1,
            });
            assert.equal(projection?.active, 0);
            assert.equal(projection?.folded, "[]");
            assert.equal(
                (await db.engine_render_log.all<{ pathname: string | null }>({ session_id: owner }))
                    .some(({ pathname }) => pathname === "/retired.md"),
                false,
                "inactive evidence is absent from the model-facing render",
            );
        }

        const effectShape = async (owner: number) => (await db.test_log_curation_effects_by_session.all<{
            op: string; active_before: 0 | 1; active_after: 0 | 1;
        }>({ session_id: owner })).map(({ op, active_before, active_after }) => ({ op, active_before, active_after }));
        assert.deepEqual(await effectShape(sessionId), [{ op: "KILL", active_before: 1, active_after: 0 }]);
        assert.deepEqual(await effectShape(branchSessionId), await effectShape(sessionId));
    } finally { await db.close(); }
});

test("{§machine-processes} a fork closes an in-flight turn snapshot without fabricating its disposition", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `ws-${crypto.randomUUID()}`);
        const sessionId = await insertSession(db, workspaceId);
        const loopId = await insertLoop(db, sessionId, 1);
        const source = await Turn.open(db, { loopId, producer: "model", kind: "inference" });

        const branchSessionId = await Fork.fork(db, sessionId, undefined);

        const branchLoop = await db.test_get_loop_by_session.get<{ id: number }>({ session_id: branchSessionId });
        assert.ok(branchLoop !== undefined);
        const [snapshot] = await db.test_list_turns_in_loop.all<{
            producer: string; kind: string; status: number; completed_at: string | null;
        }>({ loop_id: branchLoop.id });
        assert.deepEqual(
            { producer: snapshot?.producer, kind: snapshot?.kind, status: snapshot?.status },
            { producer: "model", kind: "inference", status: 102 },
            "the branch retains the source turn's identity and exact in-flight disposition",
        );
        assert.match(snapshot?.completed_at ?? "", /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
        const parent = await db.test_get_turn.get<{ status: number; completed_at: string | null }>({ id: source.id });
        assert.equal(parent?.status, 102);
        assert.equal(parent?.completed_at, null, "forking does not close the producer's source turn");
    } finally { db.close(); }
});

test("{§machine-processes} a fork shares workspace-commons entries live and uncopied", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `ws-${crypto.randomUUID()}`);
        const engine = new Engine({ db, schemes: new SchemeRegistry() });
        const sessionId = await insertSession(db, workspaceId);
        const loopId = await insertLoop(db, sessionId, 1);
        const turnId = await insertTurn(db, loopId, 1);
        await engine.dispatch({ statement: editStmt(urlPath("workspace", "/shared.md"), "x"), workspaceId, sessionId, loopId, turnId, sequence: 1, origin: "model" });
        const before = (await db.engine_list_workspace_entries.all<{ entry_id: number }>({ workspace_id: workspaceId })).length;

        const branchSessionId = await Fork.fork(db, sessionId, undefined);

        const after = (await db.engine_list_workspace_entries.all<{ entry_id: number }>({ workspace_id: workspaceId })).length;
        const branch = await db.test_session_lineage.get<{ workspace_id: number }>({ id: branchSessionId });
        assert.equal(branch!.workspace_id, workspaceId, "the branch lives in the parent's workspace");
        assert.equal(after, before, "the fork did not duplicate the workspace-commons entry");
    } finally { db.close(); }
});

test("{§machine-processes} a fork copies only quiescent snapshot entries", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `fork-entry-policy-${crypto.randomUUID()}`);
        const parent = await insertSession(db, workspaceId, null, "parent");
        await seedEntryWithChannel(db, {
            workspaceId,
            scheme: "session",
            authority: "parent",
            pathname: "/static",
            content: "retained",
            state: "static",
        });
        await seedEntryWithChannel(db, {
            workspaceId,
            scheme: "session",
            authority: "parent",
            pathname: "/active",
            content: "in flight",
            state: "active",
        });
        await seedEntryWithChannel(db, {
            workspaceId,
            scheme: "derived",
            pathname: "/generated",
            content: "rebuild me",
        });
        await seedEntryWithChannel(db, {
            workspaceId,
            scheme: "ephemeral",
            pathname: "/process",
            content: "do not copy",
        });

        const branch = await Fork.fork(db, parent, "branch");
        const entries = await db.test_fork_scratch_entries.all<{
            scheme: string;
            pathname: string;
            active: number;
        }>({ session_id: branch });
        assert.deepEqual(
            entries.map(({ scheme, pathname }) => ({ scheme, pathname })),
            [{ scheme: "session", pathname: "/static" }],
            "only quiescent named scratch is copied; other resources remain shared",
        );
    } finally { await db.close(); }
});

test("{§machine-processes} a fork creates a session while retaining the shared workspace", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `ws-${crypto.randomUUID()}`);
        const sessionId = await insertSession(db, workspaceId);
        const branchSessionId = await Fork.fork(db, sessionId, undefined);
        assert.notEqual(branchSessionId, sessionId, "a fork is a new session");
        const lineage = await db.test_session_lineage.get<{ workspace_id: number; parent_session_id: number | null }>({ id: branchSessionId });
        assert.equal(lineage!.workspace_id, workspaceId, "the branch is in the parent's workspace — the workspace is shared, never forked");
        assert.equal(lineage!.parent_session_id, sessionId, "the branch's lineage points at the parent session");
    } finally { db.close(); }
});

test("{§machine-processes} — a fork inherits history without copying provider requests", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `ws-${crypto.randomUUID()}`);
        const sessionId = await insertSession(db, workspaceId);
        const loopId = await insertLoop(db, sessionId, 1);
        const turn = await Turn.open(db, { loopId, producer: "model", kind: "inference" });
        const turnId = turn.id;
        await Turn.recordInference(db, turnId, {
            packet: JSON.stringify({ weight: 0, attributions: [] }),
            sections: "[]",
            usageCurationBudget: null, finishReason: null, model: "mock", meta: "{}",
        });
        await Turn.complete(db, turnId, 200);
        const modelCall = await db.engine_open_model_call.get<{ id: number }>({
            turn_id: turnId,
            kind: "emission",
            attributions: "[]",
            model: "mock",
        });
        assert.ok(modelCall !== undefined);
        const attempt = await db.engine_open_turn_attempt.get<{ id: number }>({
            model_call_id: modelCall.id,
        });
        assert.ok(attempt !== undefined);
        const request = await db.engine_open_provider_request.get<{ id: number }>({
            inference_call_id: modelCall.id,
            sequence: 1,
            provider: "provider:fixture",
            model: "mock",
        });
        await db.engine_settle_provider_request.run(providerRequestSettlementParams(request!.id, {
            provider: "provider:fixture",
            model: "mock",
            outcome: "response",
            usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150 },
            cost: {
                kind: "charged",
                amount: { amount: "1000", currency: "USD" },
                source: "machine fixture",
            },
        }));
        await db.engine_observe_model_call_response.run({
            id: modelCall.id,
            native_inputs: "[]",
            response: JSON.stringify({ assistant: { model: "mock" } }),
            failure: null,
            capacity: JSON.stringify(testDeferredProviderCapacity("machine:emission-fixture")),
            finish_reason: null,
            model: "mock",
        });
        await db.engine_classify_turn_attempt_response.run({
            id: attempt.id,
            accepted: 1,
            parse_errors: "[]",
        });
        const bareCall = await db.engine_open_model_call.get<{ id: number }>({
            turn_id: turnId,
            kind: "bare",
            attributions: "[]",
            model: "mock",
        });
        assert.ok(bareCall !== undefined);
        const bareRequest = await db.engine_open_provider_request.get<{ id: number }>({
            inference_call_id: bareCall.id,
            sequence: 1,
            provider: "provider:fixture",
            model: "mock",
        });
        await db.engine_settle_provider_request.run(providerRequestSettlementParams(bareRequest!.id, {
            provider: "provider:fixture",
            model: "mock",
            outcome: "response",
            usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
            cost: {
                kind: "charged",
                amount: { amount: "0", currency: "USD" },
                source: "machine fixture",
            },
        }));
        await db.engine_observe_model_call_response.run({
            id: bareCall.id,
            native_inputs: "[]",
            response: JSON.stringify({ assistant: { content: "Berlin", model: "mock" } }),
            failure: null,
            capacity: JSON.stringify(testDeferredProviderCapacity("machine:bare-fixture")),
            finish_reason: "stop",
            model: "mock",
        });
        await db.engine_insert_log_entry.run({
            session_id: sessionId,
            loop_id: loopId,
            turn_id: turnId,
            sequence: 1,
            origin: "model",
            source: null,
            model_call_id: bareCall.id,
            op: "BARE",
            scheme: null,
            username: null,
            password: null,
            hostname: null,
            port: null,
            pathname: null,
            query: null,
            fragment: null,
            lineMarker: null,
            tx: JSON.stringify({ op: "BARE", body: "What is the capital of Germany?" }),
            mimetype_tx: "application/json",
            rx: JSON.stringify({ status: 200, content: "Berlin", mimetype: "text/plain" }),
            mimetype_rx: "application/json",
            status_rx: 200,
            weight: 1,
            state: "resolved",
            outcome: null,
            attrs: "{}",
        });
        const engine = new Engine({ db, schemes: new SchemeRegistry() });
        assert.equal((await engine.loopUsage(loopId)).accounting.costUsd, "1000");
        assert.equal((await db.test_count_provider_requests.get<{ n: number }>())?.n, 2);

        const branchSessionId = await Fork.fork(db, sessionId, undefined);

        assert.equal((await db.test_count_provider_requests.get<{ n: number }>())?.n, 2, "forking creates no provider request");
        assert.equal((await engine.loopUsage(loopId)).accounting.costUsd, "1000", "parent evidence is untouched");
        const branchLoop = await db.test_get_loop_by_session.get<{ id: number }>({ session_id: branchSessionId });
        assert.ok(branchLoop !== undefined);
        const branchUsage = await engine.loopUsage(branchLoop.id);
        assert.equal(branchUsage.accounting.costUsd, "0");
        assert.deepEqual(branchUsage.accounting.requests, [], "copied history carries no physical request evidence");
        const [branchTurn] = await db.test_list_turns_in_loop.all<{ id: number }>({ loop_id: branchLoop.id });
        assert.ok(branchTurn !== undefined);
        assert.deepEqual(
            await db.test_model_calls.all({ turn_id: branchTurn.id }),
            [],
            "copied turns carry no logical model-call or admission identity",
        );
        const branchRows = await db.test_log_entries_by_turn.all<{ op: string | null; model_call_id: number | null }>({
            turn_id: branchTurn.id,
        });
        assert.deepEqual(
            branchRows.map(({ op, model_call_id }) => ({ op, model_call_id })),
            [{ op: "BARE", model_call_id: null }],
            "the BARE result remains in the copied history without claiming the source call",
        );
    } finally { db.close(); }
});
});

describe("Engine.copy-session-authority", () => {
for (const operation of ["COPY", "MOVE"]) for (const destination of ["", "caller", "peer"]) for (const scoped of [false, true]) {
    test(`{§session-scheme}: ${operation} to '${destination}' preserves ${scoped ? "scoped" : "whole"} transfer semantics`, async () => {
        await using db = await openMigrated();
        const workspaceId = await insertWorkspace(db, crypto.randomUUID());
        const sessionId = await insertSession(db, workspaceId, null, "caller");
        await insertSession(db, workspaceId, null, "peer");
        const loopId = await insertLoop(db, sessionId, 1);
        const turnId = await insertOperationTurn(db, loopId, 1, "client");
        const engine = new Engine({ db, schemes: new SchemeRegistry() });
        let sequence = 0;
        const run = (header: string, body: string | null = null) => {
            const item = PlurnkParser.parseStatements(PlurnkParser.frame(header, body), { executors: fixtureExecutors(PlurnkParser.frame(header, body)) }).items[0];
            assert.equal(item?.kind, "statement");
            if (item?.kind !== "statement") throw new Error("Expected an operation");
            return engine.dispatch({ workspaceId, sessionId, loopId, turnId, sequence: ++sequence, origin: "client",
                statement: item.statement });
        };
        const source = "session://peer/source.md";
        const target = destination === "" ? "workspace:///copy.md" : `session://${destination}/copy.md`;
        assert.equal((await run(`EDIT (${source})`, "first\nsecond\nthird")).status, 201);
        assert.equal((await run(`${operation} (${source}) ${scoped ? "<1,2>" : ""} (${target})`)).status, 201);
        const copied = await run(`READ (${target}) <1,-1>`);
        assert.equal(String(copied.content).trimEnd(), scoped ? "first\nsecond" : "first\nsecond\nthird");
        const original = await run(`READ (${source}) <1,-1>`);
        if (operation === "COPY") assert.equal(original.content, "first\nsecond\nthird");
        else if (scoped) assert.equal(String(original.content).trimEnd(), "third");
        else assert.equal(original.status, 404);
    });
}
});

describe("Engine.log-curation-receipts", () => {
// {§log-history-projection}






const logSection = (packet: string): string => {
    return packetSection(JSON.parse(packet), "log");
};
const rows = (log: string, op: string): Array<Record<string, unknown>> =>
    parseLogRecords(log).filter(({ logPath: path }) => typeof path === "string" && path.endsWith(`/${op}`));
const row = (log: string, op: string): Record<string, unknown> | undefined => rows(log, op)[0];

test("{§log-history-projection} a KILL that worked never renders; one that matched nothing renders once; errors, resource KILLs, and forensic evidence remain", async (approvalContext) => {
    serverProposals(approvalContext, "accept");
    const mock = new Mock({ contextWindow: 32768, responses: [
        "````EDIT (workspace:///note)\nfirst line\nsecond line\n````\n\n````READ (workspace:///note)````\n````NOTE\nwrote\n````",
        "````KILL (log:///1/**/READ) <2,-1>````\n````KILL (log:///1/**/EDIT)````\n````KILL (log:///9/9/9)````\n````NOTE\ncurated\n````",
        "````KILL (log:///1/**/EDIT)````\n````READ (log:///1/3/2/KILL)````\n````READ (workspace:///note)````\n````KILL (workspace:///note)````\n````NOTE\nverified\n````",
        "````NOTE\nthe mismatch has been seen; moving on\n````",
        "````SEND [200]\ndone\n````",
    ].map((content) => ({ assistant: { content, reasoning: null } })) });
    await withDaemon(mock, async (db, _daemon, addr) => {
        const ws = await connect(addr);
        try {
            await rpcCall(ws, 1, "workspace.create", { name: "log-curation-receipts" });
            const result = await runLoopToTerminal(ws, 2, { prompt: "curate" });
            assert.equal(result.result.status, 200);
            const ids = result.turnIds ?? [];
            assert.ok(ids.length >= 6, `init + five model turns; got ${ids.length}`);
            const packetOf = async (index: number) => logSection((await db.test_get_packet.get<{ packet: string }>({ id: ids[index] }))!.packet);
            const afterCuration = await packetOf(3);
            const kills = rows(afterCuration, "KILL");
            assert.deepEqual(kills.map(({ logPath, status }) => ({ logPath, status })), [
                { logPath: "log:///1/3/4/KILL", status: 404 },
            ], "the first packet after curation contains the failed KILL, not successful receipts");
            assert.ok(kills[0].problem, "the failed KILL retains its corrective Problem");
            assert.equal(row(afterCuration, "EDIT"), undefined, "the killed EDIT row is retired from the projection");
            const trimmed = rows(afterCuration, "READ").find(({ logPath }) => logPath === "log:///1/2/4/READ");
            assert.match(String(trimmed?.body), /first line/u, "scoped curation retains the untrimmed line");
            assert.doesNotMatch(String(trimmed?.body), /second line/u, "scoped curation removes the requested line");
            const afterRepeat = await packetOf(4);
            assert.deepEqual(rows(afterRepeat, "KILL").map(({ logPath, status }) => ({ logPath, status })), [
                { logPath: "log:///1/3/4/KILL", status: 404 },
                { logPath: "log:///1/4/2/KILL", status: 204 },
                { logPath: "log:///1/4/5/KILL", status: undefined },
            ], "the mismatch says so in the very next packet — the model cannot otherwise tell its own earlier KILL emptied the selection (#779)");
            assert.ok(rows(afterRepeat, "READ").some(({ logPath }) => logPath === "log:///1/4/3/READ"), "explicit READ of a suppressed receipt remains an ordinary visible operation");
            const afterNext = await packetOf(5);
            assert.deepEqual(rows(afterNext, "KILL").map(({ logPath, status }) => ({ logPath, status })), [
                { logPath: "log:///1/3/4/KILL", status: 404 },
                { logPath: "log:///1/4/5/KILL", status: undefined },
            ], "shown once: a turn later the mismatch has retired, and the failure and resource deletion stay");
            const history = await db.test_log_entries_by_loop.all<{
                op: string | null; pathname: string | null; scheme: string | null;
                status_rx: number; rx: string; active: number;
            }>({ loop_id: result.loopId });
            const recordedKills = history.filter(({ op, pathname }) => op === "KILL" && pathname !== null);
            assert.deepEqual(recordedKills.map(({ status_rx }) => status_rx), [200, 200, 404, 204, 200]);
            assert.deepEqual(history.filter(({ op, pathname, rx }) => op === "SEND" && pathname === null && JSON.parse(rx).completion === 200)
                .map(({ status_rx }) => status_rx), [200], "the final reply resolves the message without curating a resource");
            assert.ok(recordedKills.every(({ active }) => active === 1), "packet suppression does not retire or delete receipt history");
            assert.equal(JSON.parse(recordedKills[0].rx).matched, 1, "the broad sweep matches the file READ; initialization reads nothing back ({§session-initialization-entry})");
            const sourceReads = history.filter(({ op, scheme, pathname }) => op === "READ" && scheme === "workspace" && pathname === "/note");
            assert.equal(sourceReads.length, 2);
            for (const read of sourceReads) {
                assert.equal(JSON.parse(read.rx).content, "first line\nsecond line", "log curation changes neither the original receipt evidence nor its source");
            }
            const receiptRead = history.find(({ op, scheme, pathname }) => op === "READ" && scheme === "log" && pathname === "/1/3/2/KILL");
            assert.ok(receiptRead);
            assert.equal(receiptRead.status_rx, 204, "the suppressed receipt remains addressable with its ordinary empty body, not a missing-entry error");
            assert.equal(JSON.parse(receiptRead.rx).content, "");
            assert.equal(history.filter(({ op }) => op === null).length, 0, "source retention does not add log rows");
            const programs = await db.test_turn_sources.all<{ kind: string; turn_id: number; content: string }>({ session_id: result.modelSessionId! });
            for (const index of mock.received.keys()) {
                assert.ok(programs.some(({ kind, turn_id }) => kind === "ops" && turn_id === ids[index + 1]), "every model turn retains its content source after curation");
            }
        } finally { ws.close(); }
    });
});
});

describe("loops", () => {
const seedSession = async (db: Db, label: string): Promise<number> => {
    const workspaceId = await insertWorkspace(db, label);
    return insertSession(db, workspaceId);
};

const terminalResult = (status: number, sequence: number): string | null => {
    if ([100, 102, 202].includes(status)) return null;
    if (status < 400) return JSON.stringify({ status });
    return JSON.stringify({
        status,
        problem: {
            type: "https://problems.plurnk.xyz/test/fixture/terminal",
            title: "Test terminal",
            status,
            detail: "The test fixture made this loop terminal.",
            instance: `ops://fixture/${sequence}`,
        },
    });
};

test("{§tokenomics} loops: status enum — 102, 200, 413, 429, 499, 500, 508 all accepted", async () => {
    const db = await openMigrated();
    try {
        const sessionId = await seedSession(db, "ws-loops-enum");
        // The full terminal vocabulary: model SENDs (200), engine-imposed ceilings
        // (413 budget, 429 turn-cap), cancel (499), and the strike split (500 fail,
        // 508 runaway). 102 = running. (100 queued is covered in the next test.)
        const valid = [102, 200, 413, 429, 499, 500, 508];
        for (const [i, status] of valid.entries()) {
            await db.test_loops_insert_with_status.run({
                session_id: sessionId,
                sequence: i + 1,
                status,
                prompt: "x",
                terminal_result: terminalResult(status, i + 1),
            });
        }
        const rows = await db.test_loops_statuses_by_session.all<{ status: number }>({ session_id: sessionId });
        assert.deepEqual(rows.map((r) => r.status), valid);
    } finally { await db.close(); }
});

test("{§tokenomics} loops: status enum accepts 100 (queued) — drain prerequisite", async () => {
    // 100 = "enqueued, awaiting drain claim." Drain flips 100 → 102 atomically
    // when it picks a loop up. Pre-drain enqueueing relies on this state being
    // legal in the CHECK constraint.
    const db = await openMigrated();
    try {
        const sessionId = await seedSession(db, "ws-loops-queued");
        await db.test_loops_insert_with_status.run({
            session_id: sessionId,
            sequence: 1,
            status: 100,
            prompt: "queued",
            terminal_result: null,
        });
        const rows = await db.test_loops_statuses_by_session.all<{ status: number }>({ session_id: sessionId });
        assert.deepEqual(rows.map((r) => r.status), [100]);
    } finally { await db.close(); }
});

test("{§session-loop-lifecycle} loops: one terminal-result constraint rejects incomplete failures on insert and update", async () => {
    const db = await openMigrated();
    try {
        const sessionId = await seedSession(db, "ws-loops-terminal-result");
        await assert.rejects(
            () => db.test_loops_insert_with_status.run({
                session_id: sessionId,
                sequence: 1,
                status: 500,
                prompt: "invalid insert",
                terminal_result: JSON.stringify({ status: 500 }),
            }),
            /loops_terminal_result_contract/,
            "a failed result cannot omit its Problem",
        );

        await db.test_loops_insert.run({
            session_id: sessionId,
            sequence: 2,
            prompt: "invalid update",
        });
        const loop = await db.test_loops_get_by_session.get<{ id: number }>({ session_id: sessionId });
        assert.ok(loop);
        await assert.rejects(
            () => db.test_set_loop_status.run({
                id: loop.id,
                status: 500,
                terminal_result: JSON.stringify({ status: 500 }),
            }),
            /loops_terminal_result_contract/,
            "an update cannot exploit SQLite NULL truth to omit its Problem",
        );
    } finally { await db.close(); }
});

test("{§tokenomics} loops: status enum rejects non-enum values (e.g. 201, 300, 0, -1)", async () => {
    const db = await openMigrated();
    try {
        const sessionId = await seedSession(db, "ws-loops-badenum");
        // 201/300 are valid HTTP but not loop statuses; 0/-1 are out of range.
        for (const bad of [201, 300, 0, -1]) {
            await assert.rejects(
                () => db.test_loops_insert_with_status.run({
                    session_id: sessionId,
                    sequence: 1,
                    status: bad,
                    prompt: "x",
                    terminal_result: terminalResult(bad, 1),
                }),
                /CHECK constraint failed/,
                `status ${bad} should be rejected`,
            );
        }
    } finally { await db.close(); }
});

test("{§db-migrations} loops: sequence < 1 rejected by CHECK", async () => {
    const db = await openMigrated();
    try {
        const sessionId = await seedSession(db, "ws-loops-seqzero");
        await assert.rejects(
            () => db.test_loops_insert.run({ session_id: sessionId, sequence: 0, prompt: "x" }),
            /CHECK constraint failed/,
        );
        await assert.rejects(
            () => db.test_loops_insert.run({ session_id: sessionId, sequence: -1, prompt: "x" }),
            /CHECK constraint failed/,
        );
    } finally { await db.close(); }
});

test("{§session-scheme} loops: (session_id, sequence) UNIQUE — duplicate within session rejected", async () => {
    const db = await openMigrated();
    try {
        const sessionId = await seedSession(db, "ws-loops-uniq");
        await db.test_loops_insert.run({ session_id: sessionId, sequence: 1, prompt: "a" });
        await assert.rejects(
            () => db.test_loops_insert.run({ session_id: sessionId, sequence: 1, prompt: "b" }),
            /UNIQUE constraint failed/,
        );
    } finally { await db.close(); }
});

test("{§session-scheme} loops: same sequence number across different sessions is fine", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, "ws-loops-crossrun");
        const sessionA = await insertSession(db, workspaceId);
        const sessionB = await insertSession(db, workspaceId);
        await db.test_loops_insert.run({ session_id: sessionA, sequence: 1, prompt: "a-1" });
        await db.test_loops_insert.run({ session_id: sessionB, sequence: 1, prompt: "b-1" });
        const count = (await db.test_loops_count.get<{ n: number }>())?.n;
        assert.equal(count, 2);
    } finally { await db.close(); }
});

test("{§db-migrations} loops: session_id NOT NULL — insert without session_id rejected", async () => {
    const db = await openMigrated();
    try {
        await assert.rejects(
            () => db.test_loops_insert_no_session_id(),
            /NOT NULL constraint failed: loops\.session_id/,
        );
    } finally { await db.close(); }
});

test("{§db-migrations} loops: empty prompt is allowed", async () => {
    const db = await openMigrated();
    try {
        const sessionId = await seedSession(db, "ws-loops-emptyprompt");
        await db.test_loops_insert.run({ session_id: sessionId, sequence: 1, prompt: "" });
        const row = await db.test_loops_get_prompt.get<{ prompt: string }>({ session_id: sessionId });
        assert.equal(row?.prompt, "");
    } finally { await db.close(); }
});

test("{§db-migrations} loops: session_id FK — insert against non-existent session rejected", async () => {
    const db = await openMigrated();
    try {
        await assert.rejects(
            () => db.test_loops_insert.run({ session_id: 99999, sequence: 1, prompt: "x" }),
            /FOREIGN KEY constraint failed/,
        );
    } finally { await db.close(); }
});

test("{§db-migrations} loops: ON DELETE CASCADE via session — deleting session removes its loops", async () => {
    const db = await openMigrated();
    try {
        const sessionId = await seedSession(db, "ws-loops-runcascade");
        await db.test_loops_insert.run({ session_id: sessionId, sequence: 1, prompt: "a" });
        await db.test_loops_insert.run({ session_id: sessionId, sequence: 2, prompt: "b" });
        await db.test_sessions_delete.run({ id: sessionId });
        const remaining = (await db.test_loops_count.get<{ n: number }>())?.n;
        assert.equal(remaining, 0);
    } finally { await db.close(); }
});

test("{§db-migrations} loops: CASCADE chain via workspace→sessions→loops", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, "ws-loops-workspacecascade");
        const sessionId = await insertSession(db, workspaceId);
        await db.test_loops_insert.run({ session_id: sessionId, sequence: 1, prompt: "a" });
        await db.test_workspaces_delete.run({ id: workspaceId });
        const remaining = (await db.test_loops_count.get<{ n: number }>())?.n;
        assert.equal(remaining, 0);
    } finally { await db.close(); }
});

test("{§db-migrations} loops: negative version rejected by CHECK", async () => {
    const db = await openMigrated();
    try {
        const sessionId = await seedSession(db, "ws-loops-negver");
        await assert.rejects(
            () => db.test_loops_insert_with_version.run({ session_id: sessionId, sequence: 1, version: -1, prompt: "x" }),
            /CHECK constraint failed/,
        );
    } finally { await db.close(); }
});
});

describe("schema-baseline", () => {




// {§db-migrations} — every released schema version from the 4.0.0 support floor forward and the
// fingerprint of its shape: each release freezes what it shipped, and a database from any of them
// keeps its path through the versions after it. A database from before the 4.0.0 floor upgrades
// through @plurnk/plurnk-service@4.3.3 first.
type Release = { readonly version: number; readonly release: string; readonly shape: string };
const V4_3_3: Release = Object.freeze({ version: 10, release: "4.3.3", shape: "eb983f7a985b3ba40bec17b3b16a8acd2bf1ea0300bbbceb446762c1bec78bd0" });
const V4_3_0: Release = Object.freeze({ version: 9, release: "4.3.0", shape: "eb983f7a985b3ba40bec17b3b16a8acd2bf1ea0300bbbceb446762c1bec78bd0" });
const V4_0_0: Release = Object.freeze({ version: 8, release: "4.0.0", shape: "eace3ea2371f551d2b69cbb830a575abf0793f0bd62d3d27bbad1cdd08368e7e" });

// A database at a released version, in a temporary root the test removes when it ends.
const released = async (t: Pick<TestContext, "after">, release: Pick<Release, "version">): Promise<string> => {
    const root = await mkdtemp(join(tmpdir(), "plurnk-released-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const dir = join(root, "migrations");
    await mkdir(dir);
    const chapters = (await readdir(MIGRATIONS_DIR)).filter((name) => Number(name.split("_")[0]) <= release.version);
    await Promise.all(chapters.map((name) => copyFile(join(MIGRATIONS_DIR, name), join(dir, name))));
    const path = join(root, "released.db");
    new SqlRiteSync({ path, dir }).close();
    return path;
};

const shape = (path: string): string => {
    const db = new DatabaseSync(path);
    try {
        const rows = db.prepare("SELECT type, name, sql FROM sqlite_master WHERE sql IS NOT NULL ORDER BY type, name").all() as Array<{ type: string; name: string; sql: string }>;
        const text = rows.map(({ type, name, sql }) => `${type} ${name} ${sql.replace(/--[^\n]*/g, "").replace(/\s+/g, " ")}`).join("\n");
        return createHash("sha256").update(text).digest("hex");
    } finally { db.close(); }
};

test(`{§db-migrations} {§machine-processes}: a ${V4_0_0.release} database keeps every row, each workspace and session shown`, async (t) => {
    const path = await released(t, V4_0_0);
    const before = new DatabaseSync(path);
    before.exec(`
        PRAGMA foreign_keys = ON;
        INSERT INTO workspaces (id, name) VALUES (1, 'retained');
        INSERT INTO session_owners (workspace_id, address, tools, interactive) VALUES (1, '_plurnk', '[]', 0);
        INSERT INTO sessions (id, workspace_id, name, origin) VALUES (1, 1, 'root', 'model');
        INSERT INTO sessions (id, workspace_id, name, parent_session_id, origin) VALUES (2, 1, 'child', 1, 'model');
    `);
    const workspace = { ...before.prepare("SELECT * FROM workspaces WHERE id = 1").get() };
    const sessions = before.prepare("SELECT * FROM sessions ORDER BY id").all().map((row) => ({ ...row }));
    before.close();
    const upgraded = await openMigrated(path);
    await upgraded.close();
    const after = new DatabaseSync(path);
    try {
        assert.deepEqual({ ...after.prepare("SELECT * FROM workspaces WHERE id = 1").get() }, { ...workspace, hidden_at: null });
        assert.deepEqual(after.prepare("SELECT * FROM sessions ORDER BY id").all().map((row) => ({ ...row })),
            sessions.map((row) => ({ ...row, hidden_at: null, hidden_by: null })));
        assert.deepEqual(after.prepare("PRAGMA foreign_key_check").all(), []);
    } finally { after.close(); }
});

test(`{§db-migrations} {§session-ownership}: a ${V4_3_0.release} database collapses historical operator owners onto the workspace ACP operator owner`, async (t) => {
    const path = await released(t, V4_3_0);
    const before = new DatabaseSync(path);
    try {
        before.exec(`
            PRAGMA foreign_keys = ON;
            INSERT INTO workspaces (id, name) VALUES (1, 'operatorOwners');
            INSERT INTO session_owners (workspace_id, address, tools, interactive) VALUES
                (1, '_plurnk', '[]', 0),
                (1, 'acp://anonymous/threads/1%23user', '["request_approval","question"]', 1),
                (1, 'acp://operator/threads/1%23child', '["request_approval"]', 0),
                (1, 'acp://operator', '["request_approval"]', 0);
            INSERT INTO sessions (id, workspace_id, name, origin, owner) VALUES
                (1, 1, 'user', 'model', 'acp://anonymous/threads/1%23user'),
                (2, 1, 'child', 'model', 'acp://operator/threads/1%23child'),
                (3, 1, 'peer', 'model', 'acp://operator');
            INSERT INTO loops (id, session_id, sequence, prompt, max_turns) VALUES (1, 2, 1, 'Ask', -1);
            INSERT INTO turns (id, loop_id, sequence, producer, kind, status) VALUES (1, 1, 1, 'model', 'inference', 102);
            INSERT INTO client_interactions (id, session_id, loop_id, turn_id, recipient, request)
                VALUES (1, 2, 1, 1, 'acp://operator/threads/1%23child', '{"tool":"question"}');
        `);
    } finally { before.close(); }
    const upgraded = await openMigrated(path);
    await upgraded.close();
    const after = new DatabaseSync(path);
    try {
        assert.deepEqual(after.prepare("SELECT address, tools, interactive FROM session_owners WHERE workspace_id = 1 ORDER BY address").all().map((row) => ({ ...row })), [
            { address: "_plurnk", tools: "[]", interactive: 0 },
            { address: "acp://operator", tools: '["request_approval","question"]', interactive: 1 },
        ]);
        assert.deepEqual(after.prepare("SELECT id, owner FROM sessions ORDER BY id").all().map((row) => ({ ...row })), [
            { id: 1, owner: "acp://operator" },
            { id: 2, owner: "acp://operator" },
            { id: 3, owner: "acp://operator" },
        ]);
        assert.equal(after.prepare("SELECT recipient FROM client_interactions WHERE id = 1").get()!.recipient, "acp://operator");
        assert.deepEqual(after.prepare("PRAGMA foreign_key_check").all(), []);
    } finally { after.close(); }
});

test("{§db-migrations}: a database from before the 4.0.0 support floor is refused naming the stepping-stone release", async (t) => {
    const root = await mkdtemp(join(tmpdir(), "plurnk-pre-floor-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    for (const version of [8, 28]) {
        const dir = join(root, `v${version}`);
        await mkdir(dir);
        await writeFile(join(dir, `0${version}_legacy.sql`), `-- MIGRATE: ${version} legacy\nCREATE TABLE workspaces (id INTEGER NOT NULL PRIMARY KEY, name TEXT NOT NULL);\n`);
        const dbPath = join(root, `legacy-${version}.db`);
        new SqlRiteSync({ path: dbPath, dir }).close();
        await assert.rejects(
            () => openMigrated(dbPath),
            /precedes the 4\.0\.0 support floor; upgrade through @plurnk\/plurnk-service@4\.3\.3 first/,
        );
    }
});

test("{§db-migrations}: versions are consecutive from 1 and a fresh database lands on the last", async () => {
    const versions = SqlRiteCore.loadChunks({ dir: MIGRATIONS_DIR }).MIGRATE.map(({ version }) => version);
    assert.deepEqual(versions, versions.map((_, index) => index + 1), "versions are numbered consecutively from 1 with no gaps");
    assert.ok(versions.length >= V4_0_0.version, "the released versions are all present");
    const db = await openMigrated();
    try {
        const row = await db.test_schema_version.get<{ v: number }>({});
        assert.equal(row?.v, versions.length, "a fresh database applies every version");
    } finally { await db.close(); }
});

for (const release of [V4_3_3, V4_3_0, V4_0_0]) {
    test(`{§db-migrations}: versions 1-${release.version} keep the ${release.release} shape`, async (t) => {
        assert.equal(shape(await released(t, release)), release.shape, `a released migration changed shape; add the next MIGRATE version instead of editing versions 1-${release.version}`);
    });
}
});

describe("session-topology-mechanics", () => {
// Core session-topology mechanics at the integration level — fork IDENTITY and the premature-terminate
// LIVENESS contract. These are the seams the fanout demo broke on (forks colliding on one name, forks
// inheriting a frozen-live loop, the 409 gate disagreeing with the Open Work orientation). Guarded
// here so they can't reach a real-model tier half-baked again.






const TERMINAL = new Set([200, 413, 429, 499, 500, 508]);

test("{§execution-output-identity} N self-forks of one parent get UNIQUE, individually-addressable names", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `fork-uniq-${crypto.randomUUID()}`);
        const parent = await insertSession(db, workspaceId, null, "session");
        await insertLoop(db, parent, 1, "go");
        const f1 = await Fork.fork(db, parent, undefined);
        const f2 = await Fork.fork(db, parent, undefined);
        const f3 = await Fork.fork(db, parent, undefined);
        const nameOf = async (id: number): Promise<string | undefined> => (await db.session_get.get<{ name: string }>({ id }))?.name;
        const [n1, n2, n3] = [await nameOf(f1), await nameOf(f2), await nameOf(f3)];
        for (const name of [n1, n2, n3]) assert.match(name ?? "", /^[a-f0-9]{8}$/);
        assert.equal(new Set([n1, n2, n3]).size, 3, "no two forks collide on a single name");
        // The bug: a single `session-fork` would have session_resolve_by_name resolve to the newest for ALL three,
        // so KILL/SEND/READ could only ever reach one. Each unique name must address its OWN fork.
        for (const [n, id] of [[n1, f1], [n2, f2], [n3, f3]] as const) {
            const r = await db.session_resolve_by_name.get<{ id: number }>({ workspace_id: workspaceId, name: n });
            assert.equal(r?.id, id, `session://${n} addresses its own fork`);
        }
    } finally { await db.close(); }
});

test("{§execution-output-identity}: concurrent unnamed forks atomically claim distinct short names", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `fork-concurrent-${crypto.randomUUID()}`);
        const parent = await insertSession(db, workspaceId, null, "session");
        const forks = await Promise.all(Array.from({ length: 8 }, () => Fork.fork(db, parent, undefined)));
        const names = await Promise.all(forks.map(async (id) =>
            (await db.session_get.get<{ name: string }>({ id }))?.name ?? ""));

        assert.equal(new Set(names).size, forks.length, "every concurrent fork remains individually addressable");
        for (const name of names) assert.match(name, /^[a-f0-9]{8}$/);
    } finally { await db.close(); }
});

test("{§session-scheme} an automatic fork of a maximum-length parent remains a mintable session name", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `fork-name-${crypto.randomUUID()}`);
        const parent = await insertSession(db, workspaceId, null, "a".repeat(63));
        const fork = await Fork.fork(db, parent, undefined);
        const name = (await db.session_get.get<{ name: string }>({ id: fork }))?.name ?? "";

        assert.ok(SESSION_NAME.test(name), "the generated name satisfies the contracts-owned minting predicate");
        assert.match(name, /^[a-f0-9]{8}$/, "the parent name does not influence the generated identity");
    } finally { await db.close(); }
});

test("{§machine-processes} a fork inherits the parent's loops as HISTORY (clamped terminal), never frozen-live", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `fork-clamp-${crypto.randomUUID()}`);
        const parent = await insertSession(db, workspaceId, null, "p");
        await insertLoop(db, parent, 1, "live"); // the parent's current loop — non-terminal (forking mid-flight)
        const fork = await Fork.fork(db, parent, undefined);
        const loops = await db.test_fork_loops.all<{ status: number }>({ session_id: fork });
        assert.ok(loops.length > 0, "the fork inherited the parent's loop");
        assert.ok(loops.every((l) => TERMINAL.has(l.status)), `inherited loops are terminal history, not frozen-live (got [${loops.map((l) => l.status).join(", ")}])`);
    } finally { await db.close(); }
});

test("{§loop-completion} the completion gate and child orientation use the same any-unresolved-loop liveness law", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `gate-orient-${crypto.randomUUID()}`);
        const parent = await insertSession(db, workspaceId);
        // {§loop-completion} — the gate reads the same view the wait matrix and the drain do.
        const gate = async (): Promise<boolean> => (await db.session_live_obligations.get<{ sessions: 0 | 1 }>({ session_id: parent }))?.sessions === 1;
        const orientCount = async (): Promise<number> => (await db.engine_child_sessions_live.all<{ name: string }>({ session_id: parent })).length;

        // No children → both clear.
        assert.equal(await gate(), false, "no child: gate clear");
        assert.equal(await orientCount(), 0, "no child: orientation empty");

        // A child with one unresolved loop is live in both projections.
        const child = await insertSession(db, workspaceId, parent);
        const unresolved = await insertLoop(db, child, 1, "unresolved");
        assert.equal(await gate(), true, "live child: gate refuses termination");
        assert.equal(await orientCount(), 1, "live child: orientation shows it — the model can SEE what to KILL");

        // Newer terminal history cannot hide the older unresolved obligation.
        const ownLatest = await insertLoop(db, child, 2, "newer terminal work");
        await db.test_set_loop_status.run({
            id: ownLatest,
            status: 200,
            terminal_result: JSON.stringify({ status: 200 }),
        });
        assert.equal(await gate(), true, "the unresolved loop remains completion-blocking");
        assert.equal(await orientCount(), 1, "orientation shows the same live child");

        await db.test_set_loop_status.run({
            id: unresolved,
            status: 200,
            terminal_result: JSON.stringify({ status: 200 }),
        });
        assert.equal(await gate(), false, "the gate clears after every loop is terminal");
        assert.equal(await orientCount(), 0, "orientation clears at the same boundary");
    } finally { await db.close(); }
});
});

describe("sessions", () => {
let nameCounter = 0;
const n = (suffix: string): string => `session-${suffix}-${++nameCounter}`;

test("{§session-scheme}: 'plurnk' is an ordinary session name; the runtime actor's '_plurnk' is not mintable", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, "ws-plurnk-name");
        const runtimeId = await RuntimeSession.ensure(db, workspaceId);
        const plurnk = await Envelope.createModelSession(db, workspaceId, "plurnk");
        assert.equal(plurnk.name, "plurnk", "an operator may name a session plurnk");
        assert.notEqual(plurnk.id, runtimeId, "and holds a session of their own, not the runtime actor");
        await assert.rejects(() => Envelope.createModelSession(db, workspaceId, "_plurnk"), SessionNameError, "the runtime actor's name cannot be minted");
        const upper = await Envelope.createModelSession(db, workspaceId, "PLURNK");
        assert.equal(upper.name, "PLURNK");
        assert.notEqual(upper.id, plurnk.id, "session identity is case-sensitive");
        for (const session of [plurnk, upper]) {
            const resolved = await db.envelope_get_session_by_name.get<{ id: number }>({ workspace_id: workspaceId, name: session.name });
            assert.equal(resolved?.id, session.id, "a name resolves the exact literal identity");
        }
    } finally { await db.close(); }
});

test("{§machine-processes}: every session mints a unique immutable provider identity", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `ws-provider-identity-${crypto.randomUUID()}`);
        const first = await db.test_sessions_insert_returning.get<{ id: number }>({ workspace_id: workspaceId, name: n("provider-a") });
        const second = await db.test_sessions_insert_returning.get<{ id: number }>({ workspace_id: workspaceId, name: n("provider-b") });
        const firstIdentity = await db.test_sessions_get_provider_identity.get<{ provider_identity: string }>({ id: first?.id });
        const secondIdentity = await db.test_sessions_get_provider_identity.get<{ provider_identity: string }>({ id: second?.id });
        assert.match(firstIdentity?.provider_identity ?? "", /^[0-9a-f]{32}$/);
        assert.match(secondIdentity?.provider_identity ?? "", /^[0-9a-f]{32}$/);
        assert.notEqual(firstIdentity?.provider_identity, secondIdentity?.provider_identity);
        await assert.rejects(
            () => db.test_sessions_update_provider_identity.run({
                id: first?.id,
                provider_identity: "0".repeat(32),
            }),
            /sessions\.provider_identity is immutable/,
        );
        await assert.rejects(
            () => db.test_sessions_insert_provider_identity.run({
                workspace_id: workspaceId,
                name: n("provider-duplicate"),
                provider_identity: firstIdentity?.provider_identity,
            }),
            /UNIQUE constraint failed: sessions\.provider_identity/,
        );
    } finally { await db.close(); }
});

test("{§machine-processes} sessions: fork insert — non-null parent_session_id pointing at root session", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, "ws-fork");
        const trunk = await db.test_sessions_insert_returning.get<{ id: number }>({ workspace_id: workspaceId, name: n("trunk") });
        const fork = await db.test_sessions_insert_with_parent_returning.get<{ id: number }>({ workspace_id: workspaceId, name: n("fork"), parent_session_id: trunk?.id });
        const forkRow = await db.test_sessions_get_parent.get<{ parent_session_id: number }>({ id: fork?.id });
        assert.equal(forkRow?.parent_session_id, trunk?.id);
    } finally { await db.close(); }
});

test("{§db-migrations} sessions: workspace_id NOT NULL — insert without workspace_id rejected", async () => {
    const db = await openMigrated();
    try {
        await assert.rejects(
            () => db.test_sessions_insert_default_values(),
            /NOT NULL constraint failed: sessions\.workspace_id/,
        );
    } finally { await db.close(); }
});

test("{§db-migrations} sessions: workspace_id FK — insert against non-existent workspace rejected", async () => {
    const db = await openMigrated();
    try {
        await assert.rejects(
            () => db.test_sessions_insert.run({ workspace_id: 99999, name: n("fk-fail") }),
            /FOREIGN KEY constraint failed/,
        );
    } finally { await db.close(); }
});

test("{§db-migrations} sessions: parent_session_id FK — insert against non-existent parent rejected", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, "ws-badparent");
        await assert.rejects(
            () => db.test_sessions_insert_with_parent.run({ workspace_id: workspaceId, name: n("badparent"), parent_session_id: 99999 }),
            /FOREIGN KEY constraint failed/,
        );
    } finally { await db.close(); }
});

test("{§db-migrations} sessions: parent_session_id self-reference CHECK — parent != id rejected", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, "ws-self");
        const session = await db.test_sessions_insert_returning.get<{ id: number }>({ workspace_id: workspaceId, name: n("self") });
        await assert.rejects(
            () => db.test_sessions_set_parent.run({ parent_session_id: session?.id, id: session?.id }),
            /CHECK constraint failed/,
        );
    } finally { await db.close(); }
});

test("{§db-migrations} sessions: ON DELETE CASCADE via workspace — deleting workspace removes all its sessions", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, "ws-cascade");
        const otherWorkspaceId = await insertWorkspace(db, "ws-untouched");
        await db.test_sessions_insert.run({ workspace_id: workspaceId, name: n("c1") });
        await db.test_sessions_insert.run({ workspace_id: workspaceId, name: n("c2") });
        await db.test_sessions_insert.run({ workspace_id: otherWorkspaceId, name: n("c3") });
        const before = await db.test_sessions_count.get<{ n: number }>();
        assert.equal(before?.n, 3);
        await db.test_workspaces_delete.run({ id: workspaceId });
        const after = await db.test_sessions_count.get<{ n: number }>();
        assert.equal(after?.n, 1);
        const survivor = await db.test_sessions_get_one_workspace_id.get<{ workspace_id: number }>();
        assert.equal(survivor?.workspace_id, otherWorkspaceId);
    } finally { await db.close(); }
});

test("{§db-migrations} sessions: ON DELETE CASCADE via parent_session_id — deleting a parent session removes its forks", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, "ws-forkcascade");
        const trunk = await db.test_sessions_insert_returning.get<{ id: number }>({ workspace_id: workspaceId, name: n("fc-trunk") });
        const trunkId = trunk!.id;
        const forkA = await db.test_sessions_insert_with_parent_returning.get<{ id: number }>({ workspace_id: workspaceId, name: n("fc-fA"), parent_session_id: trunkId });
        await db.test_sessions_insert_with_parent.run({ workspace_id: workspaceId, name: n("fc-fB"), parent_session_id: trunkId });
        await db.test_sessions_insert_with_parent.run({ workspace_id: workspaceId, name: n("fc-fC"), parent_session_id: forkA?.id });
        const before = await db.test_sessions_count.get<{ n: number }>();
        assert.equal(before?.n, 4);
        await db.test_sessions_delete.run({ id: trunkId });
        const after = await db.test_sessions_count.get<{ n: number }>();
        assert.equal(after?.n, 0);
    } finally { await db.close(); }
});

test("{§db-migrations} sessions: negative version rejected by CHECK", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, "ws-negversion");
        await assert.rejects(
            () => db.test_sessions_insert_version.run({ workspace_id: workspaceId, name: n("negversion"), version: -1 }),
            /CHECK constraint failed/,
        );
    } finally { await db.close(); }
});

test("{§session-scheme} sessions: retained names are workspace-unique so old resource addresses remain stable", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, "ws-reclaim");
        const first = await db.test_sessions_insert_returning.get<{ id: number }>({ workspace_id: workspaceId, name: "session" });
        await assert.rejects(
            db.test_sessions_insert_returning.get({ workspace_id: workspaceId, name: "session" }),
            /UNIQUE constraint failed: sessions.workspace_id, sessions.name/,
        );
        const resolved = await db.session_resolve_by_name.get<{ id: number }>({ workspace_id: workspaceId, name: "session" });
        assert.equal(resolved?.id, first?.id);
    } finally { await db.close(); }
});
});
