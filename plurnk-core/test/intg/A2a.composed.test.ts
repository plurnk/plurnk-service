import assert from "node:assert/strict";
import test from "node:test";
import {
    A2a,
    Module as A2aModule,
    OutboundModule as A2aOutboundModule,
    connectHttpJsonAgent,
} from "@plurnk/plurnk-a2a";
import {
    Validator,
    type OperationResult,
} from "@plurnk/plurnk-contracts";
import { Mock } from "@plurnk/plurnk-providers";
import Daemon from "../../src/server/Daemon.ts";
import { a2aCard } from "./_a2a.ts";
import { openMigrated } from "./_helpers.ts";
import { makeMockResponse } from "./_rpc.ts";

class WorkspaceRoutedMock extends Mock {
    readonly #routes = new Map<string, Mock>();

    constructor() {
        super({ contextWindow: 100_000, responses: [] });
    }

    bind(workspaceId: number, provider: Mock): void {
        const key = String(workspaceId);
        if (this.#routes.has(key)) throw new Error(`duplicate mock route for workspace ${workspaceId}`);
        this.#routes.set(key, provider);
    }

    override generate(
        args: Parameters<Mock["generate"]>[0],
    ): ReturnType<Mock["generate"]> {
        const provider = args.workspaceId === undefined ? undefined : this.#routes.get(args.workspaceId);
        if (provider === undefined) throw new Error(`no mock provider route for workspace ${args.workspaceId}`);
        return provider.generate(args);
    }
}

test("{§a2a-inbound-exposure}{§a2a-outbound-resources}: two Plurnk daemons complete one delegated A2A Task", async () => {
    const [callerDb, agentDb] = await Promise.all([openMigrated(), openMigrated()]);
    const callerProvider = new Mock({
        contextWindow: 100_000,
        responses: [
            makeMockResponse([
                "# PLAN0",
                '[{"content":"Delegate the comparison to the configured remote agent.","status":"in_progress"}]',
                "## SEND0 [200] (a2a://remote)",
                "Compare mangoes and pineapples in one concise sentence.",
            ].join("\n")),
            makeMockResponse("## SEND0 [202]\nWaiting for the remote A2A Task."),
            makeMockResponse("## SEND0 [200]\nMangoes are drupes; pineapples are aggregate fruits."),
        ],
    });
    const agentProvider = new Mock({
        contextWindow: 100_000,
        responses: [
            makeMockResponse("## SEND0 [200]\nMangoes are drupes; pineapples are aggregate fruits."),
        ],
    });
    const routedProvider = new WorkspaceRoutedMock();
    const caller = new Daemon({ db: callerDb, provider: routedProvider });
    const agent = new Daemon({ db: agentDb, provider: routedProvider });
    const callerWorkspace = await caller.createWorkspace({
        name: `a2a-caller-${crypto.randomUUID()}`,
        projectRoot: null,
    });
    await agent.createWorkspace({
        name: `a2a-unrelated-${crypto.randomUUID()}`,
        projectRoot: null,
    });
    const agentWorkspace = await agent.createWorkspace({
        name: `a2a-agent-${crypto.randomUUID()}`,
        projectRoot: null,
    });
    routedProvider.bind(callerWorkspace.workspaceId, callerProvider);
    routedProvider.bind(agentWorkspace.workspaceId, agentProvider);
    const exposure = A2aModule.init({
        workspace: {
            name: agentWorkspace.workspaceName,
            projectRoot: agentWorkspace.projectRoot,
        },
        card: a2aCard(),
        host: "127.0.0.1",
        port: 0,
    });
    let listener: A2aModule | null = null;
    agent.registerModule({
        start: async (port) => {
            listener = await exposure.start(port);
            return listener;
        },
    });

    let unsubscribe: (() => void) | null = null;
    try {
        await agent.start();
        assert.ok(listener !== null);
        const address = (listener as A2aModule).address();
        const agentUrl = `http://${address.host}:${address.port}`;
        await caller.registerScheme("a2a", new A2a(async (authority) =>
            authority === "remote" ? await connectHttpJsonAgent(agentUrl) : null));
        await caller.start();
        const worker = await caller.createConversationWorker({
            workspaceId: callerWorkspace.workspaceId,
            name: crypto.randomUUID(),
        });
        const terminal = Promise.withResolvers<OperationResult>();
        unsubscribe = caller.subscribeToEvents((workspaceId, method, params) => {
            if (
                workspaceId !== callerWorkspace.workspaceId
                || method !== "loop/terminated"
                || typeof params !== "object"
                || params === null
                || (params as { workerId?: unknown }).workerId !== worker.workerId
            ) return;
            terminal.resolve(Validator.assertOperationResult(
                (params as { result: OperationResult }).result,
            ));
        });

        await caller.runLoop({
            workspaceId: callerWorkspace.workspaceId,
            workerId: worker.workerId,
            prompt: "Delegate the fruit comparison to the remote agent, then return its result.",
        });
        assert.deepEqual(await terminal.promise, {
            status: 200,
            content: "Mangoes are drupes; pineapples are aggregate fruits.",
            mimetype: "text/markdown",
        });

        const callerLog = await caller.readLog({
            workspaceId: callerWorkspace.workspaceId,
            workerId: worker.workerId,
            limit: 1_000,
        });
        const delegated = callerLog.find((row) => row.op === "SEND" && row.scheme === "a2a");
        assert.ok(delegated, `caller log omitted its A2A SEND: ${JSON.stringify(callerLog)}`);
        assert.equal(delegated.hostname, "remote");
        const conclusion = callerLog.find((row) =>
            row.op === "READ"
            && row.scheme === "a2a"
            && typeof row.pathname === "string"
            && row.pathname.startsWith("/tasks/"));
        assert.ok(conclusion, `caller log omitted its A2A conclusion: ${JSON.stringify(callerLog)}`);
        assert.equal(conclusion.hostname, "remote");

        const agentRoots = await agent.listWorkers(agentWorkspace.workspaceId, {
            origin: "model",
            parentWorkerId: null,
        });
        assert.equal(agentRoots.length, 1, "the remote A2A Context is one root Worker");
        const agentTasks = await agent.listWorkers(agentWorkspace.workspaceId, {
            origin: "model",
            parentWorkerId: agentRoots[0]!.id,
        });
        assert.equal(agentTasks.length, 1, "the remote A2A Task is one child Worker");
        assert.equal(callerProvider.remaining, 0);
        assert.equal(agentProvider.remaining, 0);
    } finally {
        unsubscribe?.();
        await Promise.allSettled([caller.stop(), agent.stop()]);
        await Promise.all([callerDb.close(), agentDb.close()]);
    }
});

// {§a2a-agents-functionality} {§a2a-agents-catalog} — the production composed
// path: the caller attaches the peer service through its environment and the
// Worker `agents` family (no injected resolver), delegates twice, and the
// composition respects both the Context/Task ↔ Worker mapping on the hosted
// side and topology-scoped ambience on the calling side.
test("composed production path: env-attached agent, two delegated Tasks, topology-scoped ambience", async () => {
    const [callerDb, agentDb] = await Promise.all([openMigrated(), openMigrated()]);
    const delegate = (fruit: string) => makeMockResponse([
        "# PLAN0",
        '[{"content":"Delegate the comparison to the configured remote agent.","status":"in_progress"}]',
        "## SEND0 [200] (a2a://remote)",
        `Compare ${fruit} in one concise sentence.`,
    ].join("\n"));
    const callerProvider = new Mock({
        contextWindow: 100_000,
        responses: [
            delegate("mangoes and pineapples"),
            makeMockResponse("## SEND0 [202]\nWaiting for the remote A2A Task."),
            makeMockResponse("## SEND0 [200]\nFirst delegation done."),
            delegate("plums and cherries"),
            makeMockResponse("## SEND0 [202]\nWaiting for the second remote A2A Task."),
            makeMockResponse("## SEND0 [200]\nSecond delegation done."),
            makeMockResponse("## SEND0 [200]\nBystander observed nothing remote."),
        ],
    });
    const agentProvider = new Mock({
        contextWindow: 100_000,
        responses: [
            makeMockResponse("## SEND0 [200]\nMangoes are drupes; pineapples are aggregate fruits."),
            makeMockResponse("## SEND0 [200]\nPlums and cherries are both drupes."),
        ],
    });
    const routedProvider = new WorkspaceRoutedMock();
    const agent = new Daemon({ db: agentDb, provider: routedProvider });
    const unrelatedWorkspace = await agent.createWorkspace({
        name: `a2a-unrelated-${crypto.randomUUID()}`,
        projectRoot: null,
    });
    const agentWorkspace = await agent.createWorkspace({
        name: `a2a-agent-${crypto.randomUUID()}`,
        projectRoot: null,
    });
    routedProvider.bind(agentWorkspace.workspaceId, agentProvider);
    const exposure = A2aModule.init({
        workspace: {
            name: agentWorkspace.workspaceName,
            projectRoot: agentWorkspace.projectRoot,
        },
        card: a2aCard(),
        host: "127.0.0.1",
        port: 0,
    });
    let listener: A2aModule | null = null;
    agent.registerModule({
        start: async (port) => {
            listener = await exposure.start(port);
            return listener;
        },
    });

    let caller: Daemon | null = null;
    let unsubscribe: (() => void) | null = null;
    try {
        await agent.start();
        assert.ok(listener !== null);
        const address = (listener as A2aModule).address();
        const agentUrl = `http://${address.host}:${address.port}`;

        // The production attachment: the environment defines the peer; the
        // Worker `agents` family owns availability, enablement, and resolution.
        caller = new Daemon({ db: callerDb, provider: routedProvider });
        caller.registerModule(A2aOutboundModule.init({
            PLURNK_A2A_REMOTE: agentUrl,
            PLURNK_A2A_ENABLED: '["remote"]',
        }));
        await caller.start();
        const callerWorkspace = await caller.createWorkspace({
            name: `a2a-caller-${crypto.randomUUID()}`,
            projectRoot: null,
        });
        routedProvider.bind(callerWorkspace.workspaceId, callerProvider);
        const worker = await caller.createConversationWorker({
            workspaceId: callerWorkspace.workspaceId,
            name: "delegator",
        });
        const bystander = await caller.createConversationWorker({
            workspaceId: callerWorkspace.workspaceId,
            name: "bystander",
        });
        const listed = await caller.invokeModuleAction("worker.agents.list", {}, {
            scope: "worker",
            workspaceId: callerWorkspace.workspaceId,
            workerId: worker.workerId,
        }) as { definitions: Array<{ alias: string; origin: string; state: string }> };
        assert.deepEqual(
            listed.definitions.map(({ alias, origin, state }) => `${alias}:${origin}:${state}`),
            ["remote:service:active"],
            "the environment definition is the Worker's active service baseline",
        );

        const terminals: OperationResult[] = [];
        let arrival = Promise.withResolvers<void>();
        unsubscribe = caller.subscribeToEvents((workspaceId, method, params) => {
            if (workspaceId !== callerWorkspace.workspaceId || method !== "loop/terminated") return;
            terminals.push(Validator.assertOperationResult((params as { result: OperationResult }).result));
            arrival.resolve();
        });
        const runToTerminal = async (workerId: number, prompt: string): Promise<OperationResult> => {
            const expected = terminals.length + 1;
            arrival = Promise.withResolvers<void>();
            await caller!.runLoop({ workspaceId: callerWorkspace.workspaceId, workerId, prompt });
            while (terminals.length < expected) {
                arrival = Promise.withResolvers<void>();
                await arrival.promise;
            }
            return terminals[expected - 1]!;
        };

        assert.deepEqual(await runToTerminal(worker.workerId, "Delegate the first fruit comparison."), {
            status: 200,
            content: "First delegation done.",
            mimetype: "text/markdown",
        });
        assert.deepEqual(await runToTerminal(worker.workerId, "Delegate the second fruit comparison."), {
            status: 200,
            content: "Second delegation done.",
            mimetype: "text/markdown",
        });

        // Each delegation is one remote Context (a root Worker) holding exactly
        // one Task (a child Worker); nothing lands in the unrelated workspace.
        const contexts = await agent.listWorkers(agentWorkspace.workspaceId, { origin: "model", parentWorkerId: null });
        assert.equal(contexts.length, 2, "two delegations are two remote A2A Contexts");
        for (const context of contexts) {
            const tasks = await agent.listWorkers(agentWorkspace.workspaceId, { origin: "model", parentWorkerId: context.id });
            assert.equal(tasks.length, 1, "each remote Context supervises exactly one Task Worker");
        }
        assert.deepEqual(await agent.listWorkers(unrelatedWorkspace.workspaceId, { origin: "model" }), [], "hosted execution never leaks into an unrelated workspace");

        // Topology-scoped ambience on the calling side: an independent root in
        // the same workspace, running after both delegations, materializes no
        // delegation activity — worker-private a2a resources are not commons.
        assert.equal((await runToTerminal(bystander.workerId, "Report what you observed.")).status, 200);
        const bystanderRows = await callerDb.engine_render_log.all<{ scheme: string | null; origin: string; source: string | null }>({ worker_id: bystander.workerId });
        assert.deepEqual(bystanderRows.filter(({ scheme }) => scheme === "a2a"), [], "an independent root sees none of the delegation's a2a resources");
        assert.deepEqual(bystanderRows.filter(({ origin, source }) => origin === "_plurnk" && source === "worker://delegator"), [], "an independent root receives no lineage activity from the delegator");

        // The delegator's own log carries both exact protocol journeys.
        const callerLog = await caller.readLog({ workspaceId: callerWorkspace.workspaceId, workerId: worker.workerId, limit: 1_000 });
        assert.equal(callerLog.filter((row) => row.op === "SEND" && row.scheme === "a2a" && row.hostname === "remote").length, 2, "both delegations are exact a2a SENDs");
        assert.equal(callerLog.filter((row) => row.op === "READ" && row.scheme === "a2a" && typeof row.pathname === "string" && row.pathname.startsWith("/tasks/")).length, 2, "both Task conclusions arrive as exact terminal READs");
        assert.equal(callerProvider.remaining, 0);
        assert.equal(agentProvider.remaining, 0);
    } finally {
        unsubscribe?.();
        await Promise.allSettled([caller?.stop() ?? Promise.resolve(), agent.stop()]);
        await Promise.all([callerDb.close(), agentDb.close()]);
    }
});
