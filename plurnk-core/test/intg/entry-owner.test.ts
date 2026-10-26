// {§entry-owner} {§execution-output-identity}
import test from "node:test";
import assert from "node:assert/strict";
import type { ExecStatement, ReadStatement, RuntimeTag } from "@plurnk/plurnk-contracts";
import Engine from "../../src/core/Engine.ts";
import SchemeRegistry from "../../src/core/SchemeRegistry.ts";
import type Exec from "../../src/schemes/Exec.ts";
import { Results, type EntryReadResult } from "@plurnk/plurnk-schemes";
import Envelope from "../../src/server/envelope.ts";
import ExecutionOutputs from "../../src/core/ExecutionOutputs.ts";
import SessionName, { SessionNameError } from "../../src/core/SessionName.ts";
import { executionAddress, testExecutors } from "./_execs.ts";
import { openMigrated, insertWorkspace, insertSession, insertLoop, insertTurn } from "./_db.ts";
import { clientRead } from "./_client-read.ts";

const execStmt = (runtime: string, body: string): ExecStatement => ({
    metadata: null,
    runtime: (runtime ?? "sh") as RuntimeTag, aside: null, target: null,
    lineMarker: null, body, position: { line: 1, column: 1 },
});

const streamRead = (scheme: string, hostname: string | null, pathname: string): ReadStatement => ({
    metadata: null,
    op: "READ", aside: null,
    target: { kind: "url", raw: `${scheme}://${hostname ?? ""}${pathname}`, scheme, username: null, password: null, hostname, port: null, pathname, query: null, fragment: null },
    lineMarker: null, matcher: null, body: null, position: { line: 1, column: 1 },
});

test("{§exec} fan-out: equal causal coordinates create distinct outputs shared by the workspace", async () => {
    const prior = process.env.PLURNK_SERVICE_EFFECT_HOST;
    process.env.PLURNK_SERVICE_EFFECT_HOST = "auto";
    const db = await openMigrated();
    try {
        const schemes = new SchemeRegistry();
        const engine = new Engine({ db, schemes });
        const executors = await testExecutors();
        engine.setExecutors(executors);
        schemes.registerRuntimeSchemes(executors); // {§exec} — per-tag faces let READ js:// resolve
        const exec = schemes.get("exec") as Exec;
        assert.ok(schemes.get("js"));
        const ws = await insertWorkspace(db, `owner-fanout-${crypto.randomUUID()}`);

        const parent = await insertSession(db, ws, null, "parent");
        const host = await insertSession(db, ws, parent, "extract-host");
        const hLoop = await insertLoop(db, host, 1, "host");
        const hTurn = await insertTurn(db, hLoop, 1, 102);
        const pool = await insertSession(db, ws, parent, "extract-pool");
        const pLoop = await insertLoop(db, pool, 1, "pool");
        const pTurn = await insertTurn(db, pLoop, 1, 102);

        await engine.dispatch({ statement: execStmt("js", 'console.log("db.internal")'), workspaceId: ws, sessionId: host, loopId: hLoop, turnId: hTurn, sequence: 1, origin: "model" });
        await engine.dispatch({ statement: execStmt("js", "console.log(5)"), workspaceId: ws, sessionId: pool, loopId: pLoop, turnId: pTurn, sequence: 1, origin: "model" });
        await exec.idle();

        const hostPath = new URL(await executionAddress(db, hTurn)).pathname;
        const poolPath = new URL(await executionAddress(db, pTurn)).pathname;
        assert.notEqual(hostPath, poolPath, "independent executions never alias because their causal coordinates match");
        const read = async (sessionId: number, statement: ReadStatement): Promise<EntryReadResult> => {
            const result = await clientRead(engine, db, { statement, workspaceId: ws, sessionId });
            Results.assertReadResult(result);
            return result as EntryReadResult;
        };
        for (const sessionId of [host, pool, parent]) {
            const hostRead = await read(sessionId, streamRead("js", null, hostPath));
            const poolRead = await read(sessionId, streamRead("js", null, poolPath));
            assert.equal(hostRead.status, 200);
            assert.match(hostRead.content ?? "", /db\.internal/);
            assert.equal(poolRead.status, 200);
            assert.match(poolRead.content ?? "", /^5$/m);
        }
        await db.test_delete_session.run({ id: host });
        assert.match((await read(parent, streamRead("js", null, hostPath))).content ?? "", /db\.internal/,
            "deleting the producer leaves its workspace output readable");
        const foreignWorkspace = await insertWorkspace(db, "foreign-output");
        const foreignSession = await insertSession(db, foreignWorkspace);
        const foreign = await clientRead(engine, db, { statement: streamRead("js", null, hostPath),
            workspaceId: foreignWorkspace, sessionId: foreignSession });
        assert.equal(foreign.status, 404, "the same address does not cross workspace boundaries");
    } finally {
        if (prior === undefined) delete process.env.PLURNK_SERVICE_EFFECT_HOST;
        else process.env.PLURNK_SERVICE_EFFECT_HOST = prior;
        await db.close();
    }
});

test("{§execution-output-identity}: simultaneous claims retry collisions instead of reusing an output", async (t) => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, "output-collisions");
        const names = ["a1234567", "a1234567", "b2345678"];
        t.mock.method(ExecutionOutputs, "short", () => {
            const name = names.shift();
            assert.ok(name);
            return name;
        });
        const paths = await Promise.all([
            ExecutionOutputs.claim(db, workspaceId, "sh"),
            ExecutionOutputs.claim(db, workspaceId, "sh"),
        ]);
        assert.deepEqual(paths.toSorted(), ["/a1234567", "/b2345678"]);
    } finally { await db.close(); }
});

test("{§entry-owner} shared entries require only a workspace, not a synthetic Session", async () => {
    const db = await openMigrated();
    try {
        const ws = await insertWorkspace(db, `owner-commons-${crypto.randomUUID()}`);
        const row = await db.envelope_get_session_by_name.get<{ id: number }>({ workspace_id: ws, name: "commons" });
        assert.equal(row, undefined, "no synthetic commons Session is created");

        // The identity index holds ON the commons: a second insert at the same key conflicts —
        // the exact fragmentation a NULL owner would have allowed (NULLs are distinct under UNIQUE).
        await db.test_seed_entry_workspace.get({ workspace_id: ws, scheme: "js", authority: "", pathname: "/1/1/1/js" });
        await assert.rejects(
            db.test_seed_entry_workspace.get({ workspace_id: ws, scheme: "js", authority: "", pathname: "/1/1/1/js" }),
            /UNIQUE/,
            "the same (workspace, owner, scheme, authority, pathname) key conflicts — no silent duplicate",
        );
    } finally { await db.close(); }
});

test("{§session-auto-name}: unnamed model sessions retry occupied names; explicit names retain their validation", async (t) => {
    const db = await openMigrated();
    try {
        const ws = await insertWorkspace(db, `owner-name-${crypto.randomUUID()}`);
        const names = ["ab3d5678", "ab3d5678", "bc4e6789", "cd5f7890", "de6a8901"];
        t.mock.method(SessionName, "short", () => {
            const name = names.shift();
            assert.ok(name !== undefined);
            return name;
        });
        const first = await Envelope.createModelSession(db, ws);
        assert.equal(first.name, "ab3d5678");
        const second = await Envelope.createModelSession(db, ws);
        assert.equal(second.name, "bc4e6789", "a generated name never reuses another session's identity");
        await Envelope.createModelSession(db, ws, "cd5f7890");
        const afterOccupiedLiteral = await Envelope.createModelSession(db, ws);
        assert.equal(afterOccupiedLiteral.name, "de6a8901", "explicit and generated names share the same namespace");

        assert.equal((await Envelope.createModelSession(db, ws, "commons")).name, "commons");
        await assert.rejects(Envelope.createModelSession(db, ws, "_plurnk"), SessionNameError, "the runtime actor's name is not mintable");
        assert.equal((await Envelope.createModelSession(db, ws, "plurnk")).name, "plurnk", "plurnk is an ordinary literal session name");
        await assert.rejects(Envelope.createModelSession(db, ws, "~"), SessionNameError, "tilde is not a session name");
        assert.equal((await Envelope.createModelSession(db, ws, "self")).name, "self", "self is an ordinary literal session name");
    } finally { await db.close(); }
});
