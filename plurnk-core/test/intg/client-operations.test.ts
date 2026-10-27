import assert from "node:assert/strict";
import test, { type TestContext, describe } from "node:test";
import Daemon from "../../src/server/Daemon.ts";
import SchemeRegistry from "../../src/core/SchemeRegistry.ts";
import LoopLifecycle from "../../src/core/LoopLifecycle.ts";
import DbEntryCaps from "../../src/core/caps/DbEntryCaps.ts";
import DbNotifyCaps from "../../src/core/caps/DbNotifyCaps.ts";
import Engine from "../../src/core/Engine.ts";
import ExecutorRegistry from "../../src/core/ExecutorRegistry.ts";
import CapabilityResolver from "../../src/core/CapabilityResolver.ts";
import FunctionalityManager, { plurnkRuntimeDecl } from "../../src/server/FunctionalityManager.ts";
import type Functionality from "../../src/server/Functionality.ts";
import LoopDocs from "../../src/server/loopDocs.ts";
import { PlurnkParser } from "@plurnk/plurnk-parser";
import { Mock } from "@plurnk/plurnk-providers";
import { type FindStatement, type PlurnkStatement, type FunctionalityListResult, type CapabilityPolicy, type ExecStatement, type RollbackReport } from "@plurnk/plurnk-contracts";
import { type ExecArgs, type RuntimeRegistration } from "@plurnk/plurnk-execs";
import { type SchemeCtx, type SchemeHandler, type SchemeManifest, type SchemeResult } from "@plurnk/plurnk-schemes";
import { OperationFailureError } from "../../src/core/results.ts";
import { type Db } from "../../src/core/Db.ts";
import { openMigrated, insertWorkspace, insertSession, insertLoop, insertTurn, rootWorkspace } from "./_db.ts";
import { serverProposals, TEST_OWNER, ownSession } from "./_approval.ts";
import { fixtureExecutors, makeMockResponse } from "./_mock.ts";
import { viableWindow } from "./_provider.ts";
import { waitFor, waitForDb, connect, rpcCall, withDaemon } from "./_rpc.ts";
import { modelOperation, namedModelSession } from "./_sessions.ts";
import { editStmt, readStmt, urlPath, localPath } from "./_dsl.ts";
import { type StreamEventPayload } from "../../src/core/ChannelWrite.ts";
import { makeSchemeCtx, schemeManifest, DEFAULT_MIMETYPES } from "./_scheme.ts";
import { mkdtemp, rm, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Module as McpModule } from "@plurnk/plurnk-mcp";
import { actionResult, type Event, packet, PacketCapturingMock, post, runInput, sessionUpdates, terminalMeta } from "./_acp-run.ts";
import { bindListener } from "./_http.ts";
import { McpServer, createMcpHandler } from "@modelcontextprotocol/server";
import { serveMcpHttp } from "../../../plurnk-mcp/test/http-fixture.ts";
import { httpEntry, mcpFixture, stdioEntry } from "./_mcp-config.ts";
import { resourcePath } from "../../../plurnk-mcp/src/McpResources.ts";
import { readFileSync } from "node:fs";
import { parseEnv, promisify } from "node:util";
import { execFile } from "node:child_process";
import { hermeticGitEnv } from "../../src/core/git-env.ts";

describe("client-operations", () => {
const CANCELLED = "https://problems.plurnk.xyz/daemon/client/operation-cancelled";

const parseOne = (source: string): PlurnkStatement => {
    const parsed = PlurnkParser.parseStatements(source, { executors: fixtureExecutors(source) });
    const item = parsed.items[0];
    if (item?.kind !== "statement") throw new Error(`no statement parsed from ${source}`);
    return item.statement;
};

// A command that runs until it is cancelled, recorded by its body.
const heldRuntime = (effect: "read" | "host") => {
    const runs = new Map<string, { readonly started: PromiseWithResolvers<void>; readonly ended: PromiseWithResolvers<void>; done: boolean }>();
    const run = (body: string) => {
        let entry = runs.get(body);
        if (entry === undefined) {
            entry = { started: Promise.withResolvers<void>(), ended: Promise.withResolvers<void>(), done: false };
            runs.set(body, entry);
        }
        return entry;
    };
    const registration: RuntimeRegistration = {
        namespaceOwner: "client operation fixture",
        decl: {
            name: "held", glyph: "⏳", summary: "Runs until it is cancelled.",
            invocation: { body: { role: "command", required: true }, example: { body: "wait" } },
        },
        executor: {
            runtime: "held", glyph: "⏳",
            get manifest() {
                return { name: "held", channels: { stdout: "text/plain" }, defaultChannel: "stdout", category: "data", writableBy: [], volatile: true, modelVisible: true } as never;
            },
            get defaultChannel() { return "stdout"; },
            get channels() { return { stdout: { mimetype: "text/plain" } }; },
            effect: () => effect,
            probe: async () => ({ available: true, detail: "fixture" }),
            // Accepts the service's lifetime option ({§exec-lifetime}).
            prepare: async () => ({ status: 200, cwd: null }),
            run: async (args: ExecArgs) => {
                const entry = run(args.body);
                entry.started.resolve();
                await new Promise<void>((resolve) => {
                    if (args.signal.aborted) { resolve(); return; }
                    args.signal.addEventListener("abort", () => resolve(), { once: true });
                });
                entry.done = true;
                entry.ended.resolve();
                return { status: 200 };
            },
        },
        availability: { available: true, detail: "fixture" },
    };
    return { registration, run };
};

// A FIND that answers only once its operation is cancelled: an operation still dispatching.
class Waiting implements SchemeHandler {
    static manifest: SchemeManifest = {
        name: "waiting", authority: "resource",
        channels: { body: "text/plain" }, defaultChannel: "body",
        category: "data", writableBy: [], volatile: true, modelVisible: true,
    };

    readonly entered = Promise.withResolvers<void>();

    async prepareFind(_statement: FindStatement, ctx: SchemeCtx): Promise<SchemeResult> {
        this.entered.resolve();
        const signal = ctx.signal;
        if (signal === undefined) throw new Error("a client operation's dispatch carries its loop's signal");
        await new Promise<void>((resolve) => {
            if (signal.aborted) { resolve(); return; }
            signal.addEventListener("abort", () => resolve(), { once: true });
        });
        return { status: 200 };
    }
}

const loopOf = async (daemon: Daemon, workspaceId: number, sessionId: number, loopId: number) =>
    (await daemon.listSessionLoops({ workspaceId, sessionId })).find(({ id }) => id === loopId);

const boot = async (t: TestContext, options: { schemes?: SchemeRegistry; provider?: Mock } = {}): Promise<{ db: Db; daemon: Daemon }> => {
    const db = await openMigrated();
    const daemon = new Daemon({ db, provider: options.provider ?? null, ...(options.schemes === undefined ? {} : { schemes: options.schemes }) });
    t.after(async () => { await daemon.stop(); await db.close(); });
    await daemon.start();
    return { db, daemon };
};

test("{§methods} {§connection-lifecycle} cancelLoop ends one client operation: an in-flight dispatch settles 499; a returned operation's running command is reaped while its loop keeps 200; nothing else runs down", async (t) => {
    const schemes = new SchemeRegistry();
    const waiting = new Waiting();
    schemes.register("waiting", waiting);
    const { db, daemon } = await boot(t, { schemes });
    const held = heldRuntime("read");
    await daemon.registerRuntime(held.registration);
    const { workspaceId } = await daemon.createWorkspace({ name: `cancel-loop-${crypto.randomUUID()}` });
    const other = await daemon.createWorkspace({ name: `cancel-loop-other-${crypto.randomUUID()}` });
    const concluded: Array<{ subscriptionId: number; result: { status: number } }> = [];
    daemon.subscribeToEvents((_workspaceId, method, params) => {
        if (method === "stream/concluded") concluded.push(params as { subscriptionId: number; result: { status: number } });
    });
    const operate = (statements: PlurnkStatement[]) => {
        const loop = Promise.withResolvers<{ sessionId: number; loopId: number }>();
        const done = daemon.dispatchClientAction({ workspaceId, actor: TEST_OWNER, statements, onLoop: loop.resolve });
        return { loop: loop.promise, done };
    };

    // An operation still dispatching: its loop settles cancelled, and its later statements never run.
    const inFlight = operate([parseOne("````FIND (waiting:///*)````"), parseOne("````EDIT (workspace:///never.md)\nnever\n````")]);
    const { sessionId: runtime, loopId: inFlightLoop } = await inFlight.loop;
    await waiting.entered.promise;
    assert.equal(await daemon.cancelLoop({ workspaceId: other.workspaceId, loopId: inFlightLoop }), false,
        "a cancel naming another workspace reaches nothing");
    assert.equal(await daemon.cancelLoop({ workspaceId, loopId: inFlightLoop, reason: "the person cancelled" }), true);
    await assert.rejects(inFlight.done, (error: unknown) => {
        assert.ok(error instanceof OperationFailureError, String(error));
        assert.equal(error.result.status, 499);
        assert.equal(error.result.problem.type, CANCELLED);
        return true;
    });
    const cancelled = await loopOf(daemon, workspaceId, runtime, inFlightLoop);
    assert.equal(cancelled?.status, 499, "the operation's loop settles cancelled");
    assert.equal(cancelled?.terminalResult?.problem?.type, CANCELLED);
    assert.equal(await db.test_get_entry_by_pathname_scheme.get({ pathname: "/never.md", scheme: "workspace" }), undefined,
        "a cancelled operation's later statements never run");
    assert.equal(await daemon.cancelLoop({ workspaceId, loopId: inFlightLoop }), false, "a settled operation has nothing left to cancel");

    // Two operations whose dispatch returned while their commands run on, and one detached spawn.
    const first = operate([parseOne("````held\nfirst\n````")]);
    const second = operate([parseOne("````held\nsecond\n````")]);
    const detached = operate([parseOne("````held [{\"lifetime\":\"detached\"}]\ndetached\n````")]);
    for (const operation of [first, second, detached]) {
        const [started] = await operation.done;
        assert.equal(started?.status, 200, `the dispatch returns once the command starts: ${JSON.stringify(started)}`);
    }
    await Promise.all(["first", "second", "detached"].map((body) => held.run(body).started.promise));
    const firstLoop = (await first.loop).loopId;
    const secondLoop = (await second.loop).loopId;
    for (const loopId of [firstLoop, secondLoop]) {
        assert.equal((await loopOf(daemon, workspaceId, runtime, loopId))?.status, 200, "a returned operation's loop closed 200");
    }

    assert.equal(await daemon.cancelLoop({ workspaceId, loopId: firstLoop }), true, "a returned operation's running command is still its own to cancel");
    await held.run("first").ended.promise;
    const [reaped] = await waitFor(() => concluded, (items) => items.length > 0);
    assert.equal(reaped?.result.status, 499, "the reaped command's stream concludes 499");
    assert.equal((await loopOf(daemon, workspaceId, runtime, firstLoop))?.status, 200, "the operation's loop keeps its 200");
    assert.equal(held.run("second").done, false, "a concurrent operation's command in the same workspace runs on");
    assert.equal(await daemon.cancelLoop({ workspaceId, loopId: (await detached.loop).loopId }), false, "a detached spawn is never reaped");
    assert.equal(held.run("detached").done, false);

    assert.equal(await daemon.cancelLoop({ workspaceId, loopId: secondLoop }), true);
    await held.run("second").ended.promise;
    assert.equal(held.run("detached").done, false, "only shutdown, KILL, or the session's total reap ends a detached spawn");
});

test("{§methods} cancelLoop reaps nothing of a model session's loop", async (t) => {
    serverProposals(t, "accept");
    const provider = new Mock({ contextWindow: viableWindow(), responses: [
        makeMockResponse("````held\nmodel command\n````\n````WAIT\nAwait the command.\n````"),
        makeMockResponse("````SEND [200]\nThe command ended.\n````"),
    ] });
    const { db, daemon } = await boot(t, { provider });
    const held = heldRuntime("read");
    await daemon.registerRuntime(held.registration);
    const { workspaceId } = await daemon.createWorkspace({ name: `cancel-loop-model-${crypto.randomUUID()}` });
    const sessionId = await namedModelSession(daemon, workspaceId, "main");
    const { loopId } = await daemon.runLoop({ workspaceId, sessionId, prompt: "Run the command." });
    await held.run("model command").started.promise;
    await waitForDb(() => new LoopLifecycle(db).status(loopId), (status) => status === 202);
    assert.equal(await daemon.cancelLoop({ workspaceId, loopId }), false, "a model session's loop is no client operation");
    assert.equal(held.run("model command").done, false, "the model's command runs on");
    await daemon.cancelSession({ workspaceId, sessionId });
});

test("{§connection-lifecycle} a client operation's log:/// addresses read the session the person acts for and never curate it; acting for none, they address no log", async (t) => {
    serverProposals(t, "accept");
    const provider = new Mock({ contextWindow: viableWindow(), responses: [
        makeMockResponse("````EDIT (workspace:///notes.md)\nremember this\n````\n````NOTE\nContinue.\n````"),
        makeMockResponse("````SEND [200]\ndone\n````"),
    ] });
    const { db, daemon } = await boot(t, { provider });
    const { workspaceId } = await daemon.createWorkspace({ name: `client-log-${crypto.randomUUID()}` });
    const sessionId = await namedModelSession(daemon, workspaceId, "main");
    const { loopId } = await daemon.runLoop({ workspaceId, sessionId, prompt: "Take a note." });
    await waitForDb(async () => (await loopOf(daemon, workspaceId, sessionId, loopId))?.status, (status) => status === 200);
    const modelRows = await daemon.readLog({ workspaceId, sessionId });
    const edit = modelRows.find(({ op }) => op === "EDIT");
    assert.ok(edit, "the model's log holds its EDIT");
    const coordinate = `log:///${edit.loop_seq}/${edit.turn_seq}/${edit.sequence}`;
    const person = async (source: string, contextSessionId?: number) => (await daemon.dispatchClientAction({
        workspaceId, actor: TEST_OWNER, ...(contextSessionId === undefined ? {} : { contextSessionId }), statements: [parseOne(source)],
    }))[0];
    const problemType = (result: Readonly<Record<string, unknown>>): string | undefined => (result.problem as { type?: string } | undefined)?.type;

    await t.test("{§connection-lifecycle} acting for the model session, a READ answers from its log as the model reads it", async () => {
        const read = await person(`\`\`\`\`READ (${coordinate}) <1,-1>\`\`\`\``, sessionId);
        assert.equal(read.status, 200, JSON.stringify({ status: read.status, problem: problemType(read) }));
        const own = await modelOperation(daemon, db, { workspaceId, sessionId, statement: parseOne(`\`\`\`\`READ (${coordinate}) <1,-1>\`\`\`\``) });
        assert.equal(own.status, 200);
        assert.equal(read.content, own.content);
    });
    await t.test("{§connection-lifecycle} acting for the model session, a FIND answers from its log", async () => {
        const found = await person("````FIND (log:///**)````", sessionId);
        assert.equal(found.status, 200, JSON.stringify({ status: found.status, problem: problemType(found) }));
        const paths = (found.results as Array<Array<{ path: string }>>).flat().map(({ path }) => path);
        const own = new Set((await daemon.readLog({ workspaceId, sessionId }))
            .map(({ loop_seq, turn_seq, sequence, op }) => `log:///${loop_seq}/${turn_seq}/${sequence}/${op}`));
        assert.ok(paths.includes(`${coordinate}/EDIT`), `the model's EDIT is found; first found: ${JSON.stringify(paths.slice(0, 3))}`);
        assert.deepEqual(paths.filter((path) => !own.has(path)), [], "every row found is the model's");
    });
    for (const [verb, source] of [
        ["KILL", `\`\`\`\`KILL (${coordinate})\`\`\`\``],
        ["MOVE", `\`\`\`\`MOVE (${coordinate}) (workspace:///moved.md)\`\`\`\``],
    ] as const) {
        await t.test(`{§connection-lifecycle} acting for the model session, a ${verb} that would curate its log is refused as a client write`, async () => {
            const refused = await person(source, sessionId);
            assert.equal(refused.status, 403, JSON.stringify({ status: refused.status, problem: problemType(refused) }));
            assert.equal(problemType(refused), "https://problems.plurnk.xyz/engine/dispatcher/writer-forbidden");
            assert.ok((await daemon.readLog({ workspaceId, sessionId })).some(({ id }) => id === edit.id), "the model's row stands");
        });
    }
    for (const [verb, source] of [
        ["READ", `\`\`\`\`READ (${coordinate})\`\`\`\``],
        ["FIND", "````FIND (log:///**)````"],
    ] as const) {
        await t.test(`{§connection-lifecycle} acting for no session, a ${verb} of log:/// addresses no log`, async () => {
            const unaddressed = await person(source);
            assert.equal(unaddressed.status, 404, JSON.stringify({ status: unaddressed.status, problem: problemType(unaddressed) }));
            assert.equal(problemType(unaddressed), "https://problems.plurnk.xyz/scheme/log/log-unaddressed");
        });
    }
});

for (const policy of ["review", "accept", "reject"] as const) {
    test(`{§proposal-disposition} {§connection-lifecycle} under server ${policy}, a person's host execution ${policy === "reject" ? "is vetoed" : "runs at once"}: nobody reviews it`, async (t) => {
        serverProposals(t, policy);
        const { db, daemon } = await boot(t);
        const held = heldRuntime("host");
        await daemon.registerRuntime(held.registration);
        const { workspaceId } = await daemon.createWorkspace({ name: `client-disposition-${policy}-${crypto.randomUUID()}` });
        const dispositions: unknown[] = [];
        daemon.subscribeToEvents((_workspaceId, method, params) => {
            if (method === "loop/proposal") dispositions.push((params as { disposition: unknown }).disposition);
        });
        const loop = Promise.withResolvers<{ loopId: number }>();
        const [result] = await daemon.dispatchClientAction({
            workspaceId, actor: TEST_OWNER, statements: [parseOne("````held\nhost command\n````")], onLoop: loop.resolve,
        });
        const runtime = await daemon.ensureRuntimeSession(workspaceId);
        const row = await db.test_get_log_rx_by_session_op.get<{ rx: string }>({ session_id: runtime, op: "held" });
        assert.ok(row);
        assert.deepEqual(await daemon.pendingProposals(workspaceId), [], "nothing awaits a reviewer");
        if (policy === "reject") {
            assert.equal(result.status, 400);
            assert.equal(JSON.parse(row.rx).outcome, "policy_veto");
            assert.deepEqual(dispositions, [{ decision: "reject", outcome: "policy_veto" }]);
            assert.equal(held.run("host command").done, false);
            await assert.rejects(Promise.race([
                held.run("host command").started.promise,
                new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error("never started")), 200).unref()),
            ]), /never started/u, "a vetoed command never runs");
            return;
        }
        assert.equal(result.status, 200, JSON.stringify(result));
        await held.run("host command").started.promise;
        if (policy === "review") {
            assert.equal(JSON.parse(row.rx).outcome, "client_operation", "a person's operation settles as that person's decision");
            assert.deepEqual(dispositions, [{ decision: "accept", outcome: "client_operation" }]);
        } else {
            assert.deepEqual(dispositions, [{ decision: "accept" }]);
        }
        assert.equal(await daemon.cancelLoop({ workspaceId, loopId: (await loop.promise).loopId }), true);
        await held.run("host command").ended.promise;
    });
}

test("{§session-causal-admission} shutdown cancels a person's operation still dispatching and reaps a command still running after its operation returned", async (t) => {
    const priorTimeout = process.env.PLURNK_SERVICE_STOP_TIMEOUT_MS;
    process.env.PLURNK_SERVICE_STOP_TIMEOUT_MS = "3000";
    t.after(() => {
        if (priorTimeout === undefined) delete process.env.PLURNK_SERVICE_STOP_TIMEOUT_MS;
        else process.env.PLURNK_SERVICE_STOP_TIMEOUT_MS = priorTimeout;
    });
    const schemes = new SchemeRegistry();
    const waiting = new Waiting();
    schemes.register("waiting", waiting);
    const db = await openMigrated();
    t.after(() => db.close());
    const daemon = new Daemon({ db, provider: null, schemes });
    await daemon.start();
    const held = heldRuntime("read");
    await daemon.registerRuntime(held.registration);
    const { workspaceId } = await daemon.createWorkspace({ name: `client-shutdown-${crypto.randomUUID()}` });
    const [started] = await daemon.dispatchClientAction({ workspaceId, actor: TEST_OWNER, statements: [parseOne("````held\nlong command\n````")] });
    assert.equal(started.status, 200);
    await held.run("long command").started.promise;
    const loop = Promise.withResolvers<{ loopId: number }>();
    const dispatching = daemon.dispatchClientAction({
        workspaceId, actor: TEST_OWNER, statements: [parseOne("````FIND (waiting:///*)````")], onLoop: loop.resolve,
    });
    await waiting.entered.promise;
    const cancelled = assert.rejects(dispatching, (error: unknown) => {
        assert.ok(error instanceof OperationFailureError, String(error));
        assert.equal(error.result.problem.type, CANCELLED);
        return true;
    });
    await daemon.stop();
    assert.equal(held.run("long command").done, true, "shutdown ended the command");
    await cancelled;
    assert.equal(await new LoopLifecycle(db).status((await loop.promise).loopId), 499, "the operation still dispatching settles cancelled");
});

test("{§connection-lifecycle} {§machine-processes} a person's operation speaks and delegates as that person: messages arrive from them, WORK starts a root session they own, FORK branches the session they act for", async (t) => {
    serverProposals(t, "accept");
    const provider = new Mock({ contextWindow: viableWindow(), responses: Array.from({ length: 8 }, () => makeMockResponse("````SEND [200]\nnoted\n````")) });
    const { daemon } = await boot(t, { provider });
    const { workspaceId } = await daemon.createWorkspace({ name: `client-delegation-${crypto.randomUUID()}` });
    const main = await namedModelSession(daemon, workspaceId, "main");
    const person = async (source: string, contextSessionId?: number) => (await daemon.dispatchClientAction({
        workspaceId, actor: TEST_OWNER, ...(contextSessionId === undefined ? {} : { contextSessionId }), statements: [parseOne(source)],
    }))[0];
    const firstLoop = (sessionId: number) => waitForDb(async () => (await daemon.listSessionLoops({ workspaceId, sessionId }))[0], (loop) => loop?.status === 200);
    const session = async (name: string) => (await daemon.listSessions(workspaceId)).find((row) => row.name === name);

    const sent = await person("````SEND (session://main)\nA note from a person.\n````", main);
    assert.equal(sent.status, 200, JSON.stringify(sent));
    assert.equal((await firstLoop(main))?.promptSource, TEST_OWNER, "a person's message arrives from that person, as a thread message does");
    const runtime = await daemon.ensureRuntimeSession(workspaceId);
    assert.deepEqual((await daemon.readLog({ workspaceId, sessionId: runtime })).filter(({ source }) => source !== null), [],
        "the model's reply never lands in the runtime session's journal");

    const started = await person("````WORK (session://helper)\nStart.\n````", main);
    assert.equal(started.status, 200, JSON.stringify(started));
    const helper = await session("helper");
    assert.deepEqual({ origin: helper?.origin, parent: helper?.parentSessionId, owner: helper?.owner }, { origin: "model", parent: null, owner: TEST_OWNER },
        "a person's WORK starts a root model session that person owns");
    assert.equal((await firstLoop(helper!.id))?.promptSource, TEST_OWNER, "its first prompt arrives from the person");
    const unnamed = await person("````WORK\nStart too.\n````");
    assert.equal(unnamed.status, 200, JSON.stringify(unnamed));
    assert.equal((await session(String(unnamed.body)))?.parentSessionId, null, "an unnamed WORK starts a root session too");

    const branched = await person("````FORK (session://branch)\nTry the other way.\n````", main);
    assert.equal(branched.status, 200, JSON.stringify(branched));
    const branch = await session("branch");
    assert.deepEqual({ parent: branch?.parentSessionId, kind: branch?.kind }, { parent: main, kind: "fork" }, "FORK branches the session the person acts for");
    assert.ok((await daemon.listSessionLoops({ workspaceId, sessionId: branch!.id })).some(({ promptSource }) => promptSource === TEST_OWNER),
        "the branch's task arrives from the person");
    const unaddressed = await person("````FORK (session://nowhere)\nContinue.\n````");
    assert.equal(unaddressed.status, 404, JSON.stringify(unaddressed));
    assert.equal((unaddressed.problem as { type?: string }).type, "https://problems.plurnk.xyz/engine/dispatcher/fork-unaddressed");
    assert.equal(await session("nowhere"), undefined, "acting for no session, FORK branches nothing");

    const delivered = await person("````WORK (session://main)\nAnother note.\n````", main);
    assert.equal((delivered.attrs as { delivered?: string } | undefined)?.delivered, "message", "WORK to a session that exists is its message");
    await assert.rejects(daemon.forkSession({ workspaceId, sessionId: runtime }), (error: unknown) => {
        assert.ok(error instanceof OperationFailureError, String(error));
        assert.equal(error.result.problem.type, "https://problems.plurnk.xyz/daemon/session/model-session-required");
        return true;
    });
    assert.equal((await daemon.listSessions(workspaceId)).filter(({ origin }) => origin === "_plurnk").length, 1, "the workspace keeps one runtime session");
});

test("{§connection-lifecycle} {§env-functionality} a person's env:/// is the workspace's: a model's commands receive it, and the runtime session keeps no layer", async (t) => {
    const { db, daemon } = await boot(t);
    const { workspaceId } = await daemon.createWorkspace({ name: `client-env-${crypto.randomUUID()}` });
    const sessionId = await namedModelSession(daemon, workspaceId, "main");
    const person = async (source: string) => (await daemon.dispatchClientAction({ workspaceId, actor: TEST_OWNER, statements: [parseOne(source)] }))[0];
    const modelReads = (name: string) => modelOperation(daemon, db, { workspaceId, sessionId, statement: parseOne(`\`\`\`\`READ (env:///${name})\`\`\`\``) });
    const definitions = async () => ((await daemon.invokeModuleAction("workspace.env.list", {}, { scope: "workspace", workspaceId })) as { definitions: Array<{ alias: string; origin: string }> })
        .definitions.filter(({ alias }) => alias === "FRAME_NAME").map(({ origin }) => origin);

    assert.equal((await person("````EDIT (env:///FRAME_NAME)\nworkspace-wide\n````")).status, 200);
    assert.deepEqual(await definitions(), ["workspace"], "the definition is the workspace's own");
    const read = await modelReads("FRAME_NAME");
    assert.equal(read.status, 200, JSON.stringify(read));
    assert.equal(read.content, "workspace-wide", "a model's commands receive what a person set");
    const runtime = await daemon.ensureRuntimeSession(workspaceId);
    const own = (await daemon.invokeModuleAction("session.env.list", {}, { scope: "session", workspaceId, sessionId: runtime })) as { definitions: Array<{ origin: string }> };
    assert.deepEqual(own.definitions.filter(({ origin }) => origin === "session"), [], "the runtime session keeps no layer of its own");

    assert.equal((await person("````KILL (env:///FRAME_NAME)````")).status, 200);
    assert.deepEqual(await definitions(), [], "a person's KILL removes the workspace's own entry");
    assert.equal((await modelReads("FRAME_NAME")).status, 404);
});
});

describe("Daemon.workspace-policy", () => {
test("{§capability-admission}: workspace policy changes apply to independent sessions, descendants, and a person's operations without private bounds", async () => {
    const db = await openMigrated();
    const daemon = new Daemon({ db, provider: null });
    try {
        await daemon.start();
        const workspace = await daemon.createWorkspace({ name: `shared-policy-${crypto.randomUUID()}` });
        const parent = await namedModelSession(daemon, workspace.workspaceId, "main");
        const sibling = await daemon.createSession({ workspaceId: workspace.workspaceId, name: "sibling" });
        const target = urlPath("workspace", "/shared.txt");
        const person = async (workspaceId: number, statement: ReturnType<typeof readStmt> | ReturnType<typeof editStmt>) =>
            (await daemon.dispatchClientAction({ workspaceId, actor: TEST_OWNER, statements: [statement] }))[0];
        const source = await person(workspace.workspaceId, editStmt(target, "shared content"));
        assert.equal(source.status, 201);
        const denied = { deny: [{ access: "observe" as const, scheme: "workspace" }] };
        const projection = await daemon.setWorkspaceCapabilities({ workspaceId: workspace.workspaceId, policy: denied });
        assert.deepEqual(projection, { service: {}, workspace: denied, effective: denied });
        const child = await daemon.forkSession({ workspaceId: workspace.workspaceId, sessionId: parent, name: "child" });
        // Each session's own READ, and a person's.
        const reads = [
            ...[parent, sibling.sessionId, child.sessionId].map((sessionId) => () =>
                modelOperation(daemon, db, { workspaceId: workspace.workspaceId, sessionId, statement: readStmt(target) })),
            () => person(workspace.workspaceId, readStmt(target)),
        ];
        for (const read of reads) {
            const result = await read();
            assert.equal(result.status, 403);
            assert.equal((result.problem as { policyScope: string }).policyScope, "workspace");
        }
        await daemon.setWorkspaceCapabilities({ workspaceId: workspace.workspaceId, policy: {} });
        for (const read of reads) {
            const result = await read();
            assert.equal(result.status, 200, "existing descendants see workspace widening without inherited restrictions");
            assert.match(String(result.content), /shared content/);
        }
        const other = await daemon.createWorkspace({ name: `other-policy-${crypto.randomUUID()}` });
        await daemon.setWorkspaceCapabilities({ workspaceId: workspace.workspaceId, policy: denied });
        assert.deepEqual(await daemon.readWorkspaceCapabilities({ workspaceId: other.workspaceId }), {
            service: {}, workspace: {}, effective: {},
        });
        assert.equal((await person(other.workspaceId, readStmt(target))).status, 404,
            "a workspace policy does not create access to another workspace's resources");
    } finally {
        await daemon.stop();
        await db.close();
    }
});

test("{§capability-admission}: client actions inspect and replace policy without creating a model session", async () => {
    await withDaemon(null, async (_db, daemon, addr) => {
        const ws = await connect(addr);
        try {
            await rpcCall(ws, 1, "workspace.create", { name: `policy-client-${crypto.randomUUID()}` });
            const [workspace] = await daemon.listWorkspaces();
            assert.ok(workspace);
            const before = await daemon.listSessions(workspace.id);
            const empty = { service: {}, workspace: {}, effective: {} };
            const read = await rpcCall(ws, 2, "workspace.capabilities.get", {});
            assert.deepEqual(read.result, empty);
            const policy = { deny: [{ traits: ["interaction"] }] };
            const updated = await rpcCall(ws, 3, "workspace.capabilities.set", { policy });
            assert.deepEqual(updated.result, { service: {}, workspace: policy, effective: policy });
            assert.deepEqual(await daemon.listSessions(workspace.id), before, "policy management allocates no session");
            await assert.rejects(daemon.setWorkspaceCapabilities({ workspaceId: workspace.id, policy: { deny: [{}] } }),
                /settings\.capabilities is not a valid capability policy/);
            assert.deepEqual(await daemon.readWorkspaceCapabilities({ workspaceId: workspace.id }), updated.result,
                "invalid policy cannot replace the current declaration");
            await daemon.setWorkspaceCapabilities({ workspaceId: workspace.id, policy: {} });
            assert.deepEqual(await daemon.readWorkspaceCapabilities({ workspaceId: workspace.id }), empty);
        } finally { ws.close(); }
    });
});

test("{§operator-config-workspace-settings} {§capability-policy-cascade}: service ceilings remain effective and workspace replacement preserves other settings", async () => {
    const db = await openMigrated();
    const daemon = new Daemon({ db, provider: null });
    const previous = process.env.PLURNK_SERVICE_CAPABILITIES;
    try {
        await daemon.start();
        const workspace = await daemon.createWorkspace({ name: `policy-ceiling-${crypto.randomUUID()}`,
            settings: { filesItems: 7, capabilities: { deny: [{ scheme: "https" }] } } });
        const service = { deny: [{ access: "execute" }] };
        process.env.PLURNK_SERVICE_CAPABILITIES = JSON.stringify(service);
        assert.deepEqual(await daemon.setWorkspaceCapabilities({ workspaceId: workspace.workspaceId, policy: {} }), {
            service, workspace: {}, effective: service,
        });
        const row = await db.workspace_get_settings.get<{ settings: string }>({ workspace_id: workspace.workspaceId });
        assert.deepEqual(JSON.parse(row!.settings), { filesItems: 7, capabilities: {} });
    } finally {
        if (previous === undefined) delete process.env.PLURNK_SERVICE_CAPABILITIES;
        else process.env.PLURNK_SERVICE_CAPABILITIES = previous;
        await daemon.stop();
        await db.close();
    }
});

test("{§capability-admission}: existing sessions reconcile their tool catalog after workspace policy changes", async () => {
    const db = await openMigrated();
    const daemon = new Daemon({ db, provider: null });
    try {
        await daemon.start();
        const workspace = await daemon.createWorkspace({ name: `policy-docs-${crypto.randomUUID()}` });
        const model = await namedModelSession(daemon, workspace.workspaceId, "main");
        const sibling = await daemon.createSession({ workspaceId: workspace.workspaceId, name: "sibling" });
        const reference = (sessionId: number, runtime: string) => modelOperation(daemon, db, { workspaceId: workspace.workspaceId, sessionId,
            statement: readStmt({ ...urlPath("workspace", `/_plurnk/plurnk/${runtime}.md`), hostname: null }) });
        for (const sessionId of [model, sibling.sessionId]) assert.equal((await reference(sessionId, "js")).status, 200);
        await daemon.setWorkspaceCapabilities({ workspaceId: workspace.workspaceId, policy: { deny: [{ runtime: "js" }] } });
        for (const sessionId of [model, sibling.sessionId]) {
            assert.equal((await reference(sessionId, "js")).status, 404, "the withdrawn reference cannot leak through a stale catalog");
            assert.equal((await reference(sessionId, "sh")).status, 200, "unrelated admitted tooling stays discoverable");
        }
        await daemon.setWorkspaceCapabilities({ workspaceId: workspace.workspaceId, policy: {} });
        for (const sessionId of [model, sibling.sessionId]) assert.equal((await reference(sessionId, "js")).status, 200);
    } finally {
        await daemon.stop();
        await db.close();
    }
});
});

describe("caps-notify", () => {
const tick = (): Promise<void> => new Promise((r) => setImmediate(r));
// Wall-clock wait for a condition — the emit's entryId lookup goes through the shared
// SqlRite session, which serializes every test's queries under load, so the wait must be
// measured in real time, not in event-loop turns (a turn count exhausts while queued).
const waitUntil = async (cond: () => boolean, timeoutMs = 10000): Promise<void> => {
    const deadline = Date.now() + timeoutMs;
    while (!cond() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 5));
};

test("{§capability-ctx} DbNotifyCaps: streamEvent emits for the resolved entry; absent entry / no notifier → no event", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `caps-notify-${crypto.randomUUID()}`);
        const sessionId = await insertSession(db, workspaceId);
        const captured: Array<{ sid: number; payload: StreamEventPayload }> = [];
        const ctx = makeSchemeCtx({ db, workspaceId, sessionId, streamEventNotify: (sid, payload) => captured.push({ sid, payload }) });
        const entries = new DbEntryCaps(ctx, "workspace", schemeManifest("workspace"), "");
        const notify = new DbNotifyCaps(ctx, "workspace", "");

        await entries.write("/stream.md", { channels: { body: { content: "data", mimetype: "text/markdown" } } });

        // positive — wait (wall-clock) until the best-effort async emit lands
        notify.streamEvent("/stream.md", "body", "active", 42);
        await waitUntil(() => captured.length >= 1);
        assert.equal(captured.length, 1);
        assert.equal(captured[0].sid, workspaceId);
        assert.equal(captured[0].payload.sessionId, sessionId, "notification identifies the producing session");
        assert.equal(captured[0].payload.channel, "body");
        assert.equal(captured[0].payload.state, "active");
        assert.equal(captured[0].payload.contentLength, 42);
        assert.match(captured[0].payload.target, /workspace:\/\/\/.*stream\.md/);

        // a vanished entry resolves to null → never emits (give the resolve room)
        notify.streamEvent("/missing.md", "body", "active", 1);
        for (let i = 0; i < 30; i++) await tick();
        assert.equal(captured.length, 1);

        // no notifier wired → silent sync no-op, never throws, nothing scheduled
        const noNotifier = new DbNotifyCaps(makeSchemeCtx({ db, workspaceId }), "session", "");
        assert.doesNotThrow(() => noNotifier.streamEvent("/stream.md", "body", "active", 1));
        for (let i = 0; i < 5; i++) await tick();
        assert.equal(captured.length, 1);
    } finally { await db.close(); }
});

test("{§notifications} lookup and notifier failures are diagnosed with their cause", async (t) => {
    const diagnostics: unknown[][] = [];
    t.mock.method(console, "error", (...args: unknown[]) => { diagnostics.push(args); });
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `caps-notify-failure-${crypto.randomUUID()}`);
        const notifyCause = new Error("notifier failed");
        const notifyCtx = makeSchemeCtx({
            db,
            workspaceId,
            streamEventNotify: () => { throw notifyCause; },
        });
        const entries = new DbEntryCaps(notifyCtx, "session", schemeManifest("session"), "");
        await entries.write("/stream.md", {
            channels: { body: { content: "data", mimetype: "text/markdown" } },
        });

        new DbNotifyCaps(notifyCtx, "session", "").streamEvent("/stream.md", "body", "active", 4);
        await waitUntil(() => diagnostics.length === 1, 4000);
        assert.equal(diagnostics.length, 1);
        assert.equal(diagnostics[0]?.[1], notifyCause, "the notifier exception remains the diagnostic cause");

        const lookupCause = new Error("lookup failed");
        const failingLookupDb = new Proxy(db, {
            get(target, property) {
                if (property === "crud_find_workspace_entry") {
                    return { get: async () => { throw lookupCause; } };
                }
                return Reflect.get(target, property, target);
            },
        });
        const lookupCtx = makeSchemeCtx({
            db: failingLookupDb,
            workspaceId,
            streamEventNotify: () => { throw new Error("not reached"); },
        });

        new DbNotifyCaps(lookupCtx, "session", "").streamEvent("/stream.md", "body", "active", 4);
        await waitUntil(() => diagnostics.length === 2, 4000);
        assert.equal(diagnostics.length, 2);
        assert.equal(diagnostics[1]?.[1], lookupCause, "the database exception remains the diagnostic cause");
    } finally { await db.close(); }
});
});

describe("mcp-acp-composition", () => {
test("{§functionality-inspection} a stalled MCP catalog is visible over ACP before inference and inspectable on another connection", { timeout: 15_000 }, async (t) => {
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const visible = Promise.withResolvers<void>();
    t.after(() => release.resolve());
    const handler = createMcpHandler(() => {
        const server = new McpServer({ name: "slow-catalog", version: "1.0.0" });
        server.registerTool("inspect", { description: "Inspect fixture state." }, async () => ({ content: [{ type: "text", text: "fixture" }] }));
        return server;
    }, { legacy: "reject", responseMode: "auto", keepAliveMs: 0 });
    const served = await serveMcpHttp(t, handler, async (request) => {
        if ((await request.clone().json()).method !== "tools/list") return null;
        entered.resolve();
        await release.promise;
        return null;
    });
    const provider = new PacketCapturingMock({ responses: [makeMockResponse("```SEND [200]\nOK\n```")], contextWindow: 1_000_000 });
    const { hostPaths, env: mcpEnv } = await mcpFixture(t, { fixture: httpEntry(served.url) });
    const db = await openMigrated();
    const http = await bindListener();
    const daemon = new Daemon({ db, provider, hostPaths, http });
    daemon.registerModule(McpModule.init({ env: { ...mcpEnv,
        PLURNK_MCP_CONNECT_TIMEOUT: "10000", PLURNK_MCP_REQUEST_TIMEOUT: "10000",
        PLURNK_MCP_RETRY_FLOOR_MS: "250", PLURNK_MCP_RETRY_CEILING_MS: "5000",
    } }), "@plurnk/plurnk-mcp");
    t.after(async () => { await daemon.stop(); await http.close(); await db.close(); });
    await daemon.start();
    const { port } = http.httpAddress();
    const workspace = "preparation-visibility";
    await daemon.createWorkspace({ name: workspace });
    const inspect = () => post(port, runInput(workspace, crypto.randomUUID(), {
        action: { kind: "workspace.mcp.list" },
    }));
    const cold = actionResult(await inspect());
    assert.equal(cold.ok, true);
    assert.equal((cold.result!.definitions as { state: string }[])[0].state, "dormant");
    assert.equal(served.requests.length, 0, "inspection never connects to the MCP server");
    const events: Event[] = [];
    const finished = new Promise<void>((resolve, reject) => {
        const ws = new WebSocket(`ws://127.0.0.1:${port}/acp`);
        ws.addEventListener("open", () => {
            ws.send(JSON.stringify({
                jsonrpc: "2.0",
                id: "init",
                method: "initialize",
                params: { protocolVersion: 2, info: { name: "test", version: "1.0.0" }, capabilities: {} },
            }));
        });
        ws.addEventListener("message", (msg) => {
            const event = JSON.parse(String(msg.data)) as Event & {
                id?: string;
                method?: string;
                params?: { update?: { sessionUpdate?: string; state?: string; stopReason?: string } };
            };
            if (event.id === "init") {
                ws.send(JSON.stringify(runInput(workspace, "prompt", { prompt: "Reply OK." })));
                return;
            }
            events.push(event);
            if (event.method === "session/update" && JSON.stringify(event.params).includes('"alias":"fixture"')) {
                visible.resolve();
            }
            if (event.method === "session/update" && event.params?.update?.sessionUpdate === "state_update" && event.params.update.state === "idle") {
                events.push({
                    jsonrpc: "2.0",
                    id: "prompt",
                    result: {
                        stopReason: event.params.update.stopReason ?? "end_turn",
                        _meta: { plurnk: { stopReason: event.params.update.stopReason ?? "end_turn" } },
                    },
                });
                ws.close();
                resolve();
            }
        });
        ws.addEventListener("error", (err) => reject(err));
    });
    await Promise.race([entered.promise, finished.then(() => assert.fail(`The run ended before catalog preparation: ${JSON.stringify(events)}`))]);
    await Promise.race([visible.promise, finished.then(() => assert.fail(`The run ended without preparation visibility: ${JSON.stringify(events)}`))]);
    assert.equal(provider.requests.length, 0, "the client can see startup before the provider is called");
    const during = await inspect();
    assert.equal(actionResult(during).ok, true, "inspection does not join the stalled activation");
    // {§acp-status-descendants} Preparation is the workspace's, so an action that binds no session carries it too.
    const wsUpdate = sessionUpdates(during).find((u) => u.sessionUpdate === "notice" && u.title === "workspace:state") as {
        _meta?: { plurnk?: { workspace?: { preparation: { family: string; alias: string | null }[] } } };
    } | undefined;
    assert.ok(wsUpdate?._meta?.plurnk?.workspace?.preparation.some(({ family, alias }) => family === "mcp" && alias === "fixture"));
    release.resolve();
    await finished;
    assert.equal(provider.requests.length, 1);
    assert.ok(sessionUpdates(events).some((u) => {
        const prep = (u._meta as { plurnk?: { preparation?: unknown[] } } | undefined)?.plurnk?.preparation;
        return u.sessionUpdate === "notice" && u.title === "workspace:preparation" && Array.isArray(prep) && prep.length === 0;
    }));
    assert.equal(terminalMeta(events)?.stopReason, "end_turn");
    assert.doesNotMatch(packet(provider.requests, 0), /workspace\/preparation/);
});

test("{§mcp-configuration} ACP composes configured MCP servers: execution, review, failure, and recovery", { timeout: 30_000 }, async (t) => {
    const previousFilesItems = process.env.PLURNK_SERVICE_FILES_ITEMS;
    process.env.PLURNK_SERVICE_FILES_ITEMS = "-1";
    const provider = new PacketCapturingMock({
        contextWindow: 1_000_000,
        responses: [
            makeMockResponse("\n````READ (workspace:///_plurnk/tools/fixture.md) <1,-1>````\n````NOTE\nSelect and inspect the echo contract linked from the runtime document.\n````"),
            makeMockResponse([
                PlurnkParser.frame("READ (workspace:///_plurnk/tools/fixture/echo.json) <1,-1>", null),
                PlurnkParser.frame('FIND (workspace:///_plurnk/tools/fixture.json) $.tools[?(@.name=="echo")].name <1,-1>', null),
                PlurnkParser.frame('READ (workspace:///_plurnk/tools/fixture.json) $.tools[?(@.name=="echo")] <1,-1>', null),
                PlurnkParser.frame("NOTE", "Invoke the documented observation tool."),
            ].join("\n\n")),
            makeMockResponse("\n````fixture (echo)\nhello from MCP\n````\n\n````NOTE\nInspect the attributable tool failure.\n````"),
            makeMockResponse("\n````KILL (log:///**/READ)````\n````fixture (echo)\n{\"message\":\"hello from MCP\"}\n````\n\n````NOTE\nInspect the corrected tool result.\n````"),
            makeMockResponse("\n````FIND (fixture:///**) <1,-1> invalid-tool-arguments````\n\n````NOTE\nInspect the source's durable terminal result.\n````"),
            makeMockResponse("````SEND [200]\nThe MCP echo returned hello from MCP and its earlier failure remains inspectable at the source.\n````"),
            makeMockResponse("\n````READ (workspace:///_plurnk/tools/fixture.md) <1,-1>````\n````NOTE\nInvoke the documented host tool.\n````"),
            makeMockResponse("\n````fixture (fail)````\n````NOTE\nInspect the failure.\n````"),
            makeMockResponse("````SEND [200]\nThe MCP server reported its expected tool error; recovery is complete.\n````"),
        ],
    });
    const { hostPaths, env: mcpEnv } = await mcpFixture(t, {
        fixture: stdioEntry("echo-server.mjs", {
            PLURNK_MCP_TEST_TITLE: "Transport fixture",
            PLURNK_MCP_TEST_WHERE: "1",
            PLURNK_MCP_TEST_INSTRUCTIONS: "Echo tools for transport testing.\n\n## Usage\nPass the message field unchanged.",
        }),
        legacy: stdioEntry("legacy-server.mjs"),
    });
    const db = await openMigrated();
    const http = await bindListener();
    const daemon = new Daemon({
        db,
        provider,
        nodeModulesPath: join(import.meta.dirname, "../../node_modules"),
        hostPaths,
        http,
    });
    daemon.registerModule(McpModule.init({
        env: {
            ...mcpEnv,
            PLURNK_MCP_CONNECT_TIMEOUT: "30000",
            PLURNK_MCP_REQUEST_TIMEOUT: "30000", PLURNK_MCP_RETRY_FLOOR_MS: "250", PLURNK_MCP_RETRY_CEILING_MS: "5000",
            PLURNK_MCP_fixture_TOOLS: '["echo","fail"]',
        },
    }), "@plurnk/plurnk-mcp");
    const projectRoot = await mkdtemp(join(tmpdir(), "plurnk-mcp-composition-"));

    try {
        await daemon.start();
        const { port } = http.httpAddress();
        const workspace = `mcp-composition-${crypto.randomUUID()}`;

        const listed = actionResult(await post(port, runInput(workspace, "list", {
            projectRoot,
            action: { kind: "workspace.mcp.list" },
        })));
        assert.equal(listed.ok, true, JSON.stringify(listed.problem));
        if (listed.result === undefined) throw new Error("workspace.mcp.list returned no result");
        assert.deepEqual(
            (listed.result.definitions as Array<{ alias: string; origin: string; state: string }>).map(({ alias, origin, state }) => ({ alias, origin, state })),
            [{ alias: "fixture", origin: "service", state: "dormant" }, { alias: "legacy", origin: "service", state: "dormant" }],
            "the installed plugin's servers are available and enabled, dormant until first use",
        );
        // Enabling the installed server activates the workspace, registering its tools before any turn.
        const enabled = actionResult(await post(port, runInput(workspace, "enable", {
            projectRoot,
            action: { kind: "workspace.mcp.enable", alias: "fixture" },
        })));
        assert.equal(enabled.ok, true, JSON.stringify(enabled.problem));
        assert.equal((enabled.result?.definition as { state?: string } | undefined)?.state, "active");
        assert.equal((enabled.result?.definition as { origin?: string } | undefined)?.origin, "service");

        // {§capability-admission} — exact MCP tools occupy the same selector
        // space as every other capability. One workspace restriction removes only
        // the denied tool from both dispatch and the model's generated contract.
        const attenuated = actionResult(await post(port, runInput(workspace, "deny-fail-tool", {
            projectRoot,
            action: {
                kind: "workspace.capabilities.set",
                policy: { deny: [{ runtime: "fixture", tool: "fail" }] },
            },
        })));
        assert.equal(attenuated.ok, true, JSON.stringify(attenuated.problem));
        assert.deepEqual(attenuated.result?.workspace, {
            deny: [{ runtime: "fixture", tool: "fail" }],
        });
        const deniedTool = actionResult(await post(port, runInput(workspace, "invoke-denied-tool", {
            projectRoot,
            action: { kind: "op.parse", text: "````fixture (fail)\n{}\n````" },
        })));
        assert.equal(deniedTool.ok, true, JSON.stringify(deniedTool.problem));
        if (deniedTool.result === undefined) throw new Error("op.parse returned no result");
        const [deniedResult] = deniedTool.result.results as Array<{
            status: number;
            problem?: Readonly<Record<string, unknown>>;
        }>;
        assert.equal(deniedResult?.status, 403);
        assert.equal(deniedResult?.problem?.type, "https://problems.plurnk.xyz/engine/dispatcher/capability-denied");
        assert.equal(deniedResult?.problem?.runtime, "fixture");
        assert.equal(deniedResult?.problem?.tool, "fail");
        assert.equal(deniedResult?.problem?.policyScope, "workspace");

        const observed = await post(port, runInput(workspace, "read-tool", {
            prompt: "Use the attached echo tool, then report its result.",
        }));
        assert.equal(terminalMeta(observed)?.stopReason, "end_turn");
        const workspaceRow = (await daemon.listWorkspaces()).find((row) => row.name === workspace);
        assert.ok(workspaceRow !== undefined);
        const [producer] = await daemon.listSessions(workspaceRow.id, { origin: "model" });
        assert.ok(producer !== undefined);
        const streamEvents = sessionUpdates(observed)
            .filter((u) => u.sessionUpdate === "terminal_update")
            .map((u) => (u._meta as { plurnk?: { sessionId: number; target: string; result?: { status: number } } } | undefined)?.plurnk)
            .filter((m): m is { sessionId: number; target: string; result?: { status: number } } => m !== undefined);
        assert.ok(streamEvents.some((event) => event.result?.status === 200), "the producer's ACP Run receives its actual MCP conclusion");
        assert.ok(streamEvents.some((event) => event.result === undefined), "MCP output streams through ACP before its conclusion");
        assert.ok(streamEvents.every((event) => event.sessionId === producer.id), "stream provenance identifies the producing session, not a storage owner");
        assert.ok(streamEvents.every((event) => !Object.hasOwn(event, "producerSessionId")), "the wire carries one causal actor identity");
        assert.ok(streamEvents.every((event) => /^fixture:\/\/\/[a-f0-9]{8}$/u.test(event.target)));
        const firstPacket = packet(provider.requests, 0);
        assert.ok(firstPacket.includes('```plurnk (mcp) <!-- Manage MCP servers; active servers run as <alias> (<tool>) and publish workspace:///_plurnk/tools/<alias>.md (verb: \\"list\\"|\\"add\\"|\\"replace\\"|\\"enable\\"|\\"disable\\"|\\"remove\\"; alias?: string, definition?: {name: string, type: \\"stdio\\", command: string, args?: string[], env?: object, cwd?: string}|{name: string, type: \\"streamable-http\\", url: string, headers?: object, authorization?: object}) Schema: workspace:///_plurnk/tools/plurnk/mcp.json -->\\n{\\"verb\\": \\"list\\"}\\n```'),
            "the initial survey teaches the manager's lifecycle; with no registry it has no discover");
        assert.match(firstPacket, /Echo tools for transport testing\./);
        assert.doesNotMatch(firstPacket, /Pass the message field unchanged/, "full server instructions are not pushed into turn0");
        assert.match(firstPacket, /"path":"workspace:\/\/\/_plurnk\/tools\/fixture\.md"/);
        assert.match(firstPacket, /```fixture \(echo\)/);
        assert.doesNotMatch(firstPacket, /```fixture \([^)]*fail/);
        assert.doesNotMatch(firstPacket, /"path":"workspace:\/\/\/_plurnk\/tools\/fixture\/echo\.json"/, "without PLURNK_MCP_EXPANDED, turn 0 surveys runtime documents only");
        assert.doesNotMatch(firstPacket, /fixture\.json|inputSchema|readOnlyHint/,
            "the catalog and its full definitions are not injected into turn0");
        const runtimeContract = packet(provider.requests, 1);
        assert.match(runtimeContract, /Pass the message field unchanged\./, "READ of the runtime document retrieves the full authored instructions");
        assert.match(runtimeContract, /```fixture \(echo\) <!-- Echo one message\. Schema: workspace:\/\/\/_plurnk\/tools\/fixture\/echo\.json -->/);
        assert.doesNotMatch(runtimeContract, /```fixture \(fail\)/);
        assert.match(runtimeContract, /workspace:\/\/\/_plurnk\/tools\/fixture\.json/);
        const echoContract = packet(provider.requests, 2);
        assert.match(echoContract, /"title": "fixture: echo"/);
        assert.match(echoContract, /"additionalProperties": false/, "the linked document preserves constraints omitted from the preview");
        assert.match(echoContract, /"required": \[/);
        assert.doesNotMatch(echoContract, /output schema/i);
        assert.match(echoContract, /"name": "echo"/);
        assert.match(echoContract, /"inputSchema": \{/);
        assert.match(echoContract, /"readOnlyHint": true/,
            "an ordinary JSONPath READ materializes the selected complete tool record in the log");
        assert.doesNotMatch(echoContract, /pattern-(?:invalid|unsupported)|entry-not-found/);
        const toolsCatalog = async () => {
            const parsed = PlurnkParser.parseStatements(PlurnkParser.frame("READ (workspace:///_plurnk/tools/fixture.json) <1,-1>", null));
            const item = parsed.items[0];
            assert.equal(item?.kind, "statement");
            if (item?.kind !== "statement") throw new Error("Expected one READ");
            // A person's READ, acting for the producing model session ({§connection-lifecycle}).
            const [result] = await daemon.dispatchClientAction({
                workspaceId: workspaceRow.id, actor: "test://primary", contextSessionId: producer.id, statements: [item.statement],
            });
            assert.equal(result.status, 200);
            return JSON.parse(result.content as string) as { tools: { name: string; inputSchema: object }[] };
        };
        assert.deepEqual((await toolsCatalog()).tools.map(({ name }) => name), ["echo"],
            "the catalog excludes both capability-denied fail and non-allowlisted where");
        const found = actionResult(await post(port, runInput(workspace, "find-tool-definition", {
            action: {
                kind: "op.parse",
                text: PlurnkParser.frame('FIND (workspace:///_plurnk/tools/fixture.json) $.tools[?(@.name=="echo")].name <1,-1>', null),
            },
        })));
        assert.equal(found.ok, true, JSON.stringify(found.problem));
        const [match] = found.result!.results as { status: number; matchingPathCount: number; matchLocationCount: number }[];
        assert.equal(match?.status, 200, JSON.stringify(match));
        assert.equal(match.matchingPathCount, 1);
        assert.equal(match.matchLocationCount, 1, "ordinary FIND locates the requested tool in the JSON catalog");
        const failedInvocation = packet(provider.requests, 3);
        assert.match(failedInvocation, /invalid-tool-arguments/, "the first malformed invocation reached the model as the exact MCP failure");
        assert.match(failedInvocation, /One JSON object per MCP tool call/, "the failure names the form that works, not only the JSON diagnostic");
        assert.match(failedInvocation, /log:\/\/\/\d+\/\d+\/\d+\/READ/, "the failure has a stable log coordinate curated by the next turn");
        const correctedInvocation = packet(provider.requests, 4);
        assert.match(correctedInvocation, /hello from MCP/, "the corrected remote result entered the next model packet");
        assert.doesNotMatch(
            correctedInvocation,
            /invalid-tool-arguments/,
            "curating the first terminal receipt cannot cause the failed MCP stream to be delivered again",
        );
        const revisitedFailure = packet(provider.requests, 5);
        assert.match(revisitedFailure, /fixture:\/\/\/[a-f0-9]{8}/);
        assert.match(
            revisitedFailure,
            /invalid-tool-arguments/,
            "an explicit source query still composes its exact terminal producer failure after receipt curation",
        );
        const observedSpeech = sessionUpdates(observed)
            .filter((u) => u.sessionUpdate === "agent_message_chunk")
            .map((u) => ((u.content as { text?: string } | undefined)?.text ?? ""))
            .join("");
        assert.match(observedSpeech, /echo returned hello from MCP/);

        const restored = actionResult(await post(port, runInput(workspace, "restore-fail-tool", {
            projectRoot,
            action: { kind: "workspace.capabilities.set", policy: {} },
        })));
        assert.equal(restored.ok, true, JSON.stringify(restored.problem));
        assert.deepEqual(restored.result?.workspace, {});
        assert.deepEqual((await toolsCatalog()).tools.map(({ name }) => name), ["echo", "fail"],
            "policy reconciliation restores only the configured tools");

        const interrupted = await post(port, runInput(workspace, "host-tool-a", {
            prompt: "Call the attached fail tool and recover from its result.",
        }));
        const interruptedMeta = terminalMeta(interrupted);
        assert.equal(interruptedMeta?.stopReason, "requires_action");
        const proposal = interruptedMeta?.proposal as { readonly logEntryId: number; readonly coordinate: string } | undefined;
        assert.ok(proposal !== undefined);
        // {§acp-proposal-resolve} The gate names the operation's own call, which its Run presented before it.
        const gated = proposal.coordinate;
        assert.match(gated, /^\d+\/\d+\/\d+$/);
        assert.ok(sessionUpdates(interrupted).some((u) => u.sessionUpdate === "tool_call_update" && u.toolCallId === `proposal:${proposal.logEntryId}`),
            "the gated call precedes its proposal gate");

        const resumed = await post(port, runInput(workspace, "host-tool-b", {
            proposalResolve: {
                logEntryId: proposal.logEntryId,
                optionId: "allow_once",
            },
        }));
        assert.equal(terminalMeta(resumed)?.stopReason, "end_turn");
        const failContract = packet(provider.requests, 7);
        assert.match(failContract, /Return a deterministic tool error\./);
        assert.match(failContract, /```fixture \(fail\)/);
        const recoveryPacket = packet(provider.requests, 8);
        assert.match(recoveryPacket, /tool-reported-error/);
        assert.match(recoveryPacket, /The MCP tool reported an error\./);
        assert.match(recoveryPacket, /"diagnostic":"fixture failure"/, "the durable observed result retains the server's explanation");
        const toolFailure = sessionUpdates(resumed).find((u) => u.sessionUpdate === "terminal_update"
            && (u._meta as { plurnk?: { result?: { problem?: { tool?: string } } } } | undefined)?.plurnk?.result?.problem?.tool === "fail");
        assert.ok(toolFailure, "the actual ACP stream conclusion carries the tool failure");
        const toolResult = (toolFailure._meta as { plurnk: { result: { status: number; problem: { diagnostic?: string } } } }).plurnk.result;
        assert.equal(toolResult.status, 502);
        assert.equal(toolResult.problem.diagnostic, "fixture failure");
        const recoveredSpeech = sessionUpdates(resumed)
            .filter((u) => u.sessionUpdate === "agent_message_chunk")
            .map((u) => ((u.content as { text?: string } | undefined)?.text ?? ""))
            .join("");
        assert.match(recoveredSpeech, /reported its expected tool error; recovery is complete/);

        // {§mcp-authority} — a legacy peer negotiates below the pin and serves its
        // standard catalog instead of being rejected.
        const legacyList = actionResult(await post(port, runInput(workspace, "legacy-list", {
            action: { kind: "workspace.mcp.list" },
        })));
        const legacyServer = (legacyList.result?.definitions as ReadonlyArray<Readonly<Record<string, unknown>>> | undefined)
            ?.find((server) => server.alias === "legacy");
        assert.equal(legacyServer?.state, "active");
        assert.equal((legacyServer?.detail as { protocolVersion?: string } | undefined)?.protocolVersion, "2025-06-18");
        assert.deepEqual((legacyServer?.detail as { tools?: string[] } | undefined)?.tools, ["legacy_echo"]);
    } finally {
        await daemon.stop();
        await http.close();
        await db.close();
        await rm(projectRoot, { recursive: true, force: true });
        if (previousFilesItems === undefined) delete process.env.PLURNK_SERVICE_FILES_ITEMS;
        else process.env.PLURNK_SERVICE_FILES_ITEMS = previousFilesItems;
    }
});
});

describe("mcp-cache-composition", () => {
process.env.PLURNK_SERVICE_WORKSPACE_WARM_MS = "60000";
const uri = "fixture://private-document";

test("{§mcp-host-composition} private caches stay with their authorized workspace attachment across rotation", { timeout: 15000 }, async (t) => {
    const reads: string[] = [];
    const served = await serveMcpHttp(t, createMcpHandler(() => {
        const server = new McpServer({ name: "same-server", version: "1.0.0" });
        server.registerResource("document", uri, {}, async () => ({ contents: [{ uri, text: "unused" }] }));
        return server;
    }, { legacy: "reject", responseMode: "auto", keepAliveMs: 0 }), async (request) => {
        const body = await request.clone().json();
        if (body.method !== "resources/read") return null;
        const identity = request.headers.get("authorization");
        assert.ok(identity !== null && identity.startsWith("Bearer fixture-"));
        reads.push(identity);
        return Response.json({ jsonrpc: "2.0", id: body.id, result: {
            resultType: "complete", ttlMs: 60000, cacheScope: "private",
            contents: [{ uri, mimeType: "text/plain", text: `Document for ${identity}.` }],
        } });
    });
    const { hostPaths, env: mcpEnv } = await mcpFixture(t, { fixture: {
        ...httpEntry(served.url), authorization: { type: "bearer", token: "${ENV_AUTH}" },
    } });
    const db = await openMigrated();
    const daemon = new Daemon({ db, provider: null, hostPaths });
    daemon.registerModule(McpModule.init({ env: { ...mcpEnv,
        PLURNK_MCP_CONNECT_TIMEOUT: "5000", PLURNK_MCP_REQUEST_TIMEOUT: "5000", PLURNK_MCP_RETRY_FLOOR_MS: "250", PLURNK_MCP_RETRY_CEILING_MS: "5000",
    } }), "@plurnk/plurnk-mcp");
    t.after(async () => { await daemon.stop(); await db.close(); });
    await daemon.start();
    const workspaces = await Promise.all(["alpha", "beta"].map(async (name) => {
        const { workspaceId } = await daemon.createWorkspace({ name });
        const action = (family: string, verb: string, params: Record<string, unknown> = {}) =>
            daemon.invokeModuleAction(`workspace.${family}.${verb}`, params, { scope: "workspace", workspaceId });
        await action("env", "add", { alias: "ENV_AUTH", definition: { value: `fixture-${name}` } });
        // The workspace became resident before it held its token; enabling the unavailable server
        // reconnects it ({§mcp-configuration}).
        await action("mcp", "enable", { alias: "fixture" });
        const source = PlurnkParser.frame(`READ (fixture://${resourcePath(uri)}) <1,-1>`, null);
        const parsed = PlurnkParser.parseStatements(source, { executors: fixtureExecutors(source) });
        const item = parsed.items[0];
        if (item?.kind !== "statement") throw new Error("Expected one READ");
        // A person's READ ({§connection-lifecycle}); two people read through one workspace attachment.
        const read = async (reader = TEST_OWNER) => (await daemon.dispatchClientAction({ workspaceId, actor: reader, statements: [item.statement] }))[0];
        return { name, action, read };
    }));
    for (const workspace of workspaces) {
        assert.equal((await workspace.read()).content, `Document for Bearer fixture-${workspace.name}.`);
        assert.equal((await workspace.read("test://secondary")).content, `Document for Bearer fixture-${workspace.name}.`);
    }
    assert.deepEqual(reads.toSorted(), ["Bearer fixture-alpha", "Bearer fixture-beta"],
        "readers share their workspace cache, not another workspace's identically named authorized attachment");
    const [alpha, beta] = workspaces;
    assert.ok(alpha && beta);
    await alpha.action("env", "remove", { alias: "ENV_AUTH" });
    await alpha.action("env", "add", { alias: "ENV_AUTH", definition: { value: "fixture-rotated" } });
    assert.equal((await alpha.read()).content, "Document for Bearer fixture-alpha.",
        "changing the environment does not silently replace a running attachment");
    await alpha.action("mcp", "disable", { alias: "fixture" });
    await alpha.action("mcp", "enable", { alias: "fixture" });
    assert.equal((await alpha.read()).content, "Document for Bearer fixture-rotated.");
    assert.equal((await beta.read()).content, "Document for Bearer fixture-beta.");
    assert.deepEqual(reads.toSorted(), ["Bearer fixture-alpha", "Bearer fixture-beta", "Bearer fixture-rotated"],
        "rotation uses a fresh cache without invalidating the other attachment");
    for (const workspace of workspaces) {
        const listed = await workspace.action("mcp", "list") as FunctionalityListResult;
        const [listedFixture] = listed.definitions;
        assert.ok(listedFixture !== undefined, "the configured server is listed");
        assert.deepEqual(listedFixture.definition, {
            name: "fixture", type: "streamable-http", url: served.url,
            authorization: { type: "bearer", token: "${ENV_AUTH}" },
        }, "the definition retains its symbolic reference, never the resolved credential");
    }
});
});

describe("question-tool-admission", () => {
const findStatement = (): FindStatement => ({
    metadata: null,
    op: "FIND", aside: null,
    target: {
        kind: "url", raw: "workspace:///_plurnk/**", scheme: "workspace",
        username: null, password: null, hostname: null, port: null,
        pathname: "/_plurnk/**", query: null, fragment: null,
    },
    matcher: null, body: null,
    lineMarker: { marks: [1, -1] }, position: { line: 1, column: 1 },
});

const execStatement = (): ExecStatement => ({
    metadata: null,
    runtime: "plurnk", aside: null, target: localPath("question"), lineMarker: null,
    body: JSON.stringify({ message: "Which branch?", requestedSchema: { type: "object" } }),
    position: { line: 1, column: 1 },
});

const boot = async (capabilities: CapabilityPolicy = {}) => {
    const db = await openMigrated();
    const schemes = new SchemeRegistry();
    const engine = new Engine({ db, schemes, mimetypes: DEFAULT_MIMETYPES });
    engine.setExecutors(await ExecutorRegistry.build({ cwd: process.cwd() }));
    engine.registerRuntimes([{
        tag: "plurnk",
        entry: {
            executor: new FunctionalityManager({
                coordinator: {} as unknown as Functionality,
                entries: [{
                    family: "members",
                    summary: "Manage workspace members.",
                    inputSchemas: { list: { type: "object", properties: {} } },
                }],
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
    const workspaceId = await insertWorkspace(db, `tool-admission-${crypto.randomUUID()}`);
    const sessionId = await insertSession(db, workspaceId);
    await db.test_set_workspace_settings.run({
        id: workspaceId,
        settings: JSON.stringify({ capabilities }),
    });
    await LoopDocs.materialize(engine, db, workspaceId);
    const loopId = await insertLoop(db, sessionId, 2, "admission");
    const turnId = await insertTurn(db, loopId, 1, 102);
    const dispatch = { workspaceId, sessionId, loopId, turnId, origin: "model" as const };
    // What the session's FIND of the reserved reference set shows: its paths and its rendered catalog.
    const catalog = async () => {
        const found = await engine.dispatch({ ...dispatch, sequence: 1, statement: findStatement() });
        assert.equal(found.status, 200);
        const paths = (found.results as Array<Array<{ path: string }>>).map((group) => group[0]?.path ?? "");
        return { paths, content: (typeof found.content === "string" ? found.content : "") };
    };
    return { db, schemes, engine, workspaceId, sessionId, dispatch, catalog };
};

test("{§question-tool}: an interaction-denied workspace omits the question tool even for an interactive owner", async () => {
    const { db, workspaceId, sessionId, catalog } = await boot({ deny: [{ traits: ["interaction"] }] });
    try {
        await ownSession(db, workspaceId, sessionId);
        const { paths, content } = await catalog();
        assert.ok(paths.some((path) => path.endsWith("/plurnk/members.json")), "noninteractive plurnk tools remain discoverable");
        assert.ok(!paths.some((path) => path.endsWith("/plurnk/question.json")), "the question tool schema does not exist for the workspace");
        assert.ok(!content.includes("question.json"), "the rendered catalog agrees with the location list");
    } finally {
        await db.close();
    }
});

test("{§question-tool}: a session whose interactive owner declares question sees the tool", async () => {
    const { db, workspaceId, sessionId, catalog } = await boot();
    try {
        await ownSession(db, workspaceId, sessionId);
        const { paths } = await catalog();
        assert.ok(paths.some((path) => path.endsWith("/plurnk/question.json")), "the interactive session sees the question tool");
    } finally {
        await db.close();
    }
});

for (const [label, owner] of [
    ["the runtime owner", null],
    ["an owner nobody attends", { tools: ["request_approval", "question"], interactive: false }],
    ["an attended owner that does not declare question", { tools: ["request_approval"], interactive: true }],
] as const) test(`{§question-tool}: a session owned by ${label} neither sees nor dispatches question`, async () => {
    const { db, engine, workspaceId, sessionId, dispatch, catalog } = await boot();
    try {
        if (owner !== null) await ownSession(db, workspaceId, sessionId, [...owner.tools], owner.interactive);
        const { paths, content } = await catalog();
        assert.ok(paths.some((path) => path.endsWith("/sh.md")), "noninteractive tools remain discoverable");
        assert.ok(paths.some((path) => path.endsWith("/plurnk/members.json")), "noninteractive plurnk tools remain discoverable");
        assert.ok(!paths.some((path) => path.endsWith("/plurnk/question.json")), "the shared reference set hides the tool from this session");
        assert.ok(!content.includes("question.json"), "the rendered catalog agrees with the location list");
        const result = await engine.dispatch({ ...dispatch, sequence: 2, statement: execStatement() });
        assert.equal(result.status, 403);
        assert.equal(result.problem?.type, "https://problems.plurnk.xyz/engine/dispatcher/capability-denied");
        assert.equal(result.problem?.runtime, "plurnk");
        assert.equal(result.problem?.tool, "question");
        assert.equal(result.problem?.access, "interact");
        assert.equal(result.problem?.policyScope, "owner");
        assert.equal(result.problem?.recovery, CapabilityResolver.UNATTENDED_RECOVERY);
    } finally {
        await db.close();
    }
});

test("{§operation-results}: the owner ring's refusal says why the tool is gone and what to do instead", () => {
    assert.equal(CapabilityResolver.UNATTENDED_RECOVERY,
        "Nobody is present to answer. Decide from what you already have, or conclude stating what you could not resolve.");
});

test("{§question-tool}: execution dispatch refuses an interaction-denied question tool", async () => {
    const { db, engine, workspaceId, sessionId, dispatch } = await boot({ deny: [{ traits: ["interaction"] }] });
    try {
        await ownSession(db, workspaceId, sessionId);
        const result = await engine.dispatch({ ...dispatch, sequence: 1, statement: execStatement() });
        assert.equal(result.status, 403);
        assert.equal(result.problem?.type, "https://problems.plurnk.xyz/engine/dispatcher/capability-denied");
        assert.equal(result.problem?.runtime, "plurnk");
        assert.equal(result.problem?.tool, "question");
        assert.deepEqual(result.problem?.traits, ["interaction"]);
        assert.equal(result.problem?.policyScope, "workspace");
        assert.equal(result.problem?.recovery, undefined, "operator configuration speaks for itself");
    } finally {
        await db.close();
    }
});

test("{§question-tool}: the interaction access class gates known interactive tools", async () => {
    const { db, engine, workspaceId, sessionId, dispatch } = await boot({ deny: [{ access: "interact" }] });
    try {
        await ownSession(db, workspaceId, sessionId);
        const result = await engine.dispatch({ ...dispatch, sequence: 1, statement: execStatement() });
        assert.equal(result.status, 403);
        assert.equal(result.problem?.access, "interact");
        assert.equal(result.problem?.runtime, "plurnk");
        assert.equal(result.problem?.tool, "question");
        assert.equal(result.problem?.policyScope, "workspace");
    } finally {
        await db.close();
    }
});

test("{§question-tool}: neither the shipped defaults nor the real-model profile switch plurnk off", () => {
    for (const path of ["../../../plurnk-execs/.env.defaults", "../../.env.test"]) {
        const profile = parseEnv(readFileSync(new URL(path, import.meta.url), "utf8"));
        assert.equal(profile.PLURNK_EXECS_PLURNK, undefined, `${path} leaves the tool to the owner ring`);
    }
});

test("{§question-tool}: the executor switch removes plurnk and its teaching", async () => {
    const previous = process.env.PLURNK_EXECS_PLURNK;
    process.env.PLURNK_EXECS_PLURNK = "0";
    try {
        const { db, engine, schemes, workspaceId, sessionId, dispatch, catalog } = await boot();
        try {
            await ownSession(db, workspaceId, sessionId);
            assert.equal(schemes.has("plurnk", sessionId), false);
            const { paths } = await catalog();
            assert.ok(paths.some((path) => path.endsWith("/sh.md")), "noninteractive tools remain discoverable");
            assert.ok(!paths.some((path) => path.endsWith("/plurnk/question.json")));
            const result = await engine.dispatch({ ...dispatch, sequence: 2, statement: execStatement() });
            assert.equal(result.status, 400);
            assert.equal(result.problem?.type, "https://problems.plurnk.xyz/scheme/exec/executor-not-registered");
            assert.equal(result.problem?.requestedRuntime, "plurnk");
        } finally {
            await db.close();
        }
    } finally {
        if (previous === undefined) delete process.env.PLURNK_EXECS_PLURNK;
        else process.env.PLURNK_EXECS_PLURNK = previous;
    }
});
});

describe("rollback", () => {
const execFileP = promisify(execFile);
const ORIGINAL = "one\ntwo\nthree\n";
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d, 0x49, 0x48, 0x44, 0x52]);

const parseOne = (source: string): PlurnkStatement => {
    const { items } = PlurnkParser.parseStatements(source, { executors: fixtureExecutors(source) });
    const item = items[0];
    if (item?.kind !== "statement") throw new Error(`test operation did not parse: ${source}`);
    return item.statement;
};

const exists = async (path: string): Promise<boolean> => stat(path).then(() => true, () => false);

test("{§log-wire-format} reversals land as one client operation of the acting person, latest first; patchless rows are skipped; drift stops it; a rollback is reversible", async (t) => {
    serverProposals(t, "accept");
    const env = { PLURNK_SERVICE_GIT_ALLOWED: process.env.PLURNK_SERVICE_GIT_ALLOWED, PLURNK_SERVICE_GIT_AUTO: process.env.PLURNK_SERVICE_GIT_AUTO };
    process.env.PLURNK_SERVICE_GIT_ALLOWED = "1";
    process.env.PLURNK_SERVICE_GIT_AUTO = "1";
    const root = await mkdtemp(join(tmpdir(), "rollback-"));
    const git = (args: string[]) => execFileP("git", args, { cwd: root, env: hermeticGitEnv() });
    await git(["init", "-q"]);
    await writeFile(join(root, "a.md"), ORIGINAL);
    await writeFile(join(root, "bin.png"), PNG);
    await git(["add", "a.md", "bin.png"]);
    await git(["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", "commit", "-q", "--no-verify", "-m", "seed"]);
    const db = await openMigrated();
    const workspaceId = await insertWorkspace(db, `rollback-${crypto.randomUUID()}`);
    await rootWorkspace(db, workspaceId, root);
    const model = await insertSession(db, workspaceId, null, "primary", "model");
    const loopId = await insertLoop(db, model, 1);
    const turnId = await insertTurn(db, loopId, 1, 102);
    const daemon = new Daemon({ db, provider: null });
    await daemon.start();
    try {
        await daemon.engine.warmWorkspaceDerivations(workspaceId);
        let sequence = 0;
        const model_ = async (source: string): Promise<number> => {
            const result = await daemon.engine.dispatch({ statement: parseOne(source), workspaceId, sessionId: model, loopId, turnId, sequence: ++sequence, origin: "model" });
            assert.ok(result.status < 300, `${source.slice(0, 40)}: ${JSON.stringify(result).slice(0, 200)}`);
            return sequence;
        };
        const content = (path: string) => readFile(join(root, path), "utf8");
        const rollback = (to: string) => daemon.rollback({ workspaceId, sessionId: model, actor: TEST_OWNER, to });
        // A person's client operations journal in the runtime session ({§connection-lifecycle}).
        const runtime = await daemon.ensureRuntimeSession(workspaceId);
        const personLoops = async () => (await daemon.listSessionLoops({ workspaceId, sessionId: runtime }))
            .filter(({ promptSource }) => promptSource === TEST_OWNER);
        const clientMutations = async () => {
            const operations = new Set((await personLoops()).map((loop) => loop.sequence));
            return (await db.log_file_mutations_after.all<{ loop_seq: number; op: string; pathname: string | null; patch: string | null }>({
                session_id: runtime, loop_seq: 0, turn_seq: 0, sequence: 0,
            })).filter(({ loop_seq }) => operations.has(loop_seq)).map(({ op, pathname, patch }) => `${op} ${pathname} ${patch === null ? "no patch" : "patch"}`);
        };

        await model_("````READ (a.md) <1,-1>````");
        const first = await model_("````EDIT (a.md) <2>\nTWO\n````");
        const second = await model_("````EDIT (a.md) <3>\nTHREE\n````");
        const created = await model_("````EDIT (new.md)\nhello\n````");
        const bytes = await model_("````COPY (bin.png) (bin2.png)````");
        assert.equal(await content("a.md"), "one\nTWO\nTHREE\n");

        // Roll back to the first edit: the later edit and the creation are reversed, latest first; the
        // byte write is skipped by name; the compensations are the client's rows, each with its patch.
        const report = await rollback(`1/1/${first}`);
        assert.deepEqual(report, {
            to: `1/1/${first}`,
            restored: [
                { coordinate: `1/1/${created}`, path: "new.md", action: "delete" },
                { coordinate: `1/1/${second}`, path: "a.md", action: "update" },
            ],
            skipped: [{ coordinate: `1/1/${bytes}`, reason: "no-patch" }],
            stopped: null,
        } satisfies RollbackReport);
        assert.equal(await content("a.md"), "one\nTWO\nthree\n");
        assert.equal(await exists(join(root, "new.md")), false);
        assert.equal(await exists(join(root, "bin2.png")), true, "a patchless row's effect stands");
        assert.deepEqual(await clientMutations(), ["EDIT a.md patch", "KILL new.md patch"], "every reversal is a row of the person's operation with a patch of its own");
        const [operation] = await personLoops();
        assert.equal((await personLoops()).length, 1, "the reversals are one client operation, attributed to the acting person");
        assert.equal(operation?.status, 200);

        // Rolling back past the first edit: the rows an earlier rollback reversed are recognized and skipped,
        // the first edit is reversed, and the original returns.
        const toOrigin = await rollback("1/1/1");
        assert.equal(toOrigin.stopped, null, JSON.stringify(toOrigin.stopped));
        assert.deepEqual(toOrigin.restored, [{ coordinate: `1/1/${first}`, path: "a.md", action: "update" }]);
        assert.deepEqual(toOrigin.skipped, [
            { coordinate: `1/1/${bytes}`, reason: "no-patch" },
            { coordinate: `1/1/${created}`, reason: "already-reversed" },
            { coordinate: `1/1/${second}`, reason: "already-reversed" },
        ]);
        assert.equal(await content("a.md"), ORIGINAL);
        assert.equal(await exists(join(root, "new.md")), false);

        // Drift: a file changed outside the daemon stops the rollback at that row, restoring nothing for it.
        await model_("````READ (a.md) <1,-1>````");
        const drifted = await model_("````EDIT (a.md) <1>\nONE\n````");
        await writeFile(join(root, "a.md"), "external\n");
        const stopped = await rollback(`1/1/${bytes}`);
        assert.deepEqual(stopped.restored, []);
        assert.equal(stopped.stopped?.reason, "drift");
        assert.equal(stopped.stopped?.coordinate, `1/1/${drifted}`);
        assert.equal(stopped.stopped?.path, "a.md");
        assert.equal(await content("a.md"), "external\n", "drift leaves the file alone");

        // Coordinates that name no row, and malformed ones, refuse by name.
        for (const [to, code, status] of [["9/9/9", "coordinate-not-found", 404], ["yesterday", "coordinate-invalid", 400]] as const) {
            const error = await rollback(to).then(() => null, (cause: unknown) => cause);
            assert.ok(error instanceof OperationFailureError, `${to}: ${String(error)}`);
            assert.equal(error.result.status, status);
            assert.match(error.result.problem?.type ?? "", new RegExp(`/${code}$`, "u"));
        }
    } finally {
        await daemon.stop();
        await db.close();
        await rm(root, { recursive: true, force: true });
        for (const [key, value] of Object.entries(env)) {
            if (value === undefined) delete process.env[key];
            else process.env[key] = value;
        }
    }
});
});
