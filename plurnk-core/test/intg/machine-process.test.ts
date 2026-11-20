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
import { fixtureExecutors, mcpMockTurn } from "./_mock.ts";
import { serverProposals } from "./_approval.ts";
import { Mock } from "@plurnk/plurnk-providers";
import { rpcCall, connect, withDaemon, runLoopToTerminal } from "./_rpc.ts";
import { parseLogRecords } from "../LogRecords.ts";
import { packetSection } from "./_packet.ts";
import { type Db } from "../../src/core/Db.ts";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
// oxlint-disable-next-line eslint/no-restricted-imports -- this witness writes a released-shape database and reads sqlite_master.
import { DatabaseSync } from "node:sqlite";
import { SqlRiteSync } from "@possumtech/sqlrite";
import { SessionNameError } from "../../src/core/SessionName.ts";
import { sqlFunctionPaths } from "../../src/core/sql-functions.ts";

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
    headers: null,
    op: "edit", aside: null, target, lineMarker: marker, body,
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
        assert.deepEqual(effectShape(branchEffects), ["kill:3->1:[]->[[1,-1]]"]);
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
            statement: killStmt(urlPath("log", "/1/1/1/edit")),
            workspaceId, sessionId, loopId, turnId, sequence: 2, origin: "model",
        });

        const branchSessionId = await Fork.fork(db, sessionId, undefined);
        const parentRows = await db.test_log_entries_by_session.all<{ op: string }>({ session_id: sessionId });
        const branchRows = await db.test_log_entries_by_session.all<{ op: string }>({ session_id: branchSessionId });
        assert.deepEqual(parentRows.map(({ op }) => op), ["edit", "kill"]);
        assert.deepEqual(branchRows.map(({ op }) => op), ["edit", "kill"], "the branch keeps both historical events");

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
        assert.deepEqual(await effectShape(sessionId), [{ op: "kill", active_before: 1, active_after: 0 }]);
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
            op: "bare",
            scheme: null,
            username: null,
            password: null,
            hostname: null,
            port: null,
            pathname: null,
            query: null,
            fragment: null,
            lineMarker: null,
            tx: JSON.stringify({ op: "bare", body: "What is the capital of Germany?" }),
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
            [{ op: "bare", model_call_id: null }],
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
        const run = (source: string) => {
            const item = PlurnkParser.parseStatements(source, { executors: fixtureExecutors(source) }).items[0];
            assert.equal(item?.kind, "statement");
            if (item?.kind !== "statement") throw new Error("Expected an operation");
            return engine.dispatch({ workspaceId, sessionId, loopId, turnId, sequence: ++sequence, origin: "client",
                statement: item.statement });
        };
        const source = "session://peer/source.md";
        const target = destination === "" ? "workspace:///copy.md" : `session://${destination}/copy.md`;
        assert.equal((await run(`await plurnk.edit(${JSON.stringify({ path: source, content: "first\nsecond\nthird" })});`)).status, 201);
        assert.equal((await run(`await plurnk.${operation.toLowerCase()}(${JSON.stringify({ from: scoped ? { path: source, range: "1,2" } : source, to: target })});`)).status, 201);
        const copied = await run(`await plurnk.read(${JSON.stringify({ path: target, range: "1,-1" })});`);
        assert.equal(String(copied.content).trimEnd(), scoped ? "first\nsecond" : "first\nsecond\nthird");
        const original = await run(`await plurnk.read(${JSON.stringify({ path: source, range: "1,-1" })});`);
        if (operation === "COPY") assert.equal(original.content, "first\nsecond\nthird");
        else if (scoped) assert.equal(String(original.content).trimEnd(), "third");
        else assert.equal(original.status, 404);
    });
}
});

describe("Engine.log-curation-receipts", () => {
// {§log-history-projection}






const logSection = (packet: string): string => {
    const parsed = JSON.parse(packet) as { sections?: Array<{ name?: unknown; content?: unknown }> };
    return (parsed.sections ?? [])
        .filter((s) => typeof s.name === "string"
            && (s.name === "log" || s.name.startsWith("log/") || s.name.startsWith("tool-result/") || s.name.startsWith("tool-error/"))
            && typeof s.content === "string"
            && s.content.startsWith("### log:///"))
        .map((s) => s.content as string)
        .join("\n\n");
};
const noticesSection = (packet: string): string => {
    return packetSection(JSON.parse(packet), "notices");
};
const rows = (log: string, op: string): Array<Record<string, unknown>> =>
    parseLogRecords(log).filter(({ logPath: path }) => typeof path === "string" && path.endsWith(`/${op}`));
const row = (log: string, op: string): Record<string, unknown> | undefined => rows(log, op)[0];

test("{§log-history-projection} {§operation-results} a KILL that worked never renders; missed or empty log KILLs surface once in Notices without entering Log; resource KILLs and forensic evidence remain", async (approvalContext) => {
    serverProposals(approvalContext, "accept");
    const mock = new Mock({ contextWindow: 32768, responses: [
        "await plurnk.edit({\"path\":\"workspace:///note\",\"content\":\"first line\\nsecond line\"});\n\nawait plurnk.read({\"path\":\"workspace:///note\"});\n\nawait plurnk.note({\"text\":\"wrote\"});",
        "await plurnk.kill({\"path\":\"log:///1/**/read\",\"range\":\"2,-1\"});\n\nawait plurnk.kill({\"path\":\"log:///1/**/edit\"});\n\nawait plurnk.kill({\"path\":\"log:///9/9/9\"});\n\nawait plurnk.note({\"text\":\"curated\"});",
        "await plurnk.kill({\"path\":\"log:///1/**/edit\"});\n\nawait plurnk.read({\"path\":\"log:///1/3/2/kill\"});\n\nawait plurnk.read({\"path\":\"workspace:///note\"});\n\nawait plurnk.kill({\"path\":\"workspace:///note\"});\n\nawait plurnk.note({\"text\":\"verified\"});",
        "await plurnk.note({\"text\":\"the mismatch has been seen; moving on\"});",
        "await plurnk.done({\"text\":\"done\"});",
    ].map((content) => mcpMockTurn(content)) });
    await withDaemon(mock, async (db, _daemon, addr) => {
        const ws = await connect(addr);
        try {
            await rpcCall(ws, 1, "workspace.create", { name: "log-curation-receipts" });
            const result = await runLoopToTerminal(ws, 2, { prompt: "curate" });
            assert.equal(result.result.status, 200);
            const ids = result.turnIds ?? [];
            assert.ok(ids.length >= 6, `init + five model turns; got ${ids.length}`);
            const rawPacket = async (index: number) => (await db.test_get_packet.get<{ packet: string }>({ id: ids[index] }))!.packet;
            const packetOf = async (index: number) => logSection(await rawPacket(index));
            const noticesOf = async (index: number) => noticesSection(await rawPacket(index));
            const afterCuration = await packetOf(3);
            assert.deepEqual(rows(afterCuration, "kill"), [], "neither 200 log KILLs nor stateless 404 log KILLs enter ## Log or tool-error replay");
            const notices3 = await noticesOf(3);
            assert.match(notices3, /200 kill \(log:\/\/\/1\/\*\*\/read\): Trimmed \d+ log entr(?:y|ies)\. \[log_curated\]/u);
            assert.match(notices3, /200 kill \(log:\/\/\/1\/\*\*\/edit\): Retired 1 log entry\. \[log_curated\]/u);
            assert.match(notices3, /404 kill \(log:\/\/\/9\/9\/9\):/u, "missed log KILL surfaces once in Notices");
            assert.equal(row(afterCuration, "edit"), undefined, "the killed EDIT row is retired from the projection");
            const trimmed = rows(afterCuration, "read").find(({ logPath }) => logPath === "log:///1/2/4/read");
            assert.match(String(trimmed?.body), /first line/u, "scoped curation retains the untrimmed line");
            assert.doesNotMatch(String(trimmed?.body), /second line/u, "scoped curation removes the requested line");
            const afterRepeat = await packetOf(4);
            assert.deepEqual(rows(afterRepeat, "kill").map(({ logPath, status }) => ({ logPath, status })), [
                { logPath: "log:///1/4/5/kill", status: undefined },
            ], "only the stateful workspace deletion replays in tool receipts while log KILLs stay transient");
            const notices4 = await noticesOf(4);
            assert.match(notices4, /204 kill \(log:\/\/\/1\/\*\*\/edit\): .*\[no_match\]/u, "204 log KILL mismatch surfaces once in Notices");
            assert.match(notices4, /404 read \(log:\/\/\/1\/3\/2\/kill\):/u, "reading an inactive 200 log KILL coordinate surfaces a 404 notice");
            const afterNext = await packetOf(5);
            assert.deepEqual(rows(afterNext, "kill").map(({ logPath, status }) => ({ logPath, status })), [
                { logPath: "log:///1/4/5/kill", status: undefined },
            ], "active stateful receipts stay in the cached prefix until curated");
            assert.equal(
                await noticesOf(5),
                "> [!NOTE]\n> Only note performed. If done, resolve Open Message(s) with done tool. [open_messages_unresolved]",
            );
            const history = await db.test_log_entries_by_loop.all<{
                op: string | null; pathname: string | null; scheme: string | null;
                status_rx: number; rx: string; active: number;
            }>({ loop_id: result.loopId });
            const recordedKills = history.filter(({ op, pathname }) => op === "kill" && pathname !== null);
            assert.deepEqual(recordedKills.map(({ status_rx }) => status_rx), [200, 200, 404, 204, 200]);
            assert.deepEqual(recordedKills.map(({ active }) => active), [0, 0, 0, 0, 1], "log KILLs initialize active = 0 while stateful workspace KILL stays active = 1");
            assert.deepEqual(history.filter(({ op, pathname, rx }) => op === "done" && pathname === null && JSON.parse(rx).completion === 200)
                .map(({ status_rx }) => status_rx), [200], "the final reply resolves the message without curating a resource");
            assert.equal(JSON.parse(recordedKills[0].rx).matched, 1, "the broad sweep matches the file READ; with preview off initialization reads nothing back ({§session-initialization-entry})");
            const sourceReads = history.filter(({ op, scheme, pathname }) => op === "read" && scheme === "workspace" && pathname === "/note");
            assert.equal(sourceReads.length, 2);
            for (const read of sourceReads) {
                assert.equal(JSON.parse(read.rx).content, "first line\nsecond line", "log curation changes neither the original receipt evidence nor its source");
            }
            const receiptRead = history.find(({ op, scheme, pathname }) => op === "read" && scheme === "log" && pathname === "/1/3/2/kill");
            assert.ok(receiptRead);
            assert.equal(receiptRead.status_rx, 404, "an inactive 200 log KILL receipt is outside active_log_entries while ops:// retains its turn source");
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
});

describe("schema-baseline", () => {
// {§db-migrations} — tagged historical releases keep their shipped version and shape fingerprint
// built directly from their git tags; the 8.0.0 re-founded baseline upgrades in place to 9.0.0,
// while pre-8.0.0 releases are refused naming both versions read.
type TaggedRelease = { readonly version: number; readonly release: string; readonly tag: string; readonly shape: string };
type BaselineChapter = { readonly version: number; readonly label: string; readonly shape: string };
const V8_0_0: TaggedRelease = Object.freeze({ version: 25, release: "8.0.0", tag: "v8.0.0", shape: "fa961086a689a2f869d81accea4bf64f6d65e86219180575cbabf474bab336e4" });
const V7_0_0: TaggedRelease = Object.freeze({ version: 22, release: "7.0.0", tag: "v7.0.0", shape: "d0ddde792d547d51fb8e8b614f2acb4d1bc6566091b8be9961c87a653e19f84a" });
const V6_1_0: TaggedRelease = Object.freeze({ version: 19, release: "6.1.0", tag: "v6.1.0", shape: "9a26cff25187162dde7290edf8cd90c7f4476e5112b228f24e4648fbdcbbf091" });
const V6_0_0: TaggedRelease = Object.freeze({ version: 18, release: "6.0.0", tag: "v6.0.0", shape: "36014087282a4ce9be3c0c1a0505d0b8b1d9689ac13bcca0bcad9e6d598a6593" });
const V5_3_0: TaggedRelease = Object.freeze({ version: 14, release: "5.3.0", tag: "v5.3.0", shape: "b7aaf2cac55feb657d47abd4fbfe4d3230bb5848ea2ab6be052cea8e003e7d73" });
const V5_2_0: TaggedRelease = Object.freeze({ version: 13, release: "5.2.0", tag: "v5.2.0", shape: "4dc11dc6a4c0543595b14010b10220130331f8c71e40e1c232422545fa3b3ee5" });
const V5_0_0: TaggedRelease = Object.freeze({ version: 11, release: "5.0.0", tag: "v5.0.0", shape: "a623ef441160b5b730cf0ee1cdfff83780173d12e5324855ede1bb461403bec5" });
const V4_3_3: TaggedRelease = Object.freeze({ version: 34, release: "4.3.3", tag: "v4.3.3", shape: "7c47c39a0e10cc7a6adaaba0bf9a935621ddcf4c14e765c36db248e4b5576d50" });
const V4_3_0: TaggedRelease = Object.freeze({ version: 33, release: "4.3.0", tag: "v4.3.0", shape: "7c47c39a0e10cc7a6adaaba0bf9a935621ddcf4c14e765c36db248e4b5576d50" });
const V4_0_0: TaggedRelease = Object.freeze({ version: 32, release: "4.0.0", tag: "v4.0.0", shape: "76b1dff2af95661a15e32ebea23fddaf4b07cfdc0c06af58e6ca2640e2034263" });
const V8_0_0_BASELINE: BaselineChapter = Object.freeze({ version: 25, label: "8.0.0 baseline", shape: "f7cf993223b06702012f83ba835eec5d822f7263cbde761017c010d0e14025b2" });
const V9_0_0: BaselineChapter = Object.freeze({ version: 26, label: "9.0.0", shape: "3b93c87a1c5abce886e21dbd9b878169129993c9d226debfe072642139f7fc6b" });

const REPO_ROOT = resolve(dirname(MIGRATIONS_DIR), "..");

// A database at a tagged released version, built from the git tag's own migrations.
const released = async (t: Pick<TestContext, "after">, release: TaggedRelease): Promise<string> => {
    const root = await mkdtemp(join(tmpdir(), "plurnk-released-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const dir = join(root, "migrations");
    await mkdir(dir);
    const chapters = execFileSync("git", ["ls-tree", "--name-only", `${release.tag}:plurnk-core/migrations`], { cwd: REPO_ROOT, encoding: "utf8" })
        .split("\n")
        .filter((name) => name.endsWith(".sql") && Number(name.split("_")[0]) <= release.version);
    assert.equal(chapters.length, release.version, `${release.tag} ships ${release.version} migration chapters`);
    await Promise.all(chapters.map((name) => {
        const sql = execFileSync("git", ["show", `${release.tag}:plurnk-core/migrations/${name}`], { cwd: REPO_ROOT, encoding: "utf8" });
        return writeFile(join(dir, name), sql);
    }));
    const path = join(root, "released.db");
    (await SqlRiteSync.open({ path, dir, functions: sqlFunctionPaths })).close();
    return path;
};

// A database at a chapter of the current re-founded baseline.
const baseline = async (t: Pick<TestContext, "after">, chapter: Pick<BaselineChapter, "version">): Promise<string> => {
    const root = await mkdtemp(join(tmpdir(), "plurnk-baseline-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const dir = join(root, "migrations");
    await mkdir(dir);
    const chapters = (await readdir(MIGRATIONS_DIR)).filter((name) => Number(name.split("_")[0]) <= chapter.version);
    await Promise.all(chapters.map((name) => copyFile(join(MIGRATIONS_DIR, name), join(dir, name))));
    const path = join(root, "baseline.db");
    (await SqlRiteSync.open({ path, dir, functions: sqlFunctionPaths })).close();
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

test("{§db-migrations} {§message-arrival} {§loop-completion} {§message-completion} {§tokenomics} {§packet}: the 9.0.0 baseline enforces session message keys, open-loop mailbox guards, curation bounds, and persona constraints", async (t) => {
    const path = await baseline(t, V9_0_0);
    const raw = new DatabaseSync(path);
    try {
        raw.exec(`
            PRAGMA foreign_keys = ON;
            INSERT INTO workspaces (id, name) VALUES (1, 'baselineGuards');
            INSERT INTO session_owners (workspace_id, address, tools, interactive) VALUES (1, '_plurnk', '[]', 0);
            INSERT INTO sessions (id, workspace_id, name, origin) VALUES
                (1, 1, 'root', 'model'),
                (2, 1, 'child', 'model'),
                (3, 1, 'responder', 'model');
            INSERT INTO loops (id, session_id, sequence, status, prompt, max_turns, terminal_result) VALUES
                (1, 1, 1, 102, 'Root open', -1, NULL),
                (2, 2, 1, 102, 'Child open', -1, NULL),
                (3, 1, 2, 200, 'Root done', -1, '{"status":200}'),
                (4, 3, 1, 200, 'Responder done', -1, '{"status":200}');
            INSERT INTO turns (id, loop_id, sequence, producer, kind, status, usage_curation_budget, packet, model)
                VALUES (1, 1, 1, 'model', 'inference', 102, 0, '{"weight":500,"curationWeight":120,"attributions":[]}', 'mock');
            INSERT INTO turns (id, loop_id, sequence, producer, kind, status)
                VALUES (2, 4, 1, 'model', 'inference', 200);
            INSERT INTO contents (id, hash, content) VALUES
                (1, 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', '{"op":"done"}'),
                (2, 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', '{"status":200}');
            INSERT INTO log_entry_rows (
                id, session_id, loop_id, turn_id, sequence, origin, op,
                tx_content_id, mimetype_tx, rx_content_id, mimetype_rx, status_rx, weight, state, attrs, initial_folded
            ) VALUES (
                20, 3, 4, 2, 1, 'model', 'done', 1, 'application/json', 2, 'application/json', 200, 1, 'resolved', '{}', '[]'
            );
            INSERT INTO loop_messages (id, loop_id, ordinal, message_key, body) VALUES
                (101, 1, 1, '00', 'Root msg'),
                (102, 2, 1, '00', 'Child msg');
            INSERT INTO message_completions (message_id, response_id, status) VALUES (101, 20, 200);
        `);
        assert.throws(
            () => raw.exec("INSERT INTO loop_messages (loop_id, ordinal, message_key, body) VALUES (1, 2, '00', 'Duplicate in root');"),
            /message_key already accepted in this session/,
        );
        assert.throws(
            () => raw.exec("INSERT INTO loop_messages (loop_id, ordinal, message_key, body) VALUES (3, 1, 'bad_00', 'onto terminal');"),
            /messages may only be enqueued into an open loop/,
        );
        assert.throws(
            () => raw.exec("UPDATE loop_messages SET loop_id = 3 WHERE id = 102;"),
            /messages may only be re-homed into an open loop/,
        );
        raw.exec("UPDATE loops SET status = 200, terminal_result = '{\"status\":200}' WHERE id = 1;");
        assert.throws(
            () => raw.exec("DELETE FROM message_completions WHERE message_id = 101;"),
            /settled message completions of a terminal loop can only be removed with their containing history/,
        );
        raw.exec("DELETE FROM sessions WHERE id = 3;");
        const crossAfterDelete = raw.prepare("SELECT message_id, response_id, status FROM message_completions WHERE message_id = 101").get() as {
            message_id: number; response_id: number | null; status: number;
        };
        assert.deepEqual({ ...crossAfterDelete }, { message_id: 101, response_id: null, status: 200 });
        assert.throws(
            () => raw.exec("INSERT INTO turns (loop_id, sequence, producer, kind, status, usage_curation_budget, packet, model) VALUES (2, 1, 'model', 'inference', 102, -1, '{\"weight\":500,\"attributions\":[]}', 'mock')"),
            /CHECK constraint failed/,
        );
        assert.throws(
            () => raw.exec("INSERT INTO turns (loop_id, sequence, producer, kind, status, usage_curation_budget, packet, model) VALUES (2, 1, 'model', 'inference', 102, 0, '{\"weight\":500,\"curationWeight\":501,\"attributions\":[]}', 'mock')"),
            /CHECK constraint failed/,
        );
        assert.throws(
            () => raw.exec("UPDATE turns SET producer = 'client' WHERE id = 1"),
            /turn producer and kind are immutable/,
        );
        assert.throws(
            () => raw.prepare("UPDATE sessions SET persona = '' WHERE id = 1").run(),
            /CHECK constraint failed/,
        );
        assert.deepEqual(raw.prepare("PRAGMA foreign_key_check").all(), []);
    } finally { raw.close(); }
});

test("{§db-migrations}: a database from before the 8.0.0 support floor or from a newer release is refused naming both versions read", async (t) => {
    const root = await mkdtemp(join(tmpdir(), "plurnk-pre-floor-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    for (const version of [1, 11, 22, 25, 34]) {
        const dir = join(root, `v${version}`);
        await mkdir(dir);
        await writeFile(join(dir, `${String(version).padStart(3, "0")}_legacy.sql`), `-- MIGRATE: ${version} legacy\nCREATE TABLE workspaces (id INTEGER NOT NULL PRIMARY KEY, name TEXT NOT NULL);\n`);
        const dbPath = join(root, `legacy-${version}.db`);
        new SqlRiteSync({ path: dbPath, dir }).close();
        await assert.rejects(
            () => openMigrated(dbPath),
            new RegExp(`database schema \\(version ${version}\\) precedes the 8\\.0\\.0 support floor \\(schema version 25\\); point PLURNK_SERVICE_DB_PATH at a new file or move the database`),
        );
    }
    for (const futureVersion of [27, 99]) {
        const newerPath = await baseline(t, V9_0_0);
        const raw = new DatabaseSync(newerPath);
        try { raw.exec(`PRAGMA user_version = ${futureVersion};`); }
        finally { raw.close(); }
        await assert.rejects(
            () => openMigrated(newerPath),
            new RegExp(`database schema \\(version ${futureVersion}\\) is newer than this build \\(schema version 26\\); run the @plurnk/plurnk-service release that wrote it or point PLURNK_SERVICE_DB_PATH at another file`),
        );
    }
});

test("{§db-migrations}: versions are consecutive from the 8.0.0 baseline and a fresh database lands on the last", async () => {
    const versions = SqlRiteCore.loadChunks({ dir: MIGRATIONS_DIR }).MIGRATE.map(({ version }) => version);
    assert.deepEqual(versions, versions.map((_, index) => index + V8_0_0_BASELINE.version), "versions are numbered consecutively from the 8.0.0 baseline with no gaps");
    assert.equal(versions.at(-1), V9_0_0.version, "the 9.0.0 chapter version is present");
    const db = await openMigrated();
    try {
        const row = await db.test_schema_version.get<{ v: number }>({});
        assert.equal(row?.v, versions.at(-1), "a fresh database applies every version");
    } finally { await db.close(); }
});

test("{§db-migrations} {§execution-output-identity}: tagged 8.0.0 (v25) keeps its released shape and upgrades in place to 9.0.0 (v26) re-homing execution streams onto exec:///", async (t) => {
    const path = await released(t, V8_0_0);
    assert.equal(shape(path), V8_0_0.shape, `tagged ${V8_0_0.tag} shape matches its frozen fingerprint`);
    const before = new DatabaseSync(path);
    try {
        before.exec(`
            PRAGMA foreign_keys = ON;
            INSERT INTO workspaces (id, name, project_root) VALUES (1, 'upgrade8to9', '/tmp/upgrade8to9');
            INSERT INTO session_owners (workspace_id, address, tools, interactive) VALUES (1, '_plurnk', '[]', 0);
            INSERT INTO sessions (id, workspace_id, name, origin, parent_session_id, persona) VALUES
                (1, 1, 'root', 'model', NULL, 'architect'),
                (2, 1, 'child', 'model', 1, NULL);
            INSERT INTO loops (id, session_id, sequence, status, prompt, max_turns, terminal_result) VALUES
                (1, 1, 1, 200, 'Run shell', -1, '{"status":200}');
            INSERT INTO turns (id, loop_id, sequence, producer, kind, status) VALUES
                (1, 1, 1, 'model', 'inference', 200);
            INSERT INTO entries (id, workspace_id, scheme, authority, pathname, output, default_channel) VALUES
                (10, 1, 'sh', '', '/a384d30c', 1, 'stdout'),
                (11, 1, 'mcp', '', '/browser.json', 0, 'body');
            INSERT INTO contents (id, hash, content) VALUES
                (1, '1111111111111111111111111111111111111111111111111111111111111111', 'ok'),
                (2, '2222222222222222222222222222222222222222222222222222222222222222', '{"op":"sh"}'),
                (3, '3333333333333333333333333333333333333333333333333333333333333333', '{"status":200}');
            INSERT INTO entry_channel_rows (entry_id, name, content_id, mimetype, lines, state) VALUES
                (10, 'stdout', 1, 'text/plain', 1, 'closed'),
                (11, 'body', 1, 'application/json', 1, 'static');
            INSERT INTO subscriptions (id, session_id, entry_id, scheme, handle, source) VALUES
                (1, 1, 10, 'sh', 'sh: echo ok', 'log:///1/1/1/sh');
            INSERT INTO log_entry_rows (
                id, session_id, loop_id, turn_id, sequence, origin, op, scheme, pathname,
                tx_content_id, mimetype_tx, rx_content_id, mimetype_rx, status_rx, weight, state, attrs, initial_folded
            ) VALUES
                (1, 1, 1, 1, 1, 'model', 'sh', NULL, NULL, 2, 'application/json', 3, 'application/json', 200, 1, 'resolved', '{"runtime":"sh","pathname":"/a384d30c","stream":"sh:///a384d30c"}', '[]'),
                (2, 1, 1, 1, 2, '_plurnk', 'read', 'sh', '/a384d30c', 2, 'application/json', 3, 'application/json', 200, 1, 'resolved', '{"streamEnd":2}', '[]'),
                (3, 1, 1, 1, 3, 'model', 'read', 'mcp', '/browser.json', 2, 'application/json', 3, 'application/json', 200, 1, 'resolved', '{}', '[]');
            INSERT INTO ambient_events (
                id, workspace_id, producer_session_id, recipient_session_id, workspace_broadcast, kind, source_record_id,
                op, scheme, pathname, tx, mimetype_tx, rx, mimetype_rx, status_rx, state, attrs
            ) VALUES (
                1, 1, 2, 1, 0, 'activity', 1, 'read', 'sh', '/a384d30c', '{"op":"read"}', 'application/json', '{"status":200}', 'application/json', 200, 'resolved', '{"runtime":"sh","pathname":"/a384d30c","stream":"sh:///a384d30c"}'
            );
        `);
    } finally { before.close(); }

    const upgraded = await openMigrated(path);
    await upgraded.close();

    const after = new DatabaseSync(path);
    try {
        assert.equal((after.prepare("PRAGMA user_version").get() as { user_version: number }).user_version, V9_0_0.version);
        assert.deepEqual(after.prepare("PRAGMA foreign_key_check").all(), []);
        assert.ok(after.prepare("SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = 'workspaces_project_root'").get(), "workspaces_project_root index added");
        assert.deepEqual(
            after.prepare("SELECT id, scheme, pathname, output FROM entries ORDER BY id").all().map((row) => ({ ...row })),
            [
                { id: 10, scheme: "exec", pathname: "/sh/a384d30c", output: 1 },
                { id: 11, scheme: "mcp", pathname: "/browser.json", output: 0 },
            ],
        );
        assert.equal((after.prepare("SELECT scheme FROM subscriptions WHERE id = 1").get() as { scheme: string }).scheme, "exec");
        assert.deepEqual(
            after.prepare("SELECT id, scheme, pathname, json_extract(attrs, '$.pathname') AS attr_path, json_extract(attrs, '$.stream') AS attr_stream FROM log_entry_rows ORDER BY id").all().map((row) => ({ ...row })),
            [
                { id: 1, scheme: null, pathname: null, attr_path: "/sh/a384d30c", attr_stream: "exec:///sh/a384d30c" },
                { id: 2, scheme: "exec", pathname: "/sh/a384d30c", attr_path: null, attr_stream: null },
                { id: 3, scheme: "mcp", pathname: "/browser.json", attr_path: null, attr_stream: null },
            ],
        );
        assert.deepEqual(
            { ...(after.prepare("SELECT scheme, pathname, json_extract(attrs, '$.pathname') AS attr_path, json_extract(attrs, '$.stream') AS attr_stream FROM ambient_events WHERE id = 1").get() as Record<string, unknown>) },
            { scheme: "exec", pathname: "/sh/a384d30c", attr_path: "/sh/a384d30c", attr_stream: "exec:///sh/a384d30c" },
        );
    } finally { after.close(); }
});

for (const release of [V7_0_0, V6_1_0, V6_0_0, V5_3_0, V5_2_0, V5_0_0, V4_3_3, V4_3_0, V4_0_0]) {
    test(`{§db-migrations}: tagged ${release.release} (v${release.version}) keeps its released shape and is refused by the 8.0.0 baseline naming both versions read`, async (t) => {
        const path = await released(t, release);
        assert.equal(shape(path), release.shape, `tagged ${release.tag} shape matches its frozen fingerprint`);
        await assert.rejects(
            () => openMigrated(path),
            new RegExp(`database schema \\(version ${release.version}\\) precedes the 8\\.0\\.0 support floor \\(schema version 25\\); point PLURNK_SERVICE_DB_PATH at a new file or move the database`),
        );
    });
}

for (const chapter of [V8_0_0_BASELINE, V9_0_0]) {
    test(`{§db-migrations}: versions 25-${chapter.version} keep the ${chapter.label} shape`, async (t) => {
        assert.equal(shape(await baseline(t, chapter)), chapter.shape, `a baseline migration changed shape; add the next MIGRATE version instead of editing versions 25-${chapter.version}`);
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

test("{§machine-processes} a fork inherits the parent's loops as HISTORY (clamped terminal) and preserves prompt_source", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `fork-clamp-${crypto.randomUUID()}`);
        const parent = await insertSession(db, workspaceId, null, "p");
        await db.drain_enqueue_loop.get({
            session_id: parent,
            prompt: "operator seed",
            prompt_source: "acp://operator",
            model_route_id: null,
            spawn_model_route_id: null,
            effort: null,
            max_turns: -1,
        });
        await insertLoop(db, parent, 2, "self seed");
        const fork = await Fork.fork(db, parent, undefined);
        const loops = await db.test_fork_loop_prompt_sources.all<{
            sequence: number;
            status: number;
            prompt: string;
            prompt_source: string | null;
        }>({ session_id: fork });
        assert.deepEqual(loops.map(({ sequence, status, prompt, prompt_source }) => ({ sequence, status, prompt, prompt_source })), [
            { sequence: 1, status: 200, prompt: "operator seed", prompt_source: "acp://operator" },
            { sequence: 2, status: 200, prompt: "self seed", prompt_source: null },
        ], "inherited loops clamp non-terminal status to 200 while preserving prompt_source");
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
