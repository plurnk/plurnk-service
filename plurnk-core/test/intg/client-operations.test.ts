// {§connection-lifecycle} {§actor-boundary-client-operations} — a person's client operations: each one is
// a loop of the workspace's runtime session, cancelled on its own ({§methods-loop-cancel}), reading the log
// of the session the person acts for, and already that person's decision ({§proposal-disposition}).
import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { PlurnkParser } from "@plurnk/plurnk-parser";
import { Mock } from "@plurnk/plurnk-providers";
import type { FindStatement, PlurnkStatement } from "@plurnk/plurnk-contracts";
import type { ExecArgs, RuntimeRegistration } from "@plurnk/plurnk-execs";
import type { SchemeCtx, SchemeHandler, SchemeManifest, SchemeResult } from "@plurnk/plurnk-schemes";
import Daemon from "../../src/server/Daemon.ts";
import SchemeRegistry from "../../src/core/SchemeRegistry.ts";
import LoopLifecycle from "../../src/core/LoopLifecycle.ts";
import { OperationFailureError } from "../../src/core/results.ts";
import type { Db } from "../../src/core/Db.ts";
import { openMigrated } from "./_db.ts";
import { serverProposals, TEST_OWNER } from "./_approval.ts";
import { fixtureExecutors, makeMockResponse } from "./_mock.ts";
import { viableWindow } from "./_provider.ts";
import { waitFor, waitForDb } from "./_rpc.ts";
import { modelOperation, namedModelSession } from "./_sessions.ts";

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

test("{§methods-loop-cancel} {§connection-lifecycle} cancelLoop ends one client operation: an in-flight dispatch settles 499; a returned operation's running command is reaped while its loop keeps 200; nothing else runs down", async (t) => {
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

test("{§methods-loop-cancel} cancelLoop reaps nothing of a model session's loop", async (t) => {
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

test("{§actor-boundary-client-operations} a client operation's log:/// addresses read the session the person acts for and never curate it; acting for none, they address no log", async (t) => {
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

    await t.test("acting for the model session, a READ answers from its log as the model reads it", async () => {
        const read = await person(`\`\`\`\`READ (${coordinate}) <1,-1>\`\`\`\``, sessionId);
        assert.equal(read.status, 200, JSON.stringify({ status: read.status, problem: problemType(read) }));
        const own = await modelOperation(daemon, db, { workspaceId, sessionId, statement: parseOne(`\`\`\`\`READ (${coordinate}) <1,-1>\`\`\`\``) });
        assert.equal(own.status, 200);
        assert.equal(read.content, own.content);
    });
    await t.test("acting for the model session, a FIND answers from its log", async () => {
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
        await t.test(`acting for the model session, a ${verb} that would curate its log is refused as a client write`, async () => {
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
        await t.test(`acting for no session, a ${verb} of log:/// addresses no log`, async () => {
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

test("{§session-lifecycle-total-reap} shutdown cancels a person's operation still dispatching and reaps a command still running after its operation returned", async (t) => {
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

test("{§actor-boundary-client-operations} {§machine-processes} a person's operation speaks and delegates as that person: messages arrive from them, WORK starts a root session they own, FORK branches the session they act for", async (t) => {
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

test("{§actor-boundary-client-operations} {§env-scheme} a person's env:/// is the workspace's: a model's commands receive it, and the runtime session keeps no layer", async (t) => {
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
