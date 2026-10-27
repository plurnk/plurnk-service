import test, { describe } from "node:test";
import assert from "node:assert/strict";
import StrikeRail, { type StrikeOutcome } from "../../src/core/StrikeRail.ts";
import LoopLifecycle from "../../src/core/LoopLifecycle.ts";
import DrainSupervisor from "../../src/server/DrainSupervisor.ts";
import Daemon from "../../src/server/Daemon.ts";
import Engine from "../../src/core/Engine.ts";
import SchemeRegistry from "../../src/core/SchemeRegistry.ts";
import TerminalResult from "../../src/core/TerminalResult.ts";
import Results from "../../src/core/results.ts";
import SessionName from "../../src/core/SessionName.ts";
import ChannelWrite from "../../src/core/ChannelWrite.ts";
import Turn from "../../src/core/Turn.ts";
import TurnMaterialization from "../../src/core/TurnMaterialization.ts";
import { type Db } from "../../src/core/Db.ts";
import { openMigrated, insertWorkspace, insertSession, insertLoop, holdChild, sendingOperation, seedEntryWithChannel } from "./_db.ts";
import { Mock, type MockResponse, AiSdkProvider, ProviderError } from "@plurnk/plurnk-providers";
import { withDaemon, rpcCall, connect, runLoopToTerminal, waitForDb } from "./_rpc.ts";
import { namedModelSession } from "./_sessions.ts";
import { type SchemeManifest } from "../../src/core/scheme-types.ts";
import { serverProposals, ownSession } from "./_approval.ts";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeMockResponse } from "./_mock.ts";
import { lastReply } from "./_packet.ts";
import { PlurnkParser } from "@plurnk/plurnk-parser";
import { completeStmt, sendStmt, killStmt, noteStmt } from "./_dsl.ts";
import { type EditStatement, type PlurnkStatement, type UrlPath } from "@plurnk/plurnk-contracts";
import { viableWindow } from "./_provider.ts";
import { requestBody } from "../../../scripts/lib/test-fetch.ts";

describe("StrikeRail", () => {
let db: Db;
let loopId: number;
test.beforeEach(async () => {
    db = await openMigrated();
    const workspaceId = await insertWorkspace(db, "strike-state");
    const sessionId = await insertSession(db, workspaceId);
    loopId = await insertLoop(db, sessionId, 1);
});
test.afterEach(async () => { await db.close(); });

const base = { waitRevision: 0, fingerprint: "READ(x)", progressed: false, cut: false, minCycles: 3, maxCyclePeriod: 4, maxStrikes: 3 };
const outcome = (op: StrikeOutcome["op"], status: number): StrikeOutcome => ({ op, status });

test("{§engine-rails} a 409 status alone is soft; no completion claim strikes ({§completion-joins-live-work}, {§completion-defers-to-results})", async () => {
    const rail = new StrikeRail(db);
    const verdict = await rail.assess(loopId, { ...base, outcomes: [outcome("SEND", 409)] });
    assert.equal(verdict.thresholdCrossed, false);
    assert.equal(await rail.streak(loopId), 0, "a soft status is never counted");
});

test("{§engine-rails} a genuinely-spinning model is still caught — identical turns cycle-strike (508 backstop)", async () => {
    const rail = new StrikeRail(db);
    // The retrieval-preemie no-strike leaves the cycle detector as the backstop: a model repeating
    // the IDENTICAL read+conclude turn is loop-detected even with 409 soft.
    let cycleHit = false;
    for (let i = 0; i < 8; i++) cycleHit = (await rail.assess(loopId, { ...base, fingerprint: "READ(page)+SEND", outcomes: [outcome("SEND", 409)] })).cycleDetected || cycleHit;
    assert.equal(cycleHit, true, "identical repetition is loop-detected — the spin backstop survives the soft 409");
});

test("{§engine-rails} a non-execution hard failure (500-class status) still strikes normally", async () => {
    const rail = new StrikeRail(db);
    let crossed = false;
    for (const fp of ["EDIT(a)", "EDIT(b)", "EDIT(c)"]) crossed = (await rail.assess(loopId, { ...base, fingerprint: fp, outcomes: [outcome("EDIT", 500)] })).thresholdCrossed || crossed;
    assert.equal(crossed, true, "a non-soft failure status accrues strikes as ever");
});

test("{§engine-rails} executor evidence never strikes, wherever it surfaces", async () => {
    // The engine materializes a failed command as a READ[500] carrying the
    // executor's problem identity; the model reads a failed stream and gets the same 500.
    const rail = new StrikeRail(db);
    const evidence = (op: StrikeOutcome["op"]): StrikeOutcome => ({ op, status: 500, problemType: "https://problems.plurnk.xyz/executor/subprocess/spawn-failed" });
    let crossed = false;
    for (const fp of ["execution(a)", "execution(b)", "execution(c)", "execution(d)"]) crossed = (await rail.assess(loopId, { ...base, fingerprint: fp, outcomes: [evidence("READ"), evidence("READ")] })).thresholdCrossed;
    assert.equal(crossed, false, "four turns of red test runs are evidence, not strikes");
    assert.equal(await rail.streak(loopId), 0);
    // The same status without executor identity is a hard failure and strikes as before.
    let struck = false;
    for (const fp of ["READ(a)", "READ(b)", "READ(c)"]) struck = (await rail.assess(loopId, { ...base, fingerprint: fp, outcomes: [{ op: "READ", status: 500, problemType: "https://problems.plurnk.xyz/engine/dispatcher/scheme-handler-threw" }] })).thresholdCrossed;
    assert.equal(struck, true, "a non-executor 500 still strikes to the threshold");
});

test("{§engine-rails} execution errors are soft regardless of status", async () => {
    const rail = new StrikeRail(db);
    await rail.assess(loopId, { ...base, fingerprint: "execution(python3)", outcomes: [outcome("python3", 400)] });
    await rail.assess(loopId, { ...base, fingerprint: "execution(sh)", outcomes: [outcome("sh", 500)] });
    assert.equal(await rail.streak(loopId), 0, "an executor error remains evidence without pricing experimentation into the strike rail");
});

test("{§engine-rails} hard outcomes are the non-cycle strike source and accumulate a streak", async () => {
    const rail = new StrikeRail(db);
    assert.equal((await rail.assess(loopId, { ...base, fingerprint: "hard", outcomes: [outcome(null, 400)] })).thresholdCrossed, false);
    assert.equal(await rail.streak(loopId), 1);
    assert.equal((await rail.assess(loopId, { ...base, fingerprint: "hard2", outcomes: [outcome("EDIT", 500)] })).thresholdCrossed, false);
    assert.equal(await rail.streak(loopId), 2);
});

test("{§engine-rails} multiple sources still count once per turn, and a clean turn resets the streak", async () => {
    const rail = new StrikeRail(db);
    const struck = await rail.assess(loopId, {
        ...base,
        outcomes: [outcome("EDIT", 500)],
        maxStrikes: 2,
    });
    assert.equal(struck.thresholdCrossed, false);
    assert.equal(await rail.streak(loopId), 1, "one admitted turn contributes at most one strike");
    await rail.assess(loopId, { ...base, fingerprint: "clean", outcomes: [] });
    assert.equal(await rail.streak(loopId), 0);
});

test("{§engine-rails}: a hard 400 beside a successful operation is progress and clears the streak", async () => {
    const rail = new StrikeRail(db);
    await rail.assess(loopId, { ...base, fingerprint: "failed", outcomes: [outcome("EDIT", 400)] });
    assert.equal(await rail.streak(loopId), 1);
    const productive = await rail.assess(loopId, {
        ...base,
        fingerprint: "productive",
        outcomes: [outcome("READ", 200), outcome(null, 400), outcome("EDIT", 400), outcome("NOTE", 201)],
        progressed: true,
        maxStrikes: 2,
    });
    assert.equal(productive.thresholdCrossed, false, "the turn that read successfully does not cross on its hard 400");
    assert.equal(productive.crossedBy, null, "the productive turn is not struck at all");
    assert.equal(await rail.streak(loopId), 0, "a productive turn counts as progress: the streak clears");
});

test("{§engine-rails}: turns without progress strike on their hard failures", async () => {
    const rail = new StrikeRail(db);
    const turns = [
        [outcome("NOTE", 201), outcome(null, 400)],
        [outcome("EDIT", 400), outcome("WAIT", 202)],
        [outcome("NOTE", 201), outcome("READ", 404), outcome("SEND", 200), outcome("KILL", 405)],
    ];
    const verdicts = [];
    for (const [index, outcomes] of turns.entries()) verdicts.push(await rail.assess(loopId, { ...base, fingerprint: `failed-${index}`, outcomes }));
    assert.deepEqual(verdicts.map(({ crossedBy }) => crossedBy), ["operation", "operation", "operation"]);
    assert.equal(verdicts.at(-1)?.thresholdCrossed, true, "three turns with no successful operation cross the threshold");
});

test("{§engine-rails}: a successful operation does not exempt a repeating turn from the cycle backstop", async () => {
    const rail = new StrikeRail(db);
    let crossed = null;
    for (let i = 0; i < base.minCycles * 3; i++) crossed = await rail.assess(loopId, { ...base, fingerprint: "READ(same)+EDIT(bad)", progressed: true, outcomes: [outcome("READ", 200), outcome("EDIT", 400)] });
    assert.equal(crossed?.cycleDetected, true);
    assert.equal(crossed?.crossedBy, "repetition");
    assert.equal(crossed?.thresholdCrossed, true);
});

test("{§engine-rails} {§output-allowance-notice}: a cut is no repetition evidence and closes the cycle window", async () => {
    const rail = new StrikeRail(db);
    const same = { ...base, fingerprint: "empty:", outcomes: [] };
    const cut = async () => (await rail.assess(loopId, { ...same, cut: true })).cycleDetected;
    assert.deepEqual([await cut(), await cut(), await cut(), await cut()], [false, false, false, false],
        "identical cut turns never repeat: the ceiling, not the model, ended each");
    await rail.assess(loopId, same);
    await rail.assess(loopId, same);
    assert.equal(await cut(), false);
    assert.equal((await rail.assess(loopId, same)).cycleDetected, false, "no repetition spans a cut");
    assert.equal((await rail.assess(loopId, same)).cycleDetected, false);
    assert.equal((await rail.assess(loopId, same)).cycleDetected, true, "the window the cut opened detects its own repetition");
});

test("{§engine-rails} {§output-allowance-notice}: a cut turn's strike is the allowance's, whatever else it struck on", async () => {
    const rail = new StrikeRail(db);
    const sources = [
        { emptyTurn: true, outcomes: [] },
        { emptyTurn: false, outcomes: [outcome(null, 500)] },
        { emptyTurn: false, outcomes: [outcome("EDIT", 400)] },
    ];
    const verdicts = [];
    for (const [index, turn] of sources.entries()) verdicts.push(await rail.assess(loopId, { ...base, ...turn, fingerprint: `cut-${index}`, cut: true }));
    assert.deepEqual(verdicts.map(({ crossedBy }) => crossedBy), ["output_allowance", "output_allowance", "output_allowance"]);
    assert.deepEqual(verdicts.map(({ cycleDetected }) => cycleDetected), [false, false, false]);
    assert.equal(verdicts.at(-1)?.thresholdCrossed, true, "a cut still strikes, so a model that keeps reaching the allowance stops");
    const progressed = await rail.assess(loopId, { ...base, cut: true, progressed: true, outcomes: [outcome("READ", 200), outcome(null, 400)] });
    assert.equal(progressed.crossedBy, null, "a cut turn that acted on the task is progress like any other");
    assert.equal(await rail.streak(loopId), 0);
});

test("{§engine-rails}: clean recovery after a park resets only this loop's streak", async () => {
    const rail = new StrikeRail(db);
    await rail.assess(loopId, { ...base, outcomes: [outcome("READ", 403)] });
    const lifecycle = new LoopLifecycle(db);
    assert.equal(await lifecycle.park(loopId, { wakenBy: "test-fixture" }), true);
    assert.equal(await lifecycle.wake(loopId), true);
    const resumed = new StrikeRail(db);
    assert.equal(await resumed.streak(loopId), 1);
    assert.equal((await resumed.assess(loopId, { ...base, waitRevision: 1, outcomes: [] })).cycleDetected, false);
    assert.equal(await resumed.streak(loopId), 0);

    const workspaceId = await insertWorkspace(db, "independent-rail");
    const sessionId = await insertSession(db, workspaceId);
    const otherLoopId = await insertLoop(db, sessionId, 1);
    await resumed.assess(otherLoopId, { ...base, outcomes: [outcome("READ", 403)] });
    assert.equal(await resumed.streak(otherLoopId), 1);
    assert.equal(await resumed.streak(loopId), 0);
});

test("{§engine-rails}: reconstructing an owner does not renew the bounded cycle window", async () => {
    for (let i = 0; i < 2; i++) {
        assert.equal((await new StrikeRail(db).assess(loopId, { ...base, outcomes: [] })).cycleDetected, false);
    }
    assert.equal((await new StrikeRail(db).assess(loopId, { ...base, outcomes: [] })).cycleDetected, true);
    for (let i = 0; i < 20; i++) await new StrikeRail(db).assess(loopId, { ...base, outcomes: [] });
    const state = await db.strike_rail_state.get<{ cycle_history: string }>({ loop_id: loopId });
    assert.equal(JSON.parse(state!.cycle_history).length, base.minCycles * base.maxCyclePeriod);
});

test("{§engine-rails}: an unsuccessful park does not create a new cycle window", async () => {
    const lifecycle = new LoopLifecycle(db);
    assert.equal(await lifecycle.park(loopId, { wakenBy: "test-fixture" }), true);
    for (let i = 0; i < 2; i++) {
        assert.equal(await lifecycle.park(loopId, { wakenBy: "test-fixture" }), false, "an already parked loop cannot park twice");
        await new StrikeRail(db).assess(loopId, { ...base, waitRevision: 1, outcomes: [] });
    }
    assert.equal((await new StrikeRail(db).assess(loopId, { ...base, waitRevision: 1, outcomes: [] })).cycleDetected, true);
});
});

describe("Daemon.wait-rails", () => {
// A contract violation that strikes: a third COPY operand ({§extra-path-slot}); a fumbled matcher
// would not ({§matcher-refusal}).
const extraSlotCopy = "````COPY (workspace:///a) (workspace:///b) (workspace:///c)````";
const response = (dsl: string) => ({
    assistant: { content: dsl, reasoning: null },
    usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
});

for (const wake of ["message", "same-drain", "restart"] as const) {
    for (const last of ["WAIT", "SEND"] as const) {
        test(`{§engine-rails}: ${wake} wake preserves consecutive strikes through ${last}`, async (t) => {
            // The waits park on live work the fixture holds; a restart wakes them through recovery.
            const provider = new Mock({ contextWindow: 100000, responses: [
                response(`${extraSlotCopy}
\`\`\`\`WAIT
Await results.
\`\`\`\``),
                response(`${extraSlotCopy}
\`\`\`\`WAIT
Await results.
\`\`\`\``),
                response(`${extraSlotCopy}
\`\`\`\`${last}\`\`\`\``),
                response("````SEND [200]\nMust not reach a fourth model call.\n````"),
            ] });
            const seen: Array<number | undefined> = [];
            const generate = provider.generate.bind(provider);
            await withDaemon(provider, async (db, daemon) => {
                let activeDaemon = daemon;
                const { workspaceId } = await daemon.createWorkspace({ name: `wait-strikes-${wake}` });
                const sessionId = await namedModelSession(daemon, workspaceId, "main");
                t.mock.method(provider, "generate", async (args: Parameters<Mock["generate"]>[0]) => {
                    if (seen.length < 2) await holdChild(db, workspaceId, sessionId);
                    seen.push((args as { strikes?: number }).strikes);
                    return generate(args);
                });
                const parks = [Promise.withResolvers<void>(), Promise.withResolvers<void>()];
                const finished = Promise.withResolvers<number>();
                const schedule = DrainSupervisor.prototype.scheduleWakes;
                const park = LoopLifecycle.prototype.park;
                const finish = LoopLifecycle.prototype.finish;
                let loopId: number | undefined;
                t.mock.method(DrainSupervisor.prototype, "scheduleWakes", async function (this: DrainSupervisor, ...args: Parameters<typeof schedule>) {
                    await schedule.apply(this, args);
                    if (args[1] === sessionId) parks[seen.length - 1]?.resolve();
                });
                if (wake === "same-drain") {
                    t.mock.method(LoopLifecycle.prototype, "park", async function (this: LoopLifecycle, ...args: Parameters<typeof park>) {
                        const result = await park.apply(this, args);
                        if (result && args[0] === loopId) assert.equal(await this.wake(args[0]), true);
                        return result;
                    });
                }
                t.mock.method(LoopLifecycle.prototype, "finish", async function (this: LoopLifecycle, ...args: Parameters<typeof finish>) {
                    const result = await finish.apply(this, args);
                    if (args[0] === loopId && result !== null) finished.resolve(result.status);
                    return result;
                });
                t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: Date.now() });
                t.mock.method(performance, "now", () => Date.now());
                try {
                    loopId = (await daemon.runLoop({ workspaceId, sessionId, prompt: "Perform valid operations after each wait." })).loopId;
                    if (wake !== "same-drain") {
                        for (const parked of parks) {
                            await parked.promise;
                            assert.equal(await new LoopLifecycle(db).status(loopId), 202);
                            if (wake === "restart") {
                                await activeDaemon.stop();
                                activeDaemon = new Daemon({ db, provider });
                                await activeDaemon.start();
                            } else {
                                assert.equal((await activeDaemon.runLoop({ workspaceId, sessionId, prompt: "Continue." })).loopId, loopId);
                            }
                        }
                    }
                    assert.equal(await finished.promise, 500, "the third consecutive hard failure ends this same task");
                    assert.deepEqual(seen, [undefined, undefined, undefined], "the streak never leaves the daemon: no provider call carries it");
                    const result = await new LoopLifecycle(db).result(loopId);
                    assert.equal(result?.problem?.type, "https://problems.plurnk.xyz/engine/rails/strike-threshold");
                    const rows = await db.test_log_entries_by_loop.all<{ op: string; status_rx: number }>({ loop_id: loopId });
                    assert.equal(rows.filter(({ op, status_rx }) => op === "error" && status_rx === 400).length, 3,
                        "each strike corresponds to its preserved concrete failure");
                } finally {
                    await activeDaemon.cancelSession({ workspaceId, sessionId });
                    t.mock.timers.reset();
                    if (activeDaemon !== daemon) await activeDaemon.stop();
                }
            });
        });
    }
}

test("{§engine-rails}: actual parks end repetition windows even when wakes stay in one drain", async (t) => {
    const provider = new Mock({ contextWindow: 100000, responses: [
        ...Array.from({ length: 6 }, () => response("````READ (workspace:///missing)````\n````WAIT\nAwait results.\n````")),
        response("````SEND [200]\nObservation complete.\n````"),
    ] });
    await withDaemon(provider, async (db, daemon) => {
        const { workspaceId } = await daemon.createWorkspace({ name: "wait-cycle-windows" });
        const sessionId = await namedModelSession(daemon, workspaceId, "main");
        const childLoop = await holdChild(db, workspaceId, sessionId);
        const finished = Promise.withResolvers<number>();
        const park = LoopLifecycle.prototype.park;
        const finish = LoopLifecycle.prototype.finish;
        let loopId: number | undefined;
        let parks = 0;
        t.mock.method(LoopLifecycle.prototype, "park", async function (this: LoopLifecycle, ...args: Parameters<typeof park>) {
            const result = await park.apply(this, args);
            if (result && args[0] === loopId) {
                parks++;
                if (parks === 6) await this.finish(childLoop, { status: 200, content: "Held work finished." });
                assert.equal(await this.wake(args[0]), true);
            }
            return result;
        });
        t.mock.method(LoopLifecycle.prototype, "finish", async function (this: LoopLifecycle, ...args: Parameters<typeof finish>) {
            const result = await finish.apply(this, args);
            if (args[0] === loopId && result !== null) finished.resolve(result.status);
            return result;
        });
        try {
            loopId = (await daemon.runLoop({ workspaceId, sessionId, prompt: "Check periodically, then conclude.", maxTurns: 10 })).loopId;
            assert.equal(await finished.promise, 200, "unchanged observations separated by real waits are not a spin cycle");
            assert.equal(parks, 6);
            assert.equal(provider.received.length, 7);
            const reads = (await db.test_log_entries_by_loop.all<{ op: string; status_rx: number }>({ loop_id: loopId }))
                .filter(({ op }) => op === "READ");
            assert.equal(reads.filter(({ status_rx }) => status_rx === 404).length, 6);
        } finally { await daemon.cancelSession({ workspaceId, sessionId }); }
    });
});
});

describe("Engine.cycles", () => {
const turn = (operation: string, op: string | null = "NOTE") => ({
    assistant: { content: op === null ? operation : `${operation}
\`\`\`\`${op}
\`\`\`\``, reasoning: null },
    usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
});

for (const identical of [false, true]) {
    test(`{§engine-rails} six ${identical ? "identical" : "distinct"} appends execute and conclude`, async () => {
        const db = await openMigrated();
        try {
            const workspaceId = await insertWorkspace(db, `cycles-${crypto.randomUUID()}`);
            const sessionId = await insertSession(db, workspaceId);
            const loopId = await insertLoop(db, sessionId, 1, "Append six lines, then conclude.");
            const engine = new Engine({ db, schemes: new SchemeRegistry() });
            const lines = Array.from({ length: 6 }, (_, index) => `completed step ${identical ? "same" : index + 1}`);
            const provider = new Mock({ contextWindow: 100000, responses: [
                ...lines.map((line) => turn(`\`\`\`\`EDIT (workspace:///journal) <-1>
${line}
\`\`\`\``)),
                turn("````SEND [200]\nAppended all six lines.\n````", null),
            ] });
            const result = await engine.runLoop({ provider, workspaceId, sessionId, loopId, messages: [], maxTurns: 10 });
            assert.equal(result.result.status, 200, JSON.stringify(result.result));
            const rows = await db.test_log_entries_by_session.all<{ op: string; status_rx: number }>({ session_id: sessionId });
            assert.deepEqual(rows.filter(({ op }) => op === "EDIT").map(({ status_rx }) => status_rx), [201, 200, 200, 200, 200, 200]);
            const entry = await db.test_get_entry_by_path.get<{ id: number }>({ workspace_id: workspaceId, scheme: "workspace", pathname: "/journal" });
            assert.ok(entry);
            const channel = await db.test_get_channel.get<{ content: string }>({ entry_id: entry.id, name: "body" });
            assert.equal(channel?.content.trimEnd(), lines.join("\n"));
        } finally { await db.close(); }
    });
}

class ObservedContent {
    static manifest: SchemeManifest = {
        name: "observed-content", category: "control", channels: { body: "text/plain" }, defaultChannel: "body",
        writableBy: [], volatile: true, modelVisible: true,
    };
    readonly manifest = ObservedContent.manifest;
    calls = 0;
    readonly #changing: boolean;

    constructor(changing: boolean) { this.#changing = changing; }

    async read() {
        this.calls++;
        return { status: 200, channel: "body", mimetype: "text/plain", content: `observation ${this.#changing ? this.calls : 1}` };
    }
}

for (const changing of [false, true]) {
    for (const status of ["NOTE", null]) test(`{§engine-rails} repeated reads with ${changing ? "changing" : "unchanged"} results, NOTE=${status ?? "omitted"}`, async () => {
        const db = await openMigrated();
        try {
            const workspaceId = await insertWorkspace(db, `cycles-${crypto.randomUUID()}`);
            const sessionId = await insertSession(db, workspaceId);
            const loopId = await insertLoop(db, sessionId, 1, "Observe six results.");
            const schemes = new SchemeRegistry();
            const source = new ObservedContent(changing);
            schemes.register("observed-content", source);
            const engine = new Engine({ db, schemes });
            const provider = new Mock({ contextWindow: 100000, responses: [
                ...Array.from({ length: 6 }, () => turn("````READ (observed-content:///latest)````", status)),
                turn("````SEND [200]\nObserved all six results.\n````", null),
            ] });
            const result = await engine.runLoop({ provider, workspaceId, sessionId, loopId, messages: [], maxTurns: 10 });
            assert.equal(result.result.status, changing ? 200 : 508, JSON.stringify(result.result));
            assert.equal(source.calls, changing ? 6 : 5);
            const reads = (await db.test_log_entries_by_loop.all<{ op: string; scheme: string; rx: string }>({ loop_id: loopId }))
                .filter(({ op, scheme }) => op === "READ" && scheme === "observed-content");
            assert.deepEqual(reads.map(({ rx }) => JSON.parse(rx).content),
                Array.from({ length: source.calls }, (_, index) => `observation ${changing ? index + 1 : 1}`));
            if (!changing) assert.equal(result.result.problem?.type, "https://problems.plurnk.xyz/engine/rails/strike-threshold");
        } finally { await db.close(); }
    });
}

test("{§engine-rails} repeated misses cycle despite unique Problem occurrence addresses", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `cycles-${crypto.randomUUID()}`);
        const sessionId = await insertSession(db, workspaceId);
        const loopId = await insertLoop(db, sessionId, 1, "Read a missing resource.");
        const engine = new Engine({ db, schemes: new SchemeRegistry() });
        const provider = new Mock({ contextWindow: 100000, responses: Array.from({ length: 7 }, () => turn("````READ (workspace:///missing)````")) });
        const result = await engine.runLoop({ provider, workspaceId, sessionId, loopId, messages: [], maxTurns: 10 });
        assert.equal(result.result.status, 508, JSON.stringify(result.result));
        const misses = (await db.test_log_entries_by_loop.all<{ op: string; status_rx: number; rx: string }>({ loop_id: loopId }))
            .filter(({ op, status_rx }) => op === "READ" && status_rx === 404);
        assert.equal(misses.length, 5);
        assert.equal(new Set(misses.map(({ rx }) => JSON.parse(rx).problem.instance)).size, 5);
    } finally { await db.close(); }
});
});

describe("Engine.idle-parks-on-obligation", () => {
// {§send-idle-turn} {§session-causal-admission}








test("{§send-idle-turn} NOTE-only turns continue with or without a stream; only waiting parks", async (approvalContext) => {
    serverProposals(approvalContext, "accept");
    const releaseDir = await mkdtemp(join(tmpdir(), "plurnk-idle-park-"));
    const releasePath = join(releaseDir, "release");
    const priorWait = process.env.PLURNK_SERVICE_OPTIMISTIC_WAIT_MS;
    process.env.PLURNK_SERVICE_OPTIMISTIC_WAIT_MS = "100";
    try {
        const mock = new Mock({ contextWindow: 32768, responses: [
            makeMockResponse(`\`\`\`\`sh
while [ ! -f '${releasePath}' ]; do sleep 0.05; done; printf finished
\`\`\`\`

\`\`\`\`NOTE
started
\`\`\`\``, 50),
            makeMockResponse("````NOTE\nReview the independent work\n````", 50),
            makeMockResponse("````WAIT\nAwait the command\n````", 50),
            makeMockResponse("````SEND [200]\ndone\n````", 50),
            makeMockResponse("````NOTE\nnothing to wait on\n````", 50),
            makeMockResponse("````SEND [200]\nconcluded\n````", 50),
        ] });
        await withDaemon(mock, async (db, _daemon, addr) => {
            const ws = await connect(addr);
            try {
                await rpcCall(ws, 1, "workspace.create", { name: "idle-park" });
                const running = runLoopToTerminal(ws, 2, { prompt: "run and wait" }, { timeoutMs: 20_000 });
                let taskStatuses: number[];
                try {
                    // The park lands the loop's status before the WAIT row's receipt is durable, so
                    // wait for the rows the assertion reads, not for the status.
                    taskStatuses = await waitForDb(
                        async () => (await db.test_ops_by_loop.all<{ op: string; status_rx: number }>({}))
                            .filter(({ op }) => op === "NOTE" || op === "WAIT").map(({ status_rx }) => status_rx),
                        (statuses) => statuses.length === 3,
                    );
                } finally {
                    // Release the command whatever the wait said: a failed assertion must not leave
                    // the loop parked past the end of the test.
                    await writeFile(releasePath, "");
                }
                assert.equal(mock.remaining, 3, "both actionable turns ran before the explicit waiting inventory parked");
                assert.deepEqual(taskStatuses, [200, 200, 202], "two ordinary notes, then an explicit wait");
                const parked = await running;
                assert.equal(parked.result.status, 200, "the loop concludes after the parked turn wakes on the stream's end");
                const errBefore = await db.test_error_rows_for_session.all<{ rx: string }>({ session_id: parked.modelSessionId! });
                assert.deepEqual(errBefore, [], "valid inventory-only work and waiting produced no errors");
                const idle = await runLoopToTerminal(ws, 3, { prompt: "sit" });
                assert.equal(idle.result.status, 200);
                const errAfter = await db.test_error_rows_for_session.all<{ rx: string }>({ session_id: idle.modelSessionId! });
                assert.deepEqual(errAfter, [], "inventory-only work is also valid without a stream");
                assert.equal(mock.remaining, 0, "each explicitly supplied inventory was processed");
            } finally { ws.close(); }
        });
    } finally {
        if (priorWait === undefined) delete process.env.PLURNK_SERVICE_OPTIMISTIC_WAIT_MS;
        else process.env.PLURNK_SERVICE_OPTIMISTIC_WAIT_MS = priorWait;
        await rm(releaseDir, { recursive: true, force: true });
    }
});
});

describe("Engine.join-rails", () => {
const response = (content: string) => ({
    assistant: { content, reasoning: null },
    usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
});
const collect = "````READ (session://child)````\n````WAIT\nCollect the child result.\n````";
// A contract violation that strikes: a third COPY operand ({§extra-path-slot}); a fumbled matcher
// would not ({§matcher-refusal}).
const extraSlotCopy = "````COPY (workspace:///a) (workspace:///b) (workspace:///c)````";

for (const priorStrike of [false, true]) {
    test(`{§session-loop-lifecycle} a complete-loop collect parks without a strike${priorStrike ? " after prior failure" : " at maxStrikes=1"}`, async (t) => {
        const db = await openMigrated();
        t.after(() => db.close());
        const workspaceId = await insertWorkspace(db, "join-rails");
        const sessionId = await insertSession(db, workspaceId);
        const loopId = await insertLoop(db, sessionId, 1, "Collect the child answer.");
        const childId = await insertSession(db, workspaceId, sessionId, "child");
        const childLoop = await insertLoop(db, childId, 1, "Compute the answer.");
        const provider = new Mock({ contextWindow: 100000, responses: [
            ...(priorStrike ? [response(`${extraSlotCopy}
\`\`\`\`WAIT
Await results.
\`\`\`\``)] : []),
            response(collect),
            response(collect),
            response(collect),
            response("````SEND [200]\n42\n````"),
        ] });
        const run = () => new Engine({ db, schemes: new SchemeRegistry() }).runLoop({
            workspaceId, sessionId, loopId, provider, messages: [], maxTurns: 8, maxStrikes: priorStrike ? 2 : 1,
        });
        const lifecycle = new LoopLifecycle(db);
        const rail = new StrikeRail(db);

        if (priorStrike) {
            assert.equal((await run()).result.status, 202);
            assert.equal(await rail.streak(loopId), 1);
            assert.equal(await lifecycle.wake(loopId), true);
            assert.equal(await rail.streak(loopId), 1, "waking does not forgive an earlier contract violation");
        }
        for (let joinIdx = 0; joinIdx < 2; joinIdx++) {
            assert.equal((await run()).result.status, 202, "a not-yet-ready child is a valid join, not a contract failure");
            assert.equal(await rail.streak(loopId), 0, "a clean collect follows ordinary clean-turn accounting");
            assert.equal(provider.received.length, Number(priorStrike) + joinIdx + 1, "no model polling occurs while parked");
            if (joinIdx === 0) assert.equal(await lifecycle.wake(loopId), true);
        }

        await lifecycle.finish(childLoop, TerminalResult.success("42"));
        assert.equal(await lifecycle.wake(loopId), true);
        const result = await run();
        assert.equal(result.result.status, 200);
        assert.equal(result.result.content, undefined);
        assert.equal(await lastReply(db, loopId), "42");
        const rows = await db.test_log_entries_by_loop.all<{ op: string; status_rx: number; rx: string }>({ loop_id: loopId });
        const reads = rows.filter(({ op }) => op === "READ");
        const unfinished = reads.filter(({ status_rx }) => status_rx === 425);
        assert.equal(unfinished.length, 2, "the original not-ready receipts are not erased or relabeled");
        for (const row of unfinished) {
            assert.equal(JSON.parse(row.rx).problem.type, "https://problems.plurnk.xyz/scheme/ops/loop-running");
        }
        assert.ok(reads.some(({ status_rx, rx }) => status_rx === 200 && JSON.parse(rx).content === "42"),
            "resumption collects the child's actual terminal response");
    });
}

test("{§engine-rails} a valid join does not excuse another operation's contract failure", async (t) => {
    const db = await openMigrated();
    t.after(() => db.close());
    const workspaceId = await insertWorkspace(db, "join-with-failure");
    const sessionId = await insertSession(db, workspaceId);
    const loopId = await insertLoop(db, sessionId, 1, "Collect the child answer.");
    const childId = await insertSession(db, workspaceId, sessionId, "child");
    await insertLoop(db, childId, 1, "Compute the answer.");
    const provider = new Mock({ contextWindow: 100000, responses: [response(`${extraSlotCopy}\n${collect}`)] });
    const result = await new Engine({ db, schemes: new SchemeRegistry() }).runLoop({
        workspaceId, sessionId, loopId, provider, messages: [], maxTurns: 2, maxStrikes: 1,
    });
    assert.equal(result.result.status, 500);
    assert.equal(result.result.problem?.type, "https://problems.plurnk.xyz/engine/rails/strike-threshold");
    assert.equal(await new StrikeRail(db).streak(loopId), 1);
    const rows = await db.test_log_entries_by_loop.all<{ status_rx: number }>({ loop_id: loopId });
    assert.ok(rows.some(({ status_rx }) => status_rx === 425), "the valid join receipt survives");
    assert.ok(rows.some(({ status_rx }) => status_rx === 400), "the unrelated invalid pattern survives");
});

test("{§session-loop-lifecycle} the daemon wakes a collecting parent on actual child completion without consuming a strike", async () => {
    const provider = new Mock({ contextWindow: 100000, responses: [
        response("````WAIT\nAwait instructions.\n````"),
        response(collect),
        response("````SEND [200]\nChild answer: 42.\n````\n\n````SEND [200]\nFollow-up acknowledged.\n````"),
        response("````SEND [200]\nChild answer received: 42.\n````"),
    ] });
    await withDaemon(provider, async (db, daemon) => {
        const { workspaceId } = await daemon.createWorkspace({ name: "join-wake-rails" });
        const parentId = await namedModelSession(daemon, workspaceId, "main");
        const parentSession = await daemon.readSession({ workspaceId, identity: { id: parentId } });
        assert.ok(parentSession);
        const { sessionId: childId } = await daemon.forkSession({ workspaceId, sessionId: parentId, name: "child" });
        const held = await holdChild(db, workspaceId, childId);
        const lifecycle = new LoopLifecycle(db);
        try {
            const child = await daemon.runLoop({ workspaceId, sessionId: childId, prompt: "Wait, then answer.", source: `session://${parentSession.name}` });
            await waitForDb(() => lifecycle.status(child.loopId), (status) => status === 202);
            const parent = await daemon.runLoop({ workspaceId, sessionId: parentId, prompt: "Collect the child's answer." });
            await waitForDb(() => lifecycle.status(parent.loopId), (status) => status === 202);
            await lifecycle.finish(held, TerminalResult.success("The held dependency completed."));
            // {§session-obligations} main's own operation sends the follow-up, so the reply to it is main's.
            const resumed = await daemon.inject({
                workspaceId, sessionId: childId, prompt: "Answer now.", source: `session://${parentSession.name}`,
                providerSpec: { alias: "mocktest", provider: "openai", model: "mocktest" }, effort: "adaptive", systemPrompt: "test system",
                opener: await sendingOperation(db, parent.loopId),
            });
            assert.equal(resumed.loopId, child.loopId);
            await waitForDb(() => lifecycle.status(parent.loopId), (status) => status === 200);
            assert.equal((await lifecycle.result(parent.loopId))?.content, undefined);
            assert.equal(await lastReply(db, parent.loopId), "Child answer received: 42.");
            assert.equal(provider.received.length, 4, "actual child completion resumes the same parent loop exactly once");
            const parentRail = await db.test_strike_streak.get<{ strike_streak: number }>({ loop_id: parent.loopId });
            assert.equal(parentRail?.strike_streak, 0, "neither the join nor its wake consumes recovery allowance");
            const delivered = await db.test_log_entries_by_loop.all<{ tx: string; attrs: string; initial_folded: string; folded: string }>({ loop_id: parent.loopId });
            // {§loop-answer}: the child's answer to its parent's own task arrives as the conclusion.
            const conclusion = delivered.find(({ attrs }) => JSON.parse(attrs).kind === "loop_termination");
            assert.ok(conclusion);
            assert.equal(conclusion.initial_folded, "[]", JSON.stringify(conclusion));
            assert.equal(conclusion.folded, "[]", JSON.stringify(conclusion));
            assert.deepEqual(delivered.filter(({ attrs }) => JSON.parse(attrs).kind === "reply").map(({ tx }) => JSON.parse(tx).body.raw),
                ["Follow-up acknowledged."], "the follow-up gets its own reply; the original child answer is not duplicated");
            assert.match(JSON.stringify(provider.received.at(-1)), /Child answer: 42\./,
                "the resumed parent packet contains the child's completed response");
            assert.equal(await new StrikeRail(db).streak(parent.loopId), 0);
            const rows = await db.test_log_entries_by_loop.all<{ op: string; status_rx: number }>({ loop_id: parent.loopId });
            assert.ok(rows.some(({ op, status_rx }) => op === "READ" && status_rx === 425));
        } finally {
            await daemon.cancelSession({ workspaceId, sessionId: parentId });
        }
    });
});
});

describe("Engine.rail-lifecycle", () => {
const response = (operation: string, op: string, timing = "") => ({
    assistant: { content: [
        operation,
        PlurnkParser.frame(`${op}${timing}`, ""),
    ].join("\n"), reasoning: null },
    usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
});
// A contract violation that strikes: a third COPY operand ({§extra-path-slot}); a fumbled matcher
// would not ({§matcher-refusal}).
const extraSlotCopy = "````COPY (workspace:///a) (workspace:///b) (workspace:///c)````";

test("{§engine-rails}: a resumed task retains its strike streak across a wait and engine reconstruction", async (t) => {
    const db = await openMigrated();
    t.after(() => db.close());
    const workspaceId = await insertWorkspace(db, "wait-streak-continuity");
    const sessionId = await insertSession(db, workspaceId);
    const loopId = await insertLoop(db, sessionId, 1, "Read the answer and conclude.");
    const childId = await insertSession(db, workspaceId, sessionId, "child");
    await insertLoop(db, childId, 1, "Live child work the wait joins.");
    await seedEntryWithChannel(db, {
        workspaceId, scheme: "workspace", pathname: "/answer", channel: "body",
        content: "42", mimetype: "text/plain", state: "static",
    });
    const provider = new Mock({ contextWindow: 100000, responses: [
        response(extraSlotCopy, "NOTE"),
        response(extraSlotCopy, "WAIT"),
        response(extraSlotCopy, "NOTE"),
    ] });
    const run = () => new Engine({ db, schemes: new SchemeRegistry() }).runLoop({
        workspaceId, sessionId, loopId, provider, messages: [], maxTurns: 4, maxStrikes: 3,
    });
    assert.equal((await run()).result.status, 202, "two operation-contract strikes, then the park");
    assert.equal(await new LoopLifecycle(db).wake(loopId), true);
    const resumed = await run();
    assert.equal(resumed.result.status, 500, "the third strike crosses the threshold: the streak survived the wait and the engine reconstruction");
    assert.equal(resumed.reason, "strike_threshold");
    assert.equal(provider.received.length, 3);
});

test("{§session-loop-lifecycle}: cancellation wins against a pending strike verdict", async (t) => {
    const db = await openMigrated();
    t.after(() => db.close());
    const workspaceId = await insertWorkspace(db, "rail-cancel-race");
    const sessionId = await insertSession(db, workspaceId);
    const loopId = await insertLoop(db, sessionId, 1, "Perform work.");
    const lifecycle = new LoopLifecycle(db);
    const assess = StrikeRail.prototype.assess;
    t.mock.method(StrikeRail.prototype, "assess", async function (this: StrikeRail, ...args: Parameters<typeof assess>) {
        const verdict = await assess.apply(this, args);
        if (args[0] === loopId && verdict.thresholdCrossed) {
            await lifecycle.finish(loopId, Results.failure("daemon:loop", "cancelled", 499, "Cancelled by the client."), { terminatedBy: "cancel" });
        }
        return verdict;
    });
    const provider = new Mock({ contextWindow: 100000, responses: [response(extraSlotCopy, "NOTE")] });
    const result = await new Engine({ db, schemes: new SchemeRegistry() }).runLoop({
        workspaceId, sessionId, loopId, provider, messages: [], maxTurns: 2, maxStrikes: 1,
    });
    assert.equal(result.result.status, 499);
    assert.equal(result.result.problem?.type, "https://problems.plurnk.xyz/daemon/loop/cancelled");
    assert.equal(result.reason, "external", "the losing rail verdict reports the committed cancellation, not its intended failure");
});
});

describe("Engine.run-loop", () => {
const urlPath = (scheme: string, pathname: string): UrlPath => ({
    kind: "url", raw: `${scheme}://${pathname}`, scheme,
    username: null, password: null, hostname: null, port: null,
    pathname, query: null, fragment: null,
});

const editStmt = (pathname: string, body: string): EditStatement => ({
    metadata: null,
    op: "EDIT", aside: null,
    target: urlPath("workspace", pathname),
    lineMarker: null, body, matcher: null, position: { line: 1, column: 1 },
});

const response = (ops: PlurnkStatement[]): MockResponse => ({
    assistant: { content: "", ops, reasoning: null },
});

const contentResponse = (content: string): MockResponse => ({
    assistant: { content, reasoning: null },
});

const setup = async () => {
    const db = await openMigrated();
    const workspaceId = await insertWorkspace(db, `ws-${crypto.randomUUID()}`);
    const sessionId = await insertSession(db, workspaceId);
    const loopId = await insertLoop(db, sessionId, 1, "test prompt");
    const lifecycle = new LoopLifecycle(db);
    const engine = new Engine({ db, schemes: new SchemeRegistry(), cancelSession: async (id, reason) => { await lifecycle.cancelTree(id, reason, true); } });
    return { db, engine, workspaceId, sessionId, loopId };
};

for (const kind of ["child", "stream"] as const) for (const phase of ["before observation", "after observation", "during inference"] as const) {
test(`{§session-wait-timing}: ${kind} completion ${phase} is acknowledged only by the input that contains it`, async (t) => {
    const { db, engine, workspaceId, sessionId, loopId } = await setup();
    try {
        const lifecycle = new LoopLifecycle(db);
        const parkedLoop = await insertLoop(db, sessionId, 2, "An independent waiting task.");
        await lifecycle.park(parkedLoop, { wakenBy: "test-fixture" });
        let finish: () => Promise<unknown>;
        if (kind === "child") {
            const child = await insertSession(db, workspaceId, sessionId, "child");
            const childLoop = await insertLoop(db, child, 1, "Look up the answer.");
            finish = () => lifecycle.finish(childLoop, { status: 200, content: "The observed answer is 42." });
        } else {
            const entry = await seedEntryWithChannel(db, { workspaceId, scheme: "sh", content: "The observed answer is 42.", state: "active" });
            const subscriptionId = await ChannelWrite.openSubscription(db, { sessionId, entryId: entry, scheme: "exec", handle: "answer" });
            finish = () => ChannelWrite.closeSubscription(db, { subscriptionId, result: { status: 200 } });
        }
        let settled = false;
        const settle = async () => {
            if (!settled) {
                settled = true;
                await finish();
            }
        };
        if (phase === "before observation") {
            const open = Turn.open;
            t.mock.method(Turn, "open", async (...args: Parameters<typeof open>) => {
                const turn = await open(...args);
                if (args[1].loopId === loopId && args[1].producer === "model") await settle();
                return turn;
            });
        } else if (phase === "after observation") {
            const method = kind === "child" ? "materializeEnvironmentDeltas" : "materializeStreamDeltas";
            const materialize = TurnMaterialization.prototype[method];
            t.mock.method(TurnMaterialization.prototype, method, async function (this: TurnMaterialization, ...args: Parameters<typeof materialize>) {
                const rows = await materialize.apply(this, args);
                if (args[0].loopId === loopId) await settle();
                return rows;
            });
        }
        const provider = new Mock({ contextWindow: 100_000, responses: [
            contentResponse("````SEND [200]\nThe answer is 42.\n````"),
            contentResponse(""),
        ] });
        if (phase === "during inference") {
            const generate = provider.generate.bind(provider);
            t.mock.method(provider, "generate", async (...args: Parameters<typeof generate>) => {
                await settle();
                return generate(...args);
            });
        }
        const result = await engine.runLoop({ provider, workspaceId, sessionId, loopId, messages: [] });
        const observed = phase === "before observation";
        assert.equal(JSON.stringify(provider.received[0]).includes("The observed answer is 42."), observed);
        assert.match(JSON.stringify(provider.received.at(-1)), /The observed answer is 42\./, "the terminal evidence reaches the producer before completion");
        assert.equal(result.result.status, 200);
        assert.equal(provider.received.length, observed ? 1 : 2, "exactly one additional inference is required for unseen evidence");
        assert.equal(await new LoopLifecycle(db).wake(parkedLoop, { eventOnly: true }), true, "this loop's acknowledgement cannot consume another loop's wake");
    } finally { await db.close(); }
});
}

test("{§send-premature-terminate} Engine.runLoop: three edits are observed before answered work concludes", async () => {
    const { db, engine, workspaceId, sessionId, loopId } = await setup();
    try {
        const provider = new Mock({
            contextWindow: 100000,
            responses: [
                response([editStmt("/a", "1"), noteStmt("continuing")]),
                response([editStmt("/b", "2"), noteStmt("still going")]),
                response([editStmt("/c", "3"), sendStmt(null, "done")]),
                // {§send-premature-terminate} — the third edit needs observation before conclusion.
                response([completeStmt("done")]),
            ],
        });
        const result = await engine.runLoop({
            provider, workspaceId, sessionId, loopId,
            messages: [{ role: "user", content: "do three steps" }],
        });
        assert.equal(result.turnIds.length, 5, "packetless initialization precedes three edit turns and the observation turn");
        assert.equal(result.result.status, 200);
        assert.equal(result.hitMaxTurns, false);

        for (const [pathname, content] of [["/a", "1"], ["/b", "2"], ["/c", "3"]]) {
            const entry = await db.test_get_channel_by_pathname_scheme.get({ scheme: "workspace", pathname, name: "body" });
            assert.equal(entry?.content, content);
        }

        const loopStatus = (await db.test_get_loop_status.get<{ status: number }>({ id: loopId }))?.status;
        assert.equal(loopStatus, 200);
    } finally { await db.close(); }
});

test("{§loop-terminals} Engine.runLoop: maxTurns hit — force-terminate with 429 and hitMaxTurns flag", async () => {
    const { db, engine, workspaceId, sessionId, loopId } = await setup();
    try {
        const provider = new Mock({
            contextWindow: 100000,
            // Distinct EDIT paths avoid a cycle refusal while testing the turn ceiling.
            responses: Array.from({ length: 10 }, (_, i) => response([editStmt(`/t${i}`, "x"), noteStmt("more")])),
        });
        const result = await engine.runLoop({
            provider, workspaceId, sessionId, loopId, maxTurns: 3,
            messages: [{ role: "user", content: "never terminate" }],
        });
        assert.equal(result.turnIds.length, 4, "packetless initialization does not consume the three-model-turn ceiling");
        assert.equal(result.result.status, 429, "max_turns → 429 Too Many Requests");
        assert.equal(result.hitMaxTurns, true);
        const loopStatus = (await db.test_get_loop_status.get<{ status: number }>({ id: loopId }))?.status;
        assert.equal(loopStatus, 429);
    } finally { await db.close(); }
});

test("{§operator-config-max-turns-ceiling} maxTurns=-1 disables the turn terminator — loop ends on completed inventory, not a cap", async () => {
    const { db, engine, workspaceId, sessionId, loopId } = await setup();
    try {
        // Four continuing turns then completion. A positive cap of 3 would
        // stop at turn 3; -1 must permit the final completed inventory.
        const provider = new Mock({
            contextWindow: 100000,
            responses: [
                response([editStmt("/1", "x"), noteStmt("1")]),
                response([editStmt("/2", "x"), noteStmt("2")]),
                response([editStmt("/3", "x"), noteStmt("3")]),
                response([editStmt("/4", "x"), noteStmt("4")]),
                response([completeStmt("done")]),
            ],
        });
        const result = await engine.runLoop({
            provider, workspaceId, sessionId, loopId, maxTurns: -1,
            messages: [{ role: "user", content: "run until I say done" }],
        });
        assert.equal(result.turnIds.length, 6, "initialization plus all five model turns — no turn cap");
        assert.equal(result.result.status, 200);
        assert.equal(result.hitMaxTurns, false);
    } finally { await db.close(); }
});

test("{§engine-rails} Engine.runLoop: repeated identical NOTE-only turns remain subject to the cycle rail", async () => {
    const { db, engine, workspaceId, sessionId, loopId } = await setup();
    try {
        // {§engine-rails}
        const provider = new Mock({
            contextWindow: 100000,
            responses: Array.from({ length: 5 }, () => contentResponse(
                "\n````NOTE\nidling\n````",
            )),
        });
        const result = await engine.runLoop({ provider, workspaceId, sessionId, loopId, maxTurns: 10, maxStrikes: 2, messages: [] });
        assert.equal(result.result.status, 508, "identical inventory repetition is a cycle, not an idle-operation violation");
        assert.equal(result.result.problem?.type, "https://problems.plurnk.xyz/engine/rails/strike-threshold");
        assert.equal(result.reason, "strike_threshold");
        const errors = await db.test_error_rows_for_session.all<{ rx: string }>({ session_id: sessionId });
        assert.deepEqual(errors, [], "the cycle rail does not invent an idle-operation error");
    } finally { await db.close(); }
});

test("{§completion-joins-live-work} Engine.runLoop: a completion over a live stream joins it — the loop parks, never a false 200", async () => {
    const { db, engine, workspaceId, sessionId, loopId } = await setup();
    try {
        // Seed a live stream the session holds: an open subscription (closed_at NULL) against a real entry.
        const entryId = await seedEntryWithChannel(db, { workspaceId, authority: await SessionName.forId(db, sessionId), pathname: "/live-stream" });
        await db.open_subscription.get<{ id: number }>({ session_id: sessionId, entry_id: entryId, scheme: "exec", handle: "live-1" });
        const provider = new Mock({ contextWindow: 100000, responses: [
            response([completeStmt("all done")]),   // turn 1: a live stream makes this a join → 202 park
            response([noteStmt("Observe the settled stream.")]),
        ] });
        const result = await engine.runLoop({ provider, workspaceId, sessionId, loopId, messages: [] });
        assert.equal(result.turnIds.length, 2, "initialization plus the one model turn: the join parked the loop on its first claim");
        assert.equal(result.result.status, 202, "the loop parked on the live stream, never a false 200");
        assert.equal(provider.remaining, 1, "no further turn runs until the stream concludes and wakes the loop");
        const rows = await db.test_log_entries_by_loop.all<{ op: string; origin: string; status_rx: number; rx: string }>({ loop_id: loopId });
        const modelRows = rows.filter((r) => r.origin === "model");
        assert.deepEqual(modelRows.map(({ op, status_rx }) => [op, status_rx]), [["SEND", 200]],
            "reply delivery succeeds while the loop joins the live stream");
    } finally { await db.close(); }
});

test("{§session-causal-admission} Engine.runLoop: terminates immediately if loop.status is already non-102", async () => {
    const { db, engine, workspaceId, sessionId, loopId } = await setup();
    try {
        await new LoopLifecycle(db).finish(loopId, { status: 200 });
        const provider = new Mock({ contextWindow: 100000, responses: [response([completeStmt("")])] });
        const result = await engine.runLoop({
            provider, workspaceId, sessionId, loopId,
            messages: [],
        });
        assert.deepEqual(result.turnIds, []);
        assert.equal(result.result.status, 200);
        assert.equal(result.hitMaxTurns, false);
        assert.equal(provider.remaining, 1, "provider untouched");
    } finally { await db.close(); }
});

test("{§session-causal-admission} Engine.runLoop: a durable 202 park outranks a later abort observation", async () => {
    const { db, engine, workspaceId, sessionId, loopId } = await setup();
    try {
        await db.test_set_loop_status.run({
            id: loopId,
            status: 202,
            terminal_result: null,
        });
        const controller = new AbortController();
        controller.abort("daemon_stopping");
        const provider = new Mock({ contextWindow: 100000, responses: [] });

        const result = await engine.runLoop({
            provider,
            workspaceId,
            sessionId,
            loopId,
            messages: [],
            signal: controller.signal,
        });

        assert.equal(result.result.status, 202);
        assert.equal(result.reason, "external");
        assert.deepEqual(result.turnIds, []);
        assert.equal(
            (await db.test_get_loop_status.get<{ status: number }>({ id: loopId }))?.status,
            202,
            "shutdown cannot launder a committed park into cancellation",
        );
    } finally { await db.close(); }
});

test("{§session-causal-admission} Engine.runLoop: KILL of the current session cancels its scope", async () => {
    const { db, engine, workspaceId, sessionId, loopId } = await setup();
    try {
        const provider = new Mock({
            contextWindow: 100000,
            responses: [response([noteStmt("thinking")]), response([killStmt({
                ...urlPath("session", ""), raw: `session://${await SessionName.forId(db, sessionId)}`,
                hostname: await SessionName.forId(db, sessionId),
            })])],
        });
        const result = await engine.runLoop({
            provider, workspaceId, sessionId, loopId,
            messages: [{ role: "user", content: "may abort" }],
        });
        assert.equal(result.turnIds.length, 3, "packetless initialization precedes both model turns");
        assert.equal(result.result.status, 499);
        assert.equal(result.hitMaxTurns, false);
    } finally { await db.close(); }
});

test("{§op-methods-op-dispatch} Engine.runLoop: cross-turn state — turn 2 sees what turn 1 wrote", async () => {
    const { db, engine, workspaceId, sessionId, loopId } = await setup();
    try {
        const readStmt = (pathname: string) => ({
            metadata: null,
            op: "READ" as const, aside: null,
            target: urlPath("workspace", pathname),
            lineMarker: null, matcher: null, body: null,
            position: { line: 1, column: 1 },
        });
        const provider = new Mock({
            contextWindow: 100000,
            responses: [
                response([editStmt("/state", "from turn 1"), noteStmt("stored")]),
                // READ continues; its result enters turn 3, where it can be observed.
                response([readStmt("/state"), noteStmt("reading")]),
                response([completeStmt("retrieved")]),
            ],
        });
        const result = await engine.runLoop({
            provider, workspaceId, sessionId, loopId,
            messages: [{ role: "user", content: "store then retrieve" }],
        });
        assert.equal(result.turnIds.length, 4, "packetless initialization precedes three model turns");
        const readLog = await db.test_read_log_entries_for_turn_by_op.get<{ status_rx: number }>({ turn_id: result.turnIds[2], op: "READ" });
        assert.equal(readLog?.status_rx, 200, "READ in turn 2 found the entry written in turn 1");
    } finally { await db.close(); }
});

test("{§methods-loop-cancel} Engine.runLoop: signal abort between turns throws AbortError", async () => {
    const { db, engine, workspaceId, sessionId, loopId } = await setup();
    try {
        const controller = new AbortController();
        const provider = new Mock({
            contextWindow: 100000,
            responses: [response([noteStmt("1")]), response([noteStmt("2")]), response([completeStmt("3")])],
        });
        controller.abort();
        await assert.rejects(
            () => engine.runLoop({ provider, workspaceId, sessionId, loopId, messages: [], signal: controller.signal }),
            { name: "AbortError" },
        );
    } finally { await db.close(); }
});

test("{§lifecycle-terms} Engine.runLoop: turn sequence numbers monotonic", async () => {
    const { db, engine, workspaceId, sessionId, loopId } = await setup();
    try {
        const provider = new Mock({
            contextWindow: 100000,
            responses: [
                response([noteStmt("1")]),
                response([noteStmt("2")]),
                response([completeStmt("3")]),
            ],
        });
        await engine.runLoop({ provider, workspaceId, sessionId, loopId, messages: [] });
        const seqs = await db.test_list_turns_in_loop.all<{ sequence: number }>({ loop_id: loopId });
        assert.deepEqual(seqs.map((s) => s.sequence), [1, 2, 3, 4]);
    } finally { await db.close(); }
});

test("{§problems-loop}: a strike-threshold abandonment names itself in its exact terminal Problem", async () => {
    const db = await openMigrated();
    const engine = new Engine({ db, schemes: new SchemeRegistry() });
    try {
        const workspaceId = await insertWorkspace(db, `ws-strike-${crypto.randomUUID()}`);
        const sessionId = await insertSession(db, workspaceId);
        const loopId = await insertLoop(db, sessionId, 1, "strike out");
        // A bounded heading failure, a third COPY operand, is a hard 400 ({§extra-path-slot}); a fumbled
        // matcher would not strike ({§matcher-refusal}). Distinct paths keep the failures out of cycle detection.
        const provider = new Mock({ contextWindow: 100000, responses: Array.from({ length: 5 }, (_, i) => contentResponse(
            `\`\`\`\`COPY (workspace:///note-${i}) (workspace:///b) (workspace:///c)\`\`\`\`
\`\`\`\`NOTE
going
\`\`\`\``,
        )) });
        const result = await engine.runLoop({ provider, workspaceId, sessionId, loopId, maxTurns: 10, maxStrikes: 2, messages: [] });
        assert.equal(result.result.status, 500, "struck out to the engine's 500");

        assert.equal(result.result.problem?.type, "https://problems.plurnk.xyz/engine/rails/strike-threshold");
        assert.equal(result.result.problem?.turns, 2);
        assert.equal(result.result.problem?.retryable, false);
        assert.equal(result.result.problem?.instance, `ops://${(await db.session_name_by_id.get<{ name: string }>({ session_id: sessionId }))!.name}/1`);
    } finally { await db.close(); }
});

test("{§loop-terminals} the full terminal enumeration names itself — max_turns included", async () => {
    const db = await openMigrated();
    const engine = new Engine({ db, schemes: new SchemeRegistry() });
    try {
        const workspaceId = await insertWorkspace(db, `ws-terminals-${crypto.randomUUID()}`);
        const sessionId = await insertSession(db, workspaceId);
        const loopId = await insertLoop(db, sessionId, 1, "run to the ceiling");
        // A model that works forever (non-terminal SENDs) runs into the configured ceiling.
        const provider = new Mock({ contextWindow: 100000, responses: Array.from({ length: 4 }, () => response([noteStmt("working")])) });
        const result = await engine.runLoop({ provider, workspaceId, sessionId, loopId, maxTurns: 2, maxStrikes: 99, messages: [] });
        assert.equal(result.result.status, 429);
        assert.equal(result.result.problem?.type, "https://problems.plurnk.xyz/engine/rails/max-turns");
        assert.match(result.result.problem?.detail ?? "", /turn ceiling/i);
        assert.equal(result.result.problem?.instance, `ops://${(await db.session_name_by_id.get<{ name: string }>({ session_id: sessionId }))!.name}/1`);
    } finally { await db.close(); }
});
});

describe("Engine.strike-executor-evidence", () => {
// {§engine-rails} {§executor-exit-code} #425 F1 — a red test suite is an answer, never a strike. Every turn runs a
// command that exits 1; each conclusion is a 200 READ carrying its exit code. Under the shipped MAX_STRIKES the
// loop must run through all of them and conclude on the model's own completed inventory.





const maxStrikes = Number(process.env.PLURNK_SERVICE_MAX_STRIKES);

test("{§engine-rails} {§executor-exit-code} consecutive nonzero exits never strike the loop out", async (approvalContext) => {
    serverProposals(approvalContext, "accept");
    assert.ok(Number.isInteger(maxStrikes) && maxStrikes > 0, "PLURNK_SERVICE_MAX_STRIKES must be set for the witness");
    const failing = maxStrikes + 2;
    const mock = new Mock({ contextWindow: 100000, responses: [
        ...Array.from({ length: failing }, (_, i) => makeMockResponse(`\`\`\`\`sh
echo attempt-${i} >&2; exit 1
\`\`\`\`

\`\`\`\`NOTE
fixing the tests
\`\`\`\``, 10)),
        makeMockResponse("````SEND [200]\ngreen\n````", 10),
    ] });
    await withDaemon(mock, async (db, _daemon, addr) => {
        const ws = await connect(addr);
        try {
            await rpcCall(ws, 1, "workspace.create", { name: "strike-evidence" });
            const { finalStatus, turnIds } = await runLoopToTerminal(ws, 2, { prompt: "make the tests pass" });
            assert.equal(finalStatus, 200, `the loop concludes on the model's completed inventory after ${failing} red runs, never the engine's 500`);
            assert.equal(turnIds?.length, failing + 2, "initialization + every failing turn + the concluding turn");
            const rows = await db.test_log_entries_by_loop.all<{ op: string | null; origin: string; status_rx: number; rx: string }>({ loop_id: 1 });
            const answers = rows.filter((r) => r.op === "READ" && r.origin === "_plurnk" && JSON.parse(r.rx).exitCode === 1);
            assert.ok(answers.length >= failing, `every command surfaced as a completion READ carrying its exit code; got ${answers.length}`);
            assert.ok(answers.every((r) => r.status_rx === 200 && JSON.parse(r.rx).problem === undefined), "each completion is a 200 answer with no Problem");
        } finally { ws.close(); }
    });
});
});

describe("provider-recovery", () => {
// {§engine-rails} — a transient provider failure never ends a loop: the turn records the
// failure, backs off, and re-issues its call; when the recovery budget is spent the loop parks
// like a [202] wait and the next prompt resumes it with its log intact.








// A provider whose next `failures` calls drop with a transient network failure.
class Flaky extends Mock {
    failures: number;
    calls = 0;
    readonly requests: string[] = [];
    readonly at: number[] = [];
    constructor(failures: number, signals: readonly number[]) {
        super({
            contextWindow: viableWindow() * 4,
            responses: signals.map((signal) => makeMockResponse(signal === 102
                ? "\n````FIND (workspace:///**)````\n````NOTE\ncontinue\n````"
                : "````SEND [200]\ndone\n````", 20)),
        });
        this.failures = failures;
    }
    override async generate(...args: Parameters<Mock["generate"]>): ReturnType<Mock["generate"]> {
        this.calls += 1;
        this.at.push(Date.now());
        this.requests.push(JSON.stringify(args[0].messages));
        if (this.failures <= 0) return super.generate(...args);
        this.failures -= 1;
        const accounting = { provider: "provider:mock", model: this.model, outcome: "error" as const, cost: { kind: "unknown" as const, reason: "connection reset by peer" } };
        const settle = await args[0].observeRequest?.({ provider: "provider:mock", model: this.model });
        await settle?.(accounting);
        throw new ProviderError("mock", "network_failure", "connection reset by peer", { accounting: [accounting] });
    }
}

type Terminated = { loopId: number; result: { status: number }; turnIds: number[] };

const withEnv = async (overrides: Record<string, string>, run: () => Promise<void>): Promise<void> => {
    const prior = new Map(Object.keys(overrides).map((key) => [key, process.env[key]]));
    Object.assign(process.env, overrides);
    try { await run(); } finally {
        for (const [key, value] of prior) {
            if (value === undefined) delete process.env[key];
            else process.env[key] = value;
        }
    }
};

const untilTerminated = async (events: Terminated[], seen: number): Promise<Terminated> => {
    const start = Date.now();
    while (events.length <= seen) {
        if (Date.now() - start > 60_000) throw new Error("no loop/terminated within 60s");
        await new Promise((resolve) => setTimeout(resolve, 10));
    }
    return events[seen];
};

test("{§engine-rails} two dropped provider calls are absorbed inside the turn; the loop concludes 200", async (approvalContext) => {
    serverProposals(approvalContext, "accept");
    await withEnv({ PLURNK_SERVICE_PROVIDER_RECOVERY: "20000", PLURNK_SERVICE_PROVIDER_RECOVERY_BACKOFF: "10" }, async () => {
        const db = await openMigrated();
        const workspaceId = await insertWorkspace(db, `recovery-${crypto.randomUUID()}`);
        const sessionId = await insertSession(db, workspaceId, null, "primary", "model");
        const provider = new Flaky(2, [102, 200]);
        const daemon = new Daemon({ db, provider });
        await daemon.start();
        const terminated: Terminated[] = [];
        daemon.subscribeToEvents((_w, method, params) => { if (method === "loop/terminated") terminated.push(params as Terminated); });
        try {
            const started = await daemon.runLoop({ workspaceId, sessionId, prompt: "hello" });
            const done = await untilTerminated(terminated, 0);
            assert.equal(done.loopId, started.loopId);
            assert.equal(done.result.status, 200, "the loop concludes despite two dropped calls");
            assert.equal(provider.calls, 4, "two failed calls, the recovered response, and one genuinely new model turn");
            assert.equal(done.turnIds.length, 3, "one initialization turn and two inference turns — recovery never opens a turn");
            const rows = await db.test_log_entries_by_loop.all<{ op: string | null; status_rx: number; origin: string; source: string | null }>({ loop_id: started.loopId });
            const failures = rows.filter((row) => row.source === "provider" && row.status_rx === 503);
            assert.equal(failures.length, 2, "every dropped call is a durable _plurnk problem row");
            assert.equal(
                new Set(provider.requests.slice(0, 3)).size,
                1,
                "same-turn outage recovery reissues the exact frozen model messages",
            );
            assert.notEqual(provider.requests[3], provider.requests[2], "the next admitted turn builds a genuinely new packet");
            assert.match(provider.requests[3], /## Errors/u, "settled provider failures surface normally in the next packet");
            assert.doesNotMatch(provider.requests[3], /retrying in/u, "the next packet carries no stale recovery checkpoint");
            const turnId = done.turnIds[1];
            assert.ok(turnId !== undefined);
            const calls = await db.test_model_calls.all<{ state: string }>({ turn_id: turnId });
            const requests = await db.test_provider_requests.all<{ outcome: string }>({ turn_id: turnId });
            assert.deepEqual(calls.map(({ state }) => state), ["error", "error", "response"]);
            assert.deepEqual(requests.map(({ outcome }) => outcome), ["error", "error", "response"], "request freezing drops no durable failure evidence");
        } finally {
            await daemon.stop();
            await db.close();
        }
    });
});

test("{§engine-rails} a whole-call deadline recovers through the real provider without changing its packet", async (approvalContext) => {
    serverProposals(approvalContext, "accept");
    await withEnv({ PLURNK_SERVICE_PROVIDER_RECOVERY: "20000", PLURNK_SERVICE_PROVIDER_RECOVERY_BACKOFF: "10" }, async () => {
        const requests: string[] = [];
        const provider = new AiSdkProvider({
            model: "deadline-recovery", url: "https://example.test/v1/chat/completions",
            contextWindow: 100_000, fetchTimeoutMs: 50, operationTimeoutMs: 500,
            temperature: null, repeatPenalty: null, effort: { mode: "off", budget: null }, retryAttempts: 3,
            fetch: async (_url, init) => {
                requests.push(requestBody(init));
                if (requests.length === 1) return new Promise<Response>((_resolve, reject) => {
                    init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
                });
                const content = requests.length === 2
                    ? "````FIND (workspace:///**)\n````"
                    : "````SEND [200]\nRecovered.\n````";
                return new Response(`data: ${JSON.stringify({
                    id: `response-${requests.length}`, model: "deadline-recovery",
                    choices: [{ index: 0, delta: { content }, finish_reason: "stop" }],
                    usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 },
                })}\n\ndata: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } });
            },
        });
        const db = await openMigrated();
        const workspaceId = await insertWorkspace(db, `deadline-${crypto.randomUUID()}`);
        const sessionId = await insertSession(db, workspaceId, null, "primary", "model");
        const daemon = new Daemon({ db, provider });
        await daemon.start();
        const terminated: Terminated[] = [];
        daemon.subscribeToEvents((_w, method, params) => { if (method === "loop/terminated") terminated.push(params as Terminated); });
        try {
            const started = await daemon.runLoop({ workspaceId, sessionId, prompt: "Inspect the workspace and conclude." });
            const done = await untilTerminated(terminated, 0);
            assert.equal(done.result.status, 200);
            assert.equal(requests.length, 3, "one expired request, its recovered response, and one new turn");
            assert.equal(requests[0], requests[1], "recovery reissues the exact frozen request");
            assert.notEqual(requests[1], requests[2]);
            const rows = await db.test_log_entries_by_loop.all<{ source: string | null; status_rx: number }>({ loop_id: started.loopId });
            assert.equal(rows.filter((row) => row.source === "provider" && row.status_rx === 504).length, 1);
            const calls = await db.test_model_calls.all<{ state: string }>({ turn_id: done.turnIds[1] });
            const physical = await db.test_provider_requests.all<{ outcome: string; usage_input: number | null }>({ turn_id: done.turnIds[1] });
            assert.deepEqual(calls.map(({ state }) => state), ["error", "response"]);
            assert.deepEqual(physical.map(({ outcome }) => outcome), ["error", "response"]);
            assert.deepEqual(physical.map(({ usage_input }) => usage_input), [null, 100], "unknown usage is not invented during recovery");
        } finally {
            await daemon.stop();
            await db.close();
        }
    });
});

test("{§engine-rails} the panel's ceiling bounds the doubling delay", async (approvalContext) => {
    serverProposals(approvalContext, "accept");
    // A one-second first delay would wait 1 + 2 + 4 + 8 seconds across four failures; a 5 ms ceiling
    // bounds every one of them, so no gap between one call and the next reaches even the first
    // uncapped delay. The gaps are the subject; the daemon's own start and teardown are not timed.
    await withEnv({ PLURNK_SERVICE_PROVIDER_RECOVERY: "20000", PLURNK_SERVICE_PROVIDER_RECOVERY_BACKOFF: "1000", PLURNK_SERVICE_PROVIDER_RECOVERY_BACKOFF_MAX: "5" }, async () => {
        const db = await openMigrated();
        const workspaceId = await insertWorkspace(db, `recovery-${crypto.randomUUID()}`);
        const sessionId = await insertSession(db, workspaceId, null, "primary", "model");
        const provider = new Flaky(4, [102, 200]);
        const daemon = new Daemon({ db, provider });
        await daemon.start();
        const terminated: Terminated[] = [];
        daemon.subscribeToEvents((_w, method, params) => { if (method === "loop/terminated") terminated.push(params as Terminated); });
        try {
            await daemon.runLoop({ workspaceId, sessionId, prompt: "hello" });
            const done = await untilTerminated(terminated, 0);
            assert.equal(done.result.status, 200);
            assert.equal(provider.calls, 6, "four failed calls, the recovered response, and one new model turn");
            const gaps = provider.at.slice(1, 5).map((at, index) => at - provider.at[index]);
            assert.ok(gaps.every((gap) => gap < 1000), `every capped retry gap stays under the first uncapped delay; gaps ${gaps.join(", ")}ms`);
        } finally {
            await daemon.stop();
            await db.close();
        }
    });
});

test("{§engine-rails} a spent recovery budget parks the loop as 202; the next prompt resumes it", async (approvalContext) => {
    serverProposals(approvalContext, "accept");
    await withEnv({ PLURNK_SERVICE_PROVIDER_RECOVERY: "0", PLURNK_SERVICE_PROVIDER_RECOVERY_BACKOFF: "10" }, async () => {
        const db = await openMigrated();
        const workspaceId = await insertWorkspace(db, `recovery-park-${crypto.randomUUID()}`);
        const sessionId = await insertSession(db, workspaceId, null, "primary", "model");
        await ownSession(db, workspaceId, sessionId);
        const provider = new Flaky(99, [200, 200]);
        const daemon = new Daemon({ db, provider });
        await daemon.start();
        const terminated: Terminated[] = [];
        daemon.subscribeToEvents((_w, method, params) => { if (method === "loop/terminated") terminated.push(params as Terminated); });
        try {
            const started = await daemon.runLoop({ workspaceId, sessionId, prompt: "hello" });
            // A parked loop is not terminated: it is the [202] wait, observed on the loop itself.
            const status = async () => (await db.engine_loop_status.get<{ status: number }>({ loop_id: started.loopId }))?.status;
            const start = Date.now();
            while (await status() !== 202) {
                if (Date.now() - start > 60_000) throw new Error(`the loop did not park within 60s (status ${await status()})`);
                await new Promise((resolve) => setTimeout(resolve, 10));
            }
            assert.equal(terminated.length, 0, "parking is not a termination");
            const rows = await db.test_log_entries_by_loop.all<{ status_rx: number; source: string | null }>({ loop_id: started.loopId });
            assert.equal(rows.filter((row) => row.source === "provider" && row.status_rx === 503).length, 1, "the failure that spent the budget is durable");

            // The provider is back: the next prompt wakes the parked loop and it concludes.
            provider.failures = 0;
            const resumed = await daemon.runLoop({ workspaceId, sessionId, prompt: "continue" });
            const done = await untilTerminated(terminated, 0);
            assert.equal(done.result.status, 200, "the resumed loop concludes");
            assert.equal(resumed.loopId, started.loopId, "the parked loop itself resumes — the chain is never dropped");
        } finally {
            await daemon.stop();
            await db.close();
        }
    });
});
});

describe("send-200-failed-ops", () => {
for (const cancel of [false, true]) {
    test(`{§completion-defers-to-results}: a failed operation is observed before ${cancel ? "scope cancellation" : "explicit completion"}`, async (approvalContext) => {
    serverProposals(approvalContext, "accept");
        const mock = new Mock({ contextWindow: 16384, responses: [
            makeMockResponse("\n````KILL (workspace:///no-such-entry)\n````\n````SEND\nThe requested entry does not exist.\n````"),
            makeMockResponse(cancel ? "````KILL (session://alice)\n````" : "````SEND [200]\n````"),
        ] });
        await withDaemon(mock, async (db, daemon) => {
            const { workspaceId } = await daemon.createWorkspace({ name: "failed-op-observation" });
            const { sessionId } = await daemon.createSession({ workspaceId, name: "alice" });
                const result = await daemon.runLoop({ workspaceId, sessionId, prompt: "go" });
                const lifecycle = new LoopLifecycle(db);
                await waitForDb(() => lifecycle.status(result.loopId), (status) => status === (cancel ? 499 : 200));
                // {§turn-record}: cancellation status precedes the self-KILL receipt and turn completion.
                await waitForDb(
                    async () => (await db.test_list_turns_in_loop.all<{ producer: string; completed_at: string | null }>({ loop_id: result.loopId }))
                        .filter(({ producer }) => producer === "model"),
                    (turns) => turns.length === 2 && turns.every(({ completed_at }) => completed_at !== null),
                );
                assert.equal((await lifecycle.result(result.loopId))?.content, undefined);
                assert.equal(await lastReply(db, result.loopId), "The requested entry does not exist.");
                assert.equal(mock.received.length, 2);
                const rows = await db.test_log_entries_by_loop.all<{ op: string; origin: string; status_rx: number; rx: string }>({ loop_id: result.loopId });
                assert.deepEqual(rows.filter(({ origin }) => origin === "model").map(({ op, status_rx }) => [op, status_rx]), [
                    ["KILL", 404], ["SEND", 200], [cancel ? "KILL" : "SEND", 200],
                ]);
                const failure = rows.find(({ op, status_rx }) => op === "KILL" && status_rx === 404)!;
                const problem = JSON.parse(failure.rx).problem;
                assert.match(problem.type, /entry-not-found$/);
                assert.ok(JSON.stringify(mock.received[1]).includes(problem.type), "the actual failure reaches the observation packet");
        });
    });
}
});

describe("strike-progress-immunity", () => {
const response = (content: string) => ({
    assistant: { content, reasoning: null },
    usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
});
// A contract violation that strikes: a third COPY operand ({§extra-path-slot}); a fumbled matcher
// would not ({§matcher-refusal}).
const extraSlotCopy = "````COPY (workspace:///a) (workspace:///b) (workspace:///c)````";
const read = "````READ (workspace:///answer) <1,-1>````";

const loop = async (responses: string[], maxStrikes: number) => {
    const db = await openMigrated();
    const workspaceId = await insertWorkspace(db, `strike-progress-${crypto.randomUUID()}`);
    const sessionId = await insertSession(db, workspaceId);
    const loopId = await insertLoop(db, sessionId, 1, "Read the answer and conclude.");
    await seedEntryWithChannel(db, { workspaceId, scheme: "workspace", pathname: "/answer", channel: "body", content: "42", mimetype: "text/plain", state: "static" });
    const provider = new Mock({ contextWindow: 100000, responses: responses.map(response) });
    const result = await new Engine({ db, schemes: new SchemeRegistry() }).runLoop({ workspaceId, sessionId, loopId, provider, messages: [], maxTurns: responses.length + 1, maxStrikes });
    return { db, loopId, result };
};

// The recorded shape (#853, glm): a turn whose READ succeeded beside a hard 400 struck, and two such
// turns ended productive loops.
test("{§engine-rails}: a hard 400 beside a successful READ neither strikes nor survives into the streak", async () => {
    const { db, loopId, result } = await loop([`${extraSlotCopy}\n${read}`, extraSlotCopy, `${extraSlotCopy}\n${read}`, "````SEND [200]\n42\n````"], 2);
    try {
        assert.equal(result.result.status, 200, "no productive turn struck, and the lone failing turn was forgiven by the next productive one");
        assert.equal(await new StrikeRail(db).streak(loopId), 0);
    } finally { await db.close(); }
});

test("{§engine-rails}: failures beside only NOTE and WAIT still strike", async () => {
    const { db, result } = await loop([`${extraSlotCopy}\n\`\`\`\`NOTE\nthinking\n\`\`\`\``, `${extraSlotCopy}\nprose outside the fence`], 2);
    try {
        assert.equal(result.result.status, 500);
        assert.equal(result.result.problem?.type, "https://problems.plurnk.xyz/engine/rails/strike-threshold");
    } finally { await db.close(); }
});
});
