import test, { describe } from "node:test";
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import LoopLifecycle from "../../src/core/LoopLifecycle.ts";
import Results, { OperationFailureError } from "../../src/core/results.ts";
import Turn from "../../src/core/Turn.ts";
import LoopDriver from "../../src/core/LoopDriver.ts";
import Daemon from "../../src/server/Daemon.ts";
import ProviderInstantiate from "../../src/core/ProviderInstantiate.ts";
import DrainSupervisor from "../../src/server/DrainSupervisor.ts";
import Engine from "../../src/core/Engine.ts";
import SchemeRegistry from "../../src/core/SchemeRegistry.ts";
import LoopDocs from "../../src/server/loopDocs.ts";
import { insertLoop, insertSession, insertWorkspace, openMigrated, holdChild, insertTurn } from "./_db.ts";
import { serverProposals } from "./_approval.ts";
import { Mock, type ChatMessage, type Provider, type ProviderResponse, type InputModality, chatMessageText, type ProviderSpec } from "@plurnk/plurnk-providers";
import { makeMockResponse } from "./_mock.ts";
import { waitForDb, withDaemon, rpcCall, subscribeNotifications, connect, waitFor, runLoopToTerminal } from "./_rpc.ts";
import { namedModelSession, admitTogether } from "./_sessions.ts";
import { viableWindow, testProviderCapacity } from "./_provider.ts";
import { type Executor } from "@plurnk/plurnk-execs";
import { completeStmt, dispositionStmt } from "./_dsl.ts";
import { DEFAULT_MIMETYPES } from "./_scheme.ts";
import { mountMemoryTracing } from "./_observe-memory.ts";
import { Module, type SchedulerTimers } from "@plurnk/plurnk-schedule";
import { type FunctionalityListResult } from "@plurnk/plurnk-contracts";

describe("optimistic-settlement", () => {
// {§session-causal-admission} — terminal stream and child arrivals remain
// independent durable wake edges while one bounded session-local opportunity
// coalesces provider dispatch over sibling obligations.

const requestAccounting = {
    provider: "provider:controlled-settlement",
    model: "controlled-settlement",
    outcome: "response",
    usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
    cost: { kind: "estimated", amount: { amount: "0", currency: "USD" }, source: "controlled fixture" },
} as const;

const response = (
    content: string,
    capacity: ProviderResponse["capacity"],
    grammar?: string,
): ProviderResponse => {
    return {
        assistant: {
            content,
            reasoning: null,
            finishReason: "stop",
            model: "controlled-settlement",
        },
        assistantRaw: null,
        accounting: [requestAccounting],
        capacity,
        ...(grammar === undefined
            ? {}
            : { grammarEvidence: { input: content, contentStart: 0, transported: true } }),
    };
};

class ControlledSessionProvider implements Provider {
    readonly contextWindow = 100_000;
    readonly maxInputTokens = null;
    readonly maxOutputTokens = null;
    readonly outputBudget = 1;
    readonly reasoningBudget = null;
    readonly supportedEfforts = ["off", "adaptive", "low", "medium", "high"] as const;
    readonly inputCapacity = this.contextWindow - this.outputBudget;
    readonly outputFloor = null;
    readonly inputWall = null;
    readonly model = "controlled-settlement";
    readonly inputModalities: ReadonlySet<InputModality> = new Set();
    readonly childrenStarted = Promise.withResolvers<void>();
    readonly #parentTurns: readonly string[];
    readonly #parentStarts: Array<PromiseWithResolvers<void>>;
    readonly #childReleases: Array<PromiseWithResolvers<void>>;
    readonly #parentMessages: ChatMessage[][] = [];
    readonly #parentStartedAt: number[] = [];
    #parentCalls = 0;
    #childCalls = 0;

    constructor({ parentTurns, childCount }: { parentTurns: readonly string[]; childCount: number }) {
        this.#parentTurns = parentTurns;
        this.#parentStarts = parentTurns.map(() => Promise.withResolvers<void>());
        this.#childReleases = Array.from({ length: childCount }, () => Promise.withResolvers<void>());
        if (childCount === 0) this.childrenStarted.resolve();
    }

    get parentCalls(): number { return this.#parentCalls; }
    get childCalls(): number { return this.#childCalls; }
    parentMessages(call: number): readonly ChatMessage[] { return this.#parentMessages[call - 1] ?? []; }
    parentStartedAt(call: number): number | undefined { return this.#parentStartedAt[call - 1]; }
    waitForParentCall(call: number): Promise<void> {
        const started = this.#parentStarts[call - 1];
        if (started === undefined) throw new RangeError(`No parent turn ${call} is configured.`);
        return started.promise;
    }

    countPromptTokens(messages: readonly ChatMessage[]) {
        return Promise.resolve({
            kind: "exact" as const,
            tokens: messages.reduce((sum, { content }) => sum + Math.ceil(content.length / 2), 0),
            source: "controlled-settlement:chars2",
        });
    }

    async assessRequestCapacity(messages: readonly ChatMessage[]) {
        return testProviderCapacity(messages, this.contextWindow, this.outputBudget);
    }

    #parentIdentity: string | undefined;

    async generate({
        messages,
        sessionId,
        signal,
        grammar,
        observeRequest,
    }: Parameters<Provider["generate"]>[0]): Promise<ProviderResponse> {
        signal?.throwIfAborted();
        const capacity = await this.assessRequestCapacity(messages);
        const settle = await observeRequest?.({
            provider: requestAccounting.provider,
            model: requestAccounting.model,
        });
        // The parent session is whoever calls first; children spawn from its turn.
        this.#parentIdentity ??= sessionId;
        if (sessionId === this.#parentIdentity) {
            const index = this.#parentCalls++;
            const content = this.#parentTurns[index];
            if (content === undefined) throw new Error(`Unexpected parent provider call ${index + 1}.`);
            this.#parentMessages[index] = messages;
            this.#parentStartedAt[index] = performance.now();
            this.#parentStarts[index]?.resolve();
            await settle?.(requestAccounting);
            return response(content, capacity, grammar);
        }

        const index = this.#childCalls++;
        if (index >= this.#childReleases.length) throw new Error(`Unexpected child provider call ${index + 1}.`);
        if (this.#childCalls === this.#childReleases.length) this.childrenStarted.resolve();
        await this.#childReleases[index].promise;
        signal?.throwIfAborted();
        await settle?.(requestAccounting);
        return response(`\`\`\`\`SEND [200]
child ${index + 1} done
\`\`\`\``, capacity, grammar);
    }

    releaseChild(index: number): void {
        this.#childReleases[index]?.resolve();
    }

    releaseAll(): void {
        for (const release of this.#childReleases) release.resolve();
    }
}

test("{§session-causal-admission} near-simultaneous child conclusions share one parent provider turn", async (approvalContext) => {
    serverProposals(approvalContext, "accept");
    const previous = process.env.PLURNK_SERVICE_OPTIMISTIC_WAIT_MS;
    process.env.PLURNK_SERVICE_OPTIMISTIC_WAIT_MS = "500";
    const provider = new ControlledSessionProvider({
        childCount: 2,
        parentTurns: [
            "````WORK (session://first)\nfinish first\n\n````\n"
            + "````WORK (session://second)\nfinish second\n\n````\n"
            + "````WAIT\nwaiting for both\n````",
            "````SEND [200]\nboth children landed\n````",
        ],
    });
    try {
        await withDaemon(provider, async (_db, _daemon, addr) => {
            const ws = await connect(addr);
            try {
                await rpcCall(ws, 1, "workspace.create", { name: "optimistic-child-fanout" });
                const terminated = subscribeNotifications(ws, "loop/terminated");
                const accepted = await rpcCall(ws, 2, "loop.run", {
                    prompt: "delegate two independent jobs and await both",
                });
                const parentLoopId = (accepted.result as { loopId: number }).loopId;
                await provider.childrenStarted.promise;

                provider.releaseChild(0);
                await waitFor(
                    () => terminated() as Array<{ loopId: number; result: { status: number } }>,
                    (events) => events.some(({ loopId }) => loopId !== parentLoopId),
                );
                const resumedBeforeSibling = await Promise.race([
                    provider.waitForParentCall(2).then(() => true),
                    delay(200, false),
                ]);
                assert.equal(
                    resumedBeforeSibling,
                    false,
                    "the first child conclusion holds provider dispatch while its sibling remains in flight",
                );

                provider.releaseChild(1);
                const events = await waitFor(
                    () => terminated() as Array<{ loopId: number; result: { status: number } }>,
                    (items) => items.some(({ loopId }) => loopId === parentLoopId),
                    { timeoutMs: 5_000 },
                );
                const parent = events.find(({ loopId }) => loopId === parentLoopId);
                assert.equal(parent?.result.status, 200);
                assert.equal(provider.childCalls, 2);
                assert.equal(provider.parentCalls, 2, "both child returns cost one resumed parent turn");
                const resumedPacket = provider.parentMessages(2).map((message) => chatMessageText(message)).join("\n");
                assert.match(resumedPacket, /child 1 done/);
                assert.match(resumedPacket, /child 2 done/);
            } finally {
                provider.releaseAll();
                ws.close();
            }
        });
    } finally {
        provider.releaseAll();
        if (previous === undefined) delete process.env.PLURNK_SERVICE_OPTIMISTIC_WAIT_MS;
        else process.env.PLURNK_SERVICE_OPTIMISTIC_WAIT_MS = previous;
    }
});

test("{§session-causal-admission} a lone child conclusion resumes immediately without paying the settlement cap", async (approvalContext) => {
    serverProposals(approvalContext, "accept");
    const previous = process.env.PLURNK_SERVICE_OPTIMISTIC_WAIT_MS;
    process.env.PLURNK_SERVICE_OPTIMISTIC_WAIT_MS = "500";
    const provider = new ControlledSessionProvider({
        childCount: 1,
        parentTurns: [
            "````WORK (session://only)\nfinish the only job\n````\n\n````WAIT\nwaiting\n````",
            "````SEND [200]\nonly child landed\n````",
        ],
    });
    try {
        await withDaemon(provider, async (db, _daemon, addr) => {
            const ws = await connect(addr);
            try {
                await rpcCall(ws, 1, "workspace.create", { name: "optimistic-child-single" });
                const terminated = subscribeNotifications(ws, "loop/terminated");
                const accepted = await rpcCall(ws, 2, "loop.run", {
                    prompt: "delegate one job and await it",
                });
                const parentLoopId = (accepted.result as { loopId: number }).loopId;
                await provider.childrenStarted.promise;
                await waitForDb(
                    async () => (await db.test_get_loop_status.get<{ status: number }>({ id: parentLoopId }))?.status,
                    (status) => status === 202,
                );

                const releasedAt = performance.now();
                provider.releaseChild(0);
                await provider.waitForParentCall(2);
                assert.ok(
                    performance.now() - releasedAt < 350,
                    "without a sibling obligation, the completion wake bypasses the 500ms hold",
                );
                await waitFor(
                    () => terminated() as Array<{ loopId: number; result: { status: number } }>,
                    (events) => events.some(({ loopId, result }) => loopId === parentLoopId && result.status === 200),
                );
                assert.equal(provider.parentCalls, 2);
            } finally {
                provider.releaseAll();
                ws.close();
            }
        });
    } finally {
        provider.releaseAll();
        if (previous === undefined) delete process.env.PLURNK_SERVICE_OPTIMISTIC_WAIT_MS;
        else process.env.PLURNK_SERVICE_OPTIMISTIC_WAIT_MS = previous;
    }
});

test("{§session-causal-admission} stream conclusions coalesce across the same session-local settlement window", async (approvalContext) => {
    serverProposals(approvalContext, "accept");
    const previous = process.env.PLURNK_SERVICE_OPTIMISTIC_WAIT_MS;
    process.env.PLURNK_SERVICE_OPTIMISTIC_WAIT_MS = "200";
    const provider = new Mock({
        contextWindow: 100_000,
        responses: [
            makeMockResponse(
                "````sh\nsleep 0.25; echo first-stream\n\n````\n"
                + "````sh\nsleep 0.40; echo second-stream\n\n````\n"
                + "````WAIT\nwaiting for both streams\n````",
            ),
            makeMockResponse("````SEND [200]\nboth streams landed\n````"),
        ],
    });
    try {
        await withDaemon(provider, async (_db, _daemon, addr) => {
            const ws = await connect(addr);
            try {
                await rpcCall(ws, 1, "workspace.create", { name: "optimistic-stream-fanout" });
                const result = await runLoopToTerminal(ws, 2, {
                    prompt: "run two independent streams and await both",
                });
                assert.equal(result.finalStatus, 200);
                assert.equal(provider.remaining, 0, "two stream conclusions cost one resumed provider turn");
            } finally {
                ws.close();
            }
        });
    } finally {
        if (previous === undefined) delete process.env.PLURNK_SERVICE_OPTIMISTIC_WAIT_MS;
        else process.env.PLURNK_SERVICE_OPTIMISTIC_WAIT_MS = previous;
    }
});

test("{§session-causal-admission} a child and stream conclusion share the same settlement window", async (approvalContext) => {
    serverProposals(approvalContext, "accept");
    const previous = process.env.PLURNK_SERVICE_OPTIMISTIC_WAIT_MS;
    process.env.PLURNK_SERVICE_OPTIMISTIC_WAIT_MS = "300";
    const provider = new ControlledSessionProvider({
        childCount: 1,
        parentTurns: [
            "````WORK (session://child)\nfinish independently\n\n````\n"
            + "````sh\nsleep 0.50; echo stream-done\n\n````\n"
            + "````WAIT\nwaiting for child and stream\n````",
            "````SEND [200]\nchild and stream landed\n````",
        ],
    });
    try {
        await withDaemon(provider, async (db, _daemon, addr) => {
            const ws = await connect(addr);
            try {
                await rpcCall(ws, 1, "workspace.create", { name: "optimistic-mixed-fanout" });
                const terminated = subscribeNotifications(ws, "loop/terminated");
                const accepted = await rpcCall(ws, 2, "loop.run", {
                    prompt: "run one child and one stream and await both",
                });
                const parentLoopId = (accepted.result as { loopId: number }).loopId;
                await provider.childrenStarted.promise;
                await waitForDb(
                    async () => (await db.test_get_loop_status.get<{ status: number }>({ id: parentLoopId }))?.status,
                    (status) => status === 202,
                );
                provider.releaseChild(0);

                await waitFor(
                    () => terminated() as Array<{ loopId: number; result: { status: number } }>,
                    (events) => events.some(({ loopId, result }) => loopId === parentLoopId && result.status === 200),
                    { timeoutMs: 5_000 },
                );
                assert.equal(provider.parentCalls, 2, "mixed asynchronous returns cost one resumed parent turn");
                const resumedPacket = provider.parentMessages(2).map((message) => chatMessageText(message)).join("\n");
                assert.match(resumedPacket, /child 1 done/);
                assert.match(resumedPacket, /stream-done/);
            } finally {
                provider.releaseAll();
                ws.close();
            }
        });
    } finally {
        provider.releaseAll();
        if (previous === undefined) delete process.env.PLURNK_SERVICE_OPTIMISTIC_WAIT_MS;
        else process.env.PLURNK_SERVICE_OPTIMISTIC_WAIT_MS = previous;
    }
});

test("{§session-causal-admission} the settlement deadline is bounded and does not slide on later conclusions", async (approvalContext) => {
    serverProposals(approvalContext, "accept");
    const previous = process.env.PLURNK_SERVICE_OPTIMISTIC_WAIT_MS;
    process.env.PLURNK_SERVICE_OPTIMISTIC_WAIT_MS = "500";
    const provider = new ControlledSessionProvider({
        childCount: 3,
        parentTurns: [
            "````WORK (session://first)\nfinish first\n\n````\n"
            + "````WORK (session://second)\nfinish second\n\n````\n"
            + "````WORK (session://third)\nfinish third\n\n````\n"
            + "````WAIT\nwaiting for all three\n````",
            "````WAIT\ntwo landed; still waiting\n````",
            "````SEND [200]\nall three landed\n````",
        ],
    });
    const windowOpened = Promise.withResolvers<void>();
    const secondArrival = Promise.withResolvers<void>();
    const settle = DrainSupervisor.prototype.settleCompletionWake;
    let arrivals = 0;
    approvalContext.mock.method(DrainSupervisor.prototype, "settleCompletionWake", function (
        this: DrainSupervisor, ...args: Parameters<typeof settle>
    ) {
        const pending = settle.apply(this, args);
        if (++arrivals === 2) secondArrival.resolve();
        return pending;
    });
    const tracing = await mountMemoryTracing((span) => {
        if (span.name !== "session.wake.settlement") return;
        approvalContext.mock.timers.enable({ apis: ["setTimeout"] });
        windowOpened.resolve();
    });
    try {
        await withDaemon(provider, async (db, _daemon, addr) => {
            const ws = await connect(addr);
            try {
                await rpcCall(ws, 1, "workspace.create", { name: "optimistic-non-sliding" });
                const terminated = subscribeNotifications(ws, "loop/terminated");
                const accepted = await rpcCall(ws, 2, "loop.run", {
                    prompt: "delegate three jobs and await all three",
                });
                const parentLoopId = (accepted.result as { loopId: number }).loopId;
                await provider.childrenStarted.promise;
                await waitForDb(
                    async () => (await db.test_get_loop_status.get<{ status: number }>({ id: parentLoopId }))?.status,
                    (status) => status === 202,
                );

                provider.releaseChild(0);
                await windowOpened.promise;
                approvalContext.mock.timers.tick(350);
                provider.releaseChild(1);
                await secondArrival.promise;
                approvalContext.mock.timers.tick(149);
                assert.equal((await db.test_get_loop_status.get<{ status: number }>({ id: parentLoopId }))?.status, 202,
                    "the parent remains parked before the original deadline while one child is still live");
                assert.equal(provider.parentCalls, 1);
                assert.equal(tracing.spans().some(({ name }) => name === "session.wake.settlement"), false,
                    "the opportunity has not expired at 499ms");
                approvalContext.mock.timers.tick(1);
                approvalContext.mock.timers.reset();
                await provider.waitForParentCall(2);
                const window = tracing.spans().find(({ name }) => name === "session.wake.settlement");
                assert.equal(window?.attributes.release, "deadline");
                assert.equal(window?.attributes.conclusions, 2,
                    "the second arrival shares the first deadline, rather than starting a new opportunity");
                const resumedPacket = provider.parentMessages(2).map((message) => chatMessageText(message)).join("\n");
                assert.match(resumedPacket, /child 1 done/);
                assert.match(resumedPacket, /child 2 done/);
                assert.doesNotMatch(resumedPacket, /child 3 done/);
                await waitForDb(
                    async () => (await db.test_get_loop_status.get<{ status: number }>({ id: parentLoopId }))?.status,
                    (status) => status === 202,
                );

                provider.releaseChild(2);
                await waitFor(
                    () => terminated() as Array<{ loopId: number; result: { status: number } }>,
                    (events) => events.some(({ loopId, result }) => loopId === parentLoopId && result.status === 200),
                    { timeoutMs: 5_000 },
                );
                assert.equal(provider.parentCalls, 3, "deadline wake plus final lone-child wake are the only resumptions");
            } finally {
                approvalContext.mock.timers.reset();
                provider.releaseAll();
                ws.close();
            }
        });
    } finally {
        approvalContext.mock.timers.reset();
        provider.releaseAll();
        await tracing.shutdown();
        if (previous === undefined) delete process.env.PLURNK_SERVICE_OPTIMISTIC_WAIT_MS;
        else process.env.PLURNK_SERVICE_OPTIMISTIC_WAIT_MS = previous;
    }
});
});

describe("scheduled-occurrence", () => {
const INITIAL = Date.UTC(2026, 8, 17, 12, 0, 0, 250);

test("{§functionality-coordinator} schedule startup rejects malformed persisted enabledness before arming", async (t) => {
    const db = await openMigrated();
    const workspaceId = await insertWorkspace(db, "invalid-schedule-state");
    await db.workspace_module_state_put.run({
        workspace_id: workspaceId,
        namespace_owner: "@plurnk/plurnk-schedule",
        state: JSON.stringify({ version: 1, definitions: { beat: {
            origin: "workspace", enabled: "false",
            definition: { rule: "DTSTART;TZID=UTC:20260917T120001\nRRULE:FREQ=HOURLY;COUNT=2", target: "session://recipient", prompt: "Must not fire." },
        } } }),
    });
    const timers: SchedulerTimers = { set: () => assert.fail("malformed state must not arm a timer"), clear: () => {} };
    const module = Module.init({ env: { ...process.env, TZ: "UTC", PLURNK_SCHEDULE_ENABLED: "1" }, clock: () => INITIAL, timers });
    const daemon = new Daemon({ db, provider: null });
    daemon.registerModule(module, "@plurnk/plurnk-schedule");
    t.after(async () => { await daemon.stop(); await db.close(); });
    await assert.rejects(daemon.start(), {
        name: "Error", message: "Functionality state for schedule alias 'beat' is malformed.",
    });
});

test("{§schedule-residency} restart arms the coordinator's complete definitions and per-workspace enabledness", async (t) => {
    serverProposals(t, "accept");
    const db = await openMigrated();
    const baseline = {
        rule: "DTSTART;TZID=UTC:20260917T120001\nRRULE:FREQ=HOURLY",
        target: "session://recipient", prompt: "Baseline.",
    };
    const replacement = { rule: `${baseline.rule};COUNT=2`, target: "session://alternate", prompt: "Workspace override." };
    const instances: Daemon[] = [];
    const start = async () => {
        const module = Module.init({
            env: { ...process.env, TZ: "UTC", PLURNK_SCHEDULE_ENABLED: "1", PLURNK_SCHEDULE_beat: JSON.stringify(baseline) },
            clock: () => INITIAL, timers: { set: () => Symbol("occurrence"), clear: () => {} },
        });
        const daemon = new Daemon({ db, provider: null });
        instances.push(daemon);
        daemon.registerModule(module, "@plurnk/plurnk-schedule");
        await daemon.start();
        return { daemon, module };
    };
    t.after(async () => { for (const daemon of instances) await daemon.stop(); await db.close(); });
    const first = await start();
    const alice = await insertWorkspace(db, "schedule-alice");
    const bob = await insertWorkspace(db, "schedule-bob");
    const charlie = await insertWorkspace(db, "schedule-charlie");
    const invoke = (workspaceId: number, verb: string, params = {}) => first.daemon.invokeModuleAction(
        `workspace.schedule.${verb}`, params, { scope: "workspace", workspaceId },
    );
    await invoke(alice, "add", { alias: "beat", ...replacement });
    await invoke(alice, "add", { alias: "muted", ...replacement });
    await invoke(alice, "disable", { alias: "muted" });
    await invoke(bob, "disable", { alias: "beat" });
    await invoke(bob, "add", { alias: "private", ...replacement });
    await first.daemon.stop();

    const restored = await start();
    for (const [workspaceId, aliases] of [[alice, ["beat"]], [bob, ["private"]], [charlie, ["beat"]]] as const) {
        const listing = await restored.daemon.invokeModuleAction("workspace.schedule.list", {}, { scope: "workspace", workspaceId }) as FunctionalityListResult;
        assert.deepEqual(listing.definitions.filter(({ state }) => state !== "disabled").map(({ alias }) => alias), aliases);
        assert.deepEqual(restored.module.functionality.scheduler.armed(workspaceId), aliases,
            "restart and passive inspection must agree without demanding workspace residency");
        assert.ok(listing.definitions.every(({ state }) => state === "disabled" || state === "dormant"),
            "arming a durable obligation does not prepare the workspace's capabilities");
        assert.deepEqual(listing.definitions.find(({ alias }) => alias === "beat")?.definition,
            workspaceId === alice ? replacement : baseline, "the local rule does not inherit baseline policy or message fields");
    }
});

// {§schedule-delivery} — a composed daemon with one hourly rule targeting the recipient session; the
// scheduler's timers are the test's, so an occurrence fires when the test says so.
test("{§schedule-delivery}: an occurrence after conclusion starts a successor loop", { timeout: 30_000 }, async () => {
    const db = await openMigrated();
    const provider = new Mock({ contextWindow: 65536, responses: [
        "````SEND [200]\nDone for now; the reminder will start its own loop.\n````",
        "````SEND [200]\nReceived scheduled-proof.\n````",
    ].map((content) => ({ assistant: { content, reasoning: null } })) });
    let now = INITIAL;
    let serial = 0;
    const timers = new Map<number, { callback: () => void; due: number }>();
    const timerApi: SchedulerTimers = {
        set: (callback, delayMs) => { const id = ++serial; timers.set(id, { callback, due: now + delayMs }); return id; },
        clear: (id) => { timers.delete(id as number); },
    };
    const module = Module.init({ env: { ...process.env, TZ: "UTC", PLURNK_SCHEDULE_ENABLED: "1" }, clock: () => now, timers: timerApi });
    const daemon = new Daemon({ db, provider });
    daemon.registerModule(module, "@plurnk/plurnk-schedule");
    await daemon.start();
    try {
        const { workspaceId } = await daemon.createWorkspace({ name: "scheduled-occurrence", projectRoot: null });
        const { sessionId, sessionName } = await daemon.createSession({ workspaceId, name: "recipient" });
        const added = await daemon.invokeModuleAction("workspace.schedule.add", {
            alias: "reminder", rule: "FREQ=HOURLY;COUNT=2", target: `session://${sessionName}`, prompt: "scheduled-proof",
        }, { scope: "workspace", workspaceId }) as { status: number };
        assert.equal(added.status, 201);

        const lifecycle = new LoopLifecycle(db);
        const first = await daemon.runLoop({ workspaceId, sessionId, prompt: "Reply now; the reminder is scheduled." });
        await waitForDb(() => lifecycle.status(first.loopId), (status) => status === 200 || status >= 400);
        assert.equal(await lifecycle.status(first.loopId), 200, "a loop with nothing live concludes; the schedule holds nothing");
        assert.deepEqual(module.functionality.scheduler.armed(workspaceId), ["reminder"], "the rule stays armed on its own");

        const next = [...timers.entries()].toSorted((a, b) => a[1].due - b[1].due)[0];
        assert.ok(next, "the scheduler has an armed occurrence");
        now = next[1].due;
        timers.delete(next[0]);
        next[1].callback();

        await waitForDb(async () => provider.received.length, (calls) => calls >= 2);
        assert.match(JSON.stringify(provider.received[1]), /scheduled-proof/u, "the occurrence arrives as a message and runs a loop");
        const loops = await daemon.listSessionLoops({ workspaceId, sessionId });
        await waitForDb(async () => (await daemon.listSessionLoops({ workspaceId, sessionId })).filter(({ status }) => status === 200).length, (done) => done === 2);
        assert.equal(loops.length, 2, "the occurrence started a second loop on the same session");
        assert.deepEqual(module.functionality.scheduler.armed(workspaceId), ["reminder"], "the next recurrence armed from the delivery");
    } finally { await daemon.stop(); await db.close(); }
});

test("{§schedule-delivery} {§session-wait-timing}: an occurrence wakes a genuinely parked loop and arrives there exactly once", { timeout: 30_000 }, async () => {
    const db = await openMigrated();
    const provider = new Mock({ contextWindow: 65536, responses: [
        { assistant: { content: "```WAIT [600]\nWaiting for the child.\n```", reasoning: null } },
        { assistant: { content: "```NOTE\nReceived the scheduled message.\n```\n\n```WAIT [600]\nThe child is still running.\n```", reasoning: null } },
    ] });
    let now = INITIAL;
    let serial = 0;
    const timers = new Map<number, { callback: () => void; due: number }>();
    const module = Module.init({
        env: { ...process.env, TZ: "UTC", PLURNK_SCHEDULE_ENABLED: "1" }, clock: () => now,
        timers: {
            set: (callback, delayMs) => { const id = ++serial; timers.set(id, { callback, due: now + delayMs }); return id; },
            clear: (id) => { timers.delete(id as number); },
        },
    });
    const daemon = new Daemon({ db, provider });
    daemon.registerModule(module, "@plurnk/plurnk-schedule");
    await daemon.start();
    try {
        const { workspaceId } = await daemon.createWorkspace({ name: "scheduled-parked-arrival", projectRoot: null });
        const { sessionId, sessionName } = await daemon.createSession({ workspaceId, name: "recipient" });
        await holdChild(db, workspaceId, sessionId);
        const accepted = await daemon.runLoop({ workspaceId, sessionId, prompt: "Wait for the child." });
        const lifecycle = new LoopLifecycle(db);
        await waitForDb(() => lifecycle.status(accepted.loopId), (status) => status === 202);
        assert.equal(provider.received.length, 1, "a real parked loop, not a WAIT receipt that merely says continue");

        // The parking turn still holds the workspace gate for a moment after the loop's status row
        // says 202. A capability change in that window is answered `workspace-busy`, 409 and
        // retryable, and this witness retries it as a client would (#1117).
        const added = await waitForDb(async (): Promise<{ status: number } | null> => {
            try {
                return await daemon.invokeModuleAction("workspace.schedule.add", {
                    alias: "reminder", rule: "FREQ=HOURLY;COUNT=1", target: `session://${sessionName}`, prompt: "scheduled-proof",
                }, { scope: "workspace", workspaceId }) as { status: number };
            } catch (cause) {
                const problem = cause instanceof OperationFailureError ? cause.result.problem : undefined;
                if (problem?.type?.endsWith("/workspace-busy") === true && problem.retryable === true) return null;
                throw cause;
            }
        }, (result) => result !== null);
        assert.equal(added?.status, 201);
        const occurrence = [...timers.entries()].toSorted((a, b) => a[1].due - b[1].due)[0];
        assert.ok(occurrence, "one occurrence is armed");
        now = occurrence[1].due;
        timers.delete(occurrence[0]);
        occurrence[1].callback();

        await waitForDb(() => db.test_log_entries_by_loop.all<{ op: string; tx: string }>({ loop_id: accepted.loopId }),
            (rows) => rows.some(({ op, tx }) => op === "NOTE" && tx.includes("Received the scheduled message.")));
        await waitForDb(() => lifecycle.status(accepted.loopId), (status) => status === 202);
        await waitForDb(async () => module.functionality.scheduler.armed(workspaceId), (aliases) => aliases.length === 0);
        assert.equal(provider.received.length, 2, "the occurrence wakes the loop without waiting for its ten-minute deadline");
        assert.match(JSON.stringify(provider.received[1]), /scheduled-proof/u, "the resumed model sees the message");
        assert.deepEqual((await daemon.listSessionLoops({ workspaceId, sessionId })).map(({ id }) => id), [accepted.loopId],
            "the scheduler joins the existing loop rather than starting a successor");
        const arrivals = (await db.test_messages_by_loop.all<{ source: string; body: string; log_entry_id: number | null }>({ loop_id: accepted.loopId }))
            .filter(({ source }) => source === "schedule://reminder");
        assert.deepEqual(arrivals.map(({ body }) => body), ["scheduled-proof"]);
        assert.ok(arrivals[0].log_entry_id !== null, "the arrival has a published ordinary log receipt");
        const listing = await daemon.invokeModuleAction("workspace.schedule.list", {}, { scope: "workspace", workspaceId }) as FunctionalityListResult;
        const reminder = listing.definitions.find(({ alias }) => alias === "reminder");
        assert.ok(reminder !== undefined && reminder.state !== "unavailable", "exhaustion follows a successful delivery");
        await daemon.cancelSession({ workspaceId, sessionId });
    } finally { await daemon.stop(); await db.close(); }
});
});

describe("session-topology", () => {
// {§session-loop-lifecycle} topology join — a child session finishing is a WAKE EDGE for a parent that parked
// awaiting it. Without it, a parent that spawns work and hibernates would dead-park.
// The proof: the parent concludes at all — a non-woken 202 would hang (runLoopToTerminal times out).

test("{§session-loop-lifecycle} a child session concluding wakes a parent parked at 202", async (approvalContext) => {
    serverProposals(approvalContext, "accept");
    // Response order is forced by causality: the parent can't resume until the child concludes,
    // and the child can't run until the parent spawns it — so the Mock queue is deterministic.
    // 16384: the parent's final resume carries the whole child subtree; that accumulation crests at the 8192 edge
    // and grammar 0.76.4's plurnk.md growth consumed the margin. Headroom for the wake topology, not a budget probe.
    const mock = new Mock({ contextWindow: 16384, responses: [
        // Parent turn 1: spawn a child session, then hibernate awaiting it.
        makeMockResponse("````WORK (session://session)\ncompute the thing and finish\n````\n\n````WAIT\nspawned session; waiting on it\n````", 10),
        // Child turn 1: do its part and conclude → this is the wake edge for the parent.
        makeMockResponse("````SEND [200]\nsession done\n````", 10),
        // Parent turn 2 (only reached if the child's conclusion woke it): conclude.
        makeMockResponse("````SEND [200]\nsession finished; all done\n````", 10),
    ] });
    await withDaemon(mock, async (_db, _daemon, addr) => {
        const ws = await connect(addr);
        try {
            await rpcCall(ws, 1, "workspace.create", { name: "session-topology" });
            const terminated = subscribeNotifications(ws, "loop/terminated");
            // runLoopToTerminal awaits the PARENT's loop/terminated. If the child-wake doesn't fire,
            // the parent stays parked at 202 forever and this times out — so reaching 200 IS the proof.
            const { finalStatus, turnIds, modelSessionId } = await runLoopToTerminal(ws, 2, { prompt: "spawn a session and wait for it" });
            assert.equal(finalStatus, 200, "the parent resumed from 202 (woken by the child) and concluded");
            assert.equal(turnIds?.length, 3, "the terminal event includes initialization and both model turns across park/resume");
            const [childEnded] = await waitFor(
                () => (terminated() as Array<{ sessionId: number; result: { status: number } }>).filter((event) => event.sessionId !== modelSessionId),
                (events) => events.length > 0,
            );
            assert.equal(childEnded.result.status, 200, "the child concluded 200");
        } finally { ws.close(); }
    });
});

test("{§session-loop-lifecycle} a child cancelling itself (499) also wakes the parent — any conclusion is a wake edge", async (approvalContext) => {
    serverProposals(approvalContext, "accept");
    // The parent observes cancellation as well as successful completion.
    // 16384: the parent's woken turn carries the whole child history + collect delta, cresting at the
    // 8192 edge; execs-common 0.2.21's second sh teaching line consumed the last margin (the same
    // budget-edge class as the grammar 0.76.4 bumps above). Headroom for the wake, not a budget probe.
    const mock = new Mock({ contextWindow: 16384, responses: [
        makeMockResponse("````WORK (session://doomed)\ntry the risky thing\n````\n\n````WAIT\nwaiting on doomed\n````", 10),
        makeMockResponse("````SEND\ndoomed gave up\n````\n````KILL (session://doomed)\n````", 10),
        makeMockResponse("````SEND [200]\ndoomed is done (failed); concluding\n````", 10),
    ] });
    await withDaemon(mock, async (_db, _daemon, addr) => {
        const ws = await connect(addr);
        try {
            await rpcCall(ws, 1, "workspace.create", { name: "child-fail" });
            const { finalStatus } = await runLoopToTerminal(ws, 2, { prompt: "spawn doomed, wait" });
            assert.equal(finalStatus, 200, "the parent woke on the child's 499 and concluded — a failed child is still a wake edge");
        } finally { ws.close(); }
    });
});

test("{§session-causal-admission}: one completed child task wakes its parent while another task stays parked", async (t) => {
    const previous = process.env.PLURNK_SERVICE_OPTIMISTIC_WAIT_MS;
    process.env.PLURNK_SERVICE_OPTIMISTIC_WAIT_MS = "0";
    const provider = new Mock({ contextWindow: 100000, responses: [
        makeMockResponse("````WAIT\nFirst task waits.\n````"),
        makeMockResponse("````WAIT\nSecond task waits.\n````"),
        makeMockResponse("````WAIT\nParent awaits results.\n````"),
        makeMockResponse("````SEND [200]\nFirst task result: 42.\n````\n\n````SEND [200]\nFirst task result: 42.\n````"),
        makeMockResponse("````WAIT\nFirst result observed; second task remains.\n````"),
    ] });
    try {
        await withDaemon(provider, async (db, daemon) => {
            const { workspaceId } = await daemon.createWorkspace({ name: "partial-child-result" });
            const parentId = await namedModelSession(daemon, workspaceId, "main");
            const parentSession = await daemon.readSession({ workspaceId, identity: { id: parentId } });
            assert.ok(parentSession);
            const { sessionId: childId } = await daemon.forkSession({ workspaceId, sessionId: parentId, name: "child" });
            const held = await holdChild(db, workspaceId, childId);
            try {
                const common = {
                    workspaceId, sessionId: childId,
                    source: `session://${parentSession.name}`,
                    providerSpec: { alias: "mocktest", provider: "openai", model: "mocktest" },
                    effort: "adaptive" as const, systemPrompt: "test system",
                };
                const childTasks = await admitTogether(t, childId, [
                    () => daemon.inject({ ...common, prompt: "First child task." }),
                    () => daemon.inject({ ...common, prompt: "Second child task." }),
                ]);
                const ids = new Set(childTasks.map(({ loopId }) => loopId));
                await waitForDb(
                    async () => (await db.test_loop_queue_by_session.all<{ id: number; status: number }>({ session_id: childId }))
                        .filter(({ id }) => ids.has(id)),
                    (tasks) => tasks.length === 2 && tasks.every(({ status }) => status === 202),
                );
                const parent = await daemon.runLoop({ workspaceId, sessionId: parentId, prompt: "Observe each child result." });
                await waitForDb(() => db.test_get_loop_status.get<{ status: number }>({ id: parent.loopId }), (row) => row?.status === 202);
                await new LoopLifecycle(db).finish(held, { status: 200, content: "The held work finished." });
                const delivery = await daemon.runLoop({ workspaceId, sessionId: childId, prompt: "Complete the first task.", source: `session://${parentSession.name}` });
                assert.equal(delivery.loopId, childTasks[0]?.loopId);
                await waitForDb(async () => provider.received.length, (count) => count === 5);
                const latest = provider.received.at(-1)!;
                assert.match(JSON.stringify(latest), /First task result: 42/, "the resumed parent sees the completed task's deliverable");
                const tasks = await db.test_loop_queue_by_session.all<{ id: number; status: number }>({ session_id: childId });
                assert.deepEqual(tasks.filter(({ id }) => ids.has(id)).map(({ status }) => status), [200, 202],
                    "observing one completion neither finishes nor wakes the other child task");
                const parentTasks = await db.test_loop_queue_by_session.all<{ id: number; prompt: string }>({ session_id: parentId });
                assert.deepEqual(parentTasks.filter(({ prompt }) => prompt === "Observe each child result.").map(({ id }) => id), [parent.loopId],
                    "the parent resumes its original task without a synthetic message");
            } finally { await daemon.cancelSession({ workspaceId, sessionId: parentId }); }
        });
    } finally {
        if (previous === undefined) delete process.env.PLURNK_SERVICE_OPTIMISTIC_WAIT_MS;
        else process.env.PLURNK_SERVICE_OPTIMISTIC_WAIT_MS = previous;
    }
});

test("{§session-causal-admission}: cancelling a parked child notifies its waiting parent without a live child drain", async () => {
    const provider = new Mock({ contextWindow: 100000, responses: [
        makeMockResponse("````WAIT\nChild waits.\n````"),
        makeMockResponse("````WAIT\nParent awaits child.\n````"),
        makeMockResponse("````SEND [200]\nChild cancellation observed.\n````"),
    ] });
    await withDaemon(provider, async (db, daemon) => {
        const { workspaceId } = await daemon.createWorkspace({ name: "cancel-parked-child" });
        const parentId = await namedModelSession(daemon, workspaceId, "main");
        const { sessionId: childId } = await daemon.forkSession({ workspaceId, sessionId: parentId, name: "child" });
        await holdChild(db, workspaceId, childId);
        try {
            const child = await daemon.runLoop({ workspaceId, sessionId: childId, prompt: "Wait for instructions." });
            await waitForDb(() => db.test_get_loop_status.get<{ status: number }>({ id: child.loopId }), (row) => row?.status === 202);
            const parent = await daemon.runLoop({ workspaceId, sessionId: parentId, prompt: "Observe the child outcome." });
            await waitForDb(() => db.test_get_loop_status.get<{ status: number }>({ id: parent.loopId }), (row) => row?.status === 202);
            await daemon.cancelSession({ workspaceId, sessionId: childId });
            const completed = await waitForDb(
                () => db.test_get_loop_status.get<{ status: number }>({ id: parent.loopId }),
                (row) => row?.status === 200,
            );
            assert.equal(completed?.status, 200);
            assert.equal((await db.test_get_loop_status.get<{ status: number }>({ id: child.loopId }))?.status, 499);
            assert.equal(provider.received.length, 3, "only the live parent resumes on cancellation evidence");
        } finally { await daemon.cancelSession({ workspaceId, sessionId: parentId }); }
    });
});

test("{§session-loop-lifecycle} an empty failed child stream is observed by the child before its terminal result reaches the parent", async (approvalContext) => {
    serverProposals(approvalContext, "accept");
    const mock = new Mock({ contextWindow: 16384, responses: [
        makeMockResponse("````WORK (session://stream-child)\nrun the empty failing stream and report its outcome\n````\n\n````WAIT\nwaiting on stream-child\n````", 10),
        makeMockResponse("````sh (emptyfail)\ngo\n````\n\n````WAIT\nwaiting for emptyfail\n````", 10),
        makeMockResponse("````SEND\nemptyfail failed with no output\n````\n````KILL (session://stream-child)\n````", 10),
        makeMockResponse("````SEND [200]\nthe child reported the empty stream failure\n````", 10),
    ] });
    await withDaemon(mock, async (_db, daemon, addr) => {
        await daemon.registerRuntime({
            namespaceOwner: "session topology test module",
            decl: { name: "emptyfail", glyph: "×", summary: "Empty failure fixture.", invocation: { body: { role: "fixture input", required: true }, example: { body: "fixture" } } },
            executor: {
                runtime: "emptyfail", glyph: "×",
                get manifest() { return { name: "emptyfail", channels: { results: "text/plain" }, defaultChannel: "results", category: "data", writableBy: [], volatile: true, modelVisible: true } as never; },
                get defaultChannel() { return "results"; },
                get channels() { return { results: { mimetype: "text/plain" } }; },
                effect: () => "pure",
                probe: async () => ({ available: true, detail: "fixture" }),
                run: async () => Results.failure(
                    "executor:emptyfail",
                    "fixture-failed",
                    500,
                    "The empty failing stream fixture failed.",
                    { exitCode: 1 },
                    { stage: "execute", retryable: false },
                ),
            } as unknown as Executor,
            availability: { available: true, detail: "fixture" },
        });
        const ws = await connect(addr);
        try {
            await rpcCall(ws, 1, "workspace.create", { name: "child-empty-failed-stream" });
            const terminated = subscribeNotifications(ws, "loop/terminated");
            const { finalStatus, modelSessionId } = await runLoopToTerminal(ws, 2, {
                prompt: "delegate a failing stream and wait for its result",
            });
            assert.equal(finalStatus, 200);
            const [childEnded] = await waitFor(
                () => (terminated() as Array<{ sessionId: number; result: { status: number } }>).filter((event) => event.sessionId !== modelSessionId),
                (events) => events.length > 0,
            );
            assert.equal(childEnded.result.status, 499, "the child concluded with its observed stream failure");
            assert.equal(mock.remaining, 0, "all four causal turns ran: parent park, child exec, child terminal, parent terminal");
        } finally { ws.close(); }
    });
});

test("{§session-causal-admission}: abandonment survives child activation finishing after cancellation", async (t) => {
    serverProposals(t, "accept");
    const activationStarted = Promise.withResolvers<void>();
    const releaseActivation = Promise.withResolvers<void>();
    const childSettled = Promise.withResolvers<void>();
    let childId: number | undefined;
    const cancelSessionTree = DrainSupervisor.prototype.cancelSessionTree;
    t.mock.method(DrainSupervisor.prototype, "cancelSessionTree", async function (
        this: DrainSupervisor,
        ...args: Parameters<typeof cancelSessionTree>
    ) {
        await activationStarted.promise;
        return cancelSessionTree.apply(this, args);
    });
    const materialize = LoopDocs.materialize;
    t.mock.method(LoopDocs, "materialize", async (...args: Parameters<typeof materialize>) => {
        const [, db, workspaceId] = args;
        const child = await db.session_resolve_by_name.get<{ id: number }>({ workspace_id: workspaceId, name: "child" });
        if (child !== undefined) {
            childId = child.id;
            activationStarted.resolve();
            await releaseActivation.promise;
        }
        return materialize(...args);
    });
    const runLoop = LoopDriver.prototype.runLoop;
    t.mock.method(LoopDriver.prototype, "runLoop", async function (
        this: LoopDriver,
        args: Parameters<typeof runLoop>[0],
    ) {
        try { return await runLoop.call(this, args); }
        finally { if (args.sessionId === childId) childSettled.resolve(); }
    });
    // Cancellation reaps the subtree even before the child's activation finishes.
    const mock = new Mock({ contextWindow: 16384, responses: [
        makeMockResponse("````WORK (session://child)\nkeep working until cancelled\n````\n\n````SEND\nabandon this scope\n````\n````KILL (session://root)\n````", 10),
        makeMockResponse("````NOTE\nstill working\n````", 10),
    ] });
    await withDaemon(mock, async (db, daemon, addr) => {
        const ws = await connect(addr);
        try {
            const workspace = await rpcCall(ws, 1, "workspace.create", { name: "abandon-tree" });
            const { sessionId } = await daemon.createSession({ workspaceId: (workspace.result as { id: number }).id, name: "root" });
            const parent = runLoopToTerminal(ws, 2, { prompt: "spawn then abandon", sessionId });
            await activationStarted.promise;
            const { finalStatus } = await parent;
            assert.equal(finalStatus, 499);
            const cancelled = await db.test_list_loops_all.all<{ session_id: number; status: number }>({});
            assert.deepEqual(cancelled.filter(({ session_id }) => session_id === childId).map(({ status }) => status), [499],
                "the child is durably cancelled before its delayed activation completes");
            releaseActivation.resolve();
            await childSettled.promise;
            const loops = await db.test_list_loops_all.all<{ id: number; session_id: number; status: number }>({});
            assert.ok(loops.every(({ status }) => ![100, 102, 202].includes(status)), `no unresolved descendant survives abandonment: ${JSON.stringify(loops)}`);
            const childLoops = loops.filter(({ session_id }) => session_id === childId);
            assert.deepEqual(childLoops.map(({ status }) => status), [499], "workspace document maintenance does not create child loops");
            assert.equal(mock.remaining, 1, "the cancelled child never calls the model");
        } finally { releaseActivation.resolve(); ws.close(); }
    });
});

test("{§session-loop-lifecycle} wake propagates UP a grandchild chain (parent→child→grandchild)", async (approvalContext) => {
    serverProposals(approvalContext, "accept");
    // Each level parks until the one below concludes — so the order is forced and the recursion shows:
    // grandchild concludes → wakes child → child concludes → wakes parent → parent concludes.
    // 16384: a 2-deep chain piles grandchild→child→parent results into the parent's final resume, cresting at the
    // 8192 edge; grammar 0.76.4's plurnk.md growth consumed the margin. Headroom for the wake recursion, not a budget probe.
    const mock = new Mock({ contextWindow: 16384, responses: [
        makeMockResponse("````WORK (session://child)\ndo subwork\n````\n\n````WAIT\nawaiting child\n````", 10),       // parent t1
        makeMockResponse("````WORK (session://grandchild)\ndo leaf work\n````\n\n````WAIT\nawaiting grandchild\n````", 10), // child t1
        makeMockResponse("````SEND [200]\nleaf done\n````", 10),                                                   // grandchild
        makeMockResponse("````SEND [200]\nchild done\n````", 10),                                                  // child t2 (woken)
        makeMockResponse("````SEND [200]\nall done\n````", 10),                                                    // parent t2 (woken)
    ] });
    await withDaemon(mock, async (_db, _daemon, addr) => {
        const ws = await connect(addr);
        try {
            await rpcCall(ws, 1, "workspace.create", { name: "grandchild" });
            const { finalStatus } = await runLoopToTerminal(ws, 2, { prompt: "spawn a 2-deep chain and wait" });
            assert.equal(finalStatus, 200, "the wake propagated up two levels — the parent concluded only after the whole subtree did");
        } finally { ws.close(); }
    });
});

test("{§session-loop-lifecycle} a parent wakes across SEQUENTIAL children (multiple wakes)", async (approvalContext) => {
    serverProposals(approvalContext, "accept");
    // 16384: the parent's woken turn carries the whole child history; generous headroom over the
    // static packet so the wake budget edge is the subtree, not the tool teaching.
    const mock = new Mock({ contextWindow: 16384, responses: [
        makeMockResponse("````WORK (session://w1)\nfirst job\n````\n\n````WAIT\nawaiting w1\n````", 10), // parent t1
        makeMockResponse("````SEND [200]\nw1 done\n````", 10),                                       // w1
        makeMockResponse("````WORK (session://w2)\nsecond job\n````\n\n````WAIT\nawaiting w2\n````", 10),// parent t2 (woken by w1)
        makeMockResponse("````SEND [200]\nw2 done\n````", 10),                                       // w2
        makeMockResponse("````SEND [200]\nboth done\n````", 10),                                     // parent t3 (woken by w2)
    ] });
    await withDaemon(mock, async (db, _daemon, addr) => {
        const ws = await connect(addr);
        try {
            await rpcCall(ws, 1, "workspace.create", { name: "sequential" });
            const { finalStatus } = await runLoopToTerminal(ws, 2, { prompt: "two jobs in sequence" });
            assert.equal(finalStatus, 200, "the parent parked, woke on w1, spawned+parked again, woke on w2, then concluded");
            const sessions = await db.test_sessions_with_parent.all<{ id: number; name: string; parent_session_id: number | null; origin: string }>({});
            const modelSessions = sessions.filter(({ origin }) => origin === "model");
            const parent = modelSessions.find(({ parent_session_id: parentId }) => parentId === null);
            assert.ok(parent, `the topology has a root model session; got ${JSON.stringify(modelSessions)}`);
            assert.deepEqual(
                modelSessions.filter(({ parent_session_id: parentId }) => parentId === parent.id).map(({ name }) => name),
                ["w1", "w2"],
                "the sequential path created both named child sessions under the same parent — terminal output alone is not proof",
            );
        } finally { ws.close(); }
    });
});

test("{§session-causal-admission} an irc (SEND session://name) wakes a CONCLUDED sibling on that session's durable model", async (approvalContext) => {
    serverProposals(approvalContext, "accept");
    // Under {§session-causal-admission}, an actor with nothing to wait on CONCLUDES — it does not
    // park awaiting voice. So the voice door (a sibling's irc) reawakens it as a NEW loop carrying the
    // message as its prompt (the same wake `loop.inject` proves for the operator voice), never a
    // resume-in-place of a slept loop — there is no slept loop to resume.
    const mock = new Mock({ contextWindow: viableWindow(), responses: [
        makeMockResponse("````SEND [200]\nstanding by for the entry code\n````", 10), // loop 1 — idle actor concludes
    ] });
    const directRoute: ProviderSpec = { provider: "mocktest", model: `irc-${crypto.randomUUID()}` };
    const selected = new Mock({ contextWindow: viableWindow(), responses: [
        makeMockResponse("````SEND [200]\nreceived the entry code and confirmed\n````", 10),
    ] });
    ProviderInstantiate.registerInstance(selected, directRoute);
    await withDaemon(mock, async (db, daemon, addr) => {
        const ws = await connect(addr);
        try {
            const created = await rpcCall(ws, 1, "workspace.create", { name: "irc-wake" });
            const workspaceId = (created.result as { id: number }).id;
            const terminated = subscribeNotifications(ws, "loop/terminated");
            const response = await rpcCall(ws, 2, "loop.run", { prompt: "be a butler; await the entry code" });
            const modelSessionId = (response.result as { modelSessionId: number }).modelSessionId;
            const loopId = (response.result as { loopId: number }).loopId;
            // The actor concludes its first (idle) loop — nothing to wait on.
            await waitFor(() => terminated() as Array<{ loopId: number }>, (ts) => ts.some((t) => t.loopId === loopId), { timeoutMs: 8000 });
            const before = (await db.test_count_loops_by_session.get<{ n: number }>({ session_id: modelSessionId }))!.n;
            await daemon.setSessionModel({
                workspaceId,
                sessionId: modelSessionId,
                selector: `${directRoute.provider}/${directRoute.model}`,
            });
            // Address the concluded actor by name, then irc it — the voice door.
            const sessions = ((await rpcCall(ws, 4, "workspace.sessions", {})).result as { sessions: Array<{ name: string; origin: string }> }).sessions;
            const actor = sessions.find((r) => r.origin === "model")!;
            await rpcCall(ws, 5, "op.send", { recipient: `session://${actor.name}`, body: "the entry code is 4815" });
            // A FRESH loop is minted (there was no slept loop to resume).
            const after = await waitForDb(() => db.test_count_loops_by_session.get<{ n: number }>({ session_id: modelSessionId }), (r) => (r?.n ?? 0) > before, { timeoutMs: 8000 });
            assert.ok((after?.n ?? 0) > before, "the irc reawakened the concluded actor as a FRESH loop — the voice door mints a new loop, never resumes a park");
            const secondLoop = await waitFor(
                () => terminated() as Array<{ loopId: number; result: { status: number } }>,
                (items) => items.some(({ loopId: candidate }) => candidate !== loopId),
                { timeoutMs: 8000 },
            );
            assert.equal(secondLoop.find(({ loopId: candidate }) => candidate !== loopId)?.result.status, 200);
            assert.equal(selected.remaining, 0, "the voice door retained the receiving session's explicitly selected model");
        } finally { ws.close(); }
    });
});

test("{§session-loop-lifecycle} an empty wait continues through the real loop until the assignment is answered", async (approvalContext) => {
    serverProposals(approvalContext, "accept");
    const mock = new Mock({ contextWindow: viableWindow(), responses: [
        makeMockResponse("````WAIT\nnothing running; done for now\n````", 10),
        makeMockResponse("````SEND [200]\nNo work remains.\n````", 10),
    ] });
    await withDaemon(mock, async (db, _daemon, addr) => {
        const ws = await connect(addr);
        try {
            await rpcCall(ws, 1, "workspace.create", { name: "idle-concludes" });
            const terminated = subscribeNotifications(ws, "loop/terminated");
            await rpcCall(ws, 2, "loop.run", { prompt: "nothing to do" });
            const t = await waitFor(() => terminated() as Array<{ result: { status: number }; loopId?: number }>, (items) => items.length > 0, { timeoutMs: 8000 });
            assert.equal(t.length, 1, "the loop concluded — one loop/terminated, no held-open 202");
            assert.equal(t[0].result.status, 200, "the answered assignment concludes the loop");
            const rows = await db.test_log_entries_by_loop.all<{ op: string; origin: string; status_rx: number }>({ loop_id: t[0].loopId! });
            assert.deepEqual(rows.filter(({ op, origin }) => origin === "model" && (op === "WAIT" || op === "SEND")).map(({ status_rx }) => status_rx), [102, 200]);
            assert.equal(mock.remaining, 0);
        } finally { ws.close(); }
    });
});

test("{§session-ownership} server auto-approval settles both WORK and FORK child edits", async (approvalContext) => {
    serverProposals(approvalContext, "accept");
    const mock = new Mock({ contextWindow: 16384, responses: [
        // Parent turn 1: spawn a session AND fork self, then park awaiting them.
        makeMockResponse("````WORK (session://session)\nedit something and finish\n````\n\n````FORK (session://mirror)\nedit something and finish\n````\n\n````WAIT\ndelegated; waiting\n````", 10),
        // Session turn 1: a SIDE-EFFECTING op (proposes unless auto), then conclude.
        makeMockResponse("````EDIT (workspace:///from-session)\npayload\n````\n\n````SEND\nsession done\n````", 10),
        // Fork turn 1: same shape.
        makeMockResponse("````EDIT (workspace:///from-fork)\npayload\n````\n\n````SEND\nfork done\n````", 10),
        // {§loop-completion}: the children observe their EDIT receipts
        // before completing. A parent claim remains gated on its child results.
        ...Array.from({ length: 4 }, () => makeMockResponse("````SEND [200]\nDelegated edits observed.\n````", 10)),
    ] });
    await withDaemon(mock, async (db, _daemon, addr) => {
        const ws = await connect(addr);
        try {
            await rpcCall(ws, 1, "workspace.create", { name: "delegation-policy" });
            const { finalStatus } = await runLoopToTerminal(ws, 2, { prompt: "delegate everything" });
            assert.equal(finalStatus, 200, "the whole topology concluded — no child stalled in a proposal void");
            const edits = await db.test_edit_states.all<{ pathname: string; state: string }>({});
            const childEdits = edits.filter((x) => /from-(session|fork)/.test(x.pathname));
            assert.equal(childEdits.length, 2, "both delegated children performed their EDIT");
            for (const e of childEdits) {
                assert.equal(e.state, "resolved", `child EDIT ${e.pathname} accepted by server policy`);
            }
        } finally { ws.close(); }
    });
});

test("{§loop-completion} a wake re-queue (100) mid-drain is re-claimed and continued — never returned as a terminal", async (approvalContext) => {
    serverProposals(approvalContext, "accept");
    // The delegation-policy race: a conclusion-wake re-queues a parent's loop (202→100) between its
    // turn-end and its drain's next status check; pre-fix, runLoop read the queued 100 as an external
    // terminal and broadcast a QUEUED loop as loop/terminated{100}.
    // Under {§loop-completion} a loop blocks at 202 only on a live obligation, so the wake is a
    // REAL child-wake: the parent blocks on a spawned child, the child's conclusion re-queues the parent
    // (202→100) and the drain re-claims it (100→102). Exactly one terminal must fire for the parent, 200.
    const mock = new Mock({ contextWindow: 100000, responses: [
        makeMockResponse("````WORK (session://helper)\ndo a quick thing\n````\n\n````WAIT\nawaiting helper\n````", 10), // parent — blocks on its child
        makeMockResponse("````SEND [200]\nhelper done\n````", 10),                    // helper — concludes, waking the parent
        makeMockResponse("````SEND [200]\nhelper delivered; concluding\n````", 10),   // parent — re-queued by the wake, concludes
        makeMockResponse("````SEND [200]\ndone\n````", 10),                           // buffer
        makeMockResponse("````SEND [200]\ndone\n````", 10),                           // buffer
    ] });
    await withDaemon(mock, async (_db, _daemon, addr) => {
        const ws = await connect(addr);
        try {
            await rpcCall(ws, 1, "workspace.create", { name: "wake-requeue" });
            const terminated = subscribeNotifications(ws, "loop/terminated");
            const accept = await rpcCall(ws, 2, "loop.run", { prompt: "spawn a helper and await it" });
            const loopId = (accept.result as { loopId: number }).loopId;
            // The parent's loop is re-queued in place by the child-wake, then continues to its own terminal.
            const seen = await waitFor(
                () => terminated() as Array<{ loopId: number; result: { status: number } }>,
                (ts) => ts.some((t) => t.loopId === loopId),
                { timeoutMs: 8000 },
            );
            const finals = seen.filter((t) => t.loopId === loopId).map((t) => t.result.status);
            assert.deepEqual(finals, [200], `exactly one terminal broadcast for the parent, 200 — never a queued 100; got ${JSON.stringify(finals)}`);
        } finally { ws.close(); }
    });
});

test("{§log-history-projection} log-targeted KILL is recorded in the DB, and a failed one persists", async (approvalContext) => {
    serverProposals(approvalContext, "accept");
    // Successful meta-operations are forensic but render-free; failures remain
    // visible error signals. {§log-history-projection}
    const mock = new Mock({ contextWindow: 16384, responses: [
        makeMockResponse("````EDIT (workspace:///note)\nsome content worth folding\n````\n\n````NOTE\nwrote\n````", 10),
        // The phantom KILL fails (404); the next turn observes the failure.
        makeMockResponse("````KILL (log:///1/2/1) <1,-1>````\n````KILL (log:///9/9/9) <1,-1>````\n````NOTE\ncurated\n````", 10),
        makeMockResponse("````SEND [200]\nthe phantom KILL failed; curation done\n````", 10),
    ] });
    await withDaemon(mock, async (db, _daemon, addr) => {
        const ws = await connect(addr);
        try {
            await rpcCall(ws, 1, "workspace.create", { name: "meta-ops" });
            const { finalStatus, loopId } = await runLoopToTerminal(ws, 2, { prompt: "curate" });
            assert.equal(finalStatus, 200, "a curation turn is work, never idleness — the loop concluded");
            const rows = await db.test_log_entries_by_loop.all<{ op: string; origin: string; status_rx: number; tx: string }>({ loop_id: loopId });
            const kills = rows.filter((r) => r.origin === "model" && r.op === "KILL" && JSON.parse(r.tx).target !== null);
            assert.equal(kills.length, 2, `both KILLs recorded in the DB; got ${JSON.stringify(kills)}`);
            assert.deepEqual(kills.map(({ status_rx }) => status_rx), [200, 404], "one success + one failure recorded");
        } finally { ws.close(); }
    });
});
});

describe("undelivered-child-term", () => {
// {§loop-completion}: sessions concluding DURING the parent's generation are no
// longer live, but their ambient event is newer than the parent's observation cursor and queued
// for the next packet. Both dispositions must preserve that completed-but-unobserved result.

async function raceScenario(db: Awaited<ReturnType<typeof openMigrated>>) {
    const workspaceId = await insertWorkspace(db, `race-${crypto.randomUUID()}`);
    const parent = await insertSession(db, workspaceId);
    const parentLoop = await insertLoop(db, parent, 1, "orchestrate");
    const engine = new Engine({ db, schemes: new SchemeRegistry(), mimetypes: DEFAULT_MIMETYPES });
    await engine.runTurn({
        provider: new Mock({ contextWindow: 100_000, responses: [{ assistant: { content: "```NOTE\nCollect the child result.\n```", reasoning: null } }] }),
        workspaceId, sessionId: parent, loopId: parentLoop, messages: [],
    });
    const { id: parentTurn } = await Turn.open(db, { loopId: parentLoop, producer: "model", kind: "inference" });
    // A child spawned by the parent concludes after the parent's turn opened.
    const child = await insertSession(db, workspaceId, parent, "session-x");
    const childLoop = await insertLoop(db, child, 1, "fetch the value");
    await insertTurn(db, childLoop, 1, 102);
    await new LoopLifecycle(db).finish(childLoop, {
        status: 200,
        content: "the value is 42",
        mimetype: "text/markdown",
    });
    return { workspaceId, parent, parentLoop, parentTurn, engine };
}

test("{§session-loop-lifecycle} waiting on a just-concluded child continues until the result is delivered", async () => {
    const db = await openMigrated();
    try {
        const { workspaceId, parent, parentLoop, parentTurn, engine } = await raceScenario(db);
        const r = await engine.dispatch({ statement: dispositionStmt("WAIT", "Waiting for session-x."), workspaceId, sessionId: parent, loopId: parentLoop, turnId: parentTurn, sequence: 1, origin: "model" });
        assert.equal(r.status, 102, "the wait is NOT on nothing — the child's deliverable is on the doorstep; continue");
        const loop = await db.test_get_loop_status.get<{ status: number }>({ id: parentLoop });
        assert.notEqual(loop?.status, 200, "the loop did not conclude over the undelivered result");
    } finally { await db.close(); }
});

// A branch batch that fails git-preflight finishes the child's loop before the child ever had a
// turn. Its termination still announces to the parent, which never waits on a child that cannot
// report (#385).
test("{§loop-completion} a child refused before its first turn still announces its death to the parent", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `ghost-${crypto.randomUUID()}`);
        const parent = await insertSession(db, workspaceId);
        const parentLoop = await insertLoop(db, parent, 1, "orchestrate");
        const parentTurn = await insertTurn(db, parentLoop, 1, 102);
        const child = await insertSession(db, workspaceId, parent, "session-ghost");
        const childLoop = await insertLoop(db, child, 1, "implement");
        await new LoopLifecycle(db).finish(childLoop, Results.failure(
            "lifecycle:branch",
            "branch-checkout-dirty",
            409,
            "The project repository has staged, unstaged, or nonignored untracked changes.",
            {},
            { stage: "git-preflight", retryable: false },
        ));
        const pending = await db.engine_session_has_undelivered_child_term.get<{ pending: number }>({ session_id: parent });
        assert.ok(pending !== undefined, "the refused spawn is an undelivered child termination");
        const engine = new Engine({ db, schemes: new SchemeRegistry(), mimetypes: DEFAULT_MIMETYPES });
        const r = await engine.dispatch({ statement: dispositionStmt("WAIT", "Waiting for session-ghost."), workspaceId, sessionId: parent, loopId: parentLoop, turnId: parentTurn, sequence: 1, origin: "model" });
        assert.equal(r.status, 102, "the wait continues so the failure lands in the next packet instead of parking on a ghost");
    } finally { await db.close(); }
});

test("{§loop-completion} a delivered answer cannot complete before the just-concluded child is observed", async () => {
    const db = await openMigrated();
    try {
        const { workspaceId, parent, parentLoop, parentTurn, engine } = await raceScenario(db);
        const r = await engine.executeAdmittedTurn({ statements: [completeStmt("done")], source: null, emission: null, workspaceId, sessionId: parent, loopId: parentLoop, turnId: parentTurn, fromSequence: 1, origin: "model" });
        assert.equal(r.status, 102, "concluding over an undelivered session result is deferred, never refused");
        assert.deepEqual(r.outcomes, [{ op: "SEND", status: 200, problemType: null }]);
        const provider = new Mock({ contextWindow: 100_000, responses: [{ assistant: { content: "", reasoning: null } }] });
        const observed = await engine.runTurn({ provider, workspaceId, sessionId: parent, loopId: parentLoop, messages: [] });
        assert.equal(observed.status, 200);
        assert.match(JSON.stringify(provider.received[0]), /the value is 42/);
    } finally { await db.close(); }
});
});
