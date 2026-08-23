import assert from "node:assert/strict";
import test from "node:test";
import {
    A2a,
    Module as A2aModule,
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
        workspaceId: agentWorkspace.workspaceId,
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
