// The module's HTTP surface against a mock seam (no daemon): §3 management-action AG-UI Runs execute
// via the seam and finish clean; unknown kinds error honestly; a resume tool-result
// resolves without driving a loop.

import { test } from "node:test";
import { wireRow } from "../test/log-fixture.ts";
import assert from "node:assert/strict";
import { host } from "../test/host.ts";
import Translator from "./Translator.ts";
import { AGUI_BUILTIN_ACTIONS } from "./AguiSurface.ts";
import type {
    ApplicationActionContext,
    ApplicationPort,
    LogEntryWire,
    ProposalProjection,
    ProposalResolution,
    WorkerOwner,
} from "@plurnk/plurnk-contracts";
import type { AguiEvent } from "./types.ts";
import type { Interrupt } from "@ag-ui/core";
// {§credential-authority} — the daemon's own authority on the mock seam; the module issues through it.
const { default: Credentials } = await import("../../plurnk-core/src/server/Credentials.ts") as { default: new (options?: { readonly operatorSecret?: string | null }) => ApplicationPort["credentials"] };
const FLOOR = {
    PLURNK_AUTH: "0", PLURNK_PASS: "", PLURNK_AGUI_ISSUER: "",
    PLURNK_AGUI_ACCESS_TTL_SEC: "3600", PLURNK_AGUI_REFRESH_TTL_SEC: "2592000",
};

// Partial log rows for a mock seam: the port serves the daemon's whole LogEntryWire; these fixtures
// carry only what the module under test reads.
const logRows = (rows: readonly Record<string, unknown>[]): LogEntryWire[] => rows.map((row) => wireRow(row as Partial<LogEntryWire>));
// What a reader sees of a snapshot: arrivals and speech as text, an operation as its calls.
type Replayed = { id: string; role: string; content?: unknown; toolCalls?: ReadonlyArray<{ function: { name: string } }> };
const transcript = (messages: readonly Replayed[] | undefined): Array<Record<string, unknown>> => (messages ?? []).map(({ id, role, content, toolCalls }) =>
    toolCalls === undefined ? { id, role, content } : { id, role, calls: toolCalls.map(({ function: { name } }) => name) });
import { PlurnkParser } from "@plurnk/plurnk-parser";
import { Problems, Validator } from "@plurnk/plurnk-contracts";
import { loopUsage } from "../test/accounting-fixture.ts";
import { streamConclusion, streamEvent, termination } from "../test/notification-fixture.ts";
import { HttpAgent } from "@ag-ui/client";
import { isExecution } from "@plurnk/plurnk-contracts";
import { replayState } from "../test/state-replay.ts";



const MODULE_INPUT_SCHEMA = Object.freeze({
    type: "object",
    additionalProperties: true,
});

const MODULE_OUTPUT_SCHEMA = Object.freeze({
    type: "object",
    additionalProperties: true,
});
const workspaceRow = (id: number, name: string) => ({
    id,
    name,
    project_root: null,
    project_label: null,
    created_at: "2026-01-01T00:00:00.000Z",
});
// {§agui-sync} An observation watches a world that exists: here, workspace 3 named `name`.
const existingWorld = (seam: ApplicationPort, name: string): void => {
    seam.listWorkspaces = async () => [workspaceRow(3, name)];
    seam.attachWorkspace = async () => ({ workspaceId: 3, workspaceName: name, projectRoot: null, projectLabel: null });
};
const workerRow = (
    id: number,
    name: string,
    origin: "model" | "_plurnk" = "model",
    parentWorkerId: number | null = null,
) => ({
    id,
    name,
    created_at: "2026-01-01T00:00:00.000Z",
    origin,
    owner: "_plurnk",
    parentWorkerId,
    kind: (parentWorkerId === null ? "root" : "work") as "root" | "fork" | "work",
    lifecycle: "idle" as const,
});
type WorkerRow = ReturnType<typeof workerRow>;
// A world's workers as the daemon serves them: listed, and read by exact name or id whatever their
// origin. Rows read live, so a fixture that mints a worker can add its row.
const directory = (seam: ApplicationPort, workers: readonly WorkerRow[] | ((workspaceId: number) => readonly WorkerRow[])): void => {
    const rows = typeof workers === "function" ? workers : () => workers;
    seam.listWorkers = async (workspaceId, query) => rows(workspaceId).filter(({ origin, parentWorkerId }) =>
        (query?.origin === undefined || origin === query.origin)
        && (query?.parentWorkerId === undefined || parentWorkerId === query.parentWorkerId));
    seam.readWorker = async ({ workspaceId, identity }) => rows(workspaceId)
        .find(({ id, name }) => identity.name === undefined ? id === identity.id : name === identity.name) ?? null;
};

// `operatorSecret` is the authority's under PLURNK_AUTH=1 ({§credential-authority}); the floor is off.
const mockSeam = (operatorSecret: string | null = null) => {
    const resolves: Array<{ logEntryId: number; resolution: ProposalResolution }> = [];
    const loopRuns: Array<{
        selector?: string;
        childSelector?: string | null;
        prompt: string;
    }> = [];
    const modelSets: Array<{ selector?: string; childSelector?: string | null }> = [];
    const modelQueries: unknown[] = [];
    const effortSets: unknown[] = [];
    const handlers = new Set<(s: number | null, m: string, p: unknown) => void>();
    const owners = new Map<string, WorkerOwner>();
    const activations: number[] = [];
    // A world the fixture creates exists from then on under the name it was created with, as the daemon's does.
    const worlds = new Set<string>();
    const world = (name: string) => ({ workspaceId: 3, workspaceName: name, projectRoot: null, projectLabel: null });
    const seam: ApplicationPort = {
        credentials: new Credentials({ operatorSecret }),
        activateWorkspace: async ({ workspaceId }) => { activations.push(workspaceId); },
        registerWorkerOwner: async (_workspaceId, owner) => { owners.set(owner.address, owner); },
        claimWorkerOwner: async ({ owner }) => {
            const registered = owners.get(owner);
            assert.ok(registered, "the adapter registers the owner before claiming a worker");
            return registered;
        },
        ensureRuntimeWorker: async () => 1,
        configurationNotices: () => [],
        // {§http-host} — the test host (../test/host.ts) mounts the module's routes on its own socket.
        registerHttpRoute: () => {},
        httpAddress: () => ({ host: "127.0.0.1", port: 0 }),
        listClientDisplayCapabilities: async () => [],
        listModuleActions: () => [],
        invokeModuleAction: async (name) => { throw new Error(`unexpected module action '${name}'`); },
        subscribeToEvents: (h) => { handlers.add(h); return () => { handlers.delete(h); }; },
        pendingProposals: async () => [],
        pendingClientInteractions: async () => [],
        resolveProposal: async (logEntryId, resolution) => {
            resolves.push({ logEntryId, resolution });
            // The engine's continued loop terminating — closes the resume stream.
            setImmediate(() => handlers.forEach((h) => h(3, "loop/terminated", termination({
                workerId: 77,
                loopId: 1,
                usage: loopUsage({ inputTokens: 1, outputTokens: 1, curationBudget: 1000 }),
            }))));
        },
        resolveClientInteraction: async () => {},
        runLoop: async (a) => { loopRuns.push({ prompt: a.prompt, ...(a.selector !== undefined ? { selector: a.selector } : {}), ...(a.childSelector !== undefined ? { childSelector: a.childSelector } : {}) }); return { status: 100, action: "injected_next_turn" as const, loopId: 9, turnSeq: 2 }; },
        cancelDrain: () => true,
        cancelWorker: async () => {},
        executorTags: () => ["sh"],
        executorJsonBodyTags: () => [],
        shareWorkspace: async ({ folder }: { folder: string }) => ({ folder }),
        dispatchClientAction: async ({ statements }) => statements.map(() => ({ status: 200 })),
        cancelLoop: async () => false,
        readLog: async () => logRows([{ id: 1, op: "SEND", status_rx: 200, origin: "model" }]),
        readMessages: async () => [],
        listProviders: () => ({ aliases: [{ alias: "opus", provider: "anthropic", model: "claude", active: true, inputCapacity: 200000 }] }),
        listModels: (query) => {
            modelQueries.push(query);
            return {
                items: [{
                    selector: "google/gemini-3-flash",
                    provider: "google",
                    providerName: "Google",
                    model: "gemini-3-flash",
                    modelName: "Gemini 3 Flash",
                    limits: { contextTokens: 1_000_000 },
                    capabilities: {
                        attachment: true,
                        reasoning: true,
                        efforts: ["adaptive", "low", "medium", "high"],
                        toolCall: true,
                        inputModalities: ["text", "image"],
                        outputModalities: ["text"],
                    },
                    readiness: { ready: true, causes: [] },
                }],
                offset: query.offset ?? 0,
                total: 1,
            };
        },
        createWorkspace: async ({ name = "agui-t" }) => { worlds.add(name); return world(name); },
        attachWorkspace: async () => {
            const [name] = worlds;
            if (name === undefined) throw new Error("unexpected attach");
            return world(name);
        },
        listWorkspaces: async () => [...worlds].map((name) => workspaceRow(3, name)),
        listWorkers: async () => [],
        // Every named model worker of this fixture's world is worker 77, as createWorker mints it.
        readWorker: async ({ identity }) => workerRow(77, identity.name ?? "model-fresh", "model"),
        listWorkerLoops: async () => [],
        workerAccounting: async () => ({ requests: [], usage: null, knownUsage: null, costUsd: null, knownCostUsd: null }),
        listPrompts: async () => ["hi"],
        renameWorkspace: async (_id, name) => ({ id: 3, name }),
        rollback: async () => { throw new Error("rollback is not exercised here"); },
        workspaceDerivationStatus: () => null,
        workspacePreparationStatus: () => [],
        readEntry: async () => ({
            status: 200,
            entry: {
                entryId: 1,
                target: "worker:///x",
                channels: {},
            },
        }),
        forkWorker: async () => ({ workerId: 11, workerName: "fork-1", parentWorkerId: 10 }),
        createWorker: async (a) => ({ workerId: 77, workerName: a.name ?? "model-fresh" }),
        readWorkerModel: async () => ({ model: null, spawnModel: null }),
        readWorkerEffort: async () => ({ effort: null, source: "default", supportedEfforts: [] }),
        readWorkspaceCapabilities: async () => ({
            service: {}, workspace: {}, effective: {},
        }),
        setWorkspaceCapabilities: async ({ policy }) => ({
            service: {}, workspace: policy, effective: policy,
        }),
        setWorkerModel: async ({ selector }) => {
            modelSets.push({ selector });
            return selector.includes("/")
                ? { provider: selector.slice(0, selector.indexOf("/")), model: selector.slice(selector.indexOf("/") + 1) }
                : { alias: selector, provider: "openai", model: "mocktest" };
        },
        setWorkerSpawnModel: async ({ selector }) => {
            modelSets.push({ childSelector: selector });
            return selector === null
                ? null
                : selector.includes("/")
                    ? { provider: selector.slice(0, selector.indexOf("/")), model: selector.slice(selector.indexOf("/") + 1) }
                    : { alias: selector, provider: "openai", model: "mocktest" };
        },
        setWorkerEffort: async ({ effort }) => {
            effortSets.push(effort);
            return { effort: "adaptive", source: "explicit", supportedEfforts: ["off", "adaptive", "high"] };
        },
    };
    const finish = (workspaceId: number | null, workerId: number) => setImmediate(() => handlers.forEach((h) => h(workspaceId, "loop/terminated", termination({
        workerId,
        loopId: 9,
        usage: loopUsage({ inputTokens: 1, outputTokens: 1, curationBudget: 1000 }),
    }))));
    const emit = (workspaceId: number | null, method: string, params: unknown) => handlers.forEach((h) => h(workspaceId, method, params));
    return { seam, owners, activations, resolves, loopRuns, modelSets, modelQueries, effortSets, finish, emit };
};

const standardInput = (body: Record<string, unknown>): Record<string, unknown> => ({
    runId: typeof body.runId === "string" ? body.runId : typeof body.workerId === "string" ? body.workerId : crypto.randomUUID(),
    state: {},
    tools: [],
    context: [],
    ...body,
    messages: Array.isArray(body.messages)
        ? body.messages.map((message, index) => ({ id: `message-${index}`, ...(message as Record<string, unknown>) }))
        : [],
});

const post = async (port: number, body: Record<string, unknown>): Promise<AguiEvent[]> => {
    const res = await fetch(`http://127.0.0.1:${port}/agui`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(standardInput(body)) });
    assert.equal(res.status, 200);
    const text = await res.text();
    const events = text.split("\n\n").filter((f) => f.startsWith("data: ")).map((f) => JSON.parse(f.slice(6)) as AguiEvent);
    replayState(events);
    return events;
};

const presentedInterrupt = (events: AguiEvent[]): Interrupt => {
    const last = events.at(-1);
    assert.ok(last?.type === "RUN_FINISHED" && last.outcome?.type === "interrupt");
    assert.equal(last.outcome.interrupts.length, 1);
    return last.outcome.interrupts[0]!;
};

for (const status of [200, 502]) {
    test(`{§agui-state-patches}: HTTP deltas reconstruct the complete gauge through ${status} termination`, async () => {
        const { seam, emit } = mockSeam();
        let children = false;
        seam.listWorkers = async (_workspaceId, query) => query?.parentWorkerId === 77
            ? children ? [{ ...workerRow(88, "child", "model", 77), lifecycle: "running" }] : []
            : [workerRow(77, "state-replay")];
        // {§agui-status-spend} — the daemon's projection over the worker's and its child's settled spend, verbatim.
        const spent = { requests: [{ provider: "openai", model: "mocktest", outcome: "response" as const, usage: { inputTokens: 10, outputTokens: 2, totalTokens: 12 }, cost: { kind: "estimated" as const, amount: { amount: "0.01", currency: "USD" }, source: "fixture" } }], usage: { inputTokens: 10, outputTokens: 2, totalTokens: 12 }, knownUsage: { inputTokens: 10, outputTokens: 2, totalTokens: 12 }, costUsd: "0.01", knownCostUsd: "0.01" };
        seam.workerAccounting = async () => children ? spent : { requests: [], usage: null, knownUsage: null, costUsd: null, knownCostUsd: null };
        const usage = loopUsage({ curationWeight: 123, curationBudget: 4000, contextTokens: 900, contextCapacity: 8000 });
        seam.runLoop = async () => {
            setImmediate(async () => {
                emit(3, "notice/event", { workerId: 77, loopId: 9, notice: {
                    source: "engine:derivation", kind: "search_progress", level: "info",
                    phase: "indexing", completed: 1, total: 2, percent: 50, message: "Indexing.",
                } });
                emit(3, "loop/packet", { workerId: 77, loopId: 9, packetCount: 1 });
                children = true;
                emit(3, "loop/packet", { workerId: 88, loopId: 10, packetCount: 1 });
                await new Promise<void>((resolve) => setImmediate(resolve));
                emit(3, "notice/event", { workerId: 88, loopId: 10, notice: { source: "engine:turn", kind: "turn_generated", level: "info" } });
                await new Promise<void>((resolve) => setImmediate(resolve));
                emit(3, "loop/packet", { workerId: 77, loopId: 9, packetCount: 2 });
                emit(3, "loop/terminated", termination({ workerId: 77, loopId: 9, usage,
                    result: status === 200 ? { status } : { status, problem: Problems.create("test:provider", "failed", status, "Provider refused.") },
                }));
            });
            return { status: 100, action: "enqueued_new_loop", loopId: 9 };
        };
        const mod = await host(seam);
        try {
            const events = await post(mod.address().port, {
                threadId: "state-replay", messages: [{ role: "user", content: "Work." }],
                forwardedProps: { plurnk: { workspace: "state-replay" } },
            });
            const initial = events.find((event) => event.type === "STATE_SNAPSHOT");
            assert.ok(initial?.type === "STATE_SNAPSHOT");
            const patches = events.flatMap((event) => event.type === "STATE_DELTA" ? event.delta : []);
            assert.ok(patches.some(({ path }) => path === "/plurnk/status"), "the whole-gauge replacement is exercised");
            assert.ok(patches.some((op) => op.path === "/plurnk/workspace/activity" && "value" in op && (op.value as { percent?: number })?.percent === 50), "derivation reaches workspace state");
            assert.ok(patches.some((op) => op.path === "/plurnk/status/children" && "value" in op && op.value === 1), "child activity reaches state");
            assert.ok(patches.some((op) => op.path === "/plurnk/status/spend" && "value" in op && (op.value as { requests?: number })?.requests === 1), "the spend reaches state without promoting the child's notice");
            // {§agui-workspace-state} Derivation is the workspace's: the worker's terminal leaves it as derivation last reported it.
            const workspace = (initial.snapshot as { plurnk: { workspace: Record<string, unknown> } }).plurnk.workspace;
            assert.deepEqual(replayState(events), {
                ...initial.snapshot,
                plurnk: { ...initial.snapshot.plurnk, workspace: { ...workspace, activity: {
                    kind: "derivation", phase: "indexing", completed: 1, total: 2, percent: 50, message: "Indexing.",
                } }, status: {
                    lifecycle: status === 200 ? "completed" : "failed", model: null, loopId: 9,
                    packetCount: 2, children: 1, waitUntil: null, claimedAt: null, terminatedAt: 1_792_008_205_250,
                    spend: { requests: 1, usage: { inputTokens: 10, outputTokens: 2, totalTokens: 12 }, knownUsage: { inputTokens: 10, outputTokens: 2, totalTokens: 12 }, costUsd: "0.01", knownCostUsd: "0.01" },
                } },
                budget: { curationWeight: 123, curationBudget: 4000, contextTokens: 900, contextCapacity: 8000 },
            });
        } finally { await mod.close(); }
    });
}

test("{§agui-status-timing} a connected observer never pairs one loop's stamp with another loop's number, and the end stamp lands before the Run's terminal", async () => {
    const { seam, emit } = mockSeam();
    const claimed = 1_792_008_000_000;
    const ended = 1_792_008_205_250;
    seam.runLoop = async () => {
        setImmediate(async () => {
            const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
            emit(3, "notice/event", { workerId: 77, loopId: 9, notice: { source: "engine:lifecycle", kind: "loop_status", level: "info", status: 102, waitUntil: null, packetCount: 0, claimedAt: claimed } });
            await tick();
            emit(3, "loop/packet", { workerId: 77, loopId: 9, packetCount: 1 });
            await tick();
            emit(3, "loop/terminated", termination({ workerId: 77, loopId: 9, terminatedAt: ended, usage: loopUsage({ curationBudget: 1000 }) }));
        });
        return { status: 100, action: "enqueued_new_loop", loopId: 9 };
    };
    const mod = await host(seam);
    try {
        const events = await post(mod.address().port, { threadId: "timer", messages: [{ role: "user", content: "Work." }], forwardedProps: { plurnk: { workspace: "agui-t" } } });
        type Gauge = { plurnk: { status: { lifecycle: string; loopId: number | null; packetCount: number; claimedAt: number | null; terminatedAt: number | null } } };
        const states = events.flatMap((event, index) => event.type === "STATE_DELTA" ? [replayState(events.slice(0, index + 1)) as Gauge] : []);
        for (const { plurnk: { status } } of states) {
            if (status.claimedAt === claimed) assert.equal(status.loopId, 9, "the claim's stamp rides with its own loop's number");
        }
        const ending = events.findIndex((event) => event.type === "STATE_DELTA" && event.delta.some((op) => op.path === "/plurnk/status/terminatedAt" && "value" in op && op.value === ended));
        const finished = events.findIndex((event) => event.type === "RUN_FINISHED");
        assert.ok(ending >= 0 && ending < finished, "the end stamp arrives before the Run's terminal");
        const final = replayState(events) as Gauge;
        assert.deepEqual(
            [final.plurnk.status.lifecycle, final.plurnk.status.loopId, final.plurnk.status.packetCount, final.plurnk.status.claimedAt, final.plurnk.status.terminatedAt],
            ["completed", 9, 1, claimed, ended],
        );
    } finally { await mod.close(); }
});

test("{§agui-status-spend} a Run's spend is its worker's since it began, republished when the worker's own turn settles", async () => {
    const { seam, emit } = mockSeam();
    const request = { provider: "openai", model: "mocktest", outcome: "response" as const, usage: { inputTokens: 10, outputTokens: 2, totalTokens: 12 },
        cost: { kind: "estimated" as const, amount: { amount: "0.01", currency: "USD" }, source: "fixture" } };
    const projection = (count: number) => ({
        requests: Array.from({ length: count }, () => request),
        usage: { inputTokens: 10 * count, outputTokens: 2 * count, totalTokens: 12 * count },
        knownUsage: { inputTokens: 10 * count, outputTokens: 2 * count, totalTokens: 12 * count },
        costUsd: `0.0${count}`, knownCostUsd: `0.0${count}`,
    });
    // Two requests settled on its earlier loops; this Run's turn settles a third.
    let settled = 2;
    seam.workerAccounting = async ({ workerId }) => { assert.equal(workerId, 77); return projection(settled); };
    seam.runLoop = async () => {
        setImmediate(async () => {
            settled = 3;
            emit(3, "notice/event", { workerId: 77, loopId: 9, notice: { source: "engine:turn", kind: "turn_generated", level: "info" } });
            await new Promise<void>((resolve) => setImmediate(resolve));
            emit(3, "loop/terminated", termination({ workerId: 77, loopId: 9, usage: loopUsage({ inputTokens: 10, outputTokens: 2, curationBudget: 1000 }) }));
        });
        return { status: 100, action: "enqueued_new_loop", loopId: 9 };
    };
    const mod = await host(seam);
    try {
        const events = await post(mod.address().port, { threadId: "spender", messages: [{ role: "user", content: "Work." }], forwardedProps: { plurnk: { workspace: "agui-t" } } });
        const initial = events.find((event) => event.type === "STATE_SNAPSHOT");
        assert.ok(initial?.type === "STATE_SNAPSHOT");
        assert.equal((initial.snapshot as { plurnk: { status: { spend: { requests: number } } } }).plurnk.status.spend.requests, 2,
            "a fresh observer starts from what the worker has already spent");
        const spent = events.flatMap((event) => event.type === "STATE_DELTA" ? event.delta : [])
            .filter((op) => op.path === "/plurnk/status/spend").map((op) => ("value" in op ? (op.value as { requests: number; costUsd: string }) : null));
        assert.deepEqual(spent.at(-1), { ...projection(3), requests: 3 }, "the worker's own settled turn republishes its spend");
    } finally { await mod.close(); }
});

test("{§agui-lifecycle-projection}: log.read and live NOTE rows retain literal bodies without mutating history", async () => {
    const { seam, loopRuns } = mockSeam();
    existingWorld(seam, "history");
    const body = "Inspect, implement, and verify.\nRetain the observed evidence.";
    const tx = { runtime: "NOTE", aside: "working memory", target: null, body };
    const rows = [
        wireRow({ id: 3, worker_id: 20, loop_id: 1, turn_id: 2, loop_seq: 1, turn_seq: 2, sequence: 1, origin: "model", op: "NOTE", tx, rx: { status: 200 }, reasoning: "Evidence retained." }),
        wireRow({ id: 2, worker_id: 20, loop_id: 1, turn_id: 1, loop_seq: 1, turn_seq: 1, sequence: 2, origin: "model", op: "READ", tx: { body: null }, rx: { status: 200, content: "verbatim\n" } }),
        wireRow({ id: 1, worker_id: 20, loop_id: 1, turn_id: 1, loop_seq: 1, turn_seq: 1, sequence: 1, origin: "_plurnk", op: "NOTE", tx: JSON.stringify(tx), rx: null }),
    ];
    const before = structuredClone(rows);
    seam.readLog = async () => logRows(rows);
    const mod = await host(seam);
    try {
        const events = await post(mod.address().port, {
            threadId: "history",
            forwardedProps: { plurnk: { workspace: "history", action: { kind: "log.read", limit: 20 } } },
        });
        const result = events.find((event) => event.type === "CUSTOM" && event.name === "plurnk.action.result");
        assert.equal(result?.type, "CUSTOM");
        if (result?.type !== "CUSTOM") throw new Error("missing log.read result");
        assert.deepEqual(result.value, { kind: "log.read", ok: true, result: { entries: rows } });
        const translator = new Translator({ threadId: "history", runId: "live", modelWorkerId: 20 });
        for (const [index, row] of rows.entries()) {
            const live = translator.logEntry({ entry: row }).find((event) => event.type === "CUSTOM" && event.name === "plurnk.row");
            assert.equal(live?.type, "CUSTOM");
            if (live?.type === "CUSTOM") assert.deepEqual(result.value.result.entries[index], live.value);
        }
        assert.deepEqual(rows, before, "the standards boundary does not rewrite stored notes");
        assert.deepEqual(loopRuns, [], "reading history does not invoke a model");
    } finally {
        await mod.close();
    }
});

// A streaming reader that stays OPEN, collecting events until the connection ends —
// lets a test hold concurrent AG-UI Runs on one workspace and observe routing live.
const openStream = (port: number, body: Record<string, unknown>): Promise<AguiEvent[]> =>
    fetch(`http://127.0.0.1:${port}/agui`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(standardInput(body)) })
        .then((res) => res.text())
        .then((text) => text.split("\n\n").filter((f) => f.startsWith("data: ")).map((f) => JSON.parse(f.slice(6)) as AguiEvent));

const waitForFixture = async (barrier: Promise<void>, detail: () => string): Promise<void> => {
    let timeout: NodeJS.Timeout | null = null;
    try {
        await Promise.race([
            barrier,
            new Promise<never>((_, reject) => {
                timeout = setTimeout(() => reject(new Error(detail())), 10_000);
            }),
        ]);
    } finally {
        if (timeout !== null) clearTimeout(timeout);
    }
};

test("{§module-shutdown-order} stopping AG-UI refuses new work while an existing run receives its terminal event", async () => {
    const { seam, finish } = mockSeam();
    const entered = Promise.withResolvers<void>();
    seam.runLoop = async () => {
        entered.resolve();
        return { status: 100, action: "enqueued_new_loop", loopId: 9, turnSeq: 1 };
    };
    const mod = await host(seam);
    try {
        const port = mod.address().port;
        const stream = openStream(port, { threadId: "shutdown", messages: [{ role: "user", content: "hi" }], forwardedProps: { plurnk: { workspace: "w" } } });
        await entered.promise;
        mod.stop();
        const refused = await fetch(`http://127.0.0.1:${port}/agui`);
        assert.equal(refused.status, 503);
        const problem = await refused.json() as { type: string; stage: string };
        assert.equal(problem.type, "https://problems.plurnk.xyz/agui/http/service-stopping");
        assert.equal(problem.stage, "shutdown");
        finish(3, 77);
        const events = await stream;
        assert.ok(events.some((event) => event.type === "CUSTOM" && event.name === "plurnk.terminated"));
        assert.ok(events.some((event) => event.type === "RUN_FINISHED"));
    } finally { await mod.close(); }
});

test("{§agui-shutdown} close ends every idle connection without cancelling workers", async () => {
    const { seam } = mockSeam();
    existingWorld(seam, "w");
    const cancellations: number[] = [];
    seam.cancelDrain = (workerId) => { cancellations.push(workerId); return true; };
    const mod = await host(seam);
    const controllers = Array.from({ length: 3 }, () => new AbortController());
    let closing: Promise<void> | undefined;
    try {
        const streams = await Promise.all(controllers.map(async (controller, index) => {
            const response = await fetch(`http://127.0.0.1:${mod.address().port}/agui/connect`, {
                method: "POST", headers: { "content-type": "application/json" }, signal: controller.signal,
                body: JSON.stringify(standardInput({ threadId: `idle-${index}`, messages: [],
                    forwardedProps: { plurnk: { workspace: "w" } } })),
            });
            assert.equal(response.status, 200);
            return response;
        }));
        mod.stop();
        const bodies = Promise.all(streams.map((response) => response.text()));
        closing = mod.close();
        await waitForFixture(Promise.all([closing, bodies]).then(() => {}), () => "idle client streams prevented module/listener closure");
        for (const body of await bodies) {
            const events = body.split("\n\n").filter((frame) => frame.startsWith("data: ")).map((frame) => JSON.parse(frame.slice(6)) as AguiEvent);
            assert.equal(events.filter(({ type }) => type === "RUN_STARTED").length, 1);
            assert.equal(events.filter(({ type }) => type === "RUN_ERROR").length, 1);
            const problem = events.find((event) => event.type === "CUSTOM" && event.name === "plurnk.problem");
            assert.equal(problem?.type, "CUSTOM");
            if (problem?.type === "CUSTOM") {
                assert.equal(problem.value.type, "https://problems.plurnk.xyz/agui/http/service-stopping");
                assert.equal(problem.value.status, 503);
            }
            assert.equal(events.at(-1)?.type, "RUN_ERROR");
            assert.ok(!events.some((event) => event.type === "CUSTOM" && event.name === "plurnk.terminated"));
        }
        assert.deepEqual(cancellations, []);
        mod.module.close();
    } finally {
        controllers.forEach((controller) => controller.abort());
        await (closing ?? mod.close());
    }
});

test("{§agui-shutdown} preparation finishing after close cannot open a stream", async () => {
    const { seam, loopRuns } = mockSeam();
    existingWorld(seam, "w");
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    seam.readWorker = async ({ identity }) => {
        entered.resolve();
        await release.promise;
        return workerRow(77, identity.name ?? "late", "model");
    };
    const mod = await host(seam);
    const controller = new AbortController();
    try {
        const response = fetch(`http://127.0.0.1:${mod.address().port}/agui/connect`, {
            method: "POST", headers: { "content-type": "application/json" }, signal: controller.signal,
            body: JSON.stringify(standardInput({ threadId: "late", messages: [],
                forwardedProps: { plurnk: { workspace: "w" } } })),
        });
        await entered.promise;
        mod.module.close();
        release.resolve();
        const res = await response;
        assert.equal(res.status, 503);
        assert.equal((await res.json()).type, "https://problems.plurnk.xyz/agui/http/service-stopping");
        assert.deepEqual(loopRuns, []);
    } finally {
        release.resolve();
        controller.abort();
        await mod.close();
    }
});

test("{§agui-stream-producer} workspace stream notifications route to their producing worker's AG-UI Run", async () => {
    const { seam, emit } = mockSeam();
    const firstRun = Promise.withResolvers<void>();
    const bothRuns = Promise.withResolvers<void>();
    const releaseSecondWorker = Promise.withResolvers<void>();
    let runCalls = 0;
    seam.listWorkspaces = async () => [workspaceRow(3, "w")];
    seam.attachWorkspace = async () => ({ workspaceId: 3, workspaceName: "w", projectRoot: null, projectLabel: null });
    directory(seam, [workerRow(20, "model-1")]);
    seam.createWorker = async (a) => {
        if (a.name === "chat-b") await releaseSecondWorker.promise;
        return { workerId: a.name === "chat-a" ? 77 : 78, workerName: a.name ?? "x" };
    };
    // runLoop does NOT finish here: both streams stay open so the injected stream event
    // races concurrent management-action AG-UI Runs against a resumed exec.
    seam.runLoop = async ({ workerId }) => {
        runCalls++;
        if (runCalls === 1) firstRun.resolve();
        if (runCalls === 2) bothRuns.resolve();
        return { status: 100, action: "enqueued_new_loop" as const, loopId: workerId === 77 ? 9 : 10 };
    };
    const mod = await host(seam);
    try {
        const port = mod.address().port;
        const a = openStream(port, { threadId: "chat-a", messages: [{ role: "user", content: "hi" }], forwardedProps: { plurnk: { workspace: "w" } } });
        const b = openStream(port, { threadId: "chat-b", messages: [{ role: "user", content: "hi" }], forwardedProps: { plurnk: { workspace: "w" } } });
        await waitForFixture(firstRun.promise, () => `first AG-UI Run did not bind through runLoop; observed ${runCalls}/2`);
        releaseSecondWorker.resolve();
        await waitForFixture(bothRuns.promise, () => `both AG-UI Runs did not bind through runLoop; observed ${runCalls}/2`);
        emit(3, "stream/event", streamEvent({ entryId: 5, workerId: 77, target: "sh:///ab3d5678", scheme: "sh", contentLength: 5 }));
        emit(3, "stream/concluded", streamConclusion({ entryId: 5, workerId: 77, target: "sh:///ab3d5678", scheme: "sh" }));
        emit(3, "loop/terminated", termination({ workerId: 77, loopId: 9, usage: loopUsage({ inputTokens: 1, outputTokens: 1, curationBudget: 1000 }) }));
        emit(3, "loop/terminated", termination({ workerId: 78, loopId: 10, usage: loopUsage({ inputTokens: 1, outputTokens: 1, curationBudget: 1000 }) }));
        const [ea, eb] = await Promise.all([a, b]);
        const hasExecActivity = (evs: AguiEvent[]) => evs.some((e) => e.type === "ACTIVITY_SNAPSHOT" && (e as { messageId?: string }).messageId === "stream-5");
        assert.ok(hasExecActivity(ea), "AG-UI Run A received the exec stream activity");
        assert.equal(hasExecActivity(eb), false, "AG-UI Run B did not receive another worker's stream activity");
    } finally { await mod.close(); }
});

test("a read-only management Run does not duplicate the message Run's model settlement", async () => {
    const { seam, emit } = mockSeam();
    const loopStarted = Promise.withResolvers<void>();
    const readStarted = Promise.withResolvers<void>();
    const releaseRead = Promise.withResolvers<void>();
    seam.runLoop = async () => {
        loopStarted.resolve();
        return { status: 100, action: "enqueued_new_loop" as const, loopId: 9 };
    };
    seam.readEntry = async () => {
        readStarted.resolve();
        await releaseRead.promise;
        return { status: 200, entry: { entryId: 1, target: "worker:///x", channels: {} } };
    };
    const mod = await host(seam);
    try {
        const port = mod.address().port;
        const messageRun = openStream(port, {
            threadId: "agui-t",
            runId: "message-run",
            messages: [{ role: "user", content: "hi" }],
            forwardedProps: { plurnk: { workspace: "agui-t" } },
        });
        await waitForFixture(loopStarted.promise, () => "message AG-UI Run did not enter runLoop");

        const management = openStream(port, {
            threadId: "agui-t",
            runId: "management-run",
            forwardedProps: {
                plurnk: {
                    workspace: "agui-t",
                    action: { kind: "entry.read", target: "worker:///x" },
                },
            },
        });
        await waitForFixture(readStarted.promise, () => "management AG-UI Run did not enter entry.read");

        emit(3, "log/entry", {
            entry: {
                id: 21,
                worker_id: 77,
                loop_id: 9,
                origin: "model",
                op: "SEND", status_rx: 200, rx: { answers: ["agui://anonymous/threads/agui-t/messages/m1"] },
                loop_seq: 1, turn_seq: 1, sequence: 1,
                tx: { body: "one answer" },
                turn_id: 1,
            },
        });
        releaseRead.resolve();
        emit(3, "loop/terminated", termination({
            workerId: 77,
            loopId: 9,
            usage: loopUsage({ inputTokens: 1, outputTokens: 1, curationBudget: 1000 }),
        }));

        const [messageEvents, managementEvents] = await Promise.all([messageRun, management]);
        const answerRows = (events: AguiEvent[]) => events.filter((event) =>
            event.type === "CUSTOM"
            && (event as { name?: string; value?: { id?: number } }).name === "plurnk.row"
            && (event as { value?: { id?: number } }).value?.id === 21);
        assert.equal(answerRows(messageEvents).length, 1, "the message Run receives its SEND exactly once");
        assert.equal(answerRows(managementEvents).length, 0, "the management Run receives none of the bound worker's rows");
    } finally { await mod.close(); }
});

test("{§agui-worker-owner} a control Run declares its owner's capability set: tools, and whether a person attends", async () => {
    const { seam, owners } = mockSeam();
    existingWorld(seam, "t1");
    seam.readWorkerModel = async () => ({ model: null, spawnModel: null });
    const mod = await host(seam);
    try {
        const port = mod.address().port;
        const tools = [{ name: "request_approval", description: "Review a proposed operation.", parameters: { type: "object" } }];
        for (const [stated, interactive] of [[true, true], [false, false], [undefined, false]] as const) {
            await post(port, { threadId: "t1", tools, forwardedProps: { plurnk: {
                workspace: "t1", control: true, ...(stated === undefined ? {} : { interactive: stated }), action: { kind: "worker.model.get" },
            } } });
            assert.deepEqual(owners.get("agui://anonymous/threads/t1"), { address: "agui://anonymous/threads/t1", tools: ["request_approval"], interactive },
                `interactive ${String(stated)}: unstated, nobody attends`);
        }
        const refused = await fetch(`http://127.0.0.1:${port}/agui`, { method: "POST", headers: { "content-type": "application/json" },
            body: JSON.stringify(standardInput({ threadId: "t1", forwardedProps: { plurnk: { workspace: "t1", interactive: "yes" } } })) });
        assert.equal(refused.status, 400);
        assert.match((await refused.json() as { type: string }).type, /interactive-invalid$/u);
    } finally { await mod.close(); }
});

test("{§agui-management-plane} a management-action AG-UI Run executes via the seam: result custom + RUN_FINISHED, no loop", async () => {
    const { seam, modelQueries } = mockSeam();
    // loop.inject below addresses a live world; it never mints one.
    seam.listWorkspaces = async () => [workspaceRow(3, "t1")];
    seam.attachWorkspace = async () => ({ workspaceId: 3, workspaceName: "t1", projectRoot: null, projectLabel: null });
    const mod = await host(seam);
    try {
        const events = await post(mod.address().port, { threadId: "t1", workerId: "r1", forwardedProps: { plurnk: { workspace: "t1", action: { kind: "providers.list" } } } });
        const result = events.find((e) => e.type === "CUSTOM" && (e as { name: string }).name === "plurnk.action.result") as { value: { kind: string; ok: boolean; result: { aliases: Array<{ alias: string }> } } };
        assert.equal(result.value.ok, true);
        assert.equal(result.value.result.aliases[0].alias, "opus");
        assert.equal(events[events.length - 1].type, "RUN_FINISHED", "management-action AG-UI Run finishes clean");
        const models = await post(mod.address().port, { threadId: "t1", workerId: "models", forwardedProps: { plurnk: { action: { kind: "models.list", provider: "google", search: "flash", limit: 10 } } } });
        const modelResult = models.find((e) => e.type === "CUSTOM" && (e as { name: string }).name === "plurnk.action.result") as { value: { ok: boolean; result: { items: Array<{ selector: string }> } } };
        assert.equal(modelResult.value.ok, true);
        assert.equal(modelResult.value.result.items[0]?.selector, "google/gemini-3-flash");
        assert.deepEqual(modelQueries, [{ provider: "google", search: "flash", limit: 10 }]);

        const invalidModels = await post(mod.address().port, { threadId: "t1", workerId: "models-invalid", forwardedProps: { plurnk: { action: { kind: "models.list", limit: 101 } } } });
        const invalidModelResult = invalidModels.find((e) => e.type === "CUSTOM" && (e as { name: string }).name === "plurnk.action.result") as { value: { ok: boolean; problem: { status: number; type: string } } };
        assert.equal(invalidModelResult.value.ok, false);
        assert.equal(invalidModelResult.value.problem.status, 400);
        // inject rides the same surface
        const inj = await post(mod.address().port, { threadId: "t1", workerId: "r2", forwardedProps: { plurnk: { workspace: "t1", action: { kind: "loop.inject", prompt: "steer" } } } });
        const ack = inj.find((e) => e.type === "CUSTOM" && (e as { name: string }).name === "plurnk.action.result") as { value: { ok: boolean; result: { action: string } } };
        assert.equal(ack.value.result.action, "injected_next_turn", "inject folds into the active drain via the unified runLoop");
        // an unknown kind errors honestly
        const bad = await post(mod.address().port, { threadId: "t1", workerId: "r3", forwardedProps: { plurnk: { workspace: "t1", action: { kind: "nope.nothing" } } } });
        const err = bad.find((e) => e.type === "CUSTOM" && (e as { name: string }).name === "plurnk.action.result") as {
            value: {
                ok: boolean;
                problem: {
                    type: string;
                    detail: string;
                    requestedAction: string;
                    recovery: string;
                    retryable: boolean;
                };
            };
        };
        assert.equal(err.value.ok, false);
        assert.equal(err.value.problem.type, "https://problems.plurnk.xyz/agui/action/unknown-action");
        assert.equal(err.value.problem.detail, "Action 'nope.nothing' is not registered."); // {§pinned-wording-agui}
        assert.equal(err.value.problem.requestedAction, "nope.nothing");
        assert.equal(err.value.problem.recovery, "Use an action advertised by discover."); // {§pinned-wording-agui}
        assert.equal(err.value.problem.retryable, false);
        assert.doesNotMatch(err.value.problem.detail, /seam surface/, "no internal jargon leaks to the client");
    } finally { await mod.close(); }
});

test("{§agui-workspace-state} the initial AG-UI snapshot carries durable model and exact packet count, and its workspace the current preparation and derivation", async () => {
    const { seam } = mockSeam();
    existingWorld(seam, "status");
    seam.readWorkerModel = async () => ({
        model: { alias: "deepdumb", provider: "deepseek", model: "deepseek-v4-flash" },
        spawnModel: null,
    });
    seam.listWorkerLoops = async () => [{
        id: 9,
        workerId: 20,
        sequence: 2,
        status: 100,
        prompt: "work",
        promptSource: null,
        claimedAt: null,
        terminatedAt: null,
        terminalResult: null,
        packetCount: 3,
        waitUntil: null,
    }];
    seam.workspaceDerivationStatus = () => ({
        phase: "indexing",
        completed: 4,
        total: 10,
        percent: 40,
        message: "Indexing repository search: 40% (4/10)",
        level: "info",
    });
    const preparation = [{ family: "mcp", alias: "search", phase: "preparing" as const, since: "2026-09-29T12:00:00.000Z" }];
    seam.workspacePreparationStatus = () => preparation;
    const mod = await host(seam);
    try {
        const events = await post(mod.address().port, {
            threadId: "status",
            forwardedProps: { plurnk: { workspace: "status", action: { kind: "worker.model.get" } } },
        });
        const event = events.find((candidate) => candidate.type === "STATE_SNAPSHOT") as {
            snapshot: { plurnk: { status: Record<string, unknown>; workspace: Record<string, unknown> } };
        };
        assert.deepEqual(event.snapshot.plurnk.status, {
            lifecycle: "queued",
            model: { alias: "deepdumb", provider: "deepseek", model: "deepseek-v4-flash" },
            loopId: 9,
            packetCount: 3,
            waitUntil: null,
            claimedAt: null,
            terminatedAt: null,
            children: 0,
            spend: { requests: 0, usage: null, knownUsage: null, costUsd: null, knownCostUsd: null },
        });
        assert.deepEqual(event.snapshot.plurnk.workspace, {
            id: 3, name: "status", projectRoot: null, projectLabel: null,
            preparation,
            activity: {
                kind: "derivation",
                phase: "indexing",
                completed: 4,
                total: 10,
                percent: 40,
                message: "Indexing repository search: 40% (4/10)",
            },
        });
    } finally { await mod.close(); }
});

test("{§application-worker-observation}: an older running task owns the snapshot over newer queued and completed loops", async () => {
    const { seam } = mockSeam();
    existingWorld(seam, "status");
    const base = { workerId: 20, prompt: "task", promptSource: null, claimedAt: null, terminatedAt: null, terminalResult: null, packetCount: 4, waitUntil: null };
    seam.listWorkerLoops = async () => [
        { ...base, id: 56, sequence: 2, status: 102 },
        { ...base, id: 58, sequence: 4, status: 200, terminatedAt: "2026-09-15T00:00:00.000Z", terminalResult: { status: 200 } },
        { ...base, id: 59, sequence: 5, status: 100, packetCount: 0 },
    ];
    const mod = await host(seam);
    try {
        const events = await post(mod.address().port, {
            threadId: "status",
            forwardedProps: { plurnk: { workspace: "status", action: { kind: "worker.model.get" } } },
        });
        const snapshot = events.find((event) => event.type === "STATE_SNAPSHOT") as { snapshot: { plurnk: { status: { lifecycle: string; loopId: number; packetCount: number } } } };
        assert.equal(snapshot.snapshot.plurnk.status.lifecycle, "running");
        assert.equal(snapshot.snapshot.plurnk.status.loopId, 56);
        assert.equal(snapshot.snapshot.plurnk.status.packetCount, 4);
    } finally { await mod.close(); }
});

test("{§agui-worker-model-actions}: worker model get/set reach the seam and child null means inherit", async () => {
    const { seam, modelSets } = mockSeam();
    existingWorld(seam, "t1");
    seam.readWorkerModel = async () => ({ model: { alias: "opus", provider: "anthropic", model: "claude" }, spawnModel: { alias: "tiny", provider: "openai", model: "mini" } });
    const mod = await host(seam);
    try {
        const port = mod.address().port;
        const get = await post(port, { threadId: "t1", workerId: "r1", forwardedProps: { plurnk: { workspace: "t1", action: { kind: "worker.model.get" } } } });
        const got = get.find((e) => e.type === "CUSTOM" && (e as { name: string }).name === "plurnk.action.result") as {
            value: { ok: boolean; result: { model: { alias: string } | null; spawnModel: { alias: string } | null } };
        };
        assert.equal(got.value.ok, true);
        assert.equal(got.value.result.model?.alias, "opus");
        assert.equal(got.value.result.spawnModel?.alias, "tiny");

        const set = await post(port, { threadId: "t1", workerId: "r2", forwardedProps: { plurnk: { workspace: "t1", action: { kind: "worker.model.set", selector: "fresh" } } } });
        assert.equal(set[set.length - 1].type, "RUN_FINISHED");
        assert.deepEqual(modelSets, [{ selector: "fresh" }]);

        const child = await post(port, { threadId: "t1", workerId: "r3", forwardedProps: { plurnk: { workspace: "t1", action: { kind: "worker.child.set", selector: null } } } });
        assert.equal(child[child.length - 1].type, "RUN_FINISHED");
        assert.deepEqual(modelSets, [{ selector: "fresh" }, { childSelector: null }], "child selector null forwards as inherit");

        const noSelector = await post(port, { threadId: "t1", workerId: "r4", forwardedProps: { plurnk: { workspace: "t1", action: { kind: "worker.model.set" } } } });
        const refused = noSelector.find((e) => e.type === "CUSTOM" && (e as { name: string }).name === "plurnk.action.result") as {
            value: { ok: boolean; problem: { type: string; status: number } };
        };
        assert.equal(refused.value.ok, false);
        assert.equal(refused.value.problem.status, 400, "a selectorless set is an invalid action, not a silent no-op");
    } finally { await mod.close(); }
});

test("{§agui-worker-effort-actions}: worker reasoning get/set reach the seam as a separate durable policy", async () => {
    const { seam, effortSets } = mockSeam();
    existingWorld(seam, "t1");
    seam.readWorkerEffort = async () => ({ effort: "adaptive", source: "default", supportedEfforts: ["off", "adaptive", "high"] });
    const mod = await host(seam);
    try {
        const port = mod.address().port;
        const get = await post(port, { threadId: "t1", workerId: "r1", forwardedProps: { plurnk: { workspace: "t1", action: { kind: "worker.effort.get" } } } });
        const got = get.find((e) => e.type === "CUSTOM" && (e as { name: string }).name === "plurnk.action.result") as {
            value: { ok: boolean; result: { effort: string | null; supportedEfforts: string[] } };
        };
        assert.equal(got.value.ok, true);
        assert.equal(got.value.result.effort, "adaptive");
        assert.deepEqual(got.value.result.supportedEfforts, ["off", "adaptive", "high"]);

        const set = await post(port, { threadId: "t1", workerId: "r2", forwardedProps: { plurnk: { workspace: "t1", action: { kind: "worker.effort.set", effort: "adaptive" } } } });
        assert.equal(set[set.length - 1].type, "RUN_FINISHED");
        assert.deepEqual(effortSets, ["adaptive"]);

        const missing = await post(port, { threadId: "t1", workerId: "r3", forwardedProps: { plurnk: { workspace: "t1", action: { kind: "worker.effort.set" } } } });
        const refused = missing.find((e) => e.type === "CUSTOM" && (e as { name: string }).name === "plurnk.action.result") as {
            value: { ok: boolean; problem: { type: string; status: number } };
        };
        assert.equal(refused.value.ok, false);
        assert.equal(refused.value.problem.status, 400);
    } finally { await mod.close(); }
});

test("entry.read defaults to the thread actor, honors an explicit actor, and preserves the contracts-owned wire", async () => {
    const { seam } = mockSeam();
    existingWorld(seam, "agui-t");
    const calls: Array<Parameters<ApplicationPort["readEntry"]>[0]> = [];
    const entry = {
        entryId: 42,
        target: "worker://alice/notes.md",
        channels: {
            body: {
                content: "hello",
                contentOffset: 0,
                contentLength: 5,
                mimetype: "text/markdown",
                weight: 3,
                state: "static" as const,
            },
        },
    };
    seam.readEntry = async (args) => {
        calls.push(args);
        return Validator.assertEntryReadResult({ status: 200, entry });
    };
    const mod = await host(seam);
    try {
        const events = await post(mod.address().port, {
            threadId: "entry-wire-thread",
            forwardedProps: {
                plurnk: {
                    workspace: "agui-t",
                    action: {
                        kind: "entry.read",
                        target: "worker://alice/notes.md",
                        channel: "body",
                        offset: 0,
                    },
                },
            },
        });
        assert.deepEqual(calls, [{
            workspaceId: 3,
            workerId: 77,
            target: "worker://alice/notes.md",
            channel: "body",
            offset: 0,
        }]);
        const event = events.find((candidate) => candidate.type === "CUSTOM"
            && (candidate as { name?: string }).name === "plurnk.action.result") as {
            value?: { ok?: boolean; result?: unknown };
        } | undefined;
        assert.equal(event?.value?.ok, true);
        assert.deepEqual(event?.value?.result, { status: 200, entry });

        await post(mod.address().port, {
            threadId: "entry-wire-thread",
            forwardedProps: {
                plurnk: {
                    workspace: "agui-t",
                    action: {
                        kind: "entry.read",
                        workerId: 91,
                        target: "worker://alice/notes.md",
                    },
                },
            },
        });
        assert.deepEqual(calls[1], {
            workspaceId: 3,
            workerId: 91,
            target: "worker://alice/notes.md",
        });
    } finally {
        await mod.close();
    }
});

test("#131: structured op.exec dispatches one valid statement with unknown source position", async () => {
    const { seam } = mockSeam();
    const dispatched: Parameters<ApplicationPort["dispatchClientAction"]>[0]["statements"][] = [];
    seam.dispatchClientAction = async ({ statements }) => {
        dispatched.push(statements);
        return [{ status: 200 }];
    };
    const mod = await host(seam);
    try {
        await post(mod.address().port, {
            threadId: "structured-exec-position",
            forwardedProps: {
                plurnk: {
                    workspace: "structured-exec-position",
                    action: { kind: "op.exec", command: "printf done" },
                },
            },
        });
        assert.equal(dispatched.length, 1);
        assert.equal(dispatched[0].length, 1);
        assert.equal(isExecution(dispatched[0][0]), true);
        assert.equal(Validator.validatePlurnkStatement(dispatched[0][0]).valid, true);
        assert.deepEqual(dispatched[0][0].position, { line: 0, column: 0 });
    } finally { await mod.close(); }
});

test("#58: op.parse projects the parser-owned diagnostic and structured position", async () => {
    const { seam } = mockSeam();
    const mod = await host(seam);
    try {
        const text = "````sh (😀) <-1s,300>\nx\n````";
        const events = await post(mod.address().port, {
            threadId: "parse-diagnostic",
            runId: "parse-diagnostic-run",
            forwardedProps: {
                plurnk: {
                    workspace: "parse-diagnostic",
                    action: { kind: "op.parse", text },
                },
            },
        });
        const event = events.find((candidate) => candidate.type === "CUSTOM"
            && (candidate as { name?: string }).name === "plurnk.action.result") as {
            value?: {
                result?: {
                    results?: Array<{
                        status?: number;
                        problem?: {
                            detail?: string;
                            line?: number;
                            column?: number;
                            source?: string;
                            severity?: string;
                            recovery?: string;
                        };
                    }>;
                };
            };
        } | undefined;
        const failure = event?.value?.result?.results?.find(({ status }) => status === 400)?.problem;
        assert.ok(failure !== undefined, "the malformed statement surfaces as a child operation failure");
        const diagnostic = PlurnkParser.parseStatements(text).items.find((item) => item.kind === "error");
        assert.ok(diagnostic?.kind === "error");
        assert.equal(failure.detail, diagnostic.error.message, "AG-UI preserves the parser-owned correction verbatim");
        assert.doesNotMatch(failure.detail ?? "", /Plurnk lexer error at line/);
        assert.deepEqual(
            { line: failure.line, column: failure.column, source: failure.source, severity: failure.severity },
            { line: 1, column: 11, source: "lexer", severity: "error" },
        );
        assert.equal(text.indexOf("<"), 12, "the UTF-16 index differs from the parser's code-point column");
        assert.equal(failure.recovery, undefined, "AG-UI does not author generic parser recovery");
    } finally { await mod.close(); }
});

test("{§agui-op-parse} {§target-group}: each compiled target returns its own result through the client action", async () => {
    const { seam } = mockSeam();
    const dispatched: Parameters<ApplicationPort["dispatchClientAction"]>[0]["statements"][] = [];
    seam.dispatchClientAction = async ({ statements }) => {
        dispatched.push(statements);
        return statements.map((_statement, index) => ({ status: 200, content: `result ${index}` }));
    };
    const mod = await host(seam);
    try {
        const text = '```READ (worker:///a) <1,3> [{"pattern":"/local/"}] (worker:///b) <4,6> /shared/\n```';
        const events = await post(mod.address().port, {
            threadId: "parse-group",
            forwardedProps: { plurnk: { workspace: "parse-group", action: { kind: "op.parse", text } } },
        });
        assert.equal(dispatched.length, 1, "one action, not independent client loops");
        assert.deepEqual(dispatched[0].map((statement) => {
            assert.ok(statement.op === "READ");
            return [statement.target?.raw, statement.lineMarker?.marks, statement.matcher?.raw];
        }), [["worker:///a", [1, 3], "/local/"], ["worker:///b", [4, 6], "/shared/"]]);
        const event = events.find((candidate) => candidate.type === "CUSTOM"
            && (candidate as { name?: string }).name === "plurnk.action.result") as {
            value?: { ok: boolean; result?: { results?: unknown[] } };
        } | undefined;
        assert.equal(event?.value?.ok, true);
        assert.deepEqual(event?.value?.result?.results, [{ status: 200, content: "result 0" }, { status: 200, content: "result 1" }]);
    } finally { await mod.close(); }
});

// {§agui-op-parse} {§unparsed-tail-boundary}
test("#127: op.parse dispatches only the trusted prefix and appends one parser-owned tail failure", async () => {
    const { seam } = mockSeam();
    const dispatched: Parameters<ApplicationPort["dispatchClientAction"]>[0]["statements"][] = [];
    seam.dispatchClientAction = async ({ statements }) => {
        dispatched.push(statements);
        return statements.map(() => ({ status: 201 }));
    };
    const mod = await host(seam);
    try {
        const text = "````EDIT (worker:///ok)\nyes\n````\n\n````EDIT (worker:///bad";
        const events = await post(mod.address().port, {
            threadId: "parse-tail",
            runId: "parse-tail-run",
            forwardedProps: {
                plurnk: {
                    workspace: "parse-tail",
                    action: { kind: "op.parse", text },
                },
            },
        });
        const event = events.find((candidate) => candidate.type === "CUSTOM"
            && (candidate as { name?: string }).name === "plurnk.action.result") as {
            value?: {
                result?: {
                    results?: Array<{
                        status?: number;
                        problem?: Record<string, unknown>;
                    }>;
                };
            };
        } | undefined;

        assert.equal(dispatched.length, 1);
        assert.equal(dispatched[0].length, 1, "the recovered tail statement is not dispatched");
        assert.equal(dispatched[0][0].op, "EDIT");
        assert.equal(dispatched[0][0].target?.raw, "worker:///ok");

        const results = event?.value?.result?.results;
        assert.deepEqual(results?.map(({ status }) => status), [201, 400]);
        assert.deepEqual(results?.[1]?.problem, {
            type: "https://problems.plurnk.xyz/agui/action/parse-failed",
            title: "Parse failed",
            status: 400,
            detail: "target slot of `EDIT` opened at line 5 but never closed - add `)`",
            line: 5,
            column: 0,
            source: "grammar",
            severity: "error",
            stage: "parsing",
            retryable: false,
        });
    } finally { await mod.close(); }
});

test("{§agui-module-actions} a module action colliding with an AG-UI built-in fails module startup", async () => {
    const { seam } = mockSeam();
    seam.listModuleActions = () => [{
        name: "ping",
        scope: "worldless",
        inputSchema: MODULE_INPUT_SCHEMA,
        outputSchema: MODULE_OUTPUT_SCHEMA,
    }];
    await assert.rejects(
        () => host(seam),
        /AG-UI action 'ping' is registered more than once/,
    );
});

test("module actions are advertised and invoked without AG-UI importing their owner", async () => {
    const { seam } = mockSeam();
    const calls: Array<{
        name: string;
        params: Readonly<Record<string, unknown>>;
        context: ApplicationActionContext;
    }> = [];
    seam.listModuleActions = () => [{
        name: "example.inspect",
        scope: "worldless",
        inputSchema: MODULE_INPUT_SCHEMA,
        outputSchema: MODULE_OUTPUT_SCHEMA,
    }];
    seam.invokeModuleAction = async (name, params, context) => {
        calls.push({
            name,
            params,
            context,
        });
        return {
            prompt: "review",
        };
    };
    const mod = await host(seam);
    try {
        const discovered = await post(mod.address().port, {
            threadId: "module-discover",
            forwardedProps: {
                plurnk: {
                    action: {
                        kind: "discover",
                    },
                },
            },
        });
        const discovery = discovered.find(
            (event) => event.type === "CUSTOM"
                && (event as { name: string }).name === "plurnk.action.result",
        ) as {
            value: {
                result: {
                    actions: Record<string, { scope: string; inputSchema: unknown; outputSchema: unknown }>;
                };
            };
        };
        assert.deepEqual(discovery.value.result.actions["example.inspect"], {
            scope: "worldless",
            inputSchema: MODULE_INPUT_SCHEMA,
            outputSchema: MODULE_OUTPUT_SCHEMA,
        });

        const invoked = await post(mod.address().port, {
            threadId: "module-action",
            forwardedProps: {
                plurnk: {
                    action: {
                        kind: "example.inspect",
                        target: "sample",
                    },
                },
            },
        });
        const result = invoked.find(
            (event) => event.type === "CUSTOM"
                && (event as { name: string }).name === "plurnk.action.result",
        ) as {
            value: {
                ok: boolean;
                result: {
                    prompt: string;
                };
            };
        };
        assert.equal(result.value.ok, true);
        assert.equal(result.value.result.prompt, "review");
        assert.deepEqual(calls, [{
            name: "example.inspect",
            params: {
                target: "sample",
            },
            context: { scope: "worldless" },
        }]);
    } finally {
        await mod.close();
    }
});

test("{§agui-action-schema-enforcement} human-readable input failures retain the field and constraint", async () => {
    const { seam } = mockSeam();
    const mod = await host(seam);
    try {
        const events = await post(mod.address().port, {
            threadId: "invalid-workspace-id",
            forwardedProps: { plurnk: { workspace: "agui-t", action: { kind: "workspace.workers", id: 0 } } },
        });
        const failure = events.find((event) => event.type === "CUSTOM"
            && (event as { name?: string }).name === "plurnk.action.result") as {
            value: { ok: boolean; problem: { detail: string; issues: unknown[] } };
        };
        assert.equal(failure.value.ok, false);
        assert.equal(failure.value.problem.detail, "Action 'workspace.workers' rejected parameters. #/id: 0 is less than 1."); // {§pinned-wording-agui}
        assert.ok(failure.value.problem.issues.length > 0, "structured validation evidence also survives");
    } finally { await mod.close(); }
});

// {§agui-action-schema-enforcement}
test("advertised action schemas admit inputs and reject undeclared parameters before dispatch", async () => {
    const { seam } = mockSeam();
    let calls = 0;
    seam.listModuleActions = () => [{
        name: "example.inspect",
        scope: "worldless",
        inputSchema: {
            type: "object",
            required: ["target"],
            additionalProperties: false,
            properties: { target: { type: "string", minLength: 1 } },
        },
        outputSchema: {
            type: "object",
            required: ["prompt"],
            additionalProperties: false,
            properties: { prompt: { type: "string" } },
        },
    }];
    seam.invokeModuleAction = async () => {
        calls++;
        return { prompt: "review" };
    };
    const mod = await host(seam);
    try {
        const rejected = await post(mod.address().port, {
            threadId: "module-schema-reject",
            forwardedProps: { plurnk: { action: { kind: "example.inspect", target: "x", surprise: true } } },
        });
        const failure = rejected.find((event) => event.type === "CUSTOM"
            && (event as { name?: string }).name === "plurnk.action.result") as {
            value?: { ok?: boolean; problem?: { status?: number; type?: string } };
        } | undefined;
        assert.equal(failure?.value?.ok, false);
        assert.equal(failure?.value?.problem?.status, 400);
        assert.equal(failure?.value?.problem?.type, "https://problems.plurnk.xyz/agui/action/invalid-action-parameters");
        assert.equal(calls, 0, "the owner never receives schema-invalid parameters");

        const accepted = await post(mod.address().port, {
            threadId: "module-schema-admit",
            forwardedProps: { plurnk: { action: { kind: "example.inspect", target: "x" } } },
        });
        const success = accepted.find((event) => event.type === "CUSTOM"
            && (event as { name?: string }).name === "plurnk.action.result") as {
            value?: { ok?: boolean; result?: { prompt?: string } };
        } | undefined;
        assert.equal(success?.value?.ok, true);
        assert.equal(success?.value?.result?.prompt, "review");
        assert.equal(calls, 1);
    } finally { await mod.close(); }
});

// {§agui-action-schema-enforcement}
test("an owner output violating its advertised schema fails at the AG-UI boundary", async () => {
    const { seam } = mockSeam();
    seam.listModuleActions = () => [{
        name: "example.inspect",
        scope: "worldless",
        inputSchema: MODULE_INPUT_SCHEMA,
        outputSchema: {
            type: "object",
            required: ["prompt"],
            additionalProperties: false,
            properties: { prompt: { type: "string" } },
        },
    }];
    seam.invokeModuleAction = async () => ({ prompt: 42 });
    const mod = await host(seam);
    try {
        const events = await post(mod.address().port, {
            threadId: "module-output-schema",
            forwardedProps: { plurnk: { action: { kind: "example.inspect" } } },
        });
        const failure = events.find((event) => event.type === "CUSTOM"
            && (event as { name?: string }).name === "plurnk.action.result") as {
            value?: { ok?: boolean; problem?: { status?: number; type?: string } };
        } | undefined;
        assert.equal(failure?.value?.ok, false);
        assert.equal(failure?.value?.problem?.status, 500);
        assert.equal(failure?.value?.problem?.type, "https://problems.plurnk.xyz/agui/action/action-failed");
    } finally { await mod.close(); }
});

test("{§agui-module-action-scope} workspace module actions receive authority from the bound AG-UI envelope", async () => {
    const { seam } = mockSeam();
    const calls: Array<{
        params: Readonly<Record<string, unknown>>;
        context: ApplicationActionContext;
    }> = [];
    seam.listModuleActions = () => [{
        name: "example.configure",
        scope: "workspace",
        inputSchema: MODULE_INPUT_SCHEMA,
        outputSchema: MODULE_OUTPUT_SCHEMA,
    }];
    seam.invokeModuleAction = async (_name, params, context) => {
        calls.push({ params, context });
        return { configured: true };
    };
    const mod = await host(seam);
    try {
        const events = await post(mod.address().port, {
            threadId: "module-workspace",
            forwardedProps: {
                plurnk: {
                    workspace: "trusted-world",
                    action: {
                        kind: "example.configure",
                        workspaceId: 999,
                    },
                },
            },
        });
        const result = events.find((event) => event.type === "CUSTOM"
            && (event as { name?: string }).name === "plurnk.action.result") as {
            value?: { ok?: boolean; result?: { configured?: boolean } };
        } | undefined;
        assert.equal(result?.value?.ok, true);
        assert.equal(result?.value?.result?.configured, true);
        assert.deepEqual(calls, [{
            params: { workspaceId: 999 },
            context: { scope: "workspace", workspaceId: 3 },
        }]);
    } finally { await mod.close(); }
});

test("{§agui-module-action-scope} worker module actions receive authority from the thread's bound worker", async () => {
    const { seam } = mockSeam();
    existingWorld(seam, "trusted-world");
    const calls: Array<{
        params: Readonly<Record<string, unknown>>;
        context: ApplicationActionContext;
    }> = [];
    seam.listModuleActions = () => [{
        name: "example.worker.configure",
        scope: "worker",
        inputSchema: MODULE_INPUT_SCHEMA,
        outputSchema: MODULE_OUTPUT_SCHEMA,
    }];
    seam.invokeModuleAction = async (_name, params, context) => {
        calls.push({ params, context });
        return { configured: true };
    };
    const mod = await host(seam);
    try {
        const events = await post(mod.address().port, {
            threadId: "module-worker",
            forwardedProps: {
                plurnk: {
                    workspace: "trusted-world",
                    action: {
                        kind: "example.worker.configure",
                        workspaceId: 999,
                        workerId: 999,
                    },
                },
            },
        });
        const result = events.find((event) => event.type === "CUSTOM"
            && (event as { name?: string }).name === "plurnk.action.result") as {
            value?: { ok?: boolean; result?: { configured?: boolean } };
        } | undefined;
        assert.equal(result?.value?.ok, true);
        assert.equal(result?.value?.result?.configured, true);
        assert.deepEqual(calls, [{
            params: { workspaceId: 999, workerId: 999 },
            context: { scope: "worker", workspaceId: 3, workerId: 77 },
        }]);
    } finally { await mod.close(); }
});

test("a module action preserves its owner-defined validation Problem", async () => {
    const { seam } = mockSeam();
    const problem = Problems.create(
        "example:inspect",
        "target-required",
        400,
        "A target is required.",
        { field: "target", stage: "validation", retryable: false },
    );
    seam.listModuleActions = () => [{
        name: "example.inspect",
        scope: "worldless",
        inputSchema: MODULE_INPUT_SCHEMA,
        outputSchema: MODULE_OUTPUT_SCHEMA,
    }];
    seam.invokeModuleAction = async () => {
        throw Object.assign(new Error(problem.detail), { problem });
    };
    const mod = await host(seam);
    try {
        const events = await post(mod.address().port, {
            threadId: "module-action-validation",
            forwardedProps: { plurnk: { action: { kind: "example.inspect" } } },
        });
        const result = events.find((event) => event.type === "CUSTOM"
            && (event as { name?: string }).name === "plurnk.action.result") as {
            value?: { ok?: boolean; problem?: typeof problem };
        } | undefined;
        assert.equal(result?.value?.ok, false);
        assert.deepEqual(result?.value?.problem, problem);
        assert.equal(events.at(-1)?.type, "RUN_FINISHED");
    } finally { await mod.close(); }
});

test("{§agui-module-actions} a throwing module action becomes one generic action Problem and a completed AG-UI Run", async () => {
    const { seam } = mockSeam();
    seam.listModuleActions = () => [{
        name: "example.inspect",
        scope: "worldless",
        inputSchema: MODULE_INPUT_SCHEMA,
        outputSchema: MODULE_OUTPUT_SCHEMA,
    }];
    seam.invokeModuleAction = async () => { throw new Error("private extension detail"); };
    const mod = await host(seam);
    try {
        const events = await post(mod.address().port, {
            threadId: "module-action-failure",
            runId: "module-action-failure-run",
            forwardedProps: { plurnk: { action: { kind: "example.inspect" } } },
        });
        const result = events.find((event) => event.type === "CUSTOM"
            && (event as { name?: string }).name === "plurnk.action.result") as {
            value?: { ok?: boolean; problem?: { type?: string; detail?: string } };
        } | undefined;
        assert.equal(result?.value?.ok, false);
        assert.equal(result?.value?.problem?.type, "https://problems.plurnk.xyz/agui/action/action-failed");
        assert.doesNotMatch(result?.value?.problem?.detail ?? "", /private extension detail/);
        assert.equal(events.at(-1)?.type, "RUN_FINISHED", "a management failure is the action result, not a failed AG-UI transport Run");
    } finally { await mod.close(); }
});

test("an action failure preserves its originating Problem instead of rebuilding it at the client boundary", async () => {
    const { seam } = mockSeam();
    existingWorld(seam, "action-problem");
    const problem = Problems.create(
        "file:read",
        "target-not-found",
        404,
        "No entry exists at the requested target.",
        {
            stage: "read",
            target: "file:///missing.txt",
            recovery: "Use FIND to select an available target.",
            retryable: false,
        },
    );
    seam.readEntry = async () => ({ status: problem.status, problem, entry: null });
    const mod = await host(seam);
    try {
        const events = await post(mod.address().port, {
            threadId: "action-problem",
            runId: "action-problem-run",
            forwardedProps: {
                plurnk: {
                    workspace: "action-problem",
                    action: { kind: "entry.read", target: "file:///missing.txt" },
                },
            },
        });
        const result = events.find((event) => event.type === "CUSTOM"
            && (event as { name?: string }).name === "plurnk.action.result") as {
            value?: { ok?: boolean; problem?: typeof problem };
        } | undefined;
        assert.equal(result?.value?.ok, false);
        assert.deepEqual(result?.value?.problem, problem);
    } finally { await mod.close(); }
});

test("a loop-owned proposal cannot terminate a concurrent loop.inject action Run", async () => {
    const { seam, emit } = mockSeam();
    const messageStarted = Promise.withResolvers<void>();
    const injectionStarted = Promise.withResolvers<void>();
    const releaseInjection = Promise.withResolvers<void>();
    let runs = 0;
    // The daemon lists what it created, so a cached binding is still its workspace's.
    const created: ReturnType<typeof workspaceRow>[] = [];
    seam.listWorkspaces = async () => created;
    seam.createWorkspace = async () => {
        created.push(workspaceRow(3, "interrupt-ownership"));
        return {
            workspaceId: 3,
            workspaceName: "interrupt-ownership",
            projectRoot: null,
            projectLabel: null,
        };
    };
    seam.runLoop = async () => {
        runs += 1;
        if (runs === 1) {
            messageStarted.resolve();
            return { status: 100, action: "enqueued_new_loop", loopId: 9 };
        }
        injectionStarted.resolve();
        await releaseInjection.promise;
        return { status: 100, action: "injected_next_turn", loopId: 9, turnSeq: 2 };
    };
    const mod = await host(seam);
    try {
        const port = mod.address().port;
        const messageRun = openStream(port, {
            threadId: "interrupt-ownership",
            runId: "message-run",
            messages: [{ role: "user", content: "research the project" }],
            forwardedProps: { plurnk: { workspace: "interrupt-ownership" } },
        });
        await waitForFixture(
            messageStarted.promise,
            () => "the message Run never reached runLoop",
        );
        await new Promise((resolve) => setImmediate(resolve));

        const injection = openStream(port, {
            threadId: "interrupt-ownership",
            runId: "injection-run",
            forwardedProps: {
                plurnk: {
                    workspace: "interrupt-ownership",
                    action: { kind: "loop.inject", prompt: "I am the caller" },
                },
            },
        });
        await waitForFixture(
            injectionStarted.promise,
            () => "the injection action never reached runLoop",
        );

        emit(3, "loop/proposal", {
            logEntryId: 42,
            workerId: 77,
            loopId: 9,
            turnId: 1,
            op: "sh", target: { scheme: "gitea", authority: null, pathname: "search_repos" },
            body: "{}",
            attrs: {},
            owner: "agui://anonymous/threads/interrupt-ownership",
            disposition: { decision: "review" },
        });
        releaseInjection.resolve();

        const [messageEvents, injectionEvents] = await Promise.all([
            messageRun,
            injection,
        ]);
        assert.equal(
            (messageEvents.at(-1) as { outcome?: { type?: string } }).outcome?.type,
            "interrupt",
            "the proposal still interrupts the message Run that owns its loop",
        );
        assert.equal(
            injectionEvents.some((event) => event.type.startsWith("TOOL_CALL")),
            false,
            "the loop-owned proposal does not leak into the concurrent action Run",
        );
        const result = injectionEvents.find((event) => event.type === "CUSTOM"
            && (event as { name?: string }).name === "plurnk.action.result") as {
            value?: { kind?: string; ok?: boolean; result?: { action?: string } };
        } | undefined;
        assert.deepEqual(result?.value, {
            kind: "loop.inject",
            ok: true,
            result: {
                status: 100,
                action: "injected_next_turn",
                loopId: 9,
                turnSeq: 2,
            },
        });
        assert.equal(injectionEvents.at(-1)?.type, "RUN_FINISHED");
    } finally {
        releaseInjection.resolve();
        await mod.close();
    }
});

test("an unexpected action exception becomes one generic Problem without leaking its message", async () => {
    const { seam } = mockSeam();
    existingWorld(seam, "action-failure");
    seam.readEntry = async () => { throw new Error("private adapter detail"); };
    const mod = await host(seam);
    try {
        const events = await post(mod.address().port, {
            threadId: "action-failure",
            runId: "action-failure-run",
            forwardedProps: {
                plurnk: {
                    workspace: "action-failure",
                    action: { kind: "entry.read", target: "file:///missing.txt" },
                },
            },
        });
        const result = events.find((event) => event.type === "CUSTOM"
            && (event as { name?: string }).name === "plurnk.action.result") as {
            value?: { ok?: boolean; problem?: { type?: string; detail?: string; stage?: string } };
        } | undefined;
        assert.equal(result?.value?.ok, false);
        assert.equal(result?.value?.problem?.type, "https://problems.plurnk.xyz/agui/action/action-failed");
        assert.equal(result?.value?.problem?.detail, "The action failed unexpectedly."); // {§pinned-wording-agui}
        assert.equal(result?.value?.problem?.stage, "action-execution");
        assert.doesNotMatch(JSON.stringify(events), /private adapter detail/);
    } finally { await mod.close(); }
});

// {§agui-broadcast-fan} The loop a mock client operation opens in the runtime worker, and the row there that
// announces its execution's stream.
const OPERATION = { workerId: 10, loopId: 5 } as const;
const announcing = (id: number, stream: string) => ({ entry: {
    id, worker_id: OPERATION.workerId, loop_id: OPERATION.loopId, turn_id: 1, origin: "client", op: "sh", status_rx: 200,
    loop_seq: 1, turn_seq: 1, sequence: 1, rx: { status: 200, outcome: "started" }, tx: { runtime: "sh", body: "printf done" },
    attrs: { runtime: "sh", stream },
} });

test("{§agui-broadcast-fan} an operation Run stays open until the stream its own row announced concludes", async () => {
    const { seam, emit } = mockSeam();
    const dispatchStarted = Promise.withResolvers<void>();
    const dispatchReleased = Promise.withResolvers<void>();
    seam.dispatchClientAction = async ({ onLoop }) => {
        onLoop?.(OPERATION);
        dispatchStarted.resolve();
        await dispatchReleased.promise;
        return [{ status: 200 }];
    };
    const mod = await host(seam);
    try {
        let settled = false;
        const run = openStream(mod.address().port, {
            threadId: "streaming-action",
            runId: "streaming-action-run",
            forwardedProps: { plurnk: { workspace: "streaming-action", action: { kind: "op.exec", command: "printf done" } } },
        }).then((events) => {
            settled = true;
            return events;
        });

        await dispatchStarted.promise;
        emit(3, "log/entry", announcing(81, "sh:///1/1/81/sh"));
        emit(3, "stream/event", streamEvent({ entryId: 81, workerId: OPERATION.workerId, target: "sh:///1/1/81/sh", scheme: "sh", channel: "stdout", contentLength: 4 }));
        dispatchReleased.resolve();
        await new Promise((resolve) => setImmediate(resolve));
        await new Promise((resolve) => setImmediate(resolve));
        assert.equal(settled, false, "the action result cannot terminate its AG-UI Run while its spawned stream is active");

        emit(3, "stream/concluded", streamConclusion({ entryId: 81, workerId: OPERATION.workerId, target: "sh:///1/1/81/sh", scheme: "sh", summary: "done" }));
        const events = await run;
        assert.equal(events.at(-1)?.type, "RUN_FINISHED");
        assert.ok(events.some((event) => event.type === "CUSTOM" && (event as { name?: string }).name === "plurnk.action.result"));
        assert.ok(events.some((event) => event.type === "ACTIVITY_SNAPSHOT" && (event as { messageId?: string }).messageId === "stream-81"));
    } finally { await mod.close(); }
});

test("{§agui-run-disconnect} a client hangup cancels exactly its operation's loop, never the runtime worker", async () => {
    const { seam, emit } = mockSeam();
    const dispatchStarted = Promise.withResolvers<void>();
    const dispatchReleased = Promise.withResolvers<void>();
    const cancellation = Promise.withResolvers<{ workspaceId: number; loopId: number; reason?: string }>();
    const drains: number[] = [];
    seam.dispatchClientAction = async ({ onLoop }) => {
        onLoop?.(OPERATION);
        dispatchStarted.resolve();
        await dispatchReleased.promise;
        return [{ status: 200 }];
    };
    seam.cancelLoop = async (args) => { cancellation.resolve(args); return true; };
    seam.cancelDrain = (workerId) => { drains.push(workerId); return true; };
    const mod = await host(seam);
    try {
        const ac = new AbortController();
        const response = await fetch(`http://127.0.0.1:${mod.address().port}/agui`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            signal: ac.signal,
            body: JSON.stringify(standardInput({
                threadId: "abandoned-action",
                runId: "abandoned-action-run",
                forwardedProps: { plurnk: { workspace: "abandoned-action", action: { kind: "op.exec", command: "sleep 60" } } },
            })),
        });
        assert.equal(response.status, 200);
        const body = response.text();
        await dispatchStarted.promise;
        emit(3, "log/entry", announcing(82, "sh:///1/1/82/sh"));
        dispatchReleased.resolve();
        await new Promise((resolve) => setImmediate(resolve));
        ac.abort();
        await assert.rejects(body, { name: "AbortError" });
        assert.deepEqual(await cancellation.promise, { workspaceId: 3, loopId: OPERATION.loopId, reason: "client_disconnected" });
        assert.deepEqual(drains, []);
    } finally { await mod.close(); }
});

for (const origin of ["message", "observer", "observer-after-message", "rediscovered"] as const) {
    for (const ending of ["disconnect", "terminal"] as const) {
        test(`{§agui-run-disconnect}: ${origin} retains its lifetime role through resume and ${ending}`, async () => {
            const { seam, emit } = mockSeam();
            existingWorld(seam, "w");
            const workerId = 77;
            const gateWorkerId = 88;
            let pending: ProposalProjection[] = [{
                logEntryId: 42, workerId: gateWorkerId, loopId: 1, turnId: 1,
                op: "EDIT", target: { scheme: "file", authority: null, pathname: "a" },
                body: "replacement", attrs: {}, owner: "agui://anonymous/threads/lifetime",
                disposition: { decision: "review" },
            }];
            const cancellations: Array<{ workerId: number; reason?: string }> = [];
            const resolved = Promise.withResolvers<void>();
            seam.listWorkers = async () => [workerRow(77, "lifetime"), workerRow(88, "child", "model", 77)];
            seam.listWorkerLoops = async ({ workerId: selected }) => [{
                id: selected === gateWorkerId ? 1 : 9, workerId: selected, sequence: 1, status: 202,
                prompt: "", promptSource: null, claimedAt: null, terminatedAt: null, terminalResult: null, packetCount: 1, waitUntil: null,
            }];
            seam.pendingProposals = async () => pending;
            seam.resolveProposal = async () => { pending = []; resolved.resolve(); };
            seam.cancelDrain = (id, reason) => { cancellations.push({ workerId: id, reason }); return true; };
            let responseClosed = Promise.withResolvers<void>();
            const observeResponse = (response: import("node:http").ServerResponse): void => {
                response.once("close", responseClosed.resolve);
            };
            let mod = await host(seam, {}, observeResponse);
            const binding = { threadId: "lifetime", forwardedProps: { plurnk: { workspace: "w" } } };
            const observe = () => post(mod.address().port, {
                ...binding, runId: crypto.randomUUID(),
                forwardedProps: { plurnk: { workspace: "w", mode: "sync", control: true } },
            });
            const controller = new AbortController();
            try {
                let events = origin === "observer" ? await observe() : await post(mod.address().port, {
                    ...binding, runId: "origin", messages: [{ role: "user", content: "Work." }],
                });
                const original = events.at(-1);
                assert.ok(original?.type === "RUN_FINISHED" && original.outcome?.type === "interrupt");
                assert.deepEqual(cancellations, [], "normal interrupt closure leaves the paused work alive");
                if (origin === "rediscovered") {
                    await mod.close();
                    mod = await host(seam, {}, observeResponse);
                }
                if (origin === "observer-after-message" || origin === "rediscovered") events = await observe();
                const terminal = events.at(-1);
                assert.ok(terminal?.type === "RUN_FINISHED" && terminal.outcome?.type === "interrupt");
                const interrupt = terminal.outcome.interrupts[0]!;
                if (origin === "observer-after-message") {
                    assert.notEqual(interrupt.id, original.outcome.interrupts[0]!.id,
                        "the observer answers its own presentation, not the originating connection's continuation");
                }
                responseClosed = Promise.withResolvers<void>();
                const response = await fetch(`http://127.0.0.1:${mod.address().port}/agui`, {
                    method: "POST", headers: { "content-type": "application/json" }, signal: controller.signal,
                    body: JSON.stringify(standardInput({
                        ...binding, runId: "resume",
                        resume: [{ interruptId: interrupt.id, status: "resolved", payload: { decision: "accept" } }],
                    })),
                });
                const body = response.text();
                await waitForFixture(resolved.promise, () => "the resumed approval did not reach Core");
                if (ending === "disconnect") {
                    controller.abort();
                    await assert.rejects(body, { name: "AbortError" });
                    await responseClosed.promise;
                } else {
                    emit(3, "loop/terminated", termination({ workerId, loopId: 9 }));
                    assert.match(await body, /RUN_FINISHED/);
                }
            } finally {
                controller.abort();
                await mod.close();
            }
            assert.deepEqual(cancellations,
                ending === "disconnect" && origin === "message"
                    ? [{ workerId, reason: "client_disconnected" }] : [],
                "approval does not change which connection owns the work's lifetime");
        });
    }
}

test("{§agui-run-disconnect}: a socket closed during preparation cannot start inference later", async () => {
    const { seam, loopRuns } = mockSeam();
    const preparing = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const responseClosed = Promise.withResolvers<void>();
    seam.listWorkerLoops = async () => { preparing.resolve(); await release.promise; return []; };
    const mod = await host(seam, {}, (response) => { response.once("close", responseClosed.resolve); });
    const controller = new AbortController();
    try {
        const response = fetch(`http://127.0.0.1:${mod.address().port}/agui`, {
            method: "POST", headers: { "content-type": "application/json" }, signal: controller.signal,
            body: JSON.stringify(standardInput({ threadId: "early", messages: [{ role: "user", content: "Work." }],
                forwardedProps: { plurnk: { workspace: "w" } } })),
        });
        await preparing.promise;
        controller.abort();
        await assert.rejects(response, { name: "AbortError" });
        await responseClosed.promise;
    } finally {
        release.resolve();
    }
    await new Promise<void>((resolve) => setImmediate(resolve));
    try {
        assert.deepEqual(loopRuns, [], "a disconnected request cannot admit its prompt after preparation completes");
    } finally {
        await mod.close();
    }
});

test("{§agui-proposal-resolve}: invalid presentation sets release nothing and leave the original complete set resumable", async () => {
    const { seam, resolves } = mockSeam();
    existingWorld(seam, "w");
    let pending: ProposalProjection[] = [41, 42].map((logEntryId) => ({
        logEntryId, workerId: 77, loopId: 1, turnId: 1, op: "EDIT",
        target: { scheme: "file", authority: null, pathname: `file-${logEntryId}` }, body: "replacement", attrs: {},
        owner: "agui://anonymous/threads/presentations", disposition: { decision: "review" },
    }));
    seam.pendingProposals = async () => pending;
    const resolve = seam.resolveProposal;
    seam.resolveProposal = async (id, resolution, owner) => {
        pending = pending.filter(({ logEntryId }) => logEntryId !== id);
        await resolve(id, resolution, owner);
    };
    const mod = await host(seam);
    const binding = { threadId: "presentations", forwardedProps: { plurnk: { workspace: "w" } } };
    const observe = async (): Promise<Interrupt[]> => {
        const events = await post(mod.address().port, {
            ...binding, forwardedProps: { plurnk: { workspace: "w", mode: "sync", control: true } },
        });
        const terminal = events.at(-1);
        assert.ok(terminal?.type === "RUN_FINISHED" && terminal.outcome?.type === "interrupt");
        return terminal.outcome.interrupts;
    };
    try {
        const first = await observe();
        const second = await observe();
        assert.equal(first.length, 2);
        assert.equal(second.length, 2);
        const resumed = (interruptId: string) => ({ interruptId, status: "resolved", payload: { decision: "accept" } });
        const cases = [
            { ids: [first[0]!.id], code: "interrupt-set-incomplete" },
            { ids: [first[0]!.id, first[0]!.id], code: "interrupt-duplicate" },
            { ids: [first[0]!.id, second[1]!.id], code: "interrupt-binding-invalid" },
            { ids: ["unknown-presentation"], code: "interrupt-not-pending" },
        ];
        for (const { ids, code } of cases) {
            const events = await post(mod.address().port, { ...binding, resume: ids.map(resumed) });
            const error = events.at(-1);
            assert.ok(error?.type === "RUN_ERROR");
            assert.equal(error.code, `https://problems.plurnk.xyz/agui/interrupt/${code}`);
            assert.deepEqual(resolves, [], "invalid input cannot partly release stopped work");
        }
        const events = await post(mod.address().port, { ...binding, resume: first.map(({ id }) => resumed(id)) });
        assert.equal(events.at(-1)?.type, "RUN_FINISHED");
        assert.deepEqual(resolves.map(({ logEntryId }) => logEntryId), [41, 42]);
        const stale = await post(mod.address().port, { ...binding, resume: second.map(({ id }) => resumed(id)) });
        const error = stale.at(-1);
        assert.ok(error?.type === "RUN_ERROR");
        assert.equal(error.code, "https://problems.plurnk.xyz/agui/interrupt/interrupt-not-pending");
        assert.equal(resolves.length, 2, "another presentation cannot release an already resolved gate");
    } finally { await mod.close(); }
});

test("{§agui-run-disconnect}: disconnect during resume validation cancels controlled work without releasing its approval", async () => {
    const { seam, resolves } = mockSeam();
    const pending: ProposalProjection[] = [{ logEntryId: 42, workerId: 77, loopId: 9, turnId: 1, op: "EDIT",
        target: { scheme: "file", authority: null, pathname: "file" }, body: "replacement", attrs: {},
        owner: "agui://anonymous/threads/validating", disposition: { decision: "review" } }];
    seam.pendingProposals = async () => pending;
    const cancellations: number[] = [];
    seam.cancelDrain = (workerId) => { cancellations.push(workerId); return true; };
    const validating = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let responseClosed = Promise.withResolvers<void>();
    const mod = await host(seam, {}, (response) => { response.once("close", responseClosed.resolve); });
    const controller = new AbortController();
    const binding = { threadId: "validating", forwardedProps: { plurnk: { workspace: "w" } } };
    try {
        const interrupted = await post(mod.address().port, { ...binding, messages: [{ role: "user", content: "Work." }] });
        seam.pendingProposals = async () => { validating.resolve(); await release.promise; return pending; };
        responseClosed = Promise.withResolvers<void>();
        const response = await fetch(`http://127.0.0.1:${mod.address().port}/agui`, {
            method: "POST", headers: { "content-type": "application/json" }, signal: controller.signal,
            body: JSON.stringify(standardInput({ ...binding, resume: [{ interruptId: presentedInterrupt(interrupted).id,
                status: "resolved", payload: { decision: "accept" } }] })),
        });
        const body = assert.rejects(response.text(), { name: "AbortError" });
        await validating.promise;
        controller.abort();
        await body;
        await responseClosed.promise;
        release.resolve();
        await new Promise<void>((resolve) => setImmediate(resolve));
        assert.deepEqual(cancellations, [77]);
        assert.deepEqual(resolves, []);
    } finally { release.resolve(); controller.abort(); await mod.close(); }
});

test("a standard resume resolves the paused proposal without driving a new loop", async () => {
    const { seam, resolves } = mockSeam();
    existingWorld(seam, "t2");
    let pending: ProposalProjection[] = [{
        logEntryId: 42,
        workerId: 77,
        loopId: 1,
        turnId: 1,
        op: "EDIT",
        target: { scheme: "file", authority: null, pathname: "a" },
        body: "diff",
        attrs: {},
        owner: "agui://anonymous/threads/t2",
        disposition: { decision: "review" },
    }];
    seam.pendingProposals = async () => pending;
    const resolveProposal = seam.resolveProposal;
    seam.resolveProposal = async (logEntryId, resolution, owner) => {
        pending = [];
        await resolveProposal(logEntryId, resolution, owner);
    };
    const mod = await host(seam);
    try {
        const interrupted = await post(mod.address().port, {
            threadId: "t2", forwardedProps: { plurnk: { workspace: "t2", mode: "sync", control: true } },
        });
        const events = await post(mod.address().port, {
            threadId: "t2", runId: "r1", forwardedProps: { plurnk: { workspace: "t2" } },
            resume: [{ interruptId: presentedInterrupt(interrupted).id, status: "resolved", payload: { decision: "accept", body: "edited", outcome: "client_yolo" } }],
        });
        assert.equal(events[0].type, "RUN_STARTED");
        assert.deepEqual(resolves[0], { logEntryId: 42, resolution: { decision: "accept", body: "edited", outcome: "client_yolo" } }, `the resume reached resolveProposal: ${JSON.stringify(events)}`);
    } finally { await mod.close(); }
});

for (const { stage, accepted } of ["snapshot", "validation", "resolution"].flatMap(
    (stage) => [false, true].map((accepted) => ({ stage, accepted })),
)) {
    test(`{§agui-proposal-resolve}: a delayed terminal preserves ${accepted ? "accepted" : "rejected"} resume during ${stage}`, async () => {
        const { seam, emit, loopRuns } = mockSeam();
        let resolutions = 0;
        let pending = [{
            interactionId: 88, recipient: "agui://anonymous/threads/resume-race", workerId: 77, loopId: 9, turnId: 1,
            request: { toolName: "review", arguments: {}, responseSchema: { type: "object" } },
        }];
        seam.pendingClientInteractions = async () => pending;
        seam.listWorkers = async () => [workerRow(77, "resume-race")];
        const mod = await host(seam);
        try {
            const interrupted = await post(mod.address().port, {
                threadId: "resume-race", runId: "before-expiry",
                messages: [{ role: "user", content: "Review." }],
                forwardedProps: { plurnk: { workspace: "resume-race" } },
            });
            assert.deepEqual((interrupted.at(-1) as { outcome: { type: string } }).outcome.type, "interrupt");
            assert.deepEqual(loopRuns, [{ prompt: "Review." }], "{§agui-message-before-gate}: the message reaches Core before the pending input is re-presented");
            const terminal = (): void => emit(3, "loop/terminated", termination({ workerId: 77, loopId: 9 }));
            if (!accepted && stage !== "resolution") pending = [];
            if (stage === "snapshot") {
                const readModel = seam.readWorkerModel;
                seam.readWorkerModel = async (args) => { terminal(); return readModel(args); };
            } else if (stage === "validation") {
                seam.pendingClientInteractions = async () => { terminal(); return pending; };
            }
            seam.resolveClientInteraction = async () => {
                resolutions++;
                if (stage === "resolution") terminal();
                if (!accepted) {
                    throw Object.assign(new Error("The interaction expired."), {
                        problem: Problems.create("test:interaction", "expired", 409, "The interaction expired."),
                    });
                }
                pending = [];
            };
            const late = await post(mod.address().port, {
                threadId: "resume-race", runId: "after-expiry",
                forwardedProps: { plurnk: { workspace: "resume-race" } },
                resume: [{ interruptId: presentedInterrupt(interrupted).id, status: "cancelled" }],
            });
            assert.equal(late[0]?.type, "RUN_STARTED", JSON.stringify(late));
            const outcome = late.at(-1);
            assert.equal(outcome?.type, accepted ? "RUN_FINISHED" : "RUN_ERROR", JSON.stringify(late));
            if (accepted) {
                assert.deepEqual((outcome as { outcome: unknown }).outcome, { type: "success" });
            } else {
                assert.match((outcome as { code: string }).code, stage === "resolution" ? /\/expired$/u : /\/interrupt-not-pending$/u);
            }
            assert.equal(late.filter((event) => event.type === "RUN_FINISHED").length, accepted ? 1 : 0);
            assert.equal(resolutions, accepted || stage === "resolution" ? 1 : 0);
            assert.equal(loopRuns.length, 1, "a resume never starts fresh inference");
        } finally {
            await mod.close();
        }
    });
}

test("a descendant client interaction round-trips through its owning AG-UI thread", async () => {
    const { seam, emit, loopRuns } = mockSeam();
    let pending = [{
        interactionId: 88,
        recipient: "agui://anonymous/threads/interaction-thread",
        workerId: 88,
        loopId: 6,
        turnId: 9,
        request: {
            toolName: "choose_color",
            arguments: { palette: "warm" },
            message: "Choose one color.",
            responseSchema: {
                type: "object",
                properties: { color: { type: "string" } },
                required: ["color"],
            },
        },
    }];
    const resolutions: unknown[] = [];
    seam.pendingClientInteractions = async () => pending;
    seam.listWorkers = async () => [
        workerRow(77, "interaction-thread"),
        workerRow(88, "interaction-child", "model", 77),
    ];
    seam.listWorkerLoops = async ({ workerId }) => workerId === 77 ? [{
        id: 9,
        workerId: 77,
        sequence: 1,
        status: 202,
        prompt: "continue",
        promptSource: null,
        claimedAt: null,
        terminatedAt: null,
        terminalResult: null,
        packetCount: 1,
        waitUntil: null,
    }] : [];
    seam.resolveClientInteraction = async (interactionId, resolution) => {
        resolutions.push({ interactionId, resolution });
        pending = [];
        setImmediate(() => emit(3, "loop/terminated", termination({
            workerId: 77,
            loopId: 9,
            turnIds: [9],
            usage: loopUsage({ inputTokens: 1, outputTokens: 1, curationBudget: 1000 }),
        })));
    };
    const mod = await host(seam);
    try {
        const interrupted = await post(mod.address().port, {
            threadId: "interaction-thread",
            runId: "interaction-a",
            messages: [{ role: "user", content: "continue" }],
            forwardedProps: { plurnk: { workspace: "interaction-thread" } },
        });
        assert.deepEqual(
            interrupted.filter((event) => event.type.startsWith("TOOL_CALL")),
            [
                { type: "TOOL_CALL_START", toolCallId: "int:88", toolCallName: "choose_color" },
                { type: "TOOL_CALL_ARGS", toolCallId: "int:88", delta: JSON.stringify({ palette: "warm" }) },
                { type: "TOOL_CALL_END", toolCallId: "int:88" },
            ],
        );
        const terminal = interrupted.at(-1) as {
            type?: string;
            outcome?: { type?: string; interrupts?: unknown[] };
        };
        assert.equal(terminal.type, "RUN_FINISHED");
        assert.deepEqual(terminal.outcome, {
            type: "interrupt",
            interrupts: [{
                id: presentedInterrupt(interrupted).id,
                reason: "tool_call",
                toolCallId: "int:88",
                message: "Choose one color.",
                responseSchema: pending[0].request.responseSchema,
            }],
        });
        assert.deepEqual(loopRuns, [{ prompt: "continue" }], "{§agui-message-before-gate}: the message reaches Core before the pending input is re-presented");

        const resumed = await post(mod.address().port, {
            threadId: "interaction-thread",
            runId: "interaction-b",
            forwardedProps: { plurnk: { workspace: "interaction-thread" } },
            resume: [{
                interruptId: presentedInterrupt(interrupted).id,
                status: "resolved",
                payload: { color: "orange" },
            }],
        });
        assert.deepEqual(resolutions, [{
            interactionId: 88,
            resolution: { status: "resolved", payload: { color: "orange" } },
        }]);
        assert.equal(resumed.at(-1)?.type, "RUN_FINISHED");
    } finally {
        await mod.close();
    }
});

test("the official AG-UI client reattaches to and resumes a durable proposal interrupt", async () => {
    const { seam, emit, loopRuns } = mockSeam();
    const proposal: ProposalProjection = {
        logEntryId: 42,
        workerId: 20,
        loopId: 9,
        turnId: 12,
        op: "sh", target: { scheme: "sh", authority: null, pathname: "" },
        body: "printf ok",
        attrs: {},
        owner: "agui://anonymous/threads/verified-interrupt",
        disposition: { decision: "review" },
    };
    let pending: ProposalProjection[] = [];
    seam.pendingProposals = async () => pending;
    seam.listWorkspaces = async () => [workspaceRow(3, "verified-interrupt")];
    seam.attachWorkspace = async () => ({
        workspaceId: 3,
        workspaceName: "verified-interrupt",
        projectRoot: null,
        projectLabel: null,
    });
    directory(seam, [workerRow(20, "verified-interrupt")]);
    seam.runLoop = async () => {
        setImmediate(() => {
            emit(3, "log/entry", {
                entry: {
                    id: 40,
                    worker_id: 20,
                    loop_id: 9,
                    turn_id: 12,
                    loop_seq: 1, turn_seq: 12, sequence: 1,
                    op: "NOTE",
                    origin: "model",
                    tx: { body: "Await approval." },
                },
            });
            pending = [proposal];
            emit(3, "loop/proposal", proposal);
        });
        return { status: 100, action: "enqueued_new_loop", loopId: 9 };
    };
    seam.resolveProposal = async () => {
        pending = [];
        setImmediate(() => {
            emit(3, "log/entry", {
                entry: {
                    id: 43,
                    worker_id: 20,
                    loop_id: 9,
                    turn_id: 12,
                    loop_seq: 1, turn_seq: 12, sequence: 3,
                    op: "SEND", status_rx: 200, rx: { answers: ["agui://anonymous/threads/verified-interrupt/messages/m1"] },
                    origin: "model",
                    tx: { body: "Command approved." },
                },
            });
            emit(3, "loop/terminated", termination({
                workerId: 20,
                loopId: 9,
                result: { status: 200 },
                turnIds: [12],
                usage: loopUsage({ inputTokens: 1, outputTokens: 1, curationBudget: 1000 }),
            }));
        });
    };
    const mod = await host(seam);
    try {
        const agent = new HttpAgent({
            url: `http://127.0.0.1:${mod.address().port}/agui`,
            threadId: "verified-interrupt",
        });
        agent.messages = [{ id: "current-user", role: "user", content: "Run the command." }];

        await agent.runAgent({ forwardedProps: { plurnk: { workspace: "verified-interrupt" } } });

        assert.deepEqual(agent.pendingInterrupts.map(({ toolCallId }) => toolCallId), ["prop:42"]);
        const reattachedAgent = new HttpAgent({
            url: `http://127.0.0.1:${mod.address().port}/agui`,
            threadId: "verified-interrupt",
        });
        reattachedAgent.messages = [{ id: "reattach-user", role: "user", content: "Reconnect." }];

        await reattachedAgent.runAgent({
            forwardedProps: { plurnk: { workspace: "verified-interrupt" } },
        });

        assert.deepEqual(reattachedAgent.pendingInterrupts.map(({ toolCallId }) => toolCallId), ["prop:42"]);
        assert.notEqual(reattachedAgent.pendingInterrupts[0]!.id, agent.pendingInterrupts[0]!.id);
        assert.equal(loopRuns.length, 0, "reattaching to a durable interrupt does not start new model work");
        const resumedEvents: string[] = [];
        await reattachedAgent.runAgent({
            forwardedProps: { plurnk: { workspace: "verified-interrupt" } },
            resume: [{ interruptId: reattachedAgent.pendingInterrupts[0]!.id, status: "resolved", payload: { decision: "accept" } }],
        }, {
            onEvent: ({ event }) => { resumedEvents.push(event.type); },
        });
        assert.deepEqual(resumedEvents.slice(0, 3), ["RUN_STARTED", "STATE_SNAPSHOT", "STEP_STARTED"]);
        assert.equal(resumedEvents.at(-1), "RUN_FINISHED");
        assert.equal((reattachedAgent.messages.at(-1) as { content?: unknown }).content, "Command approved.");
    } finally {
        await mod.close();
    }
});

test("a workspace name is its identity; attach rebinds", async () => {
    const created: Array<{ name?: string }> = [];
    const attached: number[] = [];
    const { seam } = mockSeam();
    const base = seam.createWorkspace.bind(seam);
    seam.createWorkspace = async (args) => { created.push(args); return { ...(await base(args)), workspaceName: args.name ?? "workspace-1" }; };
    seam.attachWorkspace = async (args) => { attached.push(args.workspaceId); return { workspaceId: args.workspaceId, workspaceName: "alpha", projectRoot: null, projectLabel: null }; };
    seam.listWorkspaces = async () => [workspaceRow(4, "alpha")];
    const mod = await host(seam);
    try {
        // 1) A workspace named like an existing world attaches to IT — the exact name.
        // (A world-scoped action binds the workspace; a control-plane one would not.)
        const run = await post(mod.address().port, { threadId: "alpha", workerId: "r1", forwardedProps: { plurnk: { workspace: "alpha", action: { kind: "workspace.workers" } } } });
        assert.equal(run[run.length - 1].type, "RUN_FINISHED");
        assert.deepEqual(attached, [4], "workspace 'alpha' attached the world 'alpha' — no agui- prefix lookup");
        // 2) A new workspace name creates a world with EXACTLY that name.
        await post(mod.address().port, { threadId: "beta", workerId: "r2", forwardedProps: { plurnk: { workspace: "beta", action: { kind: "workspace.workers" } } } });
        assert.deepEqual(created.map((c) => c.name), ["beta"], "created verbatim — never 'agui-beta', never a uuid");
        // 3) workspace.attach is a REAL action kind returning the envelope.
        const att = await post(mod.address().port, { threadId: "alpha", workerId: "r3", forwardedProps: { plurnk: { workspace: "alpha", action: { kind: "workspace.attach", id: 4 } } } });
        const result = att.find((e) => e.type === "CUSTOM" && (e as { name: string }).name === "plurnk.action.result") as { value: { ok: boolean; result: { id: number; name: string } } };
        assert.equal(result.value.ok, true, "workspace.attach is wired, not unknown-kind");
        assert.deepEqual(
            result.value.result,
            { id: 4, name: "alpha" },
            "{§agui-thread-binding} attach returns the selected workspace and mints nothing",
        );
    } finally { await mod.close(); }
});

test("reattach replays SEND as speech without inventing an activity from NOTE", async () => {
    const { seam, finish } = mockSeam();
    seam.listWorkspaces = async () => [workspaceRow(3, "workspace")];
    seam.attachWorkspace = async () => ({ workspaceId: 3, workspaceName: "workspace", projectRoot: null, projectLabel: null });
    seam.readLog = async () => logRows([
        { id: 0, loop_seq: 1, turn_seq: 1, sequence: 0, op: "SEND", status_rx: 200, origin: "_plurnk", attrs: { kind: "message" }, turn_id: 1, tx: { body: { raw: "original question" } } },
        { id: 1, loop_seq: 1, turn_seq: 1, sequence: 1, op: "NOTE", origin: "model", turn_id: 1, tx: { body: "Inspect, repair, and verify." } },
        { id: 2, loop_seq: 1, turn_seq: 1, sequence: 2, op: "SEND", status_rx: 200, origin: "model", rx: { answers: ["agui://anonymous/threads/workspace/messages/m1"] }, turn_id: 1, tx: { body: "checkpoint complete" } },
        { id: 3, loop_seq: 1, turn_seq: 1, sequence: 3, op: null, origin: "model", turn_id: 1, attrs: { kind: "emissionAttempt" } },
    ]);
    seam.runLoop = async (args) => {
        finish(args.workspaceId, args.workerId);
        return { status: 100, action: "enqueued_new_loop", loopId: 9 };
    };
    const mod = await host(seam);
    try {
        const events = await post(mod.address().port, {
            threadId: "workspace",
            runId: "reattach-1",
            messages: [{ id: "current-user", role: "user", content: "continue" }],
            forwardedProps: { plurnk: { workspace: "workspace" } },
        });
        const snapshot = events.find((event) => event.type === "MESSAGES_SNAPSHOT") as { messages?: Replayed[] } | undefined;
        assert.deepEqual(transcript(snapshot?.messages), [
            { id: "1/1/0", role: "user", content: "original question" },
            { id: "1/1/1", role: "assistant", calls: ["NOTE"] },
            { id: "1/1/1/result", role: "tool", content: '{"status":200}' },
            { id: "1/1/2", role: "assistant", content: "checkpoint complete" },
            { id: "current-user", role: "user", content: "continue" },
        ]);
    } finally { await mod.close(); }
});

test("{§agui-sync}: an inference-free sync replays the bound worker's durable log without driving the model", async () => {
    const { seam, loopRuns } = mockSeam();
    const reads: Array<{ workspaceId: number; workerId: number; limit?: number }> = [];
    seam.listWorkspaces = async () => [workspaceRow(3, "sync-client")];
    seam.attachWorkspace = async () => ({
        workspaceId: 3,
        workspaceName: "sync-client",
        projectRoot: null,
        projectLabel: null,
    });
    directory(seam, [workerRow(20, "sync-client")]);
    seam.readLog = async (args) => {
        reads.push(args);
        return logRows([
            { id: 1, loop_seq: 1, turn_seq: 1, sequence: 1, op: "SEND", status_rx: 200, origin: "_plurnk", attrs: { kind: "message" }, turn_id: 1, tx: { body: { raw: "Prior question." } } },
            { id: 2, loop_seq: 1, turn_seq: 1, sequence: 2, op: "NOTE", origin: "model", turn_id: 1, tx: { body: "Answered the prior question." } },
            { id: 3, loop_seq: 1, turn_seq: 1, sequence: 3, op: "SEND", status_rx: 200, origin: "model", rx: { answers: ["agui://anonymous/threads/sync-client/messages/m1"] }, turn_id: 1, tx: { body: "Prior answer." } },
        ]);
    };
    const mod = await host(seam);
    try {
        const events = await post(mod.address().port, {
            threadId: "sync-client",
            runId: "sync-run",
            forwardedProps: { plurnk: { workspace: "sync-client", mode: "sync" } },
        });
        assert.deepEqual(events.map(({ type }) => type), [
            "RUN_STARTED",
            "STATE_SNAPSHOT",
            "MESSAGES_SNAPSHOT",
            "RUN_FINISHED",
        ]);
        const snapshot = events[2] as { messages?: Replayed[] };
        assert.deepEqual(transcript(snapshot.messages), [
            { id: "1/1/1", role: "user", content: "Prior question." },
            { id: "1/1/2", role: "assistant", calls: ["NOTE"] },
            { id: "1/1/2/result", role: "tool", content: '{"status":200}' },
            { id: "1/1/3", role: "assistant", content: "Prior answer." },
        ]);
        // Sync asks for as much history as the daemon will give; the ceiling is the daemon's panel's.
        assert.ok(reads.length > 0, "the sync reads the durable log");
        assert.ok(reads.every(({ workspaceId, workerId }) => workspaceId === 3 && workerId === 20), "every read is the bound worker's");
        assert.equal(loopRuns.length, 0, "sync observes durable state without creating model work");
    } finally {
        await mod.close();
    }
});

test("{§agui-owner-activation} an owner's attachment starts its workspace's activation; an observation starts none", async () => {
    const { seam, activations } = mockSeam();
    seam.listWorkspaces = async () => [workspaceRow(3, "owned")];
    seam.attachWorkspace = async () => ({ workspaceId: 3, workspaceName: "owned", projectRoot: null, projectLabel: null });
    const mod = await host(seam);
    try {
        await post(mod.address().port, { threadId: "owned", runId: "watch", forwardedProps: { plurnk: { workspace: "owned", mode: "sync" } } });
        assert.deepEqual(activations, [], "a passive observation activates nothing");
        await post(mod.address().port, { threadId: "owned", runId: "own", forwardedProps: { plurnk: { workspace: "owned", mode: "sync", control: true } } });
        assert.deepEqual(activations, [3], "the owner's arrival activates the workspace");
    } finally { await mod.close(); }
});

test("{§agui-run-start} a Run begins with RUN_STARTED and its snapshot; rows that reached it while the snapshot was read follow them, in order", async () => {
    const { seam, emit } = mockSeam();
    seam.listWorkspaces = async () => [workspaceRow(3, "busy")];
    seam.attachWorkspace = async () => ({ workspaceId: 3, workspaceName: "busy", projectRoot: null, projectLabel: null });
    directory(seam, [workerRow(20, "busy")]);
    const row = (id: number) => ({ entry: { id, worker_id: 20, loop_id: 1, origin: "model", op: "READ", status_rx: 200, rx: {}, loop_seq: 1, turn_seq: 1, sequence: id, tx: { body: "" }, turn_id: 1 } });
    // The observed worker is busy: two of its rows land while the Run reads the worker's status.
    seam.readWorkerModel = async () => {
        emit(3, "log/entry", row(2));
        emit(3, "log/entry", row(3));
        return { model: null, spawnModel: null };
    };
    const mod = await host(seam);
    try {
        const events = await post(mod.address().port, { threadId: "busy", runId: "observe", forwardedProps: { plurnk: { workspace: "busy", mode: "sync" } } });
        assert.deepEqual(events.slice(0, 2).map(({ type }) => type), ["RUN_STARTED", "STATE_SNAPSHOT"]);
        const rows = events.filter((event) => event.type === "CUSTOM" && event.name === "plurnk.row").map((event) => ((event as { value: { id: number } }).value.id));
        assert.deepEqual(rows, [2, 3], "each row once, in arrival order, after the snapshot");
        assert.equal(events.at(-1)?.type, "RUN_FINISHED");
    } finally { await mod.close(); }
});

test("{§agui-thread-binding} a thread's worker belongs to its world, not a name: a new world under an old name binds its own", async () => {
    const { seam, finish } = mockSeam();
    const worlds = [workspaceRow(3, "before")];
    const envelope = (id: number) => ({
        workspaceId: id, workspaceName: worlds.find((world) => world.id === id)!.name,
        projectRoot: null, projectLabel: null,
    });
    seam.listWorkspaces = async () => worlds;
    seam.attachWorkspace = async ({ workspaceId }) => envelope(workspaceId);
    seam.createWorkspace = async ({ name }) => { worlds.push(workspaceRow(4, name!)); return envelope(4); };
    const workers = new Map<number, WorkerRow[]>([[3, [workerRow(77, "page")]], [4, []]]);
    directory(seam, (workspaceId) => workers.get(workspaceId) ?? []);
    seam.createWorker = async ({ workspaceId, name }) => {
        workers.get(workspaceId)!.push(workerRow(78, name!));
        return { workerId: 78, workerName: name! };
    };
    const bound: Array<[number, number]> = [];
    seam.runLoop = async (a) => {
        bound.push([a.workspaceId, a.workerId]);
        finish(a.workspaceId, a.workerId);
        return { status: 100, action: "enqueued_new_loop" as const, loopId: 9 };
    };
    const mod = await host(seam);
    const message = (workspace: string) => post(mod.address().port, {
        threadId: "page", forwardedProps: { plurnk: { workspace } }, messages: [{ role: "user", content: "hello" }],
    });
    try {
        await message("before");
        worlds[0]!.name = "after"; // renamed by another client
        await message("before");
        await message("after");
        assert.deepEqual(bound, [[3, 77], [4, 78], [3, 77]],
            "the world now called before binds its own page; the renamed world keeps the page it had");
    } finally { await mod.close(); }
});

test("{§agui-thread-binding} a cached binding never outlives its workspace's name: renamed by any client, the old name resolves afresh", async () => {
    const { seam, loopRuns } = mockSeam();
    let name = "before-rename";
    const created: string[] = [];
    seam.createWorkspace = async () => { created.push("workspace"); throw new Error("an observation created a workspace"); };
    seam.listWorkspaces = async () => [workspaceRow(3, name)];
    seam.attachWorkspace = async () => ({ workspaceId: 3, workspaceName: name, projectRoot: null, projectLabel: null });
    seam.readWorker = async ({ identity }) => identity.name === "exact-worker" ? workerRow(88, "exact-worker", "model") : null;
    const mod = await host(seam);
    const observe = async (workspace: string): Promise<Response> => await fetch(`http://127.0.0.1:${mod.address().port}/agui`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify(standardInput({ threadId: "exact-worker", messages: [], forwardedProps: { plurnk: { workspace, mode: "sync" } } })),
    });
    try {
        const first = await observe("before-rename");
        assert.equal(first.status, 200);
        await first.text();
        // Renamed outside this module: nothing here is told, so the cache alone must not decide.
        name = "after-rename";
        const stale = await observe("before-rename");
        assert.deepEqual([stale.status, ((await stale.json()) as { type: string }).type.split("/").at(-1)], [404, "workspace-not-found"],
            "a name that no longer exists is not found, however recently it was bound");
        const renamed = await observe("after-rename");
        assert.equal(renamed.status, 200);
        const snapshot = (await renamed.text()).split("\n\n").filter((frame) => frame.startsWith("data: "))
            .map((frame) => JSON.parse(frame.slice(6)) as AguiEvent).find((event) => event.type === "STATE_SNAPSHOT") as { snapshot: { plurnk: { workspace: { name: string } } } };
        assert.equal(snapshot.snapshot.plurnk.workspace.name, "after-rename", "the current name binds the same workspace");
        assert.deepEqual(created, [], "observing created nothing");
        assert.deepEqual(loopRuns, []);
    } finally {
        await mod.close();
    }
});

test("{§agui-sync} an observation binds an existing workspace and worker, exactly as named, and creates neither", async () => {
    const { seam, loopRuns } = mockSeam();
    const created: string[] = [];
    seam.createWorkspace = async () => { created.push("workspace"); throw new Error("an observation created a workspace"); };
    seam.createWorker = async () => { created.push("worker"); throw new Error("an observation created a worker"); };
    seam.listWorkspaces = async () => [workspaceRow(3, "world")];
    seam.attachWorkspace = async () => ({ workspaceId: 3, workspaceName: "world", projectRoot: null, projectLabel: null });
    directory(seam, [workerRow(5, "_plurnk", "_plurnk"), workerRow(88, "world")]);
    const reads: number[] = [];
    seam.readLog = async ({ workerId }) => { reads.push(workerId); return logRows([]); };
    const mod = await host(seam);
    const observe = async (threadId: string, workspace: string, connect = false): Promise<Response> => await fetch(
        `http://127.0.0.1:${mod.address().port}/agui${connect ? "/connect" : ""}`, {
            method: "POST", headers: { "content-type": "application/json" },
            body: JSON.stringify(standardInput({ threadId, messages: [], forwardedProps: { plurnk: connect ? { workspace } : { workspace, mode: "sync" } } })),
        });
    const refused = async (response: Response): Promise<[number, string]> => [response.status, ((await response.json()) as { type: string }).type.split("/").at(-1)!];
    try {
        for (const connect of [false, true]) {
            assert.deepEqual(await refused(await observe("t", "elsewhere", connect)), [404, "workspace-not-found"]);
            assert.deepEqual(await refused(await observe("unknown", "world", connect)), [404, "worker-not-found"]);
            assert.deepEqual(await refused(await observe("_plurnk", "world", connect)), [404, "worker-not-found"],
                "the runtime actor is never bound");
        }
        const exact = await observe("world", "world");
        assert.equal(exact.status, 200);
        await exact.text();
        assert.deepEqual(reads, [88], "the thread names the observed worker exactly, though its workspace shares the name");
        assert.deepEqual(created, [], "observing created nothing");
        assert.deepEqual(loopRuns, []);
    } finally {
        await mod.close();
    }
});

test("{§agui-snapshot} {§agui-sync} through the official client, synchronization rebuilds the messages the live Run built and drops none of them", async () => {
    const { seam, emit } = mockSeam();
    const threadId = "rebuilt";
    const question = `agui://anonymous/threads/${threadId}/messages/u1`;
    const rows = [
        { id: 1, worker_id: 20, loop_id: 9, turn_id: 1, loop_seq: 1, turn_seq: 1, sequence: 1, op: "SEND", status_rx: 200, origin: "_plurnk",
            source: question, attrs: { kind: "message" }, tx: { body: { raw: "What does the witness say?" } } },
        { id: 2, worker_id: 20, loop_id: 9, turn_id: 2, loop_seq: 1, turn_seq: 2, sequence: 1, op: "READ", status_rx: 200, origin: "model",
            scheme: "worker", pathname: "/witness.txt", tx: { body: null }, rx: { status: 200, content: "hello" }, reasoning: "Read the witness first." },
        { id: 3, worker_id: 20, loop_id: 9, turn_id: 3, loop_seq: 1, turn_seq: 3, sequence: 1, op: "SEND", status_rx: 200, origin: "model",
            tx: { body: "The witness says hello." }, rx: { status: 200, answers: [question] }, reasoning: "Answer from the receipt." },
    ];
    let runs = 0;
    seam.listWorkspaces = async () => [workspaceRow(3, threadId)];
    seam.attachWorkspace = async () => ({ workspaceId: 3, workspaceName: threadId, projectRoot: null, projectLabel: null });
    directory(seam, [workerRow(20, threadId)]);
    seam.readLog = async () => logRows(runs === 0 ? [] : rows.toReversed());
    seam.runLoop = async () => {
        runs++;
        setImmediate(() => {
            for (const entry of rows) emit(3, "log/entry", { entry });
            emit(3, "loop/terminated", termination({ workerId: 20, loopId: 9, result: { status: 200 }, turnIds: [1, 2, 3],
                usage: loopUsage({ inputTokens: 1, outputTokens: 1, curationBudget: 1000 }) }));
        });
        return { status: 100, action: "enqueued_new_loop", loopId: 9 };
    };
    const mod = await host(seam);
    try {
        const url = `http://127.0.0.1:${mod.address().port}/agui`;
        const live = new HttpAgent({ url, threadId });
        live.messages = [{ id: "u1", role: "user", content: "What does the witness say?" }];
        await live.runAgent({ forwardedProps: { plurnk: { workspace: threadId } } });
        const built = structuredClone(live.messages);
        assert.deepEqual(transcript(built).map(({ id, role }) => [id, role]), [
            ["u1", "user"],
            ["1/2/1/reasoning", "reasoning"],
            ["1/2/1", "assistant"],
            ["1/2/1/result", "tool"],
            ["1/3/1/reasoning", "reasoning"],
            ["1/3/1", "assistant"],
        ], "the live Run built the reasoning of both turns, the READ's call and result, and the answer");

        // The SDK keeps of a client's messages only those a snapshot names, so a snapshot naming every
        // live message is what keeps a reconnecting client whole, as it rebuilds a reloaded one.
        const fresh = new HttpAgent({ url, threadId });
        await fresh.runAgent({ forwardedProps: { plurnk: { workspace: threadId, mode: "sync" } } });
        assert.deepEqual(fresh.messages.map(({ id }) => id), built.map(({ id }) => id), "the snapshot names every message the live Run built, in order");
        assert.deepEqual(fresh.messages.filter(({ role }) => role !== "user"), built.filter(({ role }) => role !== "user"),
            "reasoning, calls, results and speech are the live ones");
        assert.deepEqual(transcript(fresh.messages.filter(({ role }) => role === "user")), transcript(built.filter(({ role }) => role === "user")));
        assert.equal(runs, 1, "synchronization starts no model work");
    } finally {
        await mod.close();
    }
});

test("{§agui-sync}: sync re-surfaces a durable interrupt without driving the model", async () => {
    const { seam, loopRuns } = mockSeam();
    const proposal: ProposalProjection = {
        logEntryId: 42,
        workerId: 20,
        loopId: 9,
        turnId: 12,
        op: "sh", target: { scheme: "sh", authority: null, pathname: "" },
        body: "printf ok",
        attrs: {},
        owner: "agui://anonymous/threads/sync-interrupt",
        disposition: { decision: "review" },
    };
    seam.pendingProposals = async () => [proposal];
    seam.listWorkspaces = async () => [workspaceRow(3, "sync-interrupt")];
    seam.attachWorkspace = async () => ({
        workspaceId: 3,
        workspaceName: "sync-interrupt",
        projectRoot: null,
        projectLabel: null,
    });
    directory(seam, [workerRow(20, "sync-interrupt")]);
    seam.readLog = async () => [];
    const mod = await host(seam);
    try {
        const events = await post(mod.address().port, {
            threadId: "sync-interrupt",
            runId: "sync-interrupt-run",
            forwardedProps: { plurnk: { workspace: "sync-interrupt", mode: "sync", control: true } },
        });
        assert.deepEqual(events.slice(0, 3).map(({ type }) => type), [
            "RUN_STARTED",
            "STATE_SNAPSHOT",
            "MESSAGES_SNAPSHOT",
        ]);
        assert.ok(events.some(({ type }) => type === "TOOL_CALL_END"), "the pending proposal is visible");
        const outcome = (events.at(-1) as {
            outcome?: { type?: unknown; interrupts?: Array<{ id?: unknown; reason?: unknown; toolCallId?: unknown }> };
        }).outcome;
        assert.equal(outcome?.type, "interrupt");
        assert.deepEqual(outcome?.interrupts?.map(({ id, reason, toolCallId }) => ({ id, reason, toolCallId })), [
            { id: presentedInterrupt(events).id, reason: "tool_call", toolCallId: "prop:42" },
        ]);
        assert.equal(loopRuns.length, 0, "interrupt synchronization creates no model work");
    } finally {
        await mod.close();
    }
});

test("{§agui-sync}: sync rejects ambiguous input before binding a workspace", async () => {
    const { seam } = mockSeam();
    const mod = await host(seam);
    try {
        const response = await fetch(`http://127.0.0.1:${mod.address().port}/agui`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(standardInput({
                threadId: "ambiguous-sync",
                messages: [{ role: "user", content: "do work" }],
                forwardedProps: { plurnk: { workspace: "ambiguous-sync", mode: "sync" } },
            })),
        });
        assert.equal(response.status, 400);
        assert.deepEqual(await response.json(), Problems.create(
            "agui:http",
            "invalid-sync-input",
            400,
            "A sync Run cannot include messages, an action, or an interrupt resume.",
            { stage: "request-validation", retryable: false },
        ));
    } finally {
        await mod.close();
    }
});

test("{§agui-sync}: unknown Run modes fail without echoing untrusted input", async () => {
    const { seam } = mockSeam();
    const mod = await host(seam);
    try {
        const response = await fetch(`http://127.0.0.1:${mod.address().port}/agui`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(standardInput({
                threadId: "unknown-mode",
                forwardedProps: { plurnk: { mode: "<private-value>" } },
            })),
        });
        assert.equal(response.status, 400);
        assert.deepEqual(await response.json(), Problems.create(
            "agui:http",
            "unsupported-run-mode",
            400,
            'forwardedProps.plurnk.mode must be "sync" when present.',
            { stage: "request-validation", retryable: false },
        ));
    } finally {
        await mod.close();
    }
});

test("the official AG-UI client keeps the accepted current user message after authoritative reattach replay", async () => {
    const { seam, finish } = mockSeam();
    seam.listWorkspaces = async () => [workspaceRow(3, "replay-client")];
    seam.attachWorkspace = async () => ({ workspaceId: 3, workspaceName: "replay-client", projectRoot: null, projectLabel: null });
    seam.readLog = async () => logRows([
        { id: 3, loop_seq: 1, turn_seq: 1, sequence: 3, op: "SEND", status_rx: 200, origin: "model", rx: { answers: ["agui://anonymous/threads/replay-client/messages/m1"] }, turn_id: 1, tx: { body: "Prior answer." } },
        { id: 2, loop_seq: 1, turn_seq: 1, sequence: 2, op: "NOTE", origin: "model", turn_id: 1, tx: { body: "Answer the prior question." } },
        { id: 1, loop_seq: 1, turn_seq: 1, sequence: 1, op: "SEND", status_rx: 200, origin: "_plurnk", attrs: { kind: "message" }, turn_id: 1, tx: { body: { raw: "Prior question." } } },
    ]);
    seam.runLoop = async (args) => {
        finish(args.workspaceId, args.workerId);
        return { status: 100, action: "enqueued_new_loop", loopId: 9 };
    };
    const mod = await host(seam);
    try {
        const agent = new HttpAgent({
            url: `http://127.0.0.1:${mod.address().port}/agui`,
            threadId: "replay-client",
        });
        agent.messages = [{ id: "current-user", role: "user", content: "Current question." }];
        const snapshots: Array<Array<{ id: string; content?: unknown }>> = [];
        await agent.runAgent({
            runId: "replay-run",
            forwardedProps: { plurnk: { workspace: "replay-client" } },
        }, {
            onMessagesSnapshotEvent: ({ event }) => { snapshots.push(event.messages); },
        });
        assert.deepEqual(snapshots[0]?.filter(({ id }) => ["1/1/1", "current-user"].includes(id))
            .map(({ id, content }) => ({ id, content })), [
            { id: "1/1/1", content: "Prior question." },
            { id: "current-user", content: "Current question." },
        ], "the wire snapshot is chronological and retains the accepted message identity");
        // The SDK's snapshot merge retains existing IDs in their old positions (#721).
        // That display-order limitation must not be repaired by renaming accepted messages.
        assert.deepEqual(
            agent.messages.filter(({ role }) => role === "user").map(({ id, content }) => ({ id, content })),
            [
                { id: "current-user", content: "Current question." },
                { id: "1/1/1", content: "Prior question." },
            ],
        );
    } finally {
        await mod.close();
    }
});

test("a client carrying a durable assistant identity is already oriented and receives no repeated replay", async () => {
    const { seam, finish } = mockSeam();
    seam.listWorkspaces = async () => [workspaceRow(3, "oriented-client")];
    seam.attachWorkspace = async () => ({ workspaceId: 3, workspaceName: "oriented-client", projectRoot: null, projectLabel: null });
    seam.readLog = async () => logRows([
        { id: 2, loop_seq: 1, turn_seq: 1, sequence: 2, op: "SEND", status_rx: 200, origin: "model", rx: { answers: ["agui://anonymous/threads/oriented-client/messages/m1"] }, turn_id: 1, tx: { body: "Prior answer." } },
        { id: 1, loop_seq: 1, turn_seq: 1, sequence: 1, op: "SEND", status_rx: 200, origin: "_plurnk", attrs: { kind: "message" }, turn_id: 1, tx: { body: { raw: "Prior question." } } },
    ]);
    seam.runLoop = async (args) => {
        finish(args.workspaceId, args.workerId);
        return { status: 100, action: "enqueued_new_loop", loopId: 9 };
    };
    const mod = await host(seam);
    try {
        const events = await post(mod.address().port, {
            threadId: "oriented-client",
            runId: "oriented-run",
            messages: [
                { id: "1/1/2", role: "assistant", content: "Prior answer." },
                { id: "current-user", role: "user", content: "Current question." },
            ],
            forwardedProps: { plurnk: { workspace: "oriented-client" } },
        });
        assert.equal(events.some(({ type }) => type === "MESSAGES_SNAPSHOT"), false);
    } finally {
        await mod.close();
    }
});

test("WORKSPACE=WORLD, AG-UI THREAD=WORKER: the workspace prop selects the world; the thread resolves to a worker", async () => {
    const attaches: number[] = [];
    const created: Array<{ name?: string; projectRoot?: string | null }> = [];
    const minted: Array<Parameters<ApplicationPort["createWorker"]>[0]> = [];
    const { seam, finish } = mockSeam();
    seam.listWorkspaces = async () => [workspaceRow(7, "workspace-a")];
    seam.attachWorkspace = async (a) => { attaches.push(a.workspaceId); return { workspaceId: a.workspaceId, workspaceName: "workspace-a", projectRoot: "/w", projectLabel: "/w" }; };
    seam.createWorkspace = async (a) => { created.push(a); return { workspaceId: 8, workspaceName: a.name ?? "workspace-1", projectRoot: a.projectRoot ?? null, projectLabel: a.projectRoot ?? null }; };
    directory(seam, [workerRow(200, "chat-0")]);
    seam.createWorker = async (a) => { minted.push(a); return { workerId: 300, workerName: a.name ?? "x" }; };
    const drivenRuns: number[] = [];
    seam.runLoop = async (a) => { drivenRuns.push(a.workerId); finish(a.workspaceId, a.workerId); return { status: 100, action: "enqueued_new_loop", loopId: 9 }; };
    const mod = await host(seam);
    try {
        // The `workspace` workspace prop selects the WORLD — not the threadId. Two
        // distinct threads naming the SAME workspace share the one workspace.
        await post(mod.address().port, { threadId: "chat-1", workerId: "r1", messages: [{ role: "user", content: "hi" }], forwardedProps: { plurnk: { workspace: "workspace-a" } } });
        assert.deepEqual(attaches, [7], "the workspace 'workspace-a' was attached (not a workspace named 'chat-1')");
        assert.deepEqual(created, [], "no world was created for the thread");
        assert.deepEqual(minted, [{ workspaceId: 7, name: "chat-1" }], "the thread names its own worker in that world");
        assert.deepEqual(drivenRuns, [300], "the loop drove in the thread's own worker");
    } finally { await mod.close(); }
});

test("{§agui-thread-binding}: the same thread name remains isolated across workspaces under concurrent and alternating Runs", async () => {
    const driven: Array<[workspaceId: number, workerId: number]> = [];
    const { seam, finish } = mockSeam();
    seam.listWorkspaces = async () => [workspaceRow(3, "workspace-a"), workspaceRow(4, "workspace-b")];
    seam.attachWorkspace = async ({ workspaceId }) => ({
        workspaceId,
        workspaceName: workspaceId === 3 ? "workspace-a" : "workspace-b",
        projectRoot: null,
        projectLabel: null,
    });
    directory(seam, (workspaceId) => [workerRow(workspaceId === 3 ? 31 : 41, "shared")]);
    seam.runLoop = async ({ workspaceId, workerId }) => {
        driven.push([workspaceId, workerId]);
        finish(workspaceId, workerId);
        return { status: 100, action: "enqueued_new_loop", loopId: 9 };
    };
    const mod = await host(seam);
    const run = (workspace: string, runId: string) => post(mod.address().port, {
        threadId: "shared",
        runId,
        messages: [{ role: "user", content: runId }],
        forwardedProps: { plurnk: { workspace } },
    });
    try {
        await Promise.all([
            run("workspace-a", "concurrent-a"),
            run("workspace-b", "concurrent-b"),
        ]);
        assert.deepEqual(
            driven.slice(0, 2).toSorted(([a], [b]) => a - b),
            [[3, 31], [4, 41]],
            "concurrent Runs with one thread name bind to the Worker in their own workspace",
        );

        await run("workspace-a", "alternating-a");
        await run("workspace-b", "alternating-b");
        assert.deepEqual(
            driven.slice(2),
            [[3, 31], [4, 41]],
            "later alternating Runs cannot inherit the other workspace's cached envelope or Worker",
        );
    } finally {
        await mod.close();
    }
});

test("NO workspace prop is a 400 Problem - a worker has no world to forge from the threadId", async () => {
    let created = 0;
    const { seam } = mockSeam();
    seam.listWorkspaces = async () => [];
    seam.createWorkspace = async (a) => { created++; return { workspaceId: 9, workspaceName: a.name ?? "x", projectRoot: null, projectLabel: null }; };
    const mod = await host(seam);
    try {
        const res = await fetch(`http://127.0.0.1:${mod.address().port}/agui`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(standardInput({ threadId: "solo", runId: "r1", messages: [{ role: "user", content: "hi" }] })) });
        assert.equal(res.status, 400, "the missing workspace is a request defect, not an internal failure");
        assert.equal(res.headers.get("content-type"), "application/problem+json");
        const body = await res.json() as { type: string; status: number; detail: string; stage: string; recovery: string; retryable: boolean };
        assert.equal(body.type, "https://problems.plurnk.xyz/agui/http/workspace-required");
        assert.equal(body.status, 400);
        assert.match(body.detail, /forwardedProps\.plurnk\.workspace must name a workspace/);
        assert.equal(body.stage, "request-validation");
        assert.equal(body.recovery, "Provide a non-empty workspace name."); // {§problems-agui}
        assert.equal(body.retryable, false);
        assert.doesNotMatch(body.detail, /world|existence/, "the error states the contract, never the machine-model philosophy");
        assert.equal(created, 0, "NO workspace was forged from the threadId");
    } finally { await mod.close(); }
});

// {§agui-thread-binding} — only a message Run brings a world into being.
test("an action naming an unknown workspace is a 404 Problem and creates nothing", async () => {
    let created = 0;
    const { seam } = mockSeam();
    seam.listWorkspaces = async () => [];
    seam.createWorkspace = async (a) => { created++; return { workspaceId: 9, workspaceName: a.name ?? "x", projectRoot: null, projectLabel: null }; };
    const mod = await host(seam);
    try {
        const res = await fetch(`http://127.0.0.1:${mod.address().port}/agui`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(standardInput({ threadId: "designer", workerId: "r1", forwardedProps: { plurnk: { workspace: "designer", action: { kind: "loop.inject", prompt: "what are you waiting on?" } } } })) });
        assert.equal(res.status, 404, "an action addresses a world that exists");
        const body = await res.json() as { type: string; workspace: string; recovery: string; retryable: boolean };
        assert.equal(body.type, "https://problems.plurnk.xyz/agui/http/workspace-not-found");
        assert.equal(body.workspace, "designer");
        assert.match(body.recovery, /workspace\.create or a message Run/);
        assert.equal(body.retryable, false);
        assert.equal(created, 0, "no world was minted on the action's behalf");
    } finally { await mod.close(); }
});

test("{§agui-cors} the panel states which pages may read a reply, and its empty value sends no CORS header", async () => {
    const { seam } = mockSeam("expected");
    const cors = async (allowOrigin: string): Promise<{ origin: string | null; headers: string | null; preflight: number }> => {
        const mod = await host(seam, {
            env: { ...FLOOR, PLURNK_AUTH: "1", PLURNK_AGUI_ALLOW_ORIGIN: allowOrigin, PLURNK_AGUI_HEARTBEAT_MS: "0" },
        });
        try {
            const base = `http://127.0.0.1:${mod.address().port}/agui`;
            const preflight = await fetch(base, { method: "OPTIONS" });
            const refused = await fetch(base, { method: "POST", body: "{}" });
            assert.equal(refused.status, 401, "CORS never stands in for the bearer");
            return {
                origin: refused.headers.get("access-control-allow-origin"),
                headers: refused.headers.get("access-control-allow-headers"),
                preflight: preflight.status,
            };
        } finally {
            await mod.close();
        }
    };
    assert.deepEqual(await cors("*"), { origin: "*", headers: "content-type, authorization", preflight: 204 });
    assert.deepEqual(await cors("https://portal.example"), { origin: "https://portal.example", headers: "content-type, authorization", preflight: 204 });
    assert.deepEqual(await cors(""), { origin: null, headers: null, preflight: 204 }, "no page reads a reply");
});

test("PLURNK-owned HTTP failures use application/problem+json with stable Problems", async () => {
    const { seam } = mockSeam("expected");
    const mod = await host(seam, {
        env: {
            ...FLOOR,
            PLURNK_AUTH: "1",
            PLURNK_AGUI_ALLOW_ORIGIN: "*",
            PLURNK_AGUI_HEARTBEAT_MS: "0",
        },
    });
    const base = `http://127.0.0.1:${mod.address().port}`;
    const access = await mintAccess(mod.address().port, { id: "operator", secret: "expected" });
    const problem = async (path: string, init: RequestInit): Promise<Record<string, unknown>> => {
        const response = await fetch(`${base}${path}`, init);
        assert.equal(response.headers.get("content-type"), "application/problem+json");
        const body = await response.json() as Record<string, unknown>;
        assert.equal(body.status, response.status);
        return body;
    };
    try {
        const unauthorized = await problem("/agui", { method: "POST", body: "{}" });
        assert.equal(unauthorized.type, "https://problems.plurnk.xyz/agui/http/bearer-token-required");
        assert.equal(unauthorized.status, 401);
        assert.equal(unauthorized.stage, "authorization");

        const invalidJson = await problem("/agui", {
            method: "POST",
            headers: { authorization: `Bearer ${access}`, "content-type": "application/json" },
            body: "{",
        });
        assert.equal(invalidJson.type, "https://problems.plurnk.xyz/agui/http/invalid-json");
        assert.equal(invalidJson.status, 400);
        assert.equal(invalidJson.stage, "request-validation");

        const invalidInput = await problem("/agui", {
            method: "POST",
            headers: { authorization: `Bearer ${access}`, "content-type": "application/json" },
            body: "{}",
        });
        assert.equal(invalidInput.type, "https://problems.plurnk.xyz/agui/http/invalid-run-input");
        assert.ok(Array.isArray(invalidInput.issues));

        const missingRoute = await problem("/agui/missing", {
            method: "GET",
            headers: { authorization: `Bearer ${access}` },
        });
        assert.equal(missingRoute.type, "https://problems.plurnk.xyz/agui/http/route-not-found");
        assert.equal(missingRoute.path, "/agui/missing");
    } finally { await mod.close(); }
});

test("{§workspace-label} the workspace list and the snapshot carry each folder's label exactly as the daemon spelled it", async () => {
    const { seam } = mockSeam();
    seam.listWorkspaces = async () => [{ id: 3, name: "proj", project_root: "/home/u/proj", project_label: "~/proj", created_at: "2026-01-01T00:00:00.000Z" }];
    seam.attachWorkspace = async () => ({ workspaceId: 3, workspaceName: "proj", projectRoot: "/home/u/proj", projectLabel: "~/proj" });
    const mod = await host(seam);
    try {
        const listed = await post(mod.address().port, { threadId: "probe", forwardedProps: { plurnk: { action: { kind: "workspace.list" } } } });
        const result = listed.find((event) => event.type === "CUSTOM" && event.name === "plurnk.action.result") as { value: { ok: boolean; result: { workspaces: Array<{ project_label: string | null }> } } };
        assert.equal(result.value.ok, true, "the list's output schema admits the label");
        assert.equal(result.value.result.workspaces[0]?.project_label, "~/proj");
        const observed = await post(mod.address().port, { threadId: "proj", runId: "observe", forwardedProps: { plurnk: { workspace: "proj", mode: "sync" } } });
        const snapshot = observed.find((event) => event.type === "STATE_SNAPSHOT") as { snapshot: { plurnk: { workspace: unknown } } };
        assert.deepEqual(snapshot.snapshot.plurnk.workspace, { id: 3, name: "proj", projectRoot: "/home/u/proj", projectLabel: "~/proj", preparation: [], activity: null });
    } finally { await mod.close(); }
});

test("CONTROL PLANE: a worldless action needs NO workspace and FORGES none", async () => {
    let created = 0, bound = 0;
    const { seam } = mockSeam();
    seam.listWorkspaces = async () => [workspaceRow(1, "a"), workspaceRow(2, "b")];
    seam.createWorkspace = async (a) => { created++; return { workspaceId: 9, workspaceName: a.name ?? "x", projectRoot: null, projectLabel: null }; };
    seam.readWorker = async () => { bound++; return null; };
    seam.createWorker = async () => { bound++; throw new Error("a control-plane action minted a worker"); };
    const mod = await host(seam);
    try {
        // workspace.list with NO workspace prop — control plane, so no world required, none forged.
        const ev = await post(mod.address().port, { threadId: "probe", workerId: "r1", forwardedProps: { plurnk: { action: { kind: "workspace.list" } } } });
        const r = ev.find((e) => e.type === "CUSTOM" && (e as { name: string }).name === "plurnk.action.result") as { value: { ok: boolean; result: { workspaces: unknown[] } } };
        assert.equal(r.value.ok, true);
        assert.equal(r.value.result.workspaces.length, 2, "listed the real workspaces");
        assert.equal(ev[ev.length - 1].type, "RUN_FINISHED");
        assert.equal(created, 0, "no ephemeral workspace was created");
        assert.equal(bound, 0, "no model worker was looked up or minted for a control-plane action");
    } finally { await mod.close(); }
});

test("run.fork admits the contract's anonymous-fork form", async () => {
    const { seam } = mockSeam();
    existingWorld(seam, "anonymous-fork");
    const calls: Parameters<ApplicationPort["forkWorker"]>[0][] = [];
    seam.forkWorker = async (args) => {
        calls.push(args);
        return { workerId: 11, workerName: "main-fork", parentWorkerId: args.workerId };
    };
    const mod = await host(seam);
    try {
        const events = await post(mod.address().port, {
            threadId: "anonymous-fork",
            forwardedProps: {
                plurnk: {
                    workspace: "anonymous-fork",
                    action: { kind: "run.fork" },
                },
            },
        });
        const result = events.find((event) => event.type === "CUSTOM"
            && (event as { name?: string }).name === "plurnk.action.result") as {
            value?: { ok?: boolean; result?: { workerName?: string | null } };
        } | undefined;
        assert.equal(result?.value?.ok, true);
        assert.equal(result?.value?.result?.workerName, "main-fork");
        assert.equal(calls.length, 1);
        assert.equal(calls[0].name, undefined);
    } finally { await mod.close(); }
});

test("{§discovery} discover returns the exact public action and notification membership", async () => {
    const { seam } = mockSeam();
    seam.listClientDisplayCapabilities = async () => [
        { kind: "scheme", scheme: "https", display: { glyph: "🌐" } },
        { kind: "mimetype", mimetype: "text/html", display: { glyph: "󰖟" } },
    ];
    const mod = await host(seam);
    try {
        const ev = await post(mod.address().port, { threadId: "probe", workerId: "r1", forwardedProps: { plurnk: { action: { kind: "discover" } } } });
        const r = ev.find((e) => e.type === "CUSTOM" && (e as { name: string }).name === "plurnk.action.result") as { value: { ok: boolean; result: { schemaVersion: number; actions: Record<string, { scope: string; inputSchema: unknown; outputSchema: unknown }>; notifications: Record<string, { payloadSchema: unknown }>; display: unknown[] } } };
        assert.equal(r.value.ok, true);
        assert.deepEqual(Object.keys(r.value.result).toSorted(), ["actions", "display", "notifications", "schemaVersion"]);
        assert.equal(r.value.result.schemaVersion, 1);
        assert.deepEqual(r.value.result.display, [
            { kind: "scheme", scheme: "https", display: { glyph: "🌐" } },
            { kind: "mimetype", mimetype: "text/html", display: { glyph: "󰖟" } },
        ]);
        assert.deepEqual(Object.keys(r.value.result.actions).toSorted(), [
            "discover",
            "entry.read",
            "log.read",
            "loop.cancel",
            "loop.inject",
            "models.list",
            "op.exec",
            "op.parse",
            "ping",
            "providers.list",
            "run.fork",
            "worker.child.set",
            "worker.effort.get",
            "worker.effort.set",
            "worker.model.get",
            "worker.model.set",
            "workspace.attach",
            "workspace.capabilities.get",
            "workspace.capabilities.set",
            "workspace.create",
            "workspace.list",
            "workspace.prompts",
            "workspace.rename",
            "workspace.rollback",
            "workspace.share",
            "workspace.workers",
        ]);
        assert.deepEqual(Object.keys(r.value.result.notifications).toSorted(), [
            "log/entry",
            "loop/interaction",
            "loop/packet",
            "loop/proposal",
            "loop/terminated",
            "notice/event",
            "outside/event",
            "reasoning/event",
            "stream/concluded",
            "stream/event",
            "workspace/preparation",
        ]);
        for (const action of Object.values(r.value.result.actions)) {
            assert.ok(action.scope === "worldless" || action.scope === "workspace");
            assert.equal(typeof action.inputSchema, "object");
            assert.equal(typeof action.outputSchema, "object");
        }
        for (const notification of Object.values(r.value.result.notifications)) {
            assert.equal(typeof notification.payloadSchema, "object");
        }
    } finally { await mod.close(); }
});

test("workspace.create WITH a name is worldless and does NOT demand a pre-bound workspace", async () => {
    const { seam } = mockSeam();
    seam.listWorkspaces = async () => [];
    seam.createWorkspace = async (a) => ({ workspaceId: 12, workspaceName: a.name ?? "auto", projectRoot: null, projectLabel: null });
    const mod = await host(seam);
    try {
        // No forwardedProps.plurnk.workspace on the worker itself — workspace.create supplies its own world.
        const ev = await post(mod.address().port, { threadId: "probe", workerId: "r1", forwardedProps: { plurnk: { action: { kind: "workspace.create", name: "fresh-world" } } } });
        const r = ev.find((e) => e.type === "CUSTOM" && (e as { name: string }).name === "plurnk.action.result") as { value: { ok: boolean; result: { name: string } } };
        assert.equal(r.value.ok, true);
        assert.equal(r.value.result.name, "fresh-world", "created the named world, no workspace-required throw");
    } finally { await mod.close(); }
});

test("loop.cancel is a REAL action kind — cancels the model worker's drain (both clients' stop buttons ride it)", async () => {
    const cancelled: Array<{ workerId: number; reason?: string }> = [];
    const { seam } = mockSeam();
    seam.listWorkspaces = async () => [workspaceRow(3, "w")];
    seam.attachWorkspace = async () => ({ workspaceId: 3, workspaceName: "w", projectRoot: null, projectLabel: null });
    directory(seam, [workerRow(20, "w")]);
    seam.cancelDrain = (workerId, reason) => {
        cancelled.push({ workerId, ...(reason === undefined ? {} : { reason }) });
        return true;
    };
    const mod = await host(seam);
    try {
        const ev = await post(mod.address().port, { threadId: "w", workerId: "r1", forwardedProps: { plurnk: { workspace: "w", action: { kind: "loop.cancel", reason: "user_stop" } } } });
        const r = ev.find((e) => e.type === "CUSTOM" && (e as { name: string }).name === "plurnk.action.result") as { value: { ok: boolean; result: { cancelled: boolean } } };
        assert.equal(r.value.ok, true, "loop.cancel must be a known kind");
        assert.equal(r.value.result.cancelled, true);
        assert.deepEqual(cancelled, [{ workerId: 20, reason: "user_stop" }], "the drain of the model worker the thread names was cancelled with the client's reason");
    } finally { await mod.close(); }
});

// {§agui-thread-binding} AG-UI THREAD ↔ CORE WORKER: the threadId names its worker in every Run, never
// compared with the workspace's name; {§agui-action-binding} says what each form of Run binds of it. The
// matrix below enumerates every form, each run in world 3 ("world") by thread "page" unless it says otherwise.
type RunForm = {
    readonly path?: "/agui" | "/agui/connect";
    readonly messages?: ReadonlyArray<Record<string, unknown>>;
    readonly plurnk?: Readonly<Record<string, unknown>>;
};
const WORKER_ACTION = "example.worker.inspect";
const WORKSPACE_ACTION = "example.workspace.inspect";
const bindingModuleActions = () => [
    { name: WORKER_ACTION, scope: "worker" as const, inputSchema: MODULE_INPUT_SCHEMA, outputSchema: MODULE_OUTPUT_SCHEMA },
    { name: WORKSPACE_ACTION, scope: "workspace" as const, inputSchema: MODULE_INPUT_SCHEMA, outputSchema: MODULE_OUTPUT_SCHEMA },
];
const actionForm = (kind: string, params: Record<string, unknown> = {}): RunForm => ({ plurnk: { action: { kind, ...params } } });
const CREATING_FORMS: Readonly<Record<string, RunForm>> = {
    "a message Run": { messages: [{ role: "user", content: "hello" }] },
    "worker.model.set": actionForm("worker.model.set", { selector: "fresh" }),
    "worker.child.set": actionForm("worker.child.set", { selector: null }),
    "worker.effort.set": actionForm("worker.effort.set", { effort: "adaptive" }),
};
// Each names the seam call that carries its effect to the worker it binds.
const REQUIRING_FORMS: Readonly<Record<string, RunForm & { readonly effect: string }>> = {
    "a sync observation": { plurnk: { mode: "sync" }, effect: "readLog" },
    "a connect observation": { path: "/agui/connect", effect: "readLog" },
    "loop.inject": { ...actionForm("loop.inject", { prompt: "steer" }), effect: "runLoop" },
    "loop.cancel": { ...actionForm("loop.cancel"), effect: "cancelDrain" },
    "run.fork": { ...actionForm("run.fork"), effect: "forkWorker" },
    "worker.model.get": { ...actionForm("worker.model.get"), effect: "readWorkerModel" },
    "worker.effort.get": { ...actionForm("worker.effort.get"), effect: "readWorkerEffort" },
    "a worker-scoped module action": { ...actionForm(WORKER_ACTION), effect: "invokeModuleAction" },
    "log.read": { ...actionForm("log.read"), effect: "readLog" },
    "entry.read": { ...actionForm("entry.read", { target: "worker:///x" }), effect: "readEntry" },
    "workspace.prompts": { ...actionForm("workspace.prompts"), effect: "listPrompts" },
    "workspace.rollback": { ...actionForm("workspace.rollback", { to: "1/1/1" }), effect: "rollback" },
};
const UNBOUND_FORMS: Readonly<Record<string, RunForm>> = {
    "log.read naming worker 91": actionForm("log.read", { workerId: 91 }),
    "entry.read naming worker 91": actionForm("entry.read", { target: "worker:///x", workerId: 91 }),
    "workspace.prompts naming worker 91": actionForm("workspace.prompts", { workerId: 91 }),
    "workspace.rollback naming worker 91": actionForm("workspace.rollback", { to: "1/1/1", workerId: 91 }),
    "workspace.workers": actionForm("workspace.workers"),
    "workspace.rename": actionForm("workspace.rename", { name: "world" }),
    "workspace.share": actionForm("workspace.share", { folder: "/srv/share" }),
    "workspace.capabilities.get": actionForm("workspace.capabilities.get"),
    "workspace.capabilities.set": actionForm("workspace.capabilities.set", { policy: {} }),
    "op.exec": actionForm("op.exec", { command: "true" }),
    "op.parse": actionForm("op.parse", { text: "````READ (worker:///a)````" }),
    "a workspace-scoped module action": actionForm(WORKSPACE_ACTION),
    ping: actionForm("ping"),
    discover: actionForm("discover"),
    "providers.list": actionForm("providers.list"),
    "models.list": actionForm("models.list"),
    "workspace.list": actionForm("workspace.list"),
    "workspace.create": actionForm("workspace.create", { name: "world" }),
    "workspace.attach": actionForm("workspace.attach", { id: 3 }),
};
const formKind = ({ plurnk }: RunForm): string | undefined => (plurnk?.action as { kind?: string } | undefined)?.kind;
const formInput = (threadId: string, { messages, plurnk }: RunForm, workspace = "world"): Record<string, unknown> =>
    ({ threadId, messages: messages ?? [], forwardedProps: { plurnk: { workspace, ...plurnk } } });
const runForm = (port: number, threadId: string, form: RunForm, signal?: AbortSignal): Promise<Response> =>
    fetch(`http://127.0.0.1:${port}${form.path ?? "/agui"}`, {
        method: "POST", headers: { "content-type": "application/json" }, ...(signal === undefined ? {} : { signal }),
        body: JSON.stringify(standardInput(formInput(threadId, form))),
    });
type BoundSnapshot = { snapshot: { plurnk: Record<string, unknown> } };

test("{§agui-action-binding} the binding matrix classifies every built-in action", () => {
    const classified = new Set([CREATING_FORMS, REQUIRING_FORMS, UNBOUND_FORMS]
        .flatMap((forms) => Object.values(forms).flatMap((form) => formKind(form) ?? [])));
    assert.deepEqual(Object.keys(AGUI_BUILTIN_ACTIONS).filter((kind) => !classified.has(kind)), [],
        "a built-in action outside the matrix has no witnessed binding");
});

for (const [form, input] of Object.entries(CREATING_FORMS)) {
    for (const present of [false, true]) {
        test(`{§agui-action-binding} ${form} ${present ? "binds the worker its thread names" : "creates the worker its thread names, once"}`, async () => {
            const { seam, finish } = mockSeam();
            existingWorld(seam, "world");
            const workers = [workerRow(20, "elsewhere"), ...(present ? [workerRow(44, "page")] : [])];
            directory(seam, workers);
            const minted: Array<Parameters<ApplicationPort["createWorker"]>[0]> = [];
            seam.createWorker = async (args) => {
                minted.push(args);
                workers.push(workerRow(77, args.name!));
                return { workerId: 77, workerName: args.name! };
            };
            const reached: number[] = [];
            seam.runLoop = async ({ workspaceId, workerId }) => {
                reached.push(workerId);
                finish(workspaceId, workerId);
                return { status: 100, action: "enqueued_new_loop", loopId: 9 };
            };
            seam.setWorkerModel = async ({ workerId }) => { reached.push(workerId); return { alias: "fresh", provider: "openai", model: "mocktest" }; };
            seam.setWorkerSpawnModel = async ({ workerId }) => { reached.push(workerId); return null; };
            seam.setWorkerEffort = async ({ workerId }) => { reached.push(workerId); return { effort: "adaptive", source: "explicit", supportedEfforts: ["adaptive"] }; };
            // Twice through one module, then once through a fresh one: the daemon's directory decides, not a cache.
            for (const runs of [2, 1]) {
                const mod = await host(seam);
                try {
                    for (let run = 0; run < runs; run++) {
                        const events = await post(mod.address().port, formInput("page", input));
                        assert.equal(events.at(-1)?.type, "RUN_FINISHED");
                        const snapshot = events.find((event) => event.type === "STATE_SNAPSHOT") as BoundSnapshot | undefined;
                        assert.ok(snapshot?.snapshot.plurnk.status !== undefined, "a Run bound to a worker reports its status");
                    }
                } finally { await mod.close(); }
            }
            const bound = present ? 44 : 77;
            assert.deepEqual(minted, present ? [] : [{ workspaceId: 3, name: "page" }],
                present ? "a worker the workspace holds is never minted again" : "the worker is created once, named for its thread");
            assert.deepEqual(reached, [bound, bound, bound], "every Run reached the worker its thread names");
        });
    }
}

// {§agui-owner-connection} An owner's control observation is the owner's session attaching to its worker.
const OWNER_OBSERVATIONS: Readonly<Record<string, RunForm>> = {
    "a sync control observation": { plurnk: { mode: "sync", control: true } },
    "a connect control observation": { path: "/agui/connect", plurnk: { control: true } },
};

for (const [form, input] of Object.entries(OWNER_OBSERVATIONS)) {
    for (const present of [false, true]) {
        test(`{§agui-action-binding} ${form} ${present ? "binds and claims the worker its thread names" : "creates the worker its thread names, once, and claims it"}`, async () => {
            const { seam } = mockSeam();
            existingWorld(seam, "world");
            const workers = [workerRow(20, "elsewhere"), ...(present ? [workerRow(44, "page")] : [])];
            directory(seam, workers);
            const minted: Array<Parameters<ApplicationPort["createWorker"]>[0]> = [];
            seam.createWorker = async (args) => {
                minted.push(args);
                workers.push(workerRow(77, args.name!));
                return { workerId: 77, workerName: args.name! };
            };
            const claimed: number[] = [];
            const claim = seam.claimWorkerOwner;
            seam.claimWorkerOwner = async (args) => { claimed.push(args.workerId); return await claim(args); };
            const replayed: number[] = [];
            const attached = Promise.withResolvers<void>();
            seam.readLog = async ({ workerId }) => { replayed.push(workerId); attached.resolve(); return logRows([]); };
            const mod = await host(seam);
            const controller = new AbortController();
            try {
                const response = await runForm(mod.address().port, "page", input, controller.signal);
                assert.equal(response.status, 200);
                const body = response.text().catch(() => "");
                await waitForFixture(attached.promise, () => `${form} never replayed the worker it bound`);
                // A connection waits while its worker is idle; what it bound is decided by now.
                if (input.path === "/agui/connect") controller.abort();
                await body;
            } finally {
                controller.abort();
                await mod.close();
            }
            const bound = present ? 44 : 77;
            assert.deepEqual(minted, present ? [] : [{ workspaceId: 3, name: "page" }],
                present ? "a worker the workspace holds is never minted again" : "the owner's session creates the worker, named for its thread");
            assert.deepEqual(replayed, [bound], "the observation replays the worker its thread names");
            assert.ok(claimed.includes(bound), "the owner claims the worker it attached to");
        });
    }
}

for (const [form, input] of Object.entries(REQUIRING_FORMS)) {
    test(`{§agui-action-binding} ${form} requires the worker its thread names: 404 before any SSE when there is none, with nothing created`, async () => {
        const { seam } = mockSeam();
        existingWorld(seam, "world");
        directory(seam, [workerRow(20, "elsewhere")]);
        seam.listModuleActions = bindingModuleActions;
        const effects: string[] = [];
        for (const name of [
            "createWorkspace", "createWorker", "registerWorkerOwner", "claimWorkerOwner", "activateWorkspace",
            "runLoop", "cancelDrain", "forkWorker", "readWorkerModel", "readWorkerEffort", "invokeModuleAction",
            "readLog", "readEntry", "listPrompts", "rollback",
        ] as const) {
            const original = seam[name] as (...args: never[]) => unknown;
            Object.assign(seam, { [name]: (...args: never[]) => { effects.push(name); return original(...args); } });
        }
        const mod = await host(seam);
        try {
            const response = await runForm(mod.address().port, "ghost", input);
            assert.equal(response.status, 404);
            assert.equal(response.headers.get("content-type"), "application/problem+json", "the refusal precedes any SSE");
            const problem = await response.json() as { type: string; detail: string; recovery: string };
            // {§problems-agui}
            assert.deepEqual([problem.type, problem.detail, problem.recovery], [
                "https://problems.plurnk.xyz/agui/http/worker-not-found",
                'No model worker named "ghost" exists in workspace "world".',
                "Name an existing model worker, or create one by sending it a message.",
            ]);
            assert.deepEqual(effects, [], "nothing is created, claimed, activated or read for a worker that does not exist");
        } finally { await mod.close(); }
    });

    test(`{§agui-action-binding} ${form} binds exactly the worker its thread names`, async () => {
        const { seam } = mockSeam();
        existingWorld(seam, "world");
        directory(seam, [workerRow(20, "elsewhere"), workerRow(44, "page")]);
        seam.listModuleActions = bindingModuleActions;
        const reached: Array<[effect: string, workerId: number]> = [];
        const effected = Promise.withResolvers<void>();
        const reach = (effect: string, workerId: number): void => {
            reached.push([effect, workerId]);
            if (effect === input.effect) effected.resolve();
        };
        seam.readLog = async ({ workerId }) => { reach("readLog", workerId); return logRows([]); };
        seam.runLoop = async ({ workerId }) => { reach("runLoop", workerId); return { status: 100, action: "injected_next_turn", loopId: 9, turnSeq: 2 }; };
        seam.cancelDrain = (workerId) => { reach("cancelDrain", workerId); return true; };
        seam.forkWorker = async ({ workerId }) => { reach("forkWorker", workerId); return { workerId: 45, workerName: "page-fork", parentWorkerId: workerId }; };
        seam.readWorkerModel = async ({ workerId }) => { reach("readWorkerModel", workerId); return { model: null, spawnModel: null }; };
        seam.readWorkerEffort = async ({ workerId }) => { reach("readWorkerEffort", workerId); return { effort: null, source: "default", supportedEfforts: [] }; };
        seam.invokeModuleAction = async (_name, _params, context) => { reach("invokeModuleAction", (context as { workerId: number }).workerId); return {}; };
        seam.readEntry = async ({ workerId }) => { reach("readEntry", workerId); return { status: 200, entry: { entryId: 1, target: "worker:///x", channels: {} } }; };
        seam.listPrompts = async (_workspaceId, _limit, workerId) => { reach("listPrompts", workerId!); return []; };
        seam.rollback = async ({ workerId, to }) => { reach("rollback", workerId); return { to, restored: [], skipped: [], stopped: null }; };
        seam.createWorker = async () => { throw new Error("a Run that requires its worker minted one"); };
        const mod = await host(seam);
        const controller = new AbortController();
        try {
            const response = await runForm(mod.address().port, "page", input, controller.signal);
            assert.equal(response.status, 200);
            const body = response.text().catch(() => "");
            await waitForFixture(effected.promise, () => `${form} never carried its effect`);
            // A connection waits while its worker is idle; what it bound is decided by now.
            if (input.path === "/agui/connect") controller.abort();
            await body;
        } finally {
            controller.abort();
            await mod.close();
        }
        assert.deepEqual([...new Set(reached.map(([, workerId]) => workerId))], [44], "every effect reached the worker the thread names");
    });
}

for (const present of [true, false]) {
    test(`{§agui-client-operation} {§actor-boundary-client-operations} a client operation acts as its thread's owner, for the worker the thread names ${present ? "when it exists" : "only when it exists"}, and claims nothing`, async () => {
        const { seam, owners } = mockSeam();
        existingWorld(seam, "world");
        directory(seam, [workerRow(20, "elsewhere"), ...(present ? [workerRow(44, "page")] : [])]);
        seam.createWorker = async () => { throw new Error("a client operation minted a worker"); };
        const claims: number[] = [];
        seam.claimWorkerOwner = async ({ workerId }) => { claims.push(workerId); throw new Error("a client operation claimed a worker"); };
        const dispatched: Array<Omit<Parameters<ApplicationPort["dispatchClientAction"]>[0], "statements" | "onLoop">> = [];
        seam.dispatchClientAction = async ({ statements, onLoop: _onLoop, ...rest }) => {
            dispatched.push(rest);
            return statements.map(() => ({ status: 200 }));
        };
        const mod = await host(seam);
        try {
            for (const action of [{ kind: "op.exec", command: "true" }, { kind: "op.parse", text: "````READ (worker:///a)````" }]) {
                const events = await post(mod.address().port, { threadId: "page", forwardedProps: { plurnk: { workspace: "world", action } } });
                const result = events.find((event) => event.type === "CUSTOM" && event.name === "plurnk.action.result") as { value: { ok: boolean } } | undefined;
                assert.equal(result?.value.ok, true, JSON.stringify(result?.value));
            }
            const actor = "agui://anonymous/threads/page";
            assert.deepEqual(dispatched, Array.from({ length: 2 }, () => ({ workspaceId: 3, actor, ...(present ? { contextWorkerId: 44 } : {}) })));
            assert.deepEqual(claims, []);
            assert.equal(owners.size, 0, "an operation declares no owner capability set");
        } finally { await mod.close(); }
    });
}

for (const [form, input] of Object.entries(UNBOUND_FORMS)) {
    test(`{§agui-action-binding} ${form} binds no worker, and its Run reports no worker status`, async () => {
        const { seam } = mockSeam();
        existingWorld(seam, "world");
        directory(seam, [workerRow(20, "elsewhere")]);
        seam.listModuleActions = bindingModuleActions;
        seam.invokeModuleAction = async () => ({});
        const lookups: unknown[] = [];
        const read = seam.readWorker;
        seam.readWorker = async (args) => { lookups.push(args.identity); return await read(args); };
        seam.createWorker = async () => { throw new Error("a Run that binds no worker minted one"); };
        const addressed: number[] = [];
        seam.readLog = async ({ workerId }) => { addressed.push(workerId); return logRows([]); };
        seam.readEntry = async ({ workerId }) => { addressed.push(workerId); return { status: 200, entry: { entryId: 1, target: "worker:///x", channels: {} } }; };
        seam.listPrompts = async (_workspaceId, _limit, workerId) => { addressed.push(workerId!); return []; };
        seam.rollback = async ({ workerId, to }) => { addressed.push(workerId); return { to, restored: [], skipped: [], stopped: null }; };
        const mod = await host(seam);
        try {
            const events = await post(mod.address().port, formInput("page", input));
            const result = events.find((event) => event.type === "CUSTOM" && event.name === "plurnk.action.result") as { value: { ok: boolean } } | undefined;
            assert.equal(result?.value.ok, true, JSON.stringify(result?.value));
            // {§actor-boundary-client-operations} A client operation looks up the worker its thread names, to act for it.
            const operation = formKind(input) === "op.exec" || formKind(input) === "op.parse";
            assert.deepEqual(lookups, operation ? [{ name: "page" }] : [], "no worker is looked up for the thread but by a client operation");
            const named = (input.plurnk?.action as { workerId?: number } | undefined)?.workerId;
            assert.deepEqual(addressed, named === undefined ? [] : [named], "a reader reads only the worker it names");
            const snapshot = events.find((event) => event.type === "STATE_SNAPSHOT") as BoundSnapshot | undefined;
            const scope = (AGUI_BUILTIN_ACTIONS as Readonly<Record<string, { scope: string }>>)[formKind(input)!]?.scope;
            if (scope === "worldless") {
                assert.equal(snapshot, undefined, "a worldless action binds no workspace either");
            } else {
                assert.ok(snapshot !== undefined, "a workspace Run reports its workspace");
                assert.equal(Object.hasOwn(snapshot.snapshot.plurnk, "status"), false, "a Run bound to no worker reports no worker status");
            }
        } finally { await mod.close(); }
    });
}

test("a thread naming no worker MINTS one named for it, and the loop drives there", async () => {
    const created: Array<{ workspaceId: number; name?: string }> = [];
    const driven: number[] = [];
    const { seam, finish } = mockSeam();
    seam.listWorkspaces = async () => [workspaceRow(3, "workspace")];
    seam.attachWorkspace = async () => ({ workspaceId: 3, workspaceName: "workspace", projectRoot: null, projectLabel: null });
    directory(seam, [workerRow(20, "model-1")]);
    seam.createWorker = async (a) => { created.push(a); return { workerId: 77, workerName: a.name ?? "x" }; };
    seam.runLoop = async (a) => { driven.push(a.workerId); finish(a.workspaceId, a.workerId); return { status: 100, action: "enqueued_new_loop", loopId: 9 }; };
    const mod = await host(seam);
    try {
        await post(mod.address().port, { threadId: "chat-2", workerId: "r1", messages: [{ role: "user", content: "hi" }], forwardedProps: { plurnk: { workspace: "workspace" } } });
        assert.deepEqual(created, [{ workspaceId: 3, name: "chat-2" }], "the new worker is named for the thread, verbatim");
        assert.deepEqual(driven, [77], "the loop drove in the worker minted for the thread, not another of the workspace's");
    } finally { await mod.close(); }
});

test("{§agui-thread-binding} {§agui-action-binding}: concurrent first touches by every creating form acquire one envelope and create one worker", async () => {
    const { seam, finish } = mockSeam();
    let attached = 0;
    const created: string[] = [];
    seam.listWorkspaces = async () => [workspaceRow(3, "world")];
    seam.attachWorkspace = async () => {
        attached += 1;
        await new Promise<void>((resolve) => setImmediate(resolve));
        return { workspaceId: 3, workspaceName: "world", projectRoot: null, projectLabel: null };
    };
    const workers: WorkerRow[] = [];
    directory(seam, workers);
    seam.createWorker = async ({ name }) => {
        created.push(name!);
        await new Promise<void>((resolve) => setTimeout(resolve, 30));
        workers.push(workerRow(77, name!));
        return { workerId: 77, workerName: name! };
    };
    const reached: number[] = [];
    seam.runLoop = async ({ workspaceId, workerId }) => {
        reached.push(workerId);
        finish(workspaceId, workerId);
        return { status: 100, action: "enqueued_new_loop", loopId: 9 };
    };
    seam.setWorkerModel = async ({ workerId }) => { reached.push(workerId); return { alias: "fresh", provider: "openai", model: "mocktest" }; };
    seam.setWorkerSpawnModel = async ({ workerId }) => { reached.push(workerId); return null; };
    seam.setWorkerEffort = async ({ workerId }) => { reached.push(workerId); return { effort: "adaptive", source: "explicit", supportedEfforts: ["adaptive"] }; };
    const mod = await host(seam);
    try {
        const forms = Object.values(CREATING_FORMS);
        const runs = await Promise.all(Array.from({ length: 8 }, (_, index) => post(mod.address().port, {
            ...formInput("new-worker", forms[index % forms.length]!), runId: `run-${index}`,
        })));
        assert.ok(runs.every((events) => events.at(-1)?.type === "RUN_FINISHED"));
        assert.equal(attached, 1, "concurrent requests share envelope acquisition");
        assert.deepEqual(created, ["new-worker"], "concurrent first touches create the thread's worker once");
        assert.deepEqual(reached, Array.from({ length: 8 }, () => 77), "every touch reached that one worker");
    } finally { await mod.close(); }
});

test("{§agui-thread-binding}: concurrent threads create one world, and each thread its own worker in it", async () => {
    const { seam, finish } = mockSeam();
    const created: Parameters<ApplicationPort["createWorkspace"]>[0][] = [];
    let available = false;
    let workerId = 40;
    seam.listWorkspaces = async () => available ? [workspaceRow(3, "cold")] : [];
    seam.createWorkspace = async (args) => {
        created.push(args);
        await new Promise<void>((resolve) => setImmediate(resolve));
        available = true;
        return { workspaceId: 3, workspaceName: "cold", projectRoot: null, projectLabel: null };
    };
    seam.attachWorkspace = async () => ({ workspaceId: 3, workspaceName: "cold", projectRoot: null, projectLabel: null });
    directory(seam, []);
    seam.createWorker = async ({ name }) => ({ workerId: ++workerId, workerName: name! });
    seam.runLoop = async ({ workspaceId, workerId }) => {
        finish(workspaceId, workerId);
        return { status: 100, action: "enqueued_new_loop", loopId: 9 };
    };
    const mod = await host(seam);
    try {
        const runs = await Promise.all(Array.from({ length: 8 }, (_, index) => post(mod.address().port, {
            threadId: `thread-${index}`, runId: `run-${index}`, messages: [{ role: "user", content: "go" }],
            forwardedProps: { plurnk: { workspace: "cold", projectRoot: `/root-${index}` } },
        })));
        assert.ok(runs.every((events) => events.some((event) => event.type === "CUSTOM" && event.name === "plurnk.terminated")));
        assert.equal(created.length, 1);
        assert.match(created[0]!.projectRoot!, /^\/root-\d$/);
        assert.equal(workerId, 48, "each thread minted its own worker");
    } finally { await mod.close(); }
});

test("{§agui-thread-binding}: a failed attach-only request cannot deny a queued message Run its create contract", async () => {
    const { seam, finish } = mockSeam();
    const lookup = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let calls = 0;
    seam.listWorkspaces = async () => {
        if (++calls === 1) { lookup.resolve(); await release.promise; }
        return [];
    };
    seam.createWorkspace = async () => ({ workspaceId: 3, workspaceName: "cold", projectRoot: null, projectLabel: null });
    seam.runLoop = async ({ workspaceId, workerId }) => {
        finish(workspaceId, workerId);
        return { status: 100, action: "enqueued_new_loop", loopId: 9 };
    };
    const mod = await host(seam);
    try {
        const action = fetch(`http://127.0.0.1:${mod.address().port}/agui`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(standardInput({
            threadId: "cold", runId: "inspect", forwardedProps: { plurnk: { workspace: "cold", action: { kind: "loop.inject", prompt: "hello" } } },
        })) });
        await lookup.promise;
        const run = post(mod.address().port, { threadId: "cold", runId: "start", messages: [{ role: "user", content: "go" }], forwardedProps: { plurnk: { workspace: "cold" } } });
        release.resolve();
        const refused = await action;
        assert.equal(refused.status, 404);
        assert.equal((await refused.json() as { type: string }).type, "https://problems.plurnk.xyz/agui/http/workspace-not-found");
        assert.ok((await run).some((event) => event.type === "CUSTOM" && event.name === "plurnk.terminated"));
        assert.equal(calls, 2, "the creating request performs its own lookup after the failed action");
    } finally { release.resolve(); await mod.close(); }
});

for (const stage of ["envelope", "worker"] as const) {
    test(`{§agui-thread-binding}: a failed ${stage} acquisition preserves its Problem and permits retry`, async () => {
        const { seam } = mockSeam();
        let fail = true;
        let attached = 0;
        let created = 0;
        const problem = Problems.create("daemon:worker", "fixture-unavailable", 503, "Fixture acquisition unavailable.", { retryable: true });
        const failure = Object.assign(new Error(problem.detail), { result: { status: problem.status, problem } });
        seam.listWorkspaces = async () => [workspaceRow(3, "world")];
        seam.attachWorkspace = async () => {
            attached += 1;
            if (fail && stage === "envelope") throw failure;
            return { workspaceId: 3, workspaceName: "world", projectRoot: null, projectLabel: null };
        };
        directory(seam, []);
        seam.createWorker = async () => {
            created += 1;
            if (fail && stage === "worker") throw failure;
            return { workerId: 42, workerName: "named" };
        };
        const mod = await host(seam);
        const input = { threadId: "named", runId: "fixture", forwardedProps: { plurnk: { workspace: "world", action: { kind: "worker.model.set", selector: "fresh" } } } };
        try {
            const refused = await fetch(`http://127.0.0.1:${mod.address().port}/agui`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(standardInput(input)) });
            assert.equal(refused.status, 503);
            assert.deepEqual(await refused.json(), problem);
            fail = false;
            const events = await post(mod.address().port, input);
            assert.ok(events.some((event) => event.type === "CUSTOM" && event.name === "plurnk.action.result" && (event.value as { ok: boolean }).ok));
            assert.equal(attached, stage === "envelope" ? 2 : 1);
            assert.equal(created, stage === "worker" ? 2 : 1);
        } finally { await mod.close(); }
    });
}

test("a threadId naming an existing worker (a fork or an earlier worker) binds it — no mint", async () => {
    let created = 0;
    const driven: number[] = [];
    const { seam, finish } = mockSeam();
    seam.listWorkspaces = async () => [workspaceRow(3, "workspace")];
    seam.attachWorkspace = async () => ({ workspaceId: 3, workspaceName: "workspace", projectRoot: null, projectLabel: null });
    directory(seam, [workerRow(20, "model-1"), workerRow(44, "spike")]);
    seam.createWorker = async () => { created++; return { workerId: 99, workerName: "x" }; };
    seam.runLoop = async (a) => { driven.push(a.workerId); finish(a.workspaceId, a.workerId); return { status: 100, action: "enqueued_new_loop", loopId: 9 }; };
    const mod = await host(seam);
    try {
        await post(mod.address().port, { threadId: "spike", workerId: "r1", messages: [{ role: "user", content: "hi" }], forwardedProps: { plurnk: { workspace: "workspace" } } });
        assert.deepEqual(driven, [44], "the existing worker 'spike' is bound");
        assert.equal(created, 0, "no duplicate worker minted");
    } finally { await mod.close(); }
});

// #1134 — a workspace may share its name with a worker in it, before or after a rename by any client;
// the threadId alone selects the worker.
test("{§agui-thread-binding} a workspace renamed to one of its workers' names still binds, for each thread, exactly the worker the thread names", async () => {
    const { seam, finish } = mockSeam();
    let name = "project";
    seam.listWorkspaces = async () => [workspaceRow(3, name)];
    seam.attachWorkspace = async () => ({ workspaceId: 3, workspaceName: name, projectRoot: null, projectLabel: null });
    directory(seam, [workerRow(21, "reviewer"), workerRow(22, "page")]);
    seam.listModuleActions = bindingModuleActions;
    seam.createWorker = async () => { throw new Error("a thread naming an existing worker minted another"); };
    const addressed = new Set<number>();
    seam.readWorkerModel = async ({ workerId }) => { addressed.add(workerId); return { model: null, spawnModel: null }; };
    seam.readLog = async ({ workerId }) => { addressed.add(workerId); return logRows([]); };
    seam.runLoop = async ({ workspaceId, workerId }) => {
        addressed.add(workerId);
        finish(workspaceId, workerId);
        return { status: 100, action: "enqueued_new_loop", loopId: 9 };
    };
    seam.invokeModuleAction = async (_name, _params, context) => { addressed.add((context as { workerId: number }).workerId); return {}; };
    const forms: Readonly<Record<string, RunForm>> = {
        observation: REQUIRING_FORMS["a sync observation"]!,
        "message Run": CREATING_FORMS["a message Run"]!,
        "worker-scoped action": REQUIRING_FORMS["a worker-scoped module action"]!,
    };
    const bindsEachThread = async (port: number, workspace: string, when: string): Promise<void> => {
        for (const [threadId, worker] of [["reviewer", 21], ["page", 22]] as const) {
            for (const [form, input] of Object.entries(forms)) {
                addressed.clear();
                assert.equal((await post(port, formInput(threadId, input, workspace))).at(-1)?.type, "RUN_FINISHED");
                assert.deepEqual([...addressed], [worker], `${when}, thread ${threadId}'s ${form} binds worker ${worker} alone`);
            }
        }
    };
    let mod = await host(seam);
    try {
        await bindsEachThread(mod.address().port, "project", "before the rename");
        name = "reviewer"; // renamed by another client: the workspace now shares its name with a worker in it
        await bindsEachThread(mod.address().port, "reviewer", "after the rename");
        await mod.close();
        mod = await host(seam);
        await bindsEachThread(mod.address().port, "reviewer", "after a restart resolves every name afresh");
    } finally { await mod.close(); }
});

test("{§agui-thread-binding} a thread named after its workspace binds the worker of that name, never a different one", async () => {
    const { seam, finish } = mockSeam();
    existingWorld(seam, "project");
    const workers = [workerRow(21, "reviewer"), workerRow(22, "page")];
    directory(seam, workers);
    const minted: string[] = [];
    seam.createWorker = async ({ name }) => { minted.push(name!); workers.push(workerRow(23, name!)); return { workerId: 23, workerName: name! }; };
    const addressed = new Set<number>();
    seam.readLog = async ({ workerId }) => { addressed.add(workerId); return logRows([]); };
    seam.runLoop = async ({ workspaceId, workerId }) => {
        addressed.add(workerId);
        finish(workspaceId, workerId);
        return { status: 100, action: "enqueued_new_loop", loopId: 9 };
    };
    const mod = await host(seam);
    const observation = REQUIRING_FORMS["a sync observation"]!;
    try {
        const absent = await fetch(`http://127.0.0.1:${mod.address().port}/agui`, {
            method: "POST", headers: { "content-type": "application/json" },
            body: JSON.stringify(standardInput(formInput("project", observation, "project"))),
        });
        assert.equal(absent.status, 404, "no worker is named for the workspace yet, and none stands in for it");
        assert.match((await absent.json() as { type: string }).type, /\/worker-not-found$/u);
        await post(mod.address().port, formInput("project", CREATING_FORMS["a message Run"]!, "project"));
        assert.deepEqual(minted, ["project"], "the message created the worker its thread names");
        await post(mod.address().port, formInput("project", observation, "project"));
        assert.deepEqual([...addressed], [23], "the thread bound that worker alone");
    } finally { await mod.close(); }
});

test("loop.inject folds into the worker its thread names, as that thread's message", async () => {
    const driven: number[] = [];
    const messages: Array<Parameters<ApplicationPort["runLoop"]>[0]> = [];
    const { seam, finish } = mockSeam();
    seam.listWorkspaces = async () => [workspaceRow(3, "workspace")];
    seam.attachWorkspace = async () => ({ workspaceId: 3, workspaceName: "workspace", projectRoot: null, projectLabel: null });
    directory(seam, [workerRow(44, "spike")]);
    seam.runLoop = async (a) => { driven.push(a.workerId); messages.push(a); finish(a.workspaceId, a.workerId); return { status: 100, action: "injected_next_turn", loopId: 9, turnSeq: 2 }; };
    const mod = await host(seam);
    try {
        await post(mod.address().port, { threadId: "spike", workerId: "r1", forwardedProps: { plurnk: { workspace: "workspace", action: { kind: "loop.inject", prompt: "steer" } } } });
        assert.deepEqual(driven, [44], "the steer reached the thread's own worker");
        const message = messages[0]!;
        assert.match(message.source ?? "", /^agui:\/\/anonymous\/threads\/spike\/messages\/[^/]+$/u, "injected input belongs to its thread just like a normal message Run");
        assert.equal(message.messageAddress, message.source, "curation cannot erase the injected message's original source");
        const envelope = message.envelope as { threadId: string; runId: string; message: { id: string; role: string; content: string } };
        assert.equal(envelope.threadId, "spike");
        assert.equal(envelope.runId, "r1");
        assert.equal(envelope.message.role, "user");
        assert.equal(envelope.message.content, "steer");
        assert.equal(message.source, `agui://anonymous/threads/spike/messages/${encodeURIComponent(envelope.message.id)}`);
        await post(mod.address().port, { threadId: "spike", runId: "r2", forwardedProps: { plurnk: { workspace: "workspace", action: { kind: "loop.inject", prompt: "steer" } } } });
        assert.notEqual(messages[1]!.messageAddress, message.messageAddress, "equal text submitted twice is still two distinct messages");
    } finally { await mod.close(); }
});

test("[{§agui-configuration}] the environment heartbeat cadence reaches the SSE listener", async () => {
    const { seam, finish } = mockSeam();
    seam.listWorkspaces = async () => [workspaceRow(3, "w")];
    seam.attachWorkspace = async () => ({ workspaceId: 3, workspaceName: "w", projectRoot: null, projectLabel: null });
    // A SLOW loop: no events for ~200ms (a long model generation), then terminated.
    seam.runLoop = async (a) => { setTimeout(() => finish(a.workspaceId, a.workerId), 200); return { status: 100, action: "enqueued_new_loop", loopId: 9 }; };
    const mod = await host(seam, {
        env: { ...FLOOR, PLURNK_AGUI_ALLOW_ORIGIN: "*", PLURNK_AGUI_HEARTBEAT_MS: "40" },
    });
    try {
        const res = await fetch(`http://127.0.0.1:${mod.address().port}/agui`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(standardInput({ threadId: "w", runId: "r1", messages: [{ role: "user", content: "think long" }], forwardedProps: { plurnk: { workspace: "w" } } })) });
        const raw = await res.text();
        const beats = (raw.match(/^: hb$/gm) ?? []).length;
        assert.ok(beats >= 2, `the silent window carried heartbeats (got ${beats}) — no client bodyTimeout can starve mid-generate`);
        assert.match(raw, /RUN_FINISHED/, "the worker still ends clean");
    } finally { await mod.close(); }
});

test("[{§agui-configuration}] heartbeat cadence 0 emits no comment frames", async () => {
    const { seam, finish } = mockSeam();
    seam.listWorkspaces = async () => [workspaceRow(3, "w")];
    seam.attachWorkspace = async () => ({ workspaceId: 3, workspaceName: "w", projectRoot: null, projectLabel: null });
    seam.runLoop = async (a) => { setTimeout(() => finish(a.workspaceId, a.workerId), 100); return { status: 100, action: "enqueued_new_loop", loopId: 9 }; };
    const mod = await host(seam, {
        env: { ...FLOOR, PLURNK_AGUI_ALLOW_ORIGIN: "*", PLURNK_AGUI_HEARTBEAT_MS: "0" },
    });
    try {
        const res = await fetch(`http://127.0.0.1:${mod.address().port}/agui`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(standardInput({ threadId: "w", runId: "r1", messages: [{ role: "user", content: "think long" }], forwardedProps: { plurnk: { workspace: "w" } } })) });
        assert.doesNotMatch(await res.text(), /^: hb$/m);
    } finally { await mod.close(); }
});

test("[{§agui-configuration}] the environment turn default yields to the Run value", async () => {
    const observed: Array<number | undefined> = [];
    const { seam, finish } = mockSeam();
    seam.listWorkspaces = async () => [workspaceRow(3, "w")];
    seam.attachWorkspace = async () => ({ workspaceId: 3, workspaceName: "w", projectRoot: null, projectLabel: null });
    seam.runLoop = async (args) => {
        observed.push(args.maxTurns);
        finish(args.workspaceId, args.workerId);
        return { status: 100, action: "enqueued_new_loop", loopId: 9 };
    };
    const mod = await host(seam, {
        env: {
            ...FLOOR,
            PLURNK_AGUI_ALLOW_ORIGIN: "*",
            PLURNK_AGUI_MAX_TURNS: "7",
            PLURNK_AGUI_HEARTBEAT_MS: "0",
        },
    });
    try {
        const input = { threadId: "w", messages: [{ role: "user", content: "continue" }], forwardedProps: { plurnk: { workspace: "w" } } };
        await post(mod.address().port, input);
        await post(mod.address().port, {
            ...input,
            forwardedProps: { plurnk: { workspace: "w", maxTurns: 2 } },
        });
        assert.deepEqual(observed, [7, 2]);
    } finally { await mod.close(); }
});


test("{§agui-run-endpoint} the prompt is the last textual user message, and a non-textual one is refused before any loop", async () => {
    const { seam, loopRuns, finish } = mockSeam();
    seam.runLoop = async (a) => {
        loopRuns.push({ prompt: a.prompt });
        finish(a.workspaceId, a.workerId);
        return { status: 100, action: "enqueued_new_loop" as const, loopId: 9 };
    };
    const mod = await host(seam);
    try {
        await post(mod.address().port, {
            threadId: "t-last", workerId: "r-last",
            forwardedProps: { plurnk: { workspace: "t-last" } },
            messages: [
                { role: "user", content: "first" },
                { role: "assistant", content: "in between" },
                { role: "user", content: "the standing request" },
            ],
        });
        assert.deepEqual(loopRuns.map(({ prompt }) => prompt), ["the standing request"], "the latest user turn is the prompt");

        const response = await fetch(`http://127.0.0.1:${mod.address().port}/agui`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
                runId: "r-parts", threadId: "t-last", state: {}, tools: [], context: [],
                forwardedProps: { plurnk: { workspace: "t-last" } },
                messages: [{ id: "m0", role: "user", content: [{ type: "text", text: "multimodal" }] }],
            }),
        });
        assert.equal(response.status, 400);
        assert.equal(response.headers.get("content-type"), "application/problem+json");
        const problem = await response.json() as Record<string, unknown>;
        assert.equal(problem.type, "https://problems.plurnk.xyz/agui/http/user-message-required");
        assert.equal(loopRuns.length, 1, "a refused Run starts no loop");
    } finally { await mod.close(); }
});

test("{§agui-provider-policy-forwarding} a message AG-UI Run forwards model selection", async () => {
    const { seam, loopRuns, finish } = mockSeam();
    // The worker self-completes: the runLoop override closes the stream for its workspace (the working
    // message-drive pattern above), so the POST resolves.
    seam.runLoop = async (a) => { loopRuns.push({ prompt: a.prompt, ...(a.selector !== undefined ? { selector: a.selector } : {}), ...(a.childSelector !== undefined ? { childSelector: a.childSelector } : {}) }); finish(a.workspaceId, a.workerId); return { status: 100, action: "enqueued_new_loop" as const, loopId: 9 }; };
    const mod = await host(seam);
    try {
        await post(mod.address().port, {
            threadId: "t-model", workerId: "r1",
            forwardedProps: { plurnk: {
                workspace: "t-model",
                selector: "fireslow",
                childSelector: "firefast",
            } },
            messages: [{ role: "user", content: "hello" }],
        });
        assert.equal(loopRuns.length, 1, "the message drove one runLoop");
        assert.equal(loopRuns[0].selector, "fireslow", "the parent selector forwards off forwardedProps.plurnk");
        assert.equal(loopRuns[0].childSelector, "firefast", "the child selector rides the same per-loop wire");
    } finally { await mod.close(); }
});

test("a post-headers runLoop failure preserves its exact Problem in the terminal SSE frames", async () => {
    const { seam, emit } = mockSeam();
    seam.listWorkspaces = async () => [workspaceRow(3, "w")];
    seam.attachWorkspace = async () => ({ workspaceId: 3, workspaceName: "w", projectRoot: null, projectLabel: null });
    directory(seam, [workerRow(20, "w")]);
    const problem = Problems.create(
        "daemon:provider",
        "not-configured",
        501,
        "No model provider is configured for this AG-UI Run.",
        {
            stage: "provider-selection",
            recovery: "Configure or select an available model provider.",
            retryable: false,
            alias: "missing",
        },
    );
    seam.runLoop = async () => {
        emit(3, "log/entry", {
            entry: {
                id: 39,
                worker_id: 20,
                loop_id: 9,
                turn_id: 12,
                loop_seq: 1, turn_seq: 12, sequence: 1,
                op: "NOTE",
                origin: "model",
                tx: { body: "Attempt the run." },
            },
        });
        throw Object.assign(new Error(problem.detail), { result: { status: problem.status, problem } });
    };
    const before = process.getActiveResourcesInfo().filter((r) => r === "Timeout").length;
    const mod = await host(seam);
    try {
        const res = await fetch(`http://127.0.0.1:${mod.address().port}/agui`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(standardInput({ threadId: "w", runId: "r1", messages: [{ role: "user", content: "hi" }], forwardedProps: { plurnk: { workspace: "w" } } })) });
        assert.equal(res.status, 200, "the SSE opened before the throw");
        const frames = (await res.text()).split("\n\n").filter((f) => f.startsWith("data: ")).map((f) => JSON.parse(f.slice(6)) as { type: string; message?: string; code?: string });
        const err = frames.find((e) => e.type === "RUN_ERROR");
        assert.ok(err !== undefined, "the throw surfaced as a RUN_ERROR frame, not a silent end");
        assert.equal(err.message, problem.detail);
        assert.equal(err.code, problem.type, "RUN_ERROR code projects the exact Problem type");
        assert.deepEqual(
            frames.filter(({ type }) => type.startsWith("STEP_")).map(({ type }) => type),
            ["STEP_STARTED", "STEP_FINISHED"],
            "a failed AG-UI Run closes the Plurnk turn step it opened",
        );
        const exact = frames.find((event) => event.type === "CUSTOM"
            && (event as { name?: string }).name === "plurnk.problem") as {
            value?: typeof problem;
        } | undefined;
        assert.deepEqual(exact?.value, problem, "the lossless custom event preserves every Problem field");
        // The leak pin: the error path must release the AG-UI Run's handles (heartbeat
        // interval, portal binding) — a survivor here wedges `node --test` (no
        // force-exit in the drill) forever.
        const timeouts = process.getActiveResourcesInfo().filter((r) => r === "Timeout").length;
        assert.equal(timeouts, before, "no timer survives the errored AG-UI Run");
    } finally { await mod.close(); }
});

test("an unexpected post-headers runLoop exception becomes one generic Problem without leaking its message", async () => {
    const { seam } = mockSeam();
    seam.listWorkspaces = async () => [workspaceRow(3, "w")];
    seam.attachWorkspace = async () => ({ workspaceId: 3, workspaceName: "w", projectRoot: null, projectLabel: null });
    seam.runLoop = async () => { throw new Error("secret internal failure"); };
    const mod = await host(seam);
    try {
        const events = await post(mod.address().port, {
            threadId: "w",
            runId: "r1",
            messages: [{ role: "user", content: "hi" }],
            forwardedProps: { plurnk: { workspace: "w" } },
        });
        const exact = events.find((event) => event.type === "CUSTOM"
            && (event as { name?: string }).name === "plurnk.problem") as {
            value?: { type?: string; detail?: string; stage?: string };
        } | undefined;
        assert.equal(exact?.value?.type, "https://problems.plurnk.xyz/agui/http/run-failed");
        assert.equal(exact?.value?.detail, "The AG-UI Run failed unexpectedly."); // {§problems-agui}
        assert.equal(exact?.value?.stage, "run");
        assert.doesNotMatch(JSON.stringify(events), /secret internal failure/);
    } finally { await mod.close(); }
});

test("{§agui-run-authority} the AG-UI STANDARD face keeps the protocol's nouns: RUN_STARTED/RUN_FINISHED echo RunAgentInput.runId (never plurnk's workerId) — ungated, so a lexicon sweep can't silently break conformance", async () => {
    const { seam, finish } = mockSeam();
    seam.listWorkspaces = async () => [workspaceRow(3, "w")];
    seam.attachWorkspace = async () => ({ workspaceId: 3, workspaceName: "w", projectRoot: null, projectLabel: null });
    seam.runLoop = async (a) => { finish(a.workspaceId, a.workerId); return { status: 100, action: "enqueued_new_loop", loopId: 9 }; };
    const mod = await host(seam);
    try {
        const events = await post(mod.address().port, { threadId: "w", runId: "agui-run-7", messages: [{ role: "user", content: "hi" }], forwardedProps: { plurnk: { workspace: "w" } } });
        const started = events.find((e) => e.type === "RUN_STARTED") as { runId?: string; workerId?: unknown };
        const finished = events.find((e) => e.type === "RUN_FINISHED") as { runId?: string; workerId?: unknown };
        assert.equal(started?.runId, "agui-run-7", "RUN_STARTED echoes the protocol's runId");
        assert.equal(finished?.runId, "agui-run-7", "RUN_FINISHED echoes the protocol's runId");
        assert.equal(started?.workerId, undefined, "plurnk's worker noun NEVER rides the standard face");
        assert.equal(finished?.workerId, undefined, "plurnk's worker noun NEVER rides the standard face");
    } finally { await mod.close(); }
});

test("{§agui-thread-binding}: a thread name never binds a client or runtime actor; minting answers instead", async () => {
    const { seam } = mockSeam();
    const minted: string[] = [];
    const runWorkers: number[] = [];
    seam.listWorkspaces = async () => [workspaceRow(3, "w")];
    seam.attachWorkspace = async () => ({ workspaceId: 3, workspaceName: "w", projectRoot: null, projectLabel: null });
    directory(seam, [workerRow(5, "_plurnk", "_plurnk"), workerRow(20, "model-1")]);
    const refusals: Record<string, ReturnType<typeof Problems.create>> = {
        _plurnk: Problems.create("daemon:worker", "name-invalid", 400, "Worker name '_plurnk' must match [A-Za-z0-9][A-Za-z0-9_-]{0,62}.", { context: "worker.create", field: "name", name: "_plurnk", retryable: false }),
    };
    seam.createWorker = async (a) => {
        minted.push(a.name ?? "");
        const problem = refusals[a.name ?? ""];
        if (problem === undefined) throw new Error(`unexpected mint: ${a.name}`);
        throw Object.assign(new Error(problem.detail), { result: { status: problem.status, problem } });
    };
    seam.runLoop = async ({ workerId }) => {
        runWorkers.push(workerId);
        return { status: 100, action: "enqueued_new_loop" as const, loopId: 9 };
    };
    const mod = await host(seam);
    try {
        const port = mod.address().port;
        for (const [threadId, problem] of Object.entries(refusals)) {
            // The binding fails before the SSE opens, so the refusal is the HTTP Problem itself.
            const res = await fetch(`http://127.0.0.1:${port}/agui`, {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify(standardInput({ threadId, messages: [{ role: "user", content: "hi" }], forwardedProps: { plurnk: { workspace: "w" } } })),
            });
            const body = await res.json() as { type?: string; status?: number };
            assert.equal(res.status, problem.status, `thread '${threadId}' fails at minting instead of binding the worker that holds the name`);
            assert.equal(body.type, problem.type, `thread '${threadId}' surfaces the daemon's exact Problem`);
        }
        assert.deepEqual(minted, ["_plurnk"], "the name reached createWorker; it never resolved to the runtime actor");
        assert.deepEqual(runWorkers, [], "no loop ran on the runtime actor");
    } finally { await mod.close(); }
});

test("{§agui-delegation-observation}: forwardedProps.plurnk.descendants fans a child's rows into the message Run's SSE, introduced once", async () => {
    const { seam, emit } = mockSeam();
    const started = Promise.withResolvers<void>();
    seam.listWorkers = async () => [workerRow(77, "chat"), workerRow(78, "child", "model", 77)];
    seam.runLoop = async () => { started.resolve(); return { status: 100, action: "enqueued_new_loop" as const, loopId: 9 }; };
    const mod = await host(seam);
    try {
        const port = mod.address().port;
        const run = openStream(port, { threadId: "chat", messages: [{ role: "user", content: "hi" }], forwardedProps: { plurnk: { workspace: "chat", descendants: true } } });
        await waitForFixture(started.promise, () => "the Run did not bind through runLoop");
        emit(3, "log/entry", { entry: { id: 2, worker_id: 78, loop_id: 12, origin: "model", op: "READ", status_rx: 200, rx: {}, loop_seq: 1, turn_seq: 1, sequence: 1, tx: { body: "" }, turn_id: 1 } });
        await new Promise((resolve) => setImmediate(resolve));
        await new Promise((resolve) => setImmediate(resolve));
        emit(3, "loop/terminated", termination({ workerId: 77, loopId: 9, usage: loopUsage({ inputTokens: 1, outputTokens: 1, curationBudget: 1000 }) }));
        const events = await run;
        const customs = events.filter((event) => event.type === "CUSTOM").map((event) => (event as { name: string }).name);
        const intro = customs.indexOf("plurnk.descendant");
        const row = customs.indexOf("plurnk.row");
        assert.ok(intro >= 0 && row > intro, `the child is introduced before its row: ${customs.join(",")}`);
        const value = (events.find((event) => (event as { name?: string }).name === "plurnk.descendant") as { value: { workerId: number; name: string; depth: number } }).value;
        assert.deepEqual([value.workerId, value.name, value.depth], [78, "child", 1]);
    } finally { await mod.close(); }
});

const mintAccess = async (port: number, client: { id: string; secret: string }): Promise<string> => {
    const response = await fetch(`http://127.0.0.1:${port}/oauth/token`, {
        method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ grant_type: "client_credentials", client_id: client.id, client_secret: client.secret }).toString(),
    });
    const body = await response.json() as { access_token?: string; error?: string };
    assert.equal(response.status, 200, JSON.stringify(body));
    return body.access_token!;
};

test("{§agui-run-source} the principal is the credential's subject: the operator or a declared client", async () => {
    const { seam } = mockSeam("s3cret");
    const sources: string[] = [];
    const mod = await host(seam, { env: {
        ...FLOOR, PLURNK_AUTH: "1", PLURNK_AGUI_ALLOW_ORIGIN: "*", PLURNK_AGUI_HEARTBEAT_MS: "0",
        PLURNK_AGUI_CLIENT_agent: JSON.stringify({ secret: "agent-secret", scopes: ["agui"] }),
    } });
    try {
        const port = mod.address().port;
        // A message Run submits the message under the admitted principal; the loop it enqueues is
        // not the subject here, so the Run is abandoned once the submission was seen.
        const prompt = async (authorization: string): Promise<void> => {
            const entered = Promise.withResolvers<void>();
            seam.runLoop = async (a) => { sources.push(a.source ?? ""); entered.resolve(); return { status: 100, action: "enqueued_new_loop", loopId: 9, turnSeq: 1 }; };
            const controller = new AbortController();
            const response = fetch(`http://127.0.0.1:${port}/agui`, {
                method: "POST", headers: { "content-type": "application/json", authorization }, signal: controller.signal,
                body: JSON.stringify(standardInput({ threadId: "agui-t", messages: [{ role: "user", content: "hello" }], forwardedProps: { plurnk: { workspace: "agui-t" } } })),
            });
            await waitForFixture(entered.promise, () => "the Run never submitted its message");
            controller.abort();
            await response.then((r) => r.text()).catch(() => undefined);
        };
        await prompt(`Bearer ${await mintAccess(port, { id: "operator", secret: "s3cret" })}`);
        await prompt(`Bearer ${await mintAccess(port, { id: "agent", secret: "agent-secret" })}`);
        assert.deepEqual(sources.map((source) => source.replace(/\/messages\/.*$/u, "")), [
            "agui://operator/threads/agui-t",
            "agui://agent/threads/agui-t",
        ]);
    } finally { await mod.close(); }
});

test("{§agui-oauth-revocation} revoking a credential ends the streams admitted under it and cancels no worker; another family's stream continues", async () => {
    const { seam } = mockSeam("s3cret");
    existingWorld(seam, "w");
    const cancellations: number[] = [];
    seam.cancelDrain = (workerId) => { cancellations.push(workerId); return true; };
    const mod = await host(seam, { env: { ...FLOOR, PLURNK_AUTH: "1", PLURNK_AGUI_ALLOW_ORIGIN: "*", PLURNK_AGUI_HEARTBEAT_MS: "0" } });
    const controllers = [new AbortController(), new AbortController()];
    try {
        const port = mod.address().port;
        const [revoked, kept] = await Promise.all([mintAccess(port, { id: "operator", secret: "s3cret" }), mintAccess(port, { id: "operator", secret: "s3cret" })]);
        const open = async (token: string, index: number): Promise<Response> => {
            const response = await fetch(`http://127.0.0.1:${port}/agui/connect`, {
                method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}` }, signal: controllers[index]!.signal,
                body: JSON.stringify(standardInput({ threadId: `observer-${index}`, messages: [], forwardedProps: { plurnk: { workspace: "w" } } })),
            });
            assert.equal(response.status, 200);
            return response;
        };
        const ending = await open(revoked, 0);
        const surviving = await open(kept, 1);
        const revocation = await fetch(`http://127.0.0.1:${port}/oauth/revoke`, {
            method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
            body: new URLSearchParams({ token: revoked, client_id: "operator", client_secret: "s3cret" }).toString(),
        });
        assert.equal(revocation.status, 200);
        const body = await ending.text();
        const events = body.split("\n\n").filter((frame) => frame.startsWith("data: ")).map((frame) => JSON.parse(frame.slice(6)) as AguiEvent);
        const problem = events.find((event) => event.type === "CUSTOM" && event.name === "plurnk.problem");
        assert.ok(problem?.type === "CUSTOM" && problem.value.type === "https://problems.plurnk.xyz/agui/http/credential-revoked", JSON.stringify(events.map(({ type }) => type)));
        assert.equal(events.at(-1)?.type, "RUN_ERROR");
        assert.deepEqual(cancellations, [], "a revoked observer is not a cancelling one");
        const stillOpen = await Promise.race([surviving.text().then(() => false), new Promise<boolean>((resolve) => setTimeout(() => resolve(true), 200))]);
        assert.equal(stillOpen, true, "the other family's stream is still open");
        controllers[1]!.abort();
        await surviving.text().catch(() => undefined);
    } finally {
        for (const controller of controllers) controller.abort();
        await mod.close();
    }
});

test("{§agui-oauth-revocation} {§agui-shutdown} {§agui-readable-reasoning} a Run ended mid-reasoning closes its reasoning before RUN_ERROR; a Run that joins mid-request presents none of it", async () => {
    const { seam, emit } = mockSeam("s3cret");
    existingWorld(seam, "w");
    const cancellations: number[] = [];
    seam.cancelDrain = (workerId) => { cancellations.push(workerId); return true; };
    const mod = await host(seam, { env: { ...FLOOR, PLURNK_AUTH: "1", PLURNK_AGUI_ALLOW_ORIGIN: "*", PLURNK_AGUI_HEARTBEAT_MS: "0" } });
    const controllers = Array.from({ length: 3 }, () => new AbortController());
    const messageId = "model-call-21/request-1/reasoning";
    const reasoning = (phase: "start" | "content" | "end", delta?: string): void => emit(3, "reasoning/event", {
        workerId: 77, loopId: 9, turnId: 4, modelCallId: 21, requestSequence: 1, phase, ...(delta === undefined ? {} : { delta }),
    });
    const frames = (body: string): AguiEvent[] => body.split("\n\n").filter((frame) => frame.startsWith("data: ")).map((frame) => JSON.parse(frame.slice(6)) as AguiEvent);
    const endsBalanced = (events: AguiEvent[], problemType: string): void => {
        const order: string[] = events.map(({ type }) => type);
        const terminal = order.indexOf("RUN_ERROR");
        assert.equal(terminal, order.length - 1, `RUN_ERROR ends the Run: ${order.join(" ")}`);
        const problem = events.find((event) => event.type === "CUSTOM" && event.name === "plurnk.problem");
        assert.ok(problem?.type === "CUSTOM" && problem.value.type === problemType, order.join(" "));
        for (const [open, close] of [["REASONING_MESSAGE_START", "REASONING_MESSAGE_END"], ["REASONING_START", "REASONING_END"]] as const) {
            const opened = events.filter((event) => event.type === open).map((event) => (event as { messageId: string }).messageId);
            const closed = events.filter((event, index) => event.type === close && index < terminal).map((event) => (event as { messageId: string }).messageId);
            assert.deepEqual(closed, opened, `every ${open} is closed before RUN_ERROR: ${order.join(" ")}`);
        }
    };
    let closing: Promise<void> | undefined;
    try {
        const port = mod.address().port;
        const [revoked, kept] = await Promise.all([mintAccess(port, { id: "operator", secret: "s3cret" }), mintAccess(port, { id: "operator", secret: "s3cret" })]);
        const open = async (token: string, index: number): Promise<Response> => {
            const response = await fetch(`http://127.0.0.1:${port}/agui/connect`, {
                method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}` }, signal: controllers[index]!.signal,
                body: JSON.stringify(standardInput({ threadId: `reasoning-${index}`, messages: [], forwardedProps: { plurnk: { workspace: "w" } } })),
            });
            assert.equal(response.status, 200);
            return response;
        };
        const ending = await open(revoked, 0);
        const watching = await open(kept, 1);
        reasoning("start");
        reasoning("content", "Thinking");
        const revocation = await fetch(`http://127.0.0.1:${port}/oauth/revoke`, {
            method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
            body: new URLSearchParams({ token: revoked, client_id: "operator", client_secret: "s3cret" }).toString(),
        });
        assert.equal(revocation.status, 200);
        const revokedEvents = frames(await ending.text());
        assert.ok(revokedEvents.some((event) => event.type === "REASONING_MESSAGE_START" && event.messageId === messageId), "the revoked Run was streaming the request");
        endsBalanced(revokedEvents, "https://problems.plurnk.xyz/agui/http/credential-revoked");

        const joining = await open(kept, 2);
        reasoning("content", " further");
        mod.stop();
        const bodies = Promise.all([watching.text(), joining.text()]);
        closing = mod.close();
        await waitForFixture(Promise.all([closing, bodies]).then(() => {}), () => "Runs holding open reasoning prevented module closure");
        const [watched, joined] = (await bodies).map(frames);
        assert.deepEqual(
            watched!.filter((event) => event.type === "REASONING_MESSAGE_CONTENT").map((event) => (event as { delta: string }).delta),
            ["Thinking", " further"],
            "the request streams on to the Run still observing it",
        );
        endsBalanced(watched!, "https://problems.plurnk.xyz/agui/http/service-stopping");
        assert.ok(!joined!.some(({ type }) => type.startsWith("REASONING_")), "a Run that joined mid-request presents none of it");
        endsBalanced(joined!, "https://problems.plurnk.xyz/agui/http/service-stopping");
        assert.deepEqual(cancellations, [], "ending an observing Run cancels no worker");
    } finally {
        for (const controller of controllers) controller.abort();
        await (closing ?? mod.close());
    }
});
