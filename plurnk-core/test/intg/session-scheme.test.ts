// session:// scheme — spawn + fork (COPY), irc (SEND), terminate (KILL). Same-workspace sisters
// (SPEC {§machine-processes}, {§actor-boundary}). injectSession is the daemon's
// loop-start seam; here it's a recording stub (Daemon.inject's drain has its own
// tests), so these assert the session scheme's own work: the session-table effect + the
// exact inject call. The dispatch gates (#checkWritable session-control branch and
// #handleSessionControl routing) are exercised end-to-end.

import test from "node:test";
import assert from "node:assert/strict";
import { Mock } from "@plurnk/plurnk-providers";
import { PlurnkParser, parsePath } from "@plurnk/plurnk-parser";
import { ownSession, TEST_OWNER } from "./_approval.ts";
import SessionOwners from "../../src/core/SessionOwners.ts";
import type {
    ParsedPath,
    PlurnkStatement,
    WorkStatement,
    ForkStatement,
    KillStatement,
    ReadStatement,
    FindStatement,
} from "@plurnk/plurnk-contracts";
import Turn from "../../src/core/Turn.ts";
import Engine from "../../src/core/Engine.ts";
import RuntimeSession from "../../src/core/RuntimeSession.ts";
import type { InjectSessionNotify } from "../../src/core/ChannelWrite.ts";
import LoopLifecycle from "../../src/core/LoopLifecycle.ts";
import Results from "../../src/core/results.ts";
import SchemeRegistry from "../../src/core/SchemeRegistry.ts";
import Session from "../../src/schemes/Session.ts";
import Workspace from "../../src/schemes/Workspace.ts";
import Fork from "../../src/core/fork.ts";
import SessionName from "../../src/core/SessionName.ts";
import { openMigrated, insertWorkspace, insertSession, insertLoop, insertTurn, insertOperationTurn } from "./_db.ts";
import { readThroughScheme, makeSchemeCtx } from "./_scheme.ts";
import { fixtureExecutors } from "./_mock.ts";
import { resourcePaths } from "./_find.ts";
import { copyStmt, editStmt, sendStmt, dispositionStmt, readStmt, fullReplace, noteStmt } from "./_dsl.ts";
const PAGE = Number(process.env.PLURNK_SERVICE_PREVIEW_LINES); // {§markerless-first-page} — the first page a markerless retrieval is

// {§session-scheme} — the authority is a literal Session name.
// Control operations carry no entry path; storage operations do.
const sessionPath = (name: string): ParsedPath => ({
    kind: "url", raw: `session://${name}`, scheme: "session",
    username: null, password: null, hostname: name, port: null,
    pathname: "", query: null, fragment: null,
});

const authoredSessionPath = (raw: string): ParsedPath => {
    const target = parsePath(raw);
    if (target?.kind !== "url" || target.scheme !== "session") throw new Error(`Expected a session URL: ${raw}`);
    return target;
};

// A named scratch entry; the authority is a coordinate, not an access policy.
const sessionEntry = (owner: string, path: string): ParsedPath => ({
    kind: "url", raw: owner === "" ? `workspace:///${path}` : `session://${owner}/${path}`,
    scheme: owner === "" ? "workspace" : "session",
    username: null, password: null, hostname: owner === "" ? null : owner, port: null,
    pathname: `/${path}`, query: null, fragment: null,
});

// Session control (grammar 0.74.55): WORK(session://<name>):task spawns a fresh session; FORK(session://<name>):task
// branches the current session into a named sister. The body is the seed task, not a destination path.
const spawnedSession = (name: string, prompt: string): WorkStatement => ({
    metadata: null,
    op: "WORK", aside: null, target: sessionPath(name),
    lineMarker: null, body: prompt, position: { line: 1, column: 1 },
});
const forkSession = (name: string, prompt: string): ForkStatement => ({
    metadata: null,
    op: "FORK", aside: null, target: sessionPath(name),
    lineMarker: null, body: prompt, position: { line: 1, column: 1 },
});

// The Daemon.inject seam as a recording stub — its drain/enqueue behavior is
// covered by the Daemon/inject suites; here we assert exactly what the session
// scheme hands it.
const recordingInjectSession = () => {
    const calls: Array<Parameters<InjectSessionNotify>[0]> = [];
    const injectSession = async (args: typeof calls[number]) => {
        calls.push(args);
        return { action: "enqueued_new_loop" as const, loopId: -1, message: `message://recorded/${calls.length}` };
    };
    return { calls, injectSession };
};

const weigh = (text: string): number => Math.ceil(text.length / 4);

// FIND in one named namespace: session://<owner>/<glob>.
const findEntry = (owner: string, glob: string): FindStatement => ({
    metadata: null,
    op: "FIND", aside: null,
    target: { kind: "url", raw: owner === "" ? `workspace:///${glob}` : `session://${owner}/${glob}`, scheme: owner === "" ? "workspace" : "session", username: null, password: null, hostname: owner === "" ? null : owner, port: null, pathname: `/${glob}`, query: null, fragment: null },
    lineMarker: null, matcher: null, body: null, position: { line: 1, column: 1 },
});

// READ from one named namespace: session://<owner>/<path>.
const readEntry = (owner: string, path: string): ReadStatement => ({
    metadata: null,
    op: "READ", aside: null,
    target: { kind: "url", raw: owner === "" ? `workspace:///${path}` : `session://${owner}/${path}`, scheme: owner === "" ? "workspace" : "session", username: null, password: null, hostname: owner === "" ? null : owner, port: null, pathname: `/${path}`, query: null, fragment: null },
    lineMarker: null, matcher: null, body: null, position: { line: 1, column: 1 },
});

// KILL in one named namespace: session://<owner>/<path> — deletes the scratch entry (path present).
const killEntry = (owner: string, path: string): KillStatement => ({
    metadata: null,
    op: "KILL", aside: null,
    target: { kind: "url", raw: owner === "" ? `workspace:///${path}` : `session://${owner}/${path}`, scheme: owner === "" ? "workspace" : "session", username: null, password: null, hostname: owner === "" ? null : owner, port: null, pathname: `/${path}`, query: null, fragment: null },
    lineMarker: null, matcher: null, body: null, position: { line: 1, column: 1 },
});

test("{§session-scheme-fork-scratch} {§machine-processes-entry-inheritance}: a fork copies named scratch without changing literal references", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, crypto.randomUUID());
        const parent = await insertSession(db, workspaceId, null, "alpha");
        const ctxP = makeSchemeCtx({ db, workspaceId, sessionId: parent });
        const scheme = new Session();
        const body = "parent note: session://alpha/original.md";
        assert.equal((await scheme.edit(editStmt(sessionEntry("alpha", "todo.md"), body), ctxP)).status, 201);
        const forkId = await Fork.fork(db, parent, "alpha-fork");
        const ctxF = makeSchemeCtx({ db, workspaceId, sessionId: forkId });
        assert.deepEqual(resourcePaths(await scheme.find(findEntry("alpha-fork", "**"), ctxF)), ["session://alpha-fork/todo.md"]);
        assert.equal((await readThroughScheme("session", null, readEntry("alpha-fork", "todo.md"), ctxF)).content, body);
        assert.equal((await scheme.edit(editStmt(sessionEntry("alpha-fork", "todo.md"), "fork note", fullReplace), ctxP)).status, 200);
        for (const ctx of [ctxP, ctxF]) {
            assert.equal((await readThroughScheme("session", null, readEntry("alpha", "todo.md"), ctx)).content, body);
            assert.equal((await readThroughScheme("session", null, readEntry("alpha-fork", "todo.md"), ctx)).content, "fork note");
        }
    } finally { await db.close(); }
});

test("{§session-read-scope}: FIND addresses literal namespaces identically from unrelated Sessions", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, crypto.randomUUID());
        const alpha = await insertSession(db, workspaceId, null, "alpha");
        const beta = await insertSession(db, workspaceId, null, "beta");
        const contexts = [alpha, beta].map((sessionId) => makeSchemeCtx({ db, workspaceId, sessionId }));
        const scheme = new Session();
        assert.equal((await scheme.edit(editStmt(sessionEntry("alpha", "todo.md"), "alpha note"), contexts[1])).status, 201);
        assert.equal((await scheme.edit(editStmt(sessionEntry("beta", "plan.md"), "beta note"), contexts[0])).status, 201);
        for (const ctx of contexts) {
            assert.deepEqual(resourcePaths(await scheme.find(findEntry("alpha", "**"), ctx)), ["session://alpha/todo.md"]);
            assert.deepEqual(resourcePaths(await scheme.find(findEntry("beta", "**"), ctx)), ["session://beta/plan.md"]);
        }
    } finally { await db.close(); }
});

test("{§machine-processes} WORK(session://name):task spawns a same-workspace sister, seeded via injectSession", async () => {
    const db = await openMigrated();
    try {
        const { calls, injectSession } = recordingInjectSession();
        const engine = new Engine({ db, schemes: new SchemeRegistry(), injectSession, weigh });
        const workspaceId = await insertWorkspace(db, `session-spawn-${crypto.randomUUID()}`);
        const sessionId = await insertSession(db, workspaceId, null, "parent", "model");
        const loopId = await insertLoop(db, sessionId, 1, "go");
        const turnId = await insertTurn(db, loopId, 1, 102);

        const result = await engine.dispatch({
            statement: spawnedSession("session", "investigate the bug"),
            workspaceId, sessionId, loopId, turnId, sequence: 1, origin: "model",
        });
        assert.equal(result.status, 200, "spawn returns 200");

        const session = await db.session_resolve_by_name.get<{ id: number }>({ workspace_id: workspaceId, name: "session" });
        if (session === undefined) throw new Error("spawn must create a session named 'session' in the workspace");
        const meta = await db.session_get.get<{ workspace_id: number; origin: string }>({ id: session.id });
        assert.equal(meta?.origin, "model", "spawned session's actor class follows its parent");
        assert.equal(meta?.workspace_id, workspaceId, "spawned session shares the workspace (sisters)");

        assert.equal(calls.length, 1, "exactly one injectSession call");
        const spawnRest = calls[0];
        assert.deepEqual(spawnRest, { workspaceId, sessionId: session.id, sourceLoopId: loopId, prompt: "investigate the bug", spawn: true, opener: { turnId, sequence: 1 } }, "the new session is started with its delegator's causal identity, the operation that sent it");
    } finally { await db.close(); }
});

test("{§session-scheme-spawn}: concurrent WORK and FORK cannot claim the same literal address", async () => {
    await using db = await openMigrated();
    const { calls, injectSession } = recordingInjectSession();
    const engine = new Engine({ db, schemes: new SchemeRegistry(), injectSession, weigh });
    const workspaceId = await insertWorkspace(db, "named-claim-race");
    const sessionId = await insertSession(db, workspaceId, null, "parent");
    const loopId = await insertLoop(db, sessionId, 1);
    const turnId = await insertTurn(db, loopId, 1);
    const [work, fork] = await Promise.all([spawnedSession("child", "fresh"), forkSession("child", "branch")].map((statement, index) =>
        engine.dispatch({ statement, workspaceId, sessionId, loopId, turnId, sequence: index + 1, origin: "model" })));
    // One claim wins the name. A FORK that lost is 409; a WORK that lost finds the name held and delivers its
    // body to that session as a message. Either way one session holds the name and every delivery reached it.
    const child = await db.session_resolve_by_name.get<{ id: number }>({ workspace_id: workspaceId, name: "child" });
    assert.ok(child, "exactly one session holds the name");
    assert.equal(work.status, 200, "WORK either created the child or messaged it");
    if (fork.status === 409) {
        assert.match(fork.problem!.type, /session-name-conflict$/);
        assert.equal(fork.problem!.session, "child");
        assert.match(String(fork.problem!.recovery), /WORK or SEND \(session:\/\/child\)/u, "the receipt names the working forms");
        assert.equal(calls.length, 1, "the one claim started the child");
        assert.equal(calls[0].spawn, true);
    } else {
        assert.equal(fork.status, 200);
        assert.equal(calls.length, 2, "the branch started the child and the WORK messaged it");
        assert.ok(calls.some((call) => call.spawn !== true && call.prompt === "fresh"), "the WORK's body reached the held name as a message");
    }
    assert.ok(calls.every((call) => call.sessionId === child.id), "every delivery reached the one session");
});

for (const origin of ["model", "client", "_plurnk"] as const) {
    test(`{§machine-processes-session-origin}: a ${origin} turn delegates within its actor's lineage`, async () => {
        await using db = await openMigrated();
        const { calls, injectSession } = recordingInjectSession();
        const engine = new Engine({ db, schemes: new SchemeRegistry(), injectSession, weigh });
        const workspaceId = await insertWorkspace(db, `delegating-${origin}`);
        const sessionId = await insertSession(db, workspaceId, null, "parent", "model");
        const loopId = await insertLoop(db, sessionId, 1);
        const turnId = origin === "model" ? await insertTurn(db, loopId, 1) : await insertOperationTurn(db, loopId, 1, origin);
        for (const [index, statement] of [spawnedSession("fresh", "go"), forkSession("branch", "go")].entries()) {
            const result = await engine.dispatch({ statement, workspaceId, sessionId, loopId, turnId, sequence: index + 1, origin });
            assert.equal(result.status, 200, JSON.stringify(result));
            const child = await db.session_get.get<{ origin: string }>({ id: calls[index].sessionId });
            assert.equal(child?.origin, "model", "operation producer is not the child actor class");
            const lineage = await db.test_session_lineage.get<{ parent_session_id: number }>({ id: calls[index].sessionId });
            assert.equal(lineage?.parent_session_id, sessionId);
        }
    });
}

for (const op of ["WORK", "FORK"] as const) {
    test(`{§session-auto-name}: addressless ${op} allocates and reports a distinct short child address`, async (t) => {
        const db = await openMigrated();
        try {
            const { calls, injectSession } = recordingInjectSession();
            const engine = new Engine({ db, schemes: new SchemeRegistry(), injectSession, weigh });
            const workspaceId = await insertWorkspace(db, `anonymous-${op}-${crypto.randomUUID()}`);
            const parentId = await insertSession(db, workspaceId, null, "parent");
            const occupiedId = await insertSession(db, workspaceId, null, "ab3d5678");
            const loopId = await insertLoop(db, parentId, 1, "delegate");
            const turnId = await insertTurn(db, loopId, 1, 102);
            const source = PlurnkParser.frame(op, "Inspect the project.");
            const parsed = PlurnkParser.parseStatements(source, { executors: fixtureExecutors(source) });
            assert.deepEqual(parsed.items.filter(({ kind }) => kind === "error"), []);
            assert.equal(parsed.items.length, 1);
            const item = parsed.items[0];
            assert.ok(item?.kind === "statement");
            const statement = item.statement;
            assert.equal(statement.op, op);
            assert.equal(statement.target, null, "authored program contains no invented address");
            const names = ["e6a78901", "ab3d5678", "c4e56789", "d5f67890"];
            t.mock.method(SessionName, "short", () => {
                const name = names.shift();
                assert.ok(name !== undefined, "allocator must settle after the collision retry");
                return name;
            });
            const first = await engine.dispatch({
                statement, workspaceId, sessionId: parentId, loopId, turnId, sequence: 1, origin: "model",
            });
            assert.equal(first.status, 200, "an omitted address allocates a session rather than refusing the operation");
            assert.deepEqual(first.attrs, { session: "session://e6a78901", message: "message://recorded/1" }, "the receipt names the session and the message it sent");

            const results = await Promise.all([2, 3].map((sequence) => engine.dispatch({
                statement, workspaceId, sessionId: parentId, loopId, turnId, sequence, origin: "model",
            })));
            assert.deepEqual(results.map(({ status }) => status), [200, 200]);
            assert.deepEqual(results.map(({ body }) => String(body)).toSorted(), ["c4e56789", "d5f67890"]);
            for (const result of results) {
                const { session, message, ...rest } = result.attrs as { session?: unknown; message?: unknown };
                assert.deepEqual([session, rest], [`session://${String(result.body)}`, {}], "the receipt names the session it created");
                assert.match(String(message), /^message:\/\//u, "and the message it sent");
            }
            assert.equal(calls.length, 3);
            for (const call of calls) {
                const child = await db.session_get.get<{ name: string }>({ id: call.sessionId });
                assert.ok(child !== undefined);
                assert.match(child.name, /^[a-f0-9]{8}$/);
                const lineage = await db.test_session_lineage.get<{ parent_session_id: number }>({ id: call.sessionId });
                assert.equal(lineage?.parent_session_id, parentId);
                assert.equal(call.workspaceId, workspaceId);
                assert.equal(call.prompt, "Inspect the project.");
                assert.deepEqual(await SessionOwners.read(db, call.sessionId), await SessionOwners.read(db, parentId));
                const inherited = await db.test_fork_loops.all({ session_id: call.sessionId });
                assert.equal(inherited.length, op === "FORK" ? 1 : 0, "FORK copies history; WORK starts fresh");
                const addressed = await db.session_resolve_by_name.get<{ id: number }>({ workspace_id: workspaceId, name: child.name });
                assert.equal(addressed?.id, call.sessionId, "the reported name addresses the child that actually received the prompt");
            }
            assert.equal((await db.session_resolve_by_name.get<{ id: number }>({ workspace_id: workspaceId, name: "ab3d5678" }))?.id, occupiedId);
            assert.equal(statement.target, null, "allocation must not rewrite submitted operation evidence");
        } finally { await db.close(); }
    });
}

for (const op of ["WORK", "FORK"] as const) test(`{§workspace-capability-policy}: ${op} shares live workspace policy and inherits its parent owner`, async () => {
    const db = await openMigrated();
    try {
        const { calls, injectSession } = recordingInjectSession();
        const engine = new Engine({ db, schemes: new SchemeRegistry(), injectSession, weigh });
        const workspaceId = await insertWorkspace(db, `delegation-policy-${op}`);
        const parentId = await insertSession(db, workspaceId);
        const loopId = await insertLoop(db, parentId, 1, "delegate");
        const turnId = await insertTurn(db, loopId, 1, 102);
        await ownSession(db, workspaceId, parentId);
        const seed = await engine.dispatch({
            statement: editStmt(sessionEntry("", "note.md"), "shared source"),
            workspaceId, sessionId: parentId, loopId, turnId, sequence: 1, origin: "model",
        });
        assert.equal(seed.status, 201);
        await db.test_set_workspace_settings.run({
            id: workspaceId, settings: JSON.stringify({ capabilities: { deny: [{ operation: "READ" }] } }),
        });
        const spawned = await engine.dispatch({
            statement: { ...spawnedSession("child", "work independently"), op },
            workspaceId, sessionId: parentId, loopId, turnId, sequence: 2, origin: "model",
        });
        assert.equal(spawned.status, 200);
        assert.equal((await SessionOwners.read(db, calls[0].sessionId)).address, TEST_OWNER);
        const childId = calls[0].sessionId;
        const childLoop = await insertLoop(db, childId, op === "FORK" ? 2 : 1, "continue");
        const childTurn = await insertTurn(db, childLoop, 1, 102);
        const read = (sequence: number) => engine.dispatch({
            statement: readEntry("", "note.md"), workspaceId, sessionId: childId,
            loopId: childLoop, turnId: childTurn, sequence, origin: "model",
        });
        assert.equal((await read(1)).problem?.policyScope, "workspace");
        await db.test_set_workspace_settings.run({ id: workspaceId, settings: JSON.stringify({ capabilities: {} }) });
        const admitted = await read(2);
        assert.equal(admitted.status, 200);
        assert.equal(admitted.content, "shared source");
    } finally { await db.close(); }
});

// {§session-control-addressing} Parser tolerance does not grant semantics to
// components outside the exact authority-only session control address.
test("{§machine-processes} session control rejects every non-authority URI component before spawning (#160)", async () => {
    const db = await openMigrated();
    try {
        const { calls, injectSession } = recordingInjectSession();
        const engine = new Engine({ db, schemes: new SchemeRegistry(), injectSession, weigh });
        const workspaceId = await insertWorkspace(db, `session-control-shape-${crypto.randomUUID()}`);
        const sessionId = await insertSession(db, workspaceId);
        const loopId = await insertLoop(db, sessionId, 1, "go");
        const turnId = await insertTurn(db, loopId, 1, 102);
        const malformed = [
            "session:///",
            "session://user@userinfo",
            "session://user:secret@password",
            "session://port:42",
            "session://slash/",
            "session://path/ignored",
            "session://empty-query?",
            "session://query?mode=x",
            "session://empty-fragment#",
            "session://fragment#body",
        ];

        for (const [index, raw] of malformed.entries()) {
            const result = await engine.dispatch({
                statement: { ...spawnedSession("unused", "investigate"), target: authoredSessionPath(raw) },
                workspaceId,
                sessionId,
                loopId,
                turnId,
                sequence: index + 1,
                origin: "model",
            });
            assert.equal(result.status, 400, raw);
            assert.equal(result.problem?.type, "https://problems.plurnk.xyz/scheme/session/control-address-invalid", raw);
            assert.equal(result.problem?.operation, "WORK", raw);
            assert.equal(result.problem?.retryable, false, raw);
        }
        assert.equal(calls.length, 0, "invalid address components never reach child startup");
        for (const raw of malformed) {
            const target = authoredSessionPath(raw);
            if (target.kind !== "url" || target.hostname === null) continue;
            assert.equal(
                await db.session_resolve_by_name.get({ workspace_id: workspaceId, name: target.hostname }),
                undefined,
                `${raw} never mints a session`,
            );
        }
    } finally { await db.close(); }
});

test("{§machine-processes} the exact session control address is enforced before every operation path (#160)", async () => {
    const db = await openMigrated();
    try {
        const { calls, injectSession } = recordingInjectSession();
        const killed: number[] = [];
        const engine = new Engine({
            db,
            schemes: new SchemeRegistry(),
            injectSession,
            cancelSession: async (sessionId: number): Promise<void> => { killed.push(sessionId); },
            weigh,
        });
        const workspaceId = await insertWorkspace(db, `session-control-ops-${crypto.randomUUID()}`);
        const sessionId = await insertSession(db, workspaceId);
        const loopId = await insertLoop(db, sessionId, 1, "go");
        const turnId = await insertTurn(db, loopId, 1, 102);
        const sisterId = await insertSession(db, workspaceId, null, "session");
        await insertLoop(db, sisterId, 1, "working");
        const target = authoredSessionPath("session://session?ignored=true");
        const statements: PlurnkStatement[] = [
            { ...spawnedSession("session", "spawn"), target },
            { ...forkSession("session", "fork"), target },
            sendStmt(target, "message"),
            readStmt(target),
            { metadata: null, op: "KILL", aside: null, target, lineMarker: null, matcher: null, body: null, position: { line: 1, column: 1 } },
        ];

        const results = [];
        for (const [index, statement] of statements.entries()) {
            results.push(await engine.dispatch({
                statement,
                workspaceId,
                sessionId,
                loopId,
                turnId,
                sequence: index + 1,
                origin: "model",
            }));
        }
        assert.deepEqual(results.map(({ status }) => status), [400, 400, 400, 400, 400]);
        assert.deepEqual(
            results.map(({ problem }) => problem?.type),
            Array.from({ length: 5 }, () => "https://problems.plurnk.xyz/scheme/session/control-address-invalid"),
        );
        assert.deepEqual(results.map(({ problem }) => problem?.operation), ["WORK", "FORK", "SEND", "READ", "KILL"]);
        assert.equal(calls.length, 0, "invalid controls never inject a session message or task");
        assert.equal(killed.length, 0, "invalid controls never cancel a session");
    } finally { await db.close(); }
});

test("{§session-control-addressing}: all Session names are literal; tilde is not an alias", async () => {
    const db = await openMigrated();
    try {
        const { calls, injectSession } = recordingInjectSession();
        const killed: number[] = [];
        const engine = new Engine({ db, schemes: new SchemeRegistry(), injectSession, cancelSession: async (id) => { killed.push(id); }, weigh });
        const workspaceId = await insertWorkspace(db, crypto.randomUUID());
        const sessionId = await insertSession(db, workspaceId, null, "actor");
        const loopId = await insertLoop(db, sessionId, 1, "go");
        const turnId = await insertTurn(db, loopId, 1, 102);
        let sequence = 0;
        const dispatch = (statement: PlurnkStatement) => engine.dispatch({ statement, workspaceId, sessionId, loopId, turnId, sequence: ++sequence, origin: "model" });
        assert.equal((await dispatch(spawnedSession("self", "be the literally named session"))).status, 200);
        const named = await db.session_resolve_by_name.get<{ id: number }>({ workspace_id: workspaceId, name: "self" });
        assert.ok(named);
        assert.equal((await dispatch(sendStmt(sessionPath("actor"), "message the caller"))).status, 200);
        assert.equal((await dispatch(sendStmt(sessionPath("self"), "message the named session"))).status, 200);
        assert.deepEqual(calls.slice(1).map(({ sessionId: id }) => id), [sessionId, named.id]);
        assert.equal((await dispatch(sendStmt(sessionPath("~"), "no alias"))).status, 404);
        assert.equal((await dispatch(editStmt(sessionEntry("~", "notes.md"), "literal namespace"))).status, 201);
        assert.equal((await dispatch(readStmt(sessionEntry("actor", "notes.md")))).status, 404,
            "a literal tilde never aliases the caller's named scratch");
        for (const name of ["actor", "self"]) {
            assert.equal((await dispatch(editStmt(sessionEntry(name, "notes.md"), "scratch"))).status, 201);
            const kill: KillStatement = { metadata: null, op: "KILL", aside: null, target: sessionPath(name), lineMarker: null, matcher: null, body: null, position: { line: 1, column: 1 } };
            assert.equal((await dispatch(kill)).status, 200);
        }
        assert.deepEqual(killed, [sessionId, named.id]);
    } finally { await db.close(); }
});

test("{§session-scheme-spawn}: WORK naming a RUNNING sister delivers its body to her as a message, never a raw UNIQUE 500", async () => {
    const db = await openMigrated();
    try {
        const { calls, injectSession } = recordingInjectSession();
        const engine = new Engine({ db, schemes: new SchemeRegistry(), injectSession, weigh });
        const workspaceId = await insertWorkspace(db, `session-spawn-live-${crypto.randomUUID()}`);
        const sessionId = await insertSession(db, workspaceId);
        const loopId = await insertLoop(db, sessionId, 1, "go");
        const turnId = await insertTurn(db, loopId, 1, 102);
        // A sister 'session' is already RUNNING (a loop at the default live status 102).
        const sister = await insertSession(db, workspaceId, null, "session");
        await insertLoop(db, sister, 1, "working");

        const result = await engine.dispatch({
            statement: spawnedSession("session", "do it again"),
            workspaceId, sessionId, loopId, turnId, sequence: 1, origin: "model",
        });
        assert.equal(result.status, 200, "the held name is the voice door");
        assert.deepEqual((result as { attrs?: unknown }).attrs, { session: "session://session", delivered: "message", message: "message://recorded/1" }, "the receipt says what happened");
        assert.equal(calls.length, 1, "one delivery");
        assert.equal(calls[0].sessionId, sister, "to the running sister");
        assert.equal(calls[0].prompt, "do it again", "her message is the WORK's body");
        assert.notEqual(calls[0].spawn, true, "a message, not a spawn");
    } finally { await db.close(); }
});

test("{§session-scheme-spawn}: WORK naming a PARKED sister delivers its body to her as a message", async () => {
    const db = await openMigrated();
    try {
        const { calls, injectSession } = recordingInjectSession();
        const engine = new Engine({ db, schemes: new SchemeRegistry(), injectSession, weigh });
        const workspaceId = await insertWorkspace(db, `session-spawn-parked-${crypto.randomUUID()}`);
        const sessionId = await insertSession(db, workspaceId);
        const loopId = await insertLoop(db, sessionId, 1, "go");
        const turnId = await insertTurn(db, loopId, 1, 102);
        const sister = await insertSession(db, workspaceId, null, "session");
        const parkedLoop = await insertLoop(db, sister, 1, "waiting");
        await db.test_set_loop_status.run({
            id: parkedLoop,
            status: 202,
            terminal_result: null,
        });

        const result = await engine.dispatch({
            statement: spawnedSession("session", "do it again"),
            workspaceId, sessionId, loopId, turnId, sequence: 1, origin: "model",
        });
        assert.equal(result.status, 200, "a parked session keeps its name and takes the message");
        assert.deepEqual((result as { attrs?: unknown }).attrs, { session: "session://session", delivered: "message", message: "message://recorded/1" });
        assert.equal(calls.length, 1, "the message reached injection once");
        assert.equal(calls[0].sessionId, sister);
        assert.notEqual(calls[0].spawn, true, "a message, not a spawn");
    } finally { await db.close(); }
});

test("{§pinned-wording-core} WORK and FORK reject non-mintable session authorities before creating or starting a child", async () => {
    const db = await openMigrated();
    try {
        const { calls, injectSession } = recordingInjectSession();
        const engine = new Engine({ db, schemes: new SchemeRegistry(), injectSession, weigh });
        const workspaceId = await insertWorkspace(db, `session-name-${crypto.randomUUID()}`);
        const sessionId = await insertSession(db, workspaceId);
        const loopId = await insertLoop(db, sessionId, 1, "go");
        const turnId = await insertTurn(db, loopId, 1, 102);

        for (const [sequence, statement] of [
            [1, spawnedSession("_invalid", "spawn")],
            [2, forkSession("_invalid", "fork")],
        ] as const) {
            const result = await engine.dispatch({
                statement,
                workspaceId,
                sessionId,
                loopId,
                turnId,
                sequence,
                origin: "model",
            });
            assert.equal(result.status, 400);
            assert.equal(result.problem?.type, "https://problems.plurnk.xyz/engine/dispatcher/session-name-invalid");
            assert.equal(result.problem?.session, "_invalid");
            assert.equal(result.problem?.detail, "Session name '_invalid' must match [A-Za-z0-9][A-Za-z0-9_-]{0,62}."); // {§pinned-wording-core}
            assert.equal(result.problem?.recovery, "Use 1–63 ASCII letters, digits, '_' or '-', starting with a letter or digit."); // {§pinned-wording-core}
            assert.equal(result.problem?.retryable, false);
        }

        assert.equal(calls.length, 0, "invalid names never reach the child-start seam");
        assert.equal(
            await db.session_resolve_by_name.get({ workspace_id: workspaceId, name: "_invalid" }),
            undefined,
            "invalid names never reach the session registry",
        );
    } finally { await db.close(); }
});

test("{§op-execution-order}: one model program creates sessions before cancelling selected children", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, "ordered-session-control");
        const sessionId = await insertSession(db, workspaceId, null, "parent");
        const loopId = await insertLoop(db, sessionId, 1, "Compare approaches.");
        const lifecycle = new LoopLifecycle(db);
        const children = new Map<string, number>();
        const engine = new Engine({
            db, schemes: new SchemeRegistry(), weigh,
            injectSession: async ({ sessionId: child, prompt }) => {
                const childLoop = await insertLoop(db, child, 1, prompt);
                children.set(await SessionName.forId(db, child), childLoop);
                return { action: "enqueued_new_loop", loopId: childLoop, message: `message://${await SessionName.forId(db, child)}/1` };
            },
            cancelSession: async (child, reason) => { await lifecycle.cancelTree(child, reason, true); },
        });
        const content = [
            PlurnkParser.frame("WORK (session://approach_a)", "Consider approach A."),
            PlurnkParser.frame("WORK (session://approach_b)", "Consider approach B."),
            PlurnkParser.frame("WORK (session://approach_c)", "Consider approach C."),
            PlurnkParser.frame("KILL (session://approach_a)", null),
            PlurnkParser.frame("KILL (session://approach_c)", null),
        ].join("\n\n");
        const provider = new Mock({ contextWindow: 100_000, responses: [{ assistant: { content, reasoning: null } }] });
        const turn = await engine.runTurn({ workspaceId, sessionId, loopId, provider, messages: [] });
        const rows = await db.test_log_entries_by_turn.all<{ op: string; hostname: string | null; origin: string; status_rx: number }>({ turn_id: turn.turnId });
        assert.deepEqual(rows.filter(({ origin }) => origin === "model").map(({ op, hostname, status_rx }) => [op, hostname, status_rx]), [
            ["WORK", "approach_a", 200],
            ["WORK", "approach_b", 200],
            ["WORK", "approach_c", 200],
            ["KILL", "approach_a", 200],
            ["KILL", "approach_c", 200],
        ], "every operation sees the preceding operation's durable effects");
        assert.deepEqual([...children.keys()], ["approach_a", "approach_b", "approach_c"]);
        assert.equal(await lifecycle.status(children.get("approach_a")!), 499);
        assert.equal(await lifecycle.status(children.get("approach_b")!), 102);
        assert.equal(await lifecycle.status(children.get("approach_c")!), 499);
    } finally { await db.close(); }
});

test("{§session-scheme-spawn}: a completed Session retains its name and scratch identity", async () => {
    const db = await openMigrated();
    try {
        const { calls, injectSession } = recordingInjectSession();
        const engine = new Engine({ db, schemes: new SchemeRegistry(), injectSession, weigh });
        const workspaceId = await insertWorkspace(db, crypto.randomUUID());
        const sessionId = await insertSession(db, workspaceId);
        const loopId = await insertLoop(db, sessionId, 1, "go");
        const turnId = await insertTurn(db, loopId, 1, 102);
        const retained = await insertSession(db, workspaceId, null, "session");
        const completed = await insertLoop(db, retained, 1, "done");
        await db.test_set_loop_status.run({ id: completed, status: 200, terminal_result: JSON.stringify({ status: 200 }) });
        // The retained name is still that session's: WORK reaches it as a message, FORK cannot branch into it.
        const work = await engine.dispatch({ statement: spawnedSession("session", "fresh work"), workspaceId, sessionId, loopId, turnId, sequence: 1, origin: "model" });
        assert.equal(work.status, 200, "WORK to the completed session is its next message");
        assert.deepEqual((work as { attrs?: unknown }).attrs, { session: "session://session", delivered: "message", message: "message://recorded/1" });
        const fork = await engine.dispatch({ statement: forkSession("session", "branch"), workspaceId, sessionId, loopId, turnId, sequence: 2, origin: "model" });
        assert.equal(fork.status, 409);
        assert.equal(fork.problem?.type, "https://problems.plurnk.xyz/engine/dispatcher/session-name-conflict");
        assert.match(String(fork.problem?.recovery), /WORK or SEND \(session:\/\/session\)/u);
        assert.equal(calls.length, 1, "one message, no spawn");
        assert.equal(calls[0].sessionId, retained, "delivered to the retained session");
        assert.equal((await db.session_resolve_by_name.get<{ id: number }>({ workspace_id: workspaceId, name: "session" }))?.id, retained);
    } finally { await db.close(); }
});

test("{§join-blocking-collect} READ(session://name) collects the exact terminal result — 425 running, 404 absent", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `session-collect-${crypto.randomUUID()}`);
        const reader = await insertSession(db, workspaceId); // the sister doing the collection
        const ctx = makeSchemeCtx({ db, workspaceId, sessionId: reader });
        // No such session → 404 (not a bare 400 the model can't read).
        const missing = await readThroughScheme("session", null, readStmt(sessionPath("ghost")), ctx);
        assert.equal(missing.status, 404, "a name with no session is 404");

        // {§join-blocking-collect}
        const session = await insertSession(db, workspaceId, null, "session-db");
        const wLoop = await insertLoop(db, session, 1, "find db");
        const running = await readThroughScheme("session", null, readStmt(sessionPath("session-db")), ctx);
        assert.equal(running.status, 425, "a still-running session hasn't delivered — 425, not its result");
        assert.equal(running.problem?.type, "https://problems.plurnk.xyz/scheme/ops/loop-running");
        assert.equal(running.problem?.detail, "The execution at ops://session-db/1 has not concluded."); // {§pinned-wording-core}
        assert.equal(running.resource, "ops://session-db/1", "the selected execution has an exact identity");
        assert.equal("awaitSession" in running, false, "a READ result does not carry hidden scheduling intent");

        // It concludes 200 with a deliverable → READing the session yields one
        // canonical body channel, projected by the same READ rules as entries.
        const lines = Array.from({ length: 20 }, (_, index) => `finding ${index + 1}`);
        const deliverable = { status: 200, content: lines.join("\n"), mimetype: "text/markdown" };
        assert.deepEqual(
            await new LoopLifecycle(db).finish(wLoop, deliverable),
            deliverable,
        );
        const done = await readThroughScheme("session", null, readStmt(sessionPath("session-db")), ctx);
        assert.equal(done.status, 200, "a concluded session's READ succeeds");
        assert.equal(done.content, lines.join("\n"), "a markerless READ is the first page of the deliverable; 20 lines fit it ({§markerless-first-page})");
        assert.equal(Object.hasOwn(done, "lineAnchors"), false, "an actor's deliverable is not an editable entry");
        assert.deepEqual(done.range, {
            unit: "line",
            total: 20,
            requested: [1, PAGE],
            returned: [1, 20],
        });

        const tail = await readThroughScheme("session", null, {
            ...readStmt(sessionPath("session-db")),
            lineMarker: { marks: [18, -1] },
        }, ctx);
        assert.equal(tail.content, lines.slice(17).join("\n"));
        assert.equal(tail.mimetype, "text/markdown");
        assert.equal(Object.hasOwn(tail, "lineAnchors"), false, "scoping an actor READ does not grant entry-edit authority");

        const bodyTarget = sessionPath("session-db");
        if (bodyTarget.kind !== "url") throw new Error("session test target must be a URL");
        const body = await readThroughScheme("session", null, readStmt({
            ...bodyTarget,
            raw: `${bodyTarget.raw}#body`,
            fragment: "body",
        }), ctx);
        assert.equal(body.content, lines.join("\n"));
        assert.equal(body.channel, "body");

        const failedSession = await insertSession(db, workspaceId, null, "session-failed");
        const failedLoop = await insertLoop(db, failedSession, 1, "call provider");
        const failure = Results.failure(
            "test:session",
            "provider-failed",
            502,
            "The child provider failed.",
        );
        await new LoopLifecycle(db).finish(failedLoop, failure);
        const failed = await readThroughScheme("session", null, readStmt(sessionPath("session-failed")), ctx);
        assert.equal(failed.status, 502, "READ preserves the child's exact failure status");
        assert.equal(failed.problem?.detail, "The child provider failed.", "READ preserves the child's exact Problem"); // {§pinned-wording-core}
        assert.equal(failed.content, "The child provider failed.", "READ derives a readable body from the exact Problem"); // {§pinned-wording-core}
    } finally { await db.close(); }
});

test("{§problems-entries} EDIT on the bare session entity is rejected — WORK spawns, not EDIT (400, no inject)", async () => {
    const db = await openMigrated();
    try {
        const { calls, injectSession } = recordingInjectSession();
        const engine = new Engine({ db, schemes: new SchemeRegistry(), injectSession, weigh });
        const workspaceId = await insertWorkspace(db, `session-edit-entity-${crypto.randomUUID()}`);
        const sessionId = await insertSession(db, workspaceId);
        const loopId = await insertLoop(db, sessionId, 1, "go");
        const turnId = await insertTurn(db, loopId, 1, 102);
        const namedSessionId = await insertSession(db, workspaceId, null, "session");

        // grammar 0.74.41 OP×resource matrix: EDIT is file/entry only — the session ENTITY (path-absent
        // session://<name>) is not editable. WORK(session://<name>) spawns.
        const result = await engine.dispatch({
            statement: editStmt(sessionPath("session"), "loop forever"),
            workspaceId, sessionId, loopId, turnId, sequence: 1, origin: "model",
        });
        assert.equal(result.status, 400, "EDIT on the session entity is rejected");
        assert.equal(result.problem?.type, "https://problems.plurnk.xyz/scheme/session/session-entity-not-editable");
        assert.equal(result.problem?.detail, "A session entity is not an editable entry."); // {§problems-entries}
        assert.equal(result.problem?.recovery, "EDIT requires an entry path, such as workspace:///example.md."); // {§problems-entries}
        assert.equal(result.problem?.retryable, false);
        assert.equal(calls.length, 0, "no inject on a rejected EDIT");
        const session = await db.session_resolve_by_name.get<{ id: number }>({ workspace_id: workspaceId, name: "session" });
        assert.equal(session?.id, namedSessionId, "the rejected EDIT neither creates nor replaces the addressed session");
    } finally { await db.close(); }
});

test("{§session-scheme-irc} SEND(session://name):msg delivers to a sister; a missing sister is 404", async () => {
    const db = await openMigrated();
    try {
        const { calls, injectSession } = recordingInjectSession();
        const engine = new Engine({ db, schemes: new SchemeRegistry(), injectSession, weigh });
        const workspaceId = await insertWorkspace(db, `session-irc-${crypto.randomUUID()}`);
        const sessionId = await insertSession(db, workspaceId);
        const loopId = await insertLoop(db, sessionId, 1, "go");
        const turnId = await insertTurn(db, loopId, 1, 102);
        const sisterId = await insertSession(db, workspaceId, null, "session");

        const ok = await engine.dispatch({
            statement: sendStmt(sessionPath("session"), "what's your status?"),
            workspaceId, sessionId, loopId, turnId, sequence: 1, origin: "model",
        });
        assert.equal(ok.status, 200, "irc to an existing sister returns 200");
        const ircRest = calls.at(-1)!;
        assert.deepEqual(ircRest, { workspaceId, sessionId: sisterId, sourceLoopId: loopId, prompt: "what's your status?", opener: { turnId, sequence: 1 } }, "the message is delivered with the sender's causal identity, the operation that sent it");

        const missing = await engine.dispatch({
            statement: sendStmt(sessionPath("ghost"), "anyone there?"),
            workspaceId, sessionId, loopId, turnId, sequence: 2, origin: "model",
        });
        assert.equal(missing.status, 404, "irc to a non-existent sister is 404");
        assert.equal(calls.length, 1, "no inject for a missing sister");
    } finally { await db.close(); }
});

test("{§session-scheme-irc}: empty and whitespace-only messages never reach session injection", async () => {
    const db = await openMigrated();
    try {
        const { calls, injectSession } = recordingInjectSession();
        const engine = new Engine({ db, schemes: new SchemeRegistry(), injectSession, weigh });
        const workspaceId = await insertWorkspace(db, "empty-session-send");
        const sessionId = await insertSession(db, workspaceId);
        const loopId = await insertLoop(db, sessionId, 1, "go");
        const turnId = await insertTurn(db, loopId, 1, 102);
        await insertSession(db, workspaceId, null, "receiver");
        let sequence = 0;
        for (const body of [null, "", " \t\n"]) {
            const result = await engine.dispatch({
                statement: sendStmt(sessionPath("receiver"), body),
                workspaceId, sessionId, loopId, turnId, sequence: ++sequence, origin: "model",
            });
            assert.equal(result.status, 422);
            assert.equal(result.problem?.type, "https://problems.plurnk.xyz/scheme/session/message-empty");
            assert.equal(result.problem?.detail, "SEND has no message text or attachments."); // {§problems-entries}
        }
        assert.equal(calls.length, 0);
        const literal = " \tMessage with significant whitespace.\n ";
        const delivered = await engine.dispatch({
            statement: sendStmt(sessionPath("receiver"), literal),
            workspaceId, sessionId, loopId, turnId, sequence: ++sequence, origin: "model",
        });
        assert.equal(delivered.status, 200);
        assert.equal(calls.length, 1);
        assert.equal(calls[0].prompt, literal, "validation preserves a nonempty message verbatim");
    } finally { await db.close(); }
});

test("{§session-ownership}: SEND between unrelated sessions cannot transfer approval authority", async () => {
    await using db = await openMigrated();
    const { calls, injectSession } = recordingInjectSession();
    const engine = new Engine({ db, schemes: new SchemeRegistry(), injectSession, weigh });
    const workspaceId = await insertWorkspace(db, "message-owner-separation");
    const sessionId = await insertSession(db, workspaceId);
    await ownSession(db, workspaceId, sessionId);
    const sisterId = await insertSession(db, workspaceId, null, "sister");
    const loopId = await insertLoop(db, sessionId, 1, "delegate");
    const turnId = await insertTurn(db, loopId, 1, 102);
    const result = await engine.dispatch({
        statement: sendStmt(sessionPath("sister"), "continue this work"),
        workspaceId, sessionId, loopId, turnId, sequence: 1, origin: "model",
    });
    assert.equal(result.status, 200);
    assert.deepEqual(calls, [{ workspaceId, sessionId: sisterId, sourceLoopId: loopId, prompt: "continue this work", opener: { turnId, sequence: 1 } }]);
    assert.equal((await SessionOwners.read(db, sisterId)).address, "_plurnk");
    assert.equal((await SessionOwners.read(db, sessionId)).address, TEST_OWNER);
});

test("{§session-write-scoping}: entry KILL works upward, downward and on self without cancelling actors", async () => {
    const db = await openMigrated();
    try {
        const killed: number[] = [];
        const engine = new Engine({ db, schemes: new SchemeRegistry(), cancelSession: async (id) => { killed.push(id); }, weigh });
        const workspaceId = await insertWorkspace(db, crypto.randomUUID());
        const alpha = await insertSession(db, workspaceId, null, "alpha");
        const beta = await insertSession(db, workspaceId, alpha, "beta");
        for (const [index, [writer, target]] of [[beta, "alpha"], [alpha, "beta"], [alpha, "alpha"]].entries()) {
            const sessionId = writer as number;
            const name = target as string;
            const loopId = await insertLoop(db, sessionId, index + 1, "go");
            const turnId = await insertTurn(db, loopId, 1, 102);
            let sequence = 0;
            const dispatch = (statement: PlurnkStatement) => engine.dispatch({ statement, workspaceId, sessionId, loopId, turnId, sequence: ++sequence, origin: "model" });
            assert.equal((await dispatch(editStmt(sessionEntry(name, "note.md"), "scratch"))).status, 201);
            assert.equal((await dispatch(killEntry(name, "note.md"))).status, 200);
            assert.equal((await dispatch(readEntry(name, "note.md"))).status, 404);
            assert.ok(await db.session_resolve_by_name.get({ workspace_id: workspaceId, name }));
        }
        assert.deepEqual(killed, []);
    } finally { await db.close(); }
});

test("{§machine-processes} FORK(session://name):task forks a NAMED branch — started via injectSession", async () => {
    const db = await openMigrated();
    try {
        const { calls, injectSession } = recordingInjectSession();
        const engine = new Engine({ db, schemes: new SchemeRegistry(), injectSession, weigh });
        const workspaceId = await insertWorkspace(db, `session-fork-${crypto.randomUUID()}`);
        const sessionId = await insertSession(db, workspaceId, null, "explorer");
        const loopId = await insertLoop(db, sessionId, 1, "go");
        const turnId = await insertTurn(db, loopId, 1, 102);

        const forkStmt = forkSession("Recheck_A", "take the other branch");
        const result = await engine.dispatch({
            statement: forkStmt, workspaceId, sessionId, loopId, turnId, sequence: 1, origin: "model",
        });
        assert.equal(result.status, 200, "fork returns 200");
        const branchName = (result as { body?: string }).body ?? "";
        assert.equal(branchName, "Recheck_A", "the branch carries the explicit name FORK gave it");

        const branch = await db.session_resolve_by_name.get<{ id: number }>({ workspace_id: workspaceId, name: branchName });
        if (branch === undefined) throw new Error("fork must create the branch session in the workspace");
        assert.notEqual(branch.id, sessionId, "the branch is a distinct session");
        const forkRest = calls.at(-1)!;
        assert.deepEqual(forkRest, { workspaceId, sessionId: branch.id, sourceLoopId: loopId, prompt: "take the other branch", spawn: true, opener: { turnId, sequence: 1 } }, "the branch is continued with its delegator's causal identity, the operation that sent it");
    } finally { await db.close(); }
});

test("{§machine-processes} spawn AND fork past PLURNK_SERVICE_WORKSPACE_SESSIONS_MAX_ACTIVE fail hard (508), create nothing", async () => {
    const db = await openMigrated();
    const prior = process.env.PLURNK_SERVICE_WORKSPACE_SESSIONS_MAX_ACTIVE;
    process.env.PLURNK_SERVICE_WORKSPACE_SESSIONS_MAX_ACTIVE = "2";
    try {
        const { calls, injectSession } = recordingInjectSession();
        const engine = new Engine({ db, schemes: new SchemeRegistry(), injectSession, weigh });
        const workspaceId = await insertWorkspace(db, `session-cap-${crypto.randomUUID()}`);
        const sessionId = await insertSession(db, workspaceId);        // the acting session, its loop 102 = 1 active = the ceiling
        const loopId = await insertLoop(db, sessionId, 1, "go");
        const turnId = await insertTurn(db, loopId, 1, 102);
        const parkedSessionId = await insertSession(db, workspaceId, null, "parked");
        const parkedLoopId = await insertLoop(db, parkedSessionId, 1, "waiting");
        await db.test_set_loop_status.run({
            id: parkedLoopId,
            status: 202,
            terminal_result: null,
        });

        const spawn = await engine.dispatch({
            statement: spawnedSession("session", "go"),
            workspaceId, sessionId, loopId, turnId, sequence: 1, origin: "model",
        });
        assert.equal(spawn.status, 508, "spawn at the ceiling is refused, hard");

        const fork = await engine.dispatch({
            statement: forkSession("branch", "go"), workspaceId, sessionId, loopId, turnId, sequence: 2, origin: "model",
        });
        assert.equal(fork.status, 508, "fork at the ceiling is refused, hard");

        const session = await db.session_resolve_by_name.get<{ id: number }>({ workspace_id: workspaceId, name: "session" });
        assert.equal(session, undefined, "no session is created past the ceiling");
        assert.equal(calls.length, 0, "no inject on a refused spawn/fork");
    } finally {
        if (prior === undefined) delete process.env.PLURNK_SERVICE_WORKSPACE_SESSIONS_MAX_ACTIVE;
        else process.env.PLURNK_SERVICE_WORKSPACE_SESSIONS_MAX_ACTIVE = prior;
        await db.close();
    }
});

test("{§session-read-scope} KILL(session://name) aborts a sister by address; a missing sister is 404", async () => {
    const db = await openMigrated();
    try {
        const killed: number[] = [];
        const cancelSession = async (sessionId: number): Promise<void> => { killed.push(sessionId); };
        const engine = new Engine({ db, schemes: new SchemeRegistry(), cancelSession, weigh });
        const workspaceId = await insertWorkspace(db, `session-kill-${crypto.randomUUID()}`);
        const sessionId = await insertSession(db, workspaceId);
        const loopId = await insertLoop(db, sessionId, 1, "go");
        const turnId = await insertTurn(db, loopId, 1, 102);
        const sisterId = await insertSession(db, workspaceId, null, "session");

        const killSession: KillStatement = { metadata: null, op: "KILL", aside: null, target: sessionPath("session"), lineMarker: null, matcher: null, body: null, position: { line: 1, column: 1 } };
        const ok = await engine.dispatch({ statement: killSession, workspaceId, sessionId, loopId, turnId, sequence: 1, origin: "model" });
        assert.equal(ok.status, 200, "KILL of an existing sister returns 200");
        assert.deepEqual(killed, [sisterId], "the named sister session is aborted by id");

        const killGhost: KillStatement = { metadata: null, op: "KILL", aside: null, target: sessionPath("ghost"), lineMarker: null, matcher: null, body: null, position: { line: 1, column: 1 } };
        const missing = await engine.dispatch({ statement: killGhost, workspaceId, sessionId, loopId, turnId, sequence: 2, origin: "model" });
        assert.equal(missing.status, 404, "KILL of a non-existent sister is 404");
        assert.equal(killed.length, 1, "no abort for a missing sister");
    } finally { await db.close(); }
});

for (const related of [true, false]) test(`{§session-read-scope}: ${related ? "parent" : "unrelated session"} reads and writes a named entry`, async () => {
    const db = await openMigrated();
    try {
        const engine = new Engine({ db, schemes: new SchemeRegistry(), weigh });
        const workspaceId = await insertWorkspace(db, `session-store-${crypto.randomUUID()}`);
        const meId = await insertSession(db, workspaceId, null, "me");
        const childId = await insertSession(db, workspaceId, related ? meId : null, "author");
        const loopId = await insertLoop(db, meId, 1, "go");
        const turnId = await insertTurn(db, loopId, 1, 102);
        const readOf = (target: ParsedPath): ReadStatement => ({ metadata: null, op: "READ", aside: null, lineMarker: null, target, matcher: null, body: null, position: { line: 1, column: 1 } });

        // {§entry-owner}: the authority is part of the workspace entry key.
        const childLoop = await insertLoop(db, childId, 1, "go");
        const childTurn = await insertTurn(db, childLoop, 1, 102);
        const write = await engine.dispatch({ statement: editStmt(sessionEntry("author", "note.md"), "scratch"), workspaceId, sessionId: childId, loopId: childLoop, turnId: childTurn, sequence: 1, origin: "model" });
        assert.equal(write.status, 201, "own-space write creates the entry");
        const stored = await db.crud_find_workspace_entry.get<{ id: number }>({ workspace_id: workspaceId, scheme: "session", authority: "author", pathname: "/note.md" });
        if (stored === undefined) throw new Error("entry must be keyed by workspace and literal authority");

        const readCross = await engine.dispatch({ statement: readOf(sessionEntry("author", "note.md")), workspaceId, sessionId: meId, loopId, turnId, sequence: 1, origin: "model" });
        assert.equal(readCross.status, 200, "a named READ reaches another session's entry without ancestry");
        assert.equal(readCross.content, "scratch");

        // {§session-write-scoping} applies independently to the destination.
        const writeCross = await engine.dispatch({ statement: editStmt(sessionEntry("author", "note.md"), "updated", fullReplace), workspaceId, sessionId: meId, loopId, turnId, sequence: 2, origin: "model" });
        assert.equal(writeCross.status, 200);
        assert.equal((await engine.dispatch({ statement: readOf(sessionEntry("author", "note.md")), workspaceId, sessionId: meId, loopId, turnId, sequence: 3, origin: "model" })).content, "updated");
    } finally { await db.close(); }
});

test("{§machine-processes} the runtime session is an ordinary named space: readable and writable by everyone", async () => {
    const db = await openMigrated();
    try {
        const engine = new Engine({ db, schemes: new SchemeRegistry(), weigh });
        const workspaceId = await insertWorkspace(db, `plurnk-ro-${crypto.randomUUID()}`);
        const meId = await insertSession(db, workspaceId, null, "me");
        const loopId = await insertLoop(db, meId, 1, "go");
        const turnId = await insertTurn(db, loopId, 1, 102);

        const kernelId = await RuntimeSession.ensure(db, workspaceId);
        const kernelLoop = await insertLoop(db, kernelId, 1, "runtime evidence");
        const kernelTurn = await insertTurn(db, kernelLoop, 1, 102);
        const runtimeWrite = await engine.dispatch({
            statement: editStmt(sessionEntry("_plurnk", "runtime.md"), "private runtime evidence"),
            workspaceId,
            sessionId: kernelId,
            loopId: kernelLoop,
            turnId: kernelTurn,
            sequence: 1,
            origin: "_plurnk",
        });
        assert.equal(runtimeWrite.status, 201);

        const read = await engine.dispatch({
            statement: readStmt(sessionEntry("_plurnk", "runtime.md")),
            workspaceId,
            sessionId: meId,
            loopId,
            turnId,
            sequence: 1,
            origin: "model",
        });
        assert.equal(read.status, 200, "an independent root reads the runtime actor's named space (#394)");
        const write = await engine.dispatch({ statement: editStmt(sessionEntry("_plurnk", "runtime.md"), "updated", fullReplace), workspaceId, sessionId: meId, loopId, turnId, sequence: 2, origin: "model" });
        assert.equal(write.status, 200, "the runtime actor has no privileged scratch access");
        const leakedWorkspace = await db.crud_find_workspace_entry.get<{ id: number }>({ workspace_id: workspaceId, scheme: "workspace", authority: "", pathname: "/runtime.md" });
        const leakedSession = await db.crud_find_workspace_entry.get<{ id: number }>({ workspace_id: workspaceId, scheme: "session", authority: "", pathname: "/runtime.md" });
        assert.equal(leakedWorkspace, undefined, "named writes do not create a second copy in shared scratch");
        assert.equal(leakedSession, undefined, "named writes do not create an empty-authority session entry");
    } finally { await db.close(); }
});

test("{§session-scheme}: session:/// entry operations and FIND require a named session and point to workspace:///", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, crypto.randomUUID());
        const sessionId = await insertSession(db, workspaceId, null, "alpha");
        const loopId = await insertLoop(db, sessionId, 1, "go");
        const turnId = await insertTurn(db, loopId, 1, 102);
        const engine = new Engine({ db, schemes: new SchemeRegistry(), weigh });
        const emptyTarget: ParsedPath = {
            kind: "url", raw: "session:///note.md", scheme: "session",
            username: null, password: null, hostname: null, port: null,
            pathname: "/note.md", query: null, fragment: null,
        };
        let sequence = 0;
        for (const statement of [
            editStmt(emptyTarget, "body"),
            readStmt(emptyTarget),
            { metadata: null, op: "FIND" as const, aside: null, target: emptyTarget, lineMarker: null, matcher: null, body: null, position: { line: 1, column: 1 } },
            { metadata: null, op: "KILL" as const, aside: null, target: emptyTarget, lineMarker: null, matcher: null, body: null, position: { line: 1, column: 1 } },
        ]) {
            const res = await engine.dispatch({ statement, workspaceId, sessionId: sessionId, loopId, turnId, sequence: ++sequence, origin: "model" });
            assert.equal(res.status, 400);
            assert.equal(res.problem?.type, "https://problems.plurnk.xyz/scheme/session/named-session-required");
        }
    } finally { await db.close(); }
});

test("{§join-blocking-collect} READ of a running child does not override a continuing NOTE", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `join-collect-${crypto.randomUUID()}`);
        const parent = await insertSession(db, workspaceId);
        const parentLoop = await insertLoop(db, parent, 1, "orchestrate");
        const session = await insertSession(db, workspaceId, parent, "session"); // a session still running (live loop 102),
        await insertLoop(db, session, 1, "count");                     // nothing delivered yet
        const engine = new Engine({ db, schemes: new SchemeRegistry() });

        const provider = new Mock({ contextWindow: 100_000, responses: [
            { assistant: { content: "````READ (session://session)\n````\n````NOTE\nKeep working.\n````", reasoning: null } },
            { assistant: { content: "````WAIT\nAwait the child.\n````", reasoning: null } },
        ] });
        const run = () => engine.runTurn({ provider, workspaceId, sessionId: parent, loopId: parentLoop, messages: [] });
        const continued = await run();
        assert.deepEqual(continued.outcomes.map(({ op, status }) => [op, status]), [["READ", 425], ["NOTE", 200]]);
        assert.equal(continued.status, 102);
        assert.equal((await db.test_get_loop_status.get<{ status: number }>({ id: parentLoop }))?.status, 102, "actionable work remains runnable");
        const waiting = await run();
        assert.equal(waiting.status, 202);
        const parked = await db.test_get_loop_status.get<{ status: number }>({ id: parentLoop });
        assert.equal(parked?.status, 202, "the explicit waiting inventory parks on the live child");
    } finally { await db.close(); }
});

test("{§join-blocking-collect} a continuing NOTE without live work continues normally", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `join-none-${crypto.randomUUID()}`);
        const session = await insertSession(db, workspaceId);
        const loop = await insertLoop(db, session, 1, "go");
        const { id: turn } = await Turn.open(db, { loopId: loop, producer: "model", kind: "inference" });
        const engine = new Engine({ db, schemes: new SchemeRegistry() });
        const send = await engine.dispatch({ statement: noteStmt(null), workspaceId, sessionId: session, loopId: loop, turnId: turn, sequence: 1, origin: "model" });
        assert.equal(send.status, 200);
        const status = await db.test_get_loop_status.get<{ status: number }>({ id: loop });
        assert.equal(status?.status, 102, "the loop stays live");
    } finally { await db.close(); }
});

test("{§op-synchronous} KILL(session) settles before same-turn completion", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `kill-sync-${crypto.randomUUID()}`);
        const parent = await insertSession(db, workspaceId);
        const parentLoop = await insertLoop(db, parent, 1, "orchestrate");
        const session = await insertSession(db, workspaceId, null, "leftover-session");
        const sessionLoop = await insertLoop(db, session, 1, "work");          // a LIVE child (status 102)
        const lifecycle = new LoopLifecycle(db);
        const engine = new Engine({
            db,
            schemes: new SchemeRegistry(),
            cancelSession: async (sessionId: number, reason: string) => {
                await lifecycle.cancelTree(sessionId, reason, true);
            },
        });

        const result = await engine.runTurn({
            provider: new Mock({ contextWindow: 100_000, responses: [{ assistant: {
                content: "```KILL (session://leftover-session)\n```\n\n```SEND [200]\nDone, session killed.\n```", reasoning: null,
            } }] }),
            workspaceId, sessionId: parent, loopId: parentLoop, messages: [],
        });
        assert.deepEqual(result.outcomes.map(({ op, status }) => [op, status]), [["KILL", 200], ["SEND", 200]]);
        const wstatus = await db.test_get_loop_status.get<{ status: number }>({ id: sessionLoop });
        assert.equal(wstatus?.status, 499, "the killed session's loop is 499 NOW, not next turn — KILL landed before the turn moved on");
        assert.equal(result.status, 200, "the stopped session is no longer live pending work and KILL permits completion");
    } finally { await db.close(); }
});

test("{§wait-obligation-matrix} WAIT: a live obligation parks; an empty join continues without inventing completion", async () => {
    const db = await openMigrated();
    try {
        // 202 + J (a live child) → the loop BLOCKS at 202, to be reawakened when the child concludes.
        const s1 = await insertWorkspace(db, `wait-J-${crypto.randomUUID()}`);
        const parent = await insertSession(db, s1);
        const pLoop = await insertLoop(db, parent, 1, "orchestrate");
        const child = await insertSession(db, s1, parent, "session");
        await insertLoop(db, child, 1, "work"); // a live child (latest loop 102)
        const eng1 = new Engine({ db, schemes: new SchemeRegistry() });
        const provider = new Mock({ contextWindow: 100_000, responses: [{ assistant: { content: "````WAIT\nAwait the child.\n````", reasoning: null } }] });
        const blocked = await eng1.runTurn({ provider, workspaceId: s1, sessionId: parent, loopId: pLoop, messages: [] });
        assert.equal(blocked.status, 202, "202 with a live child blocks on the join");
        assert.equal((await db.test_get_loop_status.get<{ status: number }>({ id: pLoop }))?.status, 202, "the loop is blocked at 202");

        // {§wait-obligation-matrix}
        const s2 = await insertWorkspace(db, `wait-void-${crypto.randomUUID()}`);
        const session = await insertSession(db, s2);
        const loop = await insertLoop(db, session, 1, "solo");
        const turn = await insertTurn(db, loop, 1, 200);
        const eng2 = new Engine({ db, schemes: new SchemeRegistry() });
        const satisfied = await eng2.dispatch({ statement: dispositionStmt("WAIT", "standing by"), workspaceId: s2, sessionId: session, loopId: loop, turnId: turn, sequence: 1, origin: "model" });
        assert.equal(satisfied.status, 102);
        assert.equal(satisfied.detail, "Nothing is in flight. Continuing."); // {§pinned-wording-core}
        assert.equal((await db.test_get_loop_status.get<{ status: number }>({ id: loop }))?.status, 102, "the empty join is not terminal");

        // {§send-wait-scope} — a duration never invents live work.
        const s3 = await insertWorkspace(db, `wait-scope-${crypto.randomUUID()}`);
        const run3 = await insertSession(db, s3);
        const loop3 = await insertLoop(db, run3, 1, "solo");
        const turn3 = await insertTurn(db, loop3, 1, 200);
        const eng3 = new Engine({ db, schemes: new SchemeRegistry() });
        const scoped = { ...dispositionStmt("WAIT", "standing by"), seconds: 600 };
        const continued = await eng3.dispatch({ statement: scoped, workspaceId: s3, sessionId: run3, loopId: loop3, turnId: turn3, sequence: 1, origin: "model" });
        assert.equal(continued.status, 102);
        assert.equal(continued.problem, undefined);
        assert.equal(continued.detail, "Nothing is in flight. Continuing."); // {§pinned-wording-core}
        assert.equal((await db.test_get_loop_status.get<{ status: number }>({ id: loop3 }))?.status, 102, "no held-open 202");
    } finally { await db.close(); }
});

for (const answer of ["", "The module was tested."]) {
    test(`{§message-completion}: an empty join stays active until an explicit ${answer ? "answered" : "silent"} completion reply`, async () => {
        const db = await openMigrated();
        try {
            const workspaceId = await insertWorkspace(db, `drained-join-${crypto.randomUUID()}`);
            const session = await insertSession(db, workspaceId, null, "req-test");
            const wLoop = await insertLoop(db, session, 1, "test the module");
            const wTurn = await insertTurn(db, wLoop, 1, 200);
            const engine = new Engine({ db, schemes: new SchemeRegistry() });
            const waited = await engine.dispatch({ statement: dispositionStmt("WAIT", "Standing by for user input"), workspaceId, sessionId: session, loopId: wLoop, turnId: wTurn, sequence: 1, origin: "model" });
            assert.equal(waited.status, 102, "the empty join continues");
            assert.equal((await db.test_get_loop_status.get<{ status: number }>({ id: wLoop }))?.status, 102, "the loop remains active");
            const reader = await insertSession(db, workspaceId);
            const collected = await readThroughScheme("session", null, readStmt(sessionPath("req-test")), makeSchemeCtx({ db, workspaceId, sessionId: reader }));
            assert.equal(collected.status, 425);
            const provider = new Mock({ contextWindow: 100_000, responses: [
                { assistant: { content: PlurnkParser.frame("SEND [200]", answer), reasoning: null } },
            ] });
            const completed = await engine.runTurn({ provider, workspaceId, sessionId: session, loopId: wLoop, messages: [] });
            assert.equal(completed.status, 200, "explicit completion is independent of answer delivery");
            const done = await readThroughScheme("session", null, readStmt(sessionPath("req-test")), makeSchemeCtx({ db, workspaceId, sessionId: reader }));
            assert.equal(done.status, 200);
            assert.equal(done.content, answer, "READ preserves the actual reply or successful silence, never the WAIT body");
            assert.equal(done.resource, "ops://req-test/1");
            assert.equal((await new LoopLifecycle(db).result(wLoop))?.content ?? null, null);
        } finally { await db.close(); }
    });
}

test("{§machine-processes} an empty waiting inventory stays runnable in the same turn", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `idle-concludes-${crypto.randomUUID()}`);
        const session = await insertSession(db, workspaceId);
        const loop = await insertLoop(db, session, 1, "nothing to do");
        const turn = await insertTurn(db, loop, 1, 200);
        const engine = new Engine({ db, schemes: new SchemeRegistry() });
        const r = await engine.dispatch({ statement: dispositionStmt("WAIT", "idle"), workspaceId, sessionId: session, loopId: loop, turnId: turn, sequence: 1, origin: "model" });
        assert.equal(r.status, 102);
        assert.equal((await db.test_get_loop_status.get<{ status: number }>({ id: loop }))?.status, 102, "no completion and no held-open 202");
    } finally { await db.close(); }
});

test("{§session-generated-subtree}: generated documents are ordinary editable workspace scratch", async () => {
    const db = await openMigrated();
    try {
        const engine = new Engine({ db, schemes: new SchemeRegistry(), weigh });
        const workspaceId = await insertWorkspace(db, crypto.randomUUID());
        const sessionId = await insertSession(db, workspaceId, null, "alpha");
        const loopId = await insertLoop(db, sessionId, 1, "go");
        for (const [index, origin] of ["_plurnk", "model", "client"].entries()) {
            const writer = origin as "model" | "client" | "_plurnk";
            const turnId = writer === "model"
                ? await insertTurn(db, loopId, index + 1, 102)
                : await insertOperationTurn(db, loopId, index + 1, writer);
            let sequence = 0;
            const dispatch = (statement: PlurnkStatement) => engine.dispatch({ statement, workspaceId, sessionId, loopId, turnId, sequence: ++sequence, origin: writer });
            const target = sessionEntry("", "_plurnk/plurnk/example.md");
            assert.equal((await dispatch(editStmt(target, "# Example"))).status, 201);
            assert.equal((await dispatch(editStmt(target, "# Updated", fullReplace))).status, 200);
            assert.equal((await dispatch(readStmt(target))).content, "# Updated");
            assert.equal((await dispatch(copyStmt(target, sessionEntry("", "_plurnk/copied.md")))).status, 201);
            assert.equal((await dispatch(killEntry("", "_plurnk/plurnk/example.md"))).status, 200);
            assert.equal((await dispatch(killEntry("", "_plurnk/copied.md"))).status, 200);
        }
    } finally { await db.close(); }
});

test("{§session-generated-subtree}: shared docs are not forked; every named scratch path is copied", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, crypto.randomUUID());
        const parent = await insertSession(db, workspaceId, null, "alpha");
        const ctx = makeSchemeCtx({ db, workspaceId, sessionId: parent });
        const scheme = new Session();
        const workspaceScheme = new Workspace();
        assert.equal((await workspaceScheme.edit(editStmt(sessionEntry("", "_plurnk/example.md"), "# Shared"), ctx)).status, 201);
        assert.equal((await scheme.edit(editStmt(sessionEntry("alpha", "_plurnk/note.md"), "ordinary scratch"), ctx)).status, 201);
        const forkId = await Fork.fork(db, parent, "alpha-fork");
        const forkCtx = makeSchemeCtx({ db, workspaceId, sessionId: forkId });
        assert.deepEqual(resourcePaths(await scheme.find(findEntry("alpha-fork", "**"), forkCtx)), ["session://alpha-fork/_plurnk/note.md"]);
        assert.equal((await readThroughScheme("workspace", null, readEntry("", "_plurnk/example.md"), forkCtx)).content, "# Shared");
    } finally { await db.close(); }
});
