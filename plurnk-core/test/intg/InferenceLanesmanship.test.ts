import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import {
    InferenceAdmission,
    Mock,
    type ChatMessage,
    type InferenceLaneAcquireOptions,
    type InferenceLaneLease,
    type Provider,
    type ProviderGenerateArgs,
    type ProviderResponse,
    type ProviderSpec,
} from "@plurnk/plurnk-providers";
import ProviderInstantiate from "../../src/core/ProviderInstantiate.ts";
import { hermeticGitEnv } from "../../src/core/git-env.ts";
import { withDaemon, waitFor } from "./_rpc.ts";
import { mcpMockTurn, userText } from "./_mock.ts";
import { testProviderCapacity } from "./_provider.ts";

const initGitProject = (root: string, files: Record<string, string>): void => {
    const env = hermeticGitEnv();
    execFileSync("git", ["init", "-q"], { cwd: root, env });
    execFileSync("git", ["config", "user.email", "fixture@plurnk.invalid"], { cwd: root, env });
    execFileSync("git", ["config", "user.name", "fixture"], { cwd: root, env });
    for (const [name, content] of Object.entries(files)) {
        writeFileSync(join(root, name), content, "utf8");
    }
    execFileSync("git", ["add", ...Object.keys(files)], { cwd: root, env });
    execFileSync(
        "git",
        ["-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", "commit", "--no-verify", "-q", "-m", "seed"],
        { cwd: root, env },
    );
};

// Route per-session scripted mock responses through one shared 1-slot InferenceAdmission.
class MultiSessionLaneMock implements Provider {
    readonly contextWindow = 32_768;
    readonly maxInputTokens = null;
    readonly maxOutputTokens = null;
    readonly outputBudget = 1280;
    readonly outputFloor = 256;
    readonly reasoningBudget = null;
    readonly supportedEfforts = ["off", "adaptive", "low", "medium", "high"] as const;
    readonly inputCapacity = this.contextWindow - this.outputBudget;
    readonly inputWall = this.contextWindow - this.outputFloor;
    readonly model = "mock-lane";
    readonly inputModalities = new Set<never>();
    readonly laneGate: InferenceAdmission;
    readonly #burstMs: number;
    readonly #handoffMs: number;
    readonly #handler: (args: ProviderGenerateArgs) => Promise<ProviderResponse>;

    constructor({
        admission,
        burstMs,
        handoffMs,
        handler,
    }: {
        admission: InferenceAdmission;
        burstMs: number;
        handoffMs: number;
        handler: (args: ProviderGenerateArgs) => Promise<ProviderResponse>;
    }) {
        this.laneGate = admission;
        this.#burstMs = burstMs;
        this.#handoffMs = handoffMs;
        this.#handler = handler;
    }

    acquireLane(options?: InferenceLaneAcquireOptions): Promise<InferenceLaneLease> {
        return this.laneGate.acquire({
            sessionId: options?.sessionId,
            model: options?.model ?? this.model,
            signal: options?.signal,
            onQueueChange: options?.onQueueChange,
            burstMs: this.#burstMs,
            handoffMs: this.#handoffMs,
        });
    }

    async countPromptTokens(messages: readonly ChatMessage[]) {
        return {
            kind: "exact" as const,
            tokens: Math.ceil(messages.reduce((sum, m) => sum + JSON.stringify(m.content).length, 0) / 4),
            source: "mock-lane",
        };
    }

    async assessRequestCapacity(messages: readonly ChatMessage[]) {
        return testProviderCapacity(messages, this.contextWindow, this.outputBudget);
    }

    async generate(args: ProviderGenerateArgs): Promise<ProviderResponse> {
        const ownsLease = !(args.laneLease?.active && args.laneLease.gate === this.laneGate);
        const lease = ownsLease
            ? await this.laneGate.acquire({
                sessionId: args.sessionId,
                model: this.model,
                signal: args.signal,
                burstMs: 0,
                handoffMs: 0,
            })
            : undefined;
        try {
            return await this.#handler(args);
        } finally {
            if (lease?.active) lease.release();
        }
    }
}

const registerAliasProvider = (
    t: { after: (fn: () => void) => void },
    alias: string,
    provider: Provider,
): ProviderSpec => {
    const key = `PLURNK_MODEL_${alias}`;
    const prevModel = process.env.PLURNK_MODEL;
    const prevAlias = process.env[key];
    process.env.PLURNK_MODEL = alias;
    process.env[key] = `openai/${alias}`;
    const spec: ProviderSpec = { alias, provider: "openai", model: alias };
    ProviderInstantiate.registerInstance(provider, spec, process.env, "adaptive");
    t.after(() => {
        if (prevModel === undefined) delete process.env.PLURNK_MODEL;
        else process.env.PLURNK_MODEL = prevModel;
        if (prevAlias === undefined) delete process.env[key];
        else process.env[key] = prevAlias;
    });
    return spec;
};

const emitSingleMock = (dsl: string, args: ProviderGenerateArgs): Promise<ProviderResponse> => {
    const mock = new Mock({ contextWindow: 32_768, responses: [mcpMockTurn(dsl)] });
    return mock.generate({
        messages: args.messages,
        sessionId: args.sessionId,
        signal: args.signal,
        observeRequest: args.observeRequest,
        observeReasoning: args.observeReasoning,
    });
};

test("{§provider-inference-admission} {§session-wait-timing} queued session assembles a fresh packet after lane admission, emits turn_queued telemetry, and observes sibling workspace edits", async (t) => {
    const projectRoot = mkdtempSync(join(tmpdir(), "plurnk-lane-fresh-"));
    t.after(() => rmSync(projectRoot, { recursive: true, force: true }));
    initGitProject(projectRoot, { "shared.txt": "BEFORE_SIBLING\n" });

    const admission = InferenceAdmission.forEndpoint(`http://lane-fresh-${randomUUID()}.test/v1`, 1);
    const s1Entered = Promise.withResolvers<void>();
    const releaseS1 = Promise.withResolvers<void>();
    let s1Turns = 0;
    let s2PacketText = "";

    const provider = new MultiSessionLaneMock({
        admission,
        burstMs: 300_000,
        handoffMs: 15_000,
        handler: async (args) => {
            const text = userText(args.messages);
            if (text.includes("TASK_S1")) {
                s1Turns++;
                if (s1Turns === 1) {
                    s1Entered.resolve();
                    await releaseS1.promise;
                    return emitSingleMock(
                        'await plurnk.edit({ path: "shared.txt", range: "1,-1", content: "AFTER_SIBLING\\n" });',
                        args,
                    );
                }
                return emitSingleMock('await plurnk.done({ text: "s1 updated shared.txt" });', args);
            }
            if (text.includes("TASK_S2")) {
                s2PacketText = text;
                return emitSingleMock('await plurnk.done({ text: "s2 saw fresh state" });', args);
            }
            throw new Error(`unexpected prompt: ${text.slice(0, 120)}`);
        },
    });
    const alias = `lanefresh${randomUUID().replaceAll("-", "").slice(0, 8)}`;
    registerAliasProvider(t, alias, provider);

    await withDaemon(provider, async (_db, daemon) => {
        const { workspaceId } = await daemon.createWorkspace({ name: "ws-fresh", projectRoot });
        await daemon.setWorkspaceProposalPolicy({ workspaceId, policy: "accept" });
        const { sessionId: s1Id } = await daemon.createSession({ workspaceId, name: "s1" });
        const { sessionId: s2Id } = await daemon.createSession({ workspaceId, name: "s2" });

        const telemetry: Array<{ sessionId: number | null; kind: string; queuePosition?: number; queueDepth?: number }> = [];
        const unsubRuntime = daemon.subscribeToRuntimeStream((_wsId, method, params) => {
            if (method === "runtime/telemetry") {
                const p = params as { sessionId: number | null; notice: { kind: string; queuePosition?: number; queueDepth?: number } };
                telemetry.push({
                    sessionId: p.sessionId,
                    kind: p.notice.kind,
                    queuePosition: p.notice.queuePosition,
                    queueDepth: p.notice.queueDepth,
                });
            }
        });
        t.after(unsubRuntime);

        const terminated: Array<{ loopId: number; result: { status: number } }> = [];
        const unsubEvents = daemon.subscribeToEvents((_wsId, method, params) => {
            if (method === "loop/terminated") terminated.push(params as { loopId: number; result: { status: number } });
        });
        t.after(unsubEvents);

        const run1 = await daemon.runLoop({ workspaceId, sessionId: s1Id, prompt: "TASK_S1", openPaths: ["shared.txt"] });
        await s1Entered.promise;

        // Launch S2 while S1 holds the single lane: S2 must queue BEFORE reading openPaths/assembling packet.
        const run2 = await daemon.runLoop({ workspaceId, sessionId: s2Id, prompt: "TASK_S2", openPaths: ["shared.txt"] });
        await waitFor(
            () => telemetry,
            (events) => events.some((e) => e.sessionId === s2Id && e.kind === "turn_queued" && e.queuePosition === 1 && e.queueDepth === 1),
        );

        // Release S1 so it writes AFTER_SIBLING and concludes, handing the lane to S2.
        releaseS1.resolve();
        await waitFor(
            () => terminated,
            (events) => events.some((e) => e.loopId === run1.loopId) && events.some((e) => e.loopId === run2.loopId),
        );

        assert.ok(
            s2PacketText.includes("AFTER_SIBLING"),
            `S2 packet must reflect S1's post-queue edit rather than stale T=0 content; got: ${s2PacketText.slice(0, 400)}`,
        );
        assert.ok(
            !s2PacketText.includes("BEFORE_SIBLING"),
            "S2 packet must not contain stale pre-queue file contents",
        );
    });
});

test("{§provider-inference-admission} {§session-wait-timing} lane-queue wait does not burn PLURNK_SERVICE_LOOP_TIMEOUT_MS", async (t) => {
    const prevTimeout = process.env.PLURNK_SERVICE_LOOP_TIMEOUT_MS;
    process.env.PLURNK_SERVICE_LOOP_TIMEOUT_MS = "300";
    t.after(() => {
        if (prevTimeout === undefined) delete process.env.PLURNK_SERVICE_LOOP_TIMEOUT_MS;
        else process.env.PLURNK_SERVICE_LOOP_TIMEOUT_MS = prevTimeout;
    });

    const admission = InferenceAdmission.forEndpoint(`http://lane-timeout-${randomUUID()}.test/v1`, 1);
    const provider = new MultiSessionLaneMock({
        admission,
        burstMs: 300_000,
        handoffMs: 15_000,
        handler: async (args) => emitSingleMock('await plurnk.done({ text: "waiter survived" });', args),
    });
    const alias = `lanetimeout${randomUUID().replaceAll("-", "").slice(0, 8)}`;
    registerAliasProvider(t, alias, provider);

    await withDaemon(provider, async (db, daemon) => {
        const { workspaceId } = await daemon.createWorkspace({ name: "ws-timeout" });
        const { sessionId: s2Id } = await daemon.createSession({ workspaceId, name: "waiter" });

        const queuedSeen = Promise.withResolvers<void>();
        const unsubRuntime = daemon.subscribeToRuntimeStream((_wsId, method, params) => {
            if (method === "runtime/telemetry") {
                const p = params as { sessionId: number | null; notice: { kind: string } };
                if (p.sessionId === s2Id && p.notice.kind === "turn_queued") queuedSeen.resolve();
            }
        });
        t.after(unsubRuntime);

        const terminated: Array<{ loopId: number; result: { status: number } }> = [];
        const unsubEvents = daemon.subscribeToEvents((_wsId, method, params) => {
            if (method === "loop/terminated") terminated.push(params as { loopId: number; result: { status: number } });
        });
        t.after(unsubEvents);

        const externalLease = await admission.acquire({ sessionId: "external-holder", burstMs: 0, handoffMs: 0 });
        const run2 = await daemon.runLoop({ workspaceId, sessionId: s2Id, prompt: "QUEUED_WAITER" });
        await queuedSeen.promise;

        // Keep S2 queued for 420ms — strictly longer than PLURNK_SERVICE_LOOP_TIMEOUT_MS (300ms).
        await delay(420);
        externalLease.release();

        const terms = await waitFor(
            () => terminated,
            (events) => events.some((e) => e.loopId === run2.loopId),
        );
        const term2 = terms.find((e) => e.loopId === run2.loopId)!;
        assert.equal(term2.result.status, 200, "S2 must succeed rather than dying with 504 loop_timeout after waiting 420ms in the lane queue");
        const row = await db.test_get_loop_execution.get<{ execution_elapsed_ms: number }>({ id: run2.loopId });
        assert.ok(row !== undefined && row.execution_elapsed_ms < 300, `execution_elapsed_ms (${row?.execution_elapsed_ms}) must exclude the 420ms lane queue wait`);
    });
});

test("{§provider-inference-admission} {§session-loop-lifecycle} 1-slot WORK delegation runs each child consecutively without KV thrashing, yields on WAIT/DONE/BARE, and cancels queued children in O(1)", async (t) => {
    const admission = InferenceAdmission.forEndpoint(`http://lane-work-${randomUUID()}.test/v1`, 1);
    const turnOrder: string[] = [];
    const childSteps = new Map<string, number>();

    const provider = new MultiSessionLaneMock({
        admission,
        burstMs: 300_000,
        handoffMs: 15_000,
        handler: async (args) => {
            const text = userText(args.messages);
            if (text.includes("PARENT_SPAWN")) {
                if (!text.includes("child-a finished") || !text.includes("child-b finished")) {
                    if (!turnOrder.includes("parent:spawn")) {
                        turnOrder.push("parent:spawn");
                        return emitSingleMock(
                            'await plurnk.work({ target: "session://child-a", prompt: "CHILD_A_TASK" });\n'
                            + 'await plurnk.work({ target: "session://child-b", prompt: "CHILD_B_TASK" });\n'
                            + 'await plurnk.wait({});',
                            args,
                        );
                    }
                    return emitSingleMock('await plurnk.wait({});', args);
                }
                turnOrder.push("parent:done");
                return emitSingleMock('await plurnk.done({ text: "all children done" });', args);
            }
            if (text.includes("CHILD_A_TASK")) {
                const step = (childSteps.get("A") ?? 0) + 1;
                childSteps.set("A", step);
                turnOrder.push(`child-a:${step}`);
                if (step === 1) return emitSingleMock('await plurnk.note({ text: "a step 1" });', args);
                if (step === 2) return emitSingleMock('await plurnk.note({ text: "a step 2" });', args);
                return emitSingleMock('await plurnk.done({ text: "child-a finished" });', args);
            }
            if (text.includes("CHILD_B_TASK")) {
                const step = (childSteps.get("B") ?? 0) + 1;
                childSteps.set("B", step);
                turnOrder.push(`child-b:${step}`);
                if (step === 1) return emitSingleMock('await plurnk.note({ text: "b step 1" });', args);
                return emitSingleMock('await plurnk.done({ text: "child-b finished" });', args);
            }
            if (text.includes("BARE_TASK")) {
                if (text.includes("bare-reply-ok")) {
                    return emitSingleMock('await plurnk.done({ text: "bare completed without deadlock" });', args);
                }
                return emitSingleMock('await plurnk.bare({ prompt: "SAY_BARE_OK" });', args);
            }
            if (text.includes("SAY_BARE_OK")) {
                const mock = new Mock({
                    contextWindow: 32_768,
                    responses: [{ assistant: { content: "bare-reply-ok", reasoning: null, finishReason: "stop" } }],
                });
                return mock.generate({ messages: args.messages, sessionId: args.sessionId, signal: args.signal, observeRequest: args.observeRequest });
            }
            throw new Error(`unexpected prompt: ${text.slice(0, 120)}`);
        },
    });
    const alias = `lanework${randomUUID().replaceAll("-", "").slice(0, 8)}`;
    registerAliasProvider(t, alias, provider);

    await withDaemon(provider, async (_db, daemon) => {
        const { workspaceId } = await daemon.createWorkspace({ name: "ws-work" });
        await daemon.setWorkspaceProposalPolicy({ workspaceId, policy: "accept" });
        const { sessionId: parentId } = await daemon.createSession({ workspaceId, name: "parent" });

        const terminated: Array<{ loopId: number; result: { status: number } }> = [];
        const unsubEvents = daemon.subscribeToEvents((_wsId, method, params) => {
            if (method === "loop/terminated") terminated.push(params as { loopId: number; result: { status: number } });
        });
        t.after(unsubEvents);

        // 1. Parent spawns 2 multi-turn children and parks (202 WAIT -> 0ms yield).
        //    Each child runs ALL its turns consecutively (zero round-robin KV eviction).
        const parentRun = await daemon.runLoop({ workspaceId, sessionId: parentId, prompt: "PARENT_SPAWN" });
        await waitFor(
            () => terminated,
            (events) => events.some((e) => e.loopId === parentRun.loopId),
        );
        assert.equal(turnOrder[0], "parent:spawn");
        assert.equal(turnOrder.at(-1), "parent:done");
        const childTurns = turnOrder.slice(1, -1);
        assert.ok(
            JSON.stringify(childTurns) === JSON.stringify(["child-a:1", "child-a:2", "child-a:3", "child-b:1", "child-b:2"])
            || JSON.stringify(childTurns) === JSON.stringify(["child-b:1", "child-b:2", "child-a:1", "child-a:2", "child-a:3"]),
            `children must run consecutively without KV thrashing; got order: ${JSON.stringify(childTurns)}`,
        );

        // 2. BARE on the same 1-slot endpoint yields inter-turn handoff in 0ms and never deadlocks.
        const { sessionId: bareSessionId } = await daemon.createSession({ workspaceId, name: "bare-sess" });
        const bareRun = await daemon.runLoop({ workspaceId, sessionId: bareSessionId, prompt: "BARE_TASK" });
        const bareTerms = await waitFor(
            () => terminated,
            (events) => events.some((e) => e.loopId === bareRun.loopId),
        );
        assert.equal(bareTerms.find((e) => e.loopId === bareRun.loopId)!.result.status, 200);

        // 3. Cancelling a lane-queued session settles 499 immediately without waiting for the active holder.
        const { sessionId: cancelledSessionId } = await daemon.createSession({ workspaceId, name: "cancel-queued" });
        const queuedSeen = Promise.withResolvers<void>();
        const unsubRuntime = daemon.subscribeToRuntimeStream((_wsId, method, params) => {
            if (method === "runtime/telemetry") {
                const p = params as { sessionId: number | null; notice: { kind: string } };
                if (p.sessionId === cancelledSessionId && p.notice.kind === "turn_queued") queuedSeen.resolve();
            }
        });
        t.after(unsubRuntime);

        const heldLease = await admission.acquire({ sessionId: "block-for-cancel", burstMs: 0, handoffMs: 0 });
        try {
            const cancelRun = await daemon.runLoop({ workspaceId, sessionId: cancelledSessionId, prompt: "NEVER_RUNS" });
            await queuedSeen.promise;
            await daemon.cancelSession({ workspaceId, sessionId: cancelledSessionId, reason: "cancel_while_queued" });
            const cancelTerms = await waitFor(
                () => terminated,
                (events) => events.some((e) => e.loopId === cancelRun.loopId),
            );
            assert.equal(cancelTerms.find((e) => e.loopId === cancelRun.loopId)!.result.status, 499);
            assert.equal(admission.waitingCount, 0, "aborted queued session was removed from lane queue in O(1)");
        } finally {
            heldLease.release();
        }
    });
});

test("{§provider-inference-admission} HITL proposal review yields inter-turn handoff in 0ms so a queued sibling runs immediately", async (t) => {
    const projectRoot = mkdtempSync(join(tmpdir(), "plurnk-lane-hitl-"));
    t.after(() => rmSync(projectRoot, { recursive: true, force: true }));
    initGitProject(projectRoot, { "notes.txt": "hello\n" });

    const admission = InferenceAdmission.forEndpoint(`http://lane-hitl-${randomUUID()}.test/v1`, 1);
    const provider = new MultiSessionLaneMock({
        admission,
        burstMs: 300_000,
        handoffMs: 60_000, // Long handoff so any failure to explicitly yield on HITL would clearly stall sibling!
        handler: async (args) => {
            const text = userText(args.messages);
            if (text.includes("PROPOSE_EDIT")) {
                if (text.includes("updated-after-approval") || text.includes("approved")) {
                    return emitSingleMock('await plurnk.done({ text: "proposer finished" });', args);
                }
                return emitSingleMock('await plurnk.edit({ path: "notes.txt", range: "1,-1", content: "updated-after-approval\\n" });', args);
            }
            if (text.includes("SIBLING_TASK")) {
                return emitSingleMock('await plurnk.done({ text: "sibling ran while proposal waited" });', args);
            }
            throw new Error(`unexpected prompt: ${text.slice(0, 120)}`);
        },
    });
    const alias = `lanehitl${randomUUID().replaceAll("-", "").slice(0, 8)}`;
    registerAliasProvider(t, alias, provider);

    await withDaemon(provider, async (_db, daemon) => {
        const { workspaceId } = await daemon.createWorkspace({ name: "ws-hitl", projectRoot });
        await daemon.setWorkspaceProposalPolicy({ workspaceId, policy: "review" });
        const { sessionId: proposerId } = await daemon.createSession({ workspaceId, name: "proposer" });
        await daemon.registerSessionOwner(workspaceId, { address: "acp://reviewer", tools: ["request_approval"], interactive: true });
        await daemon.claimSessionOwner({ workspaceId, sessionId: proposerId, owner: "acp://reviewer" });
        const { sessionId: siblingId } = await daemon.createSession({ workspaceId, name: "sibling" });

        const proposals: Array<{ logEntryId: number; loopId: number }> = [];
        const terminated: Array<{ loopId: number; result: { status: number } }> = [];
        const unsubEvents = daemon.subscribeToEvents((_wsId, method, params) => {
            if (method === "loop/proposal") proposals.push(params as { logEntryId: number; loopId: number });
            if (method === "loop/terminated") terminated.push(params as { loopId: number; result: { status: number } });
        });
        t.after(unsubEvents);

        const proposerRun = await daemon.runLoop({ workspaceId, sessionId: proposerId, prompt: "PROPOSE_EDIT" });
        const pendingProposals = await waitFor(
            () => proposals,
            (events) => events.some((e) => e.loopId === proposerRun.loopId),
        );
        const proposal = pendingProposals.find((e) => e.loopId === proposerRun.loopId)!;

        // Proposer is blocked waiting on human review: inter-turn handoff MUST have yielded in 0ms!
        assert.equal(admission.reservedCount, 0, "HITL review yielded inter-turn lane reservation in 0ms");

        // Sibling runs immediately on the 1-slot endpoint and finishes 200 BEFORE proposal is resolved!
        const siblingRun = await daemon.runLoop({ workspaceId, sessionId: siblingId, prompt: "SIBLING_TASK" });
        const siblingTerms = await waitFor(
            () => terminated,
            (events) => events.some((e) => e.loopId === siblingRun.loopId),
        );
        assert.equal(siblingTerms.find((e) => e.loopId === siblingRun.loopId)!.result.status, 200);

        // Now resolve the proposal and verify proposer completes cleanly too.
        await daemon.resolveProposal(
            proposal.logEntryId,
            { decision: "accept", outcome: "approved" },
            { workspaceId, address: "acp://reviewer" },
        );
        const finalTerms = await waitFor(
            () => terminated,
            (events) => events.some((e) => e.loopId === proposerRun.loopId),
        );
        assert.equal(finalTerms.find((e) => e.loopId === proposerRun.loopId)!.result.status, 200);
    });
});
