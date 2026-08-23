import assert from "node:assert/strict";
import test from "node:test";
import { Mock } from "@plurnk/plurnk-providers";
import { makeMockResponse, waitFor, withDaemon } from "./_rpc.ts";

test("{§methods-worker-read}{§methods-worker-list}{§methods-worker-loops}: exterior adapters observe exact topology and durable loop state", async () => {
    const provider = new Mock({
        contextWindow: 16_384,
        responses: [makeMockResponse("## SEND0 [200]\ncomposed result", 10)],
    });

    await withDaemon(provider, async (_db, daemon) => {
        const workspace = await daemon.createWorkspace({
            name: `application-topology-${crypto.randomUUID()}`,
            projectRoot: null,
        });
        const contextId = crypto.randomUUID();
        const taskId = crypto.randomUUID();
        const context = await daemon.createConversationWorker({
            workspaceId: workspace.workspaceId,
            name: contextId,
        });
        assert.deepEqual(
            await daemon.readWorker({ workspaceId: workspace.workspaceId, identity: { name: taskId } }),
            null,
            "an absent exact lookup is singular and explicit",
        );
        const task = await daemon.forkWorker({
            workspaceId: workspace.workspaceId,
            workerId: context.workerId,
            name: taskId,
        });
        assert.equal(
            (await daemon.readWorker({ workspaceId: workspace.workspaceId, identity: { id: task.workerId } }))?.name,
            taskId,
        );

        const roots = await daemon.listWorkers(workspace.workspaceId, {
            origin: "model",
            parentWorkerId: null,
        });
        const projectedContext = roots.find(({ id }) => id === context.workerId);
        assert.ok(projectedContext);
        assert.deepEqual(projectedContext, {
            id: context.workerId,
            name: contextId,
            created_at: projectedContext.created_at,
            origin: "model",
            parentWorkerId: null,
        });
        assert.equal(typeof projectedContext.created_at, "string");
        // {§methods-worker-list} — an omitted parent filter returns every lineage
        // position; the child is listed beside its root, not hidden behind it.
        const everyPosition = await daemon.listWorkers(workspace.workspaceId, { origin: "model" });
        assert.deepEqual(
            everyPosition.map(({ id }) => id).toSorted((left, right) => left - right),
            [context.workerId, task.workerId].toSorted((left, right) => left - right),
        );
        assert.ok(
            (await daemon.listWorkers(workspace.workspaceId)).some(({ id }) => id === task.workerId),
            "a query-less listing includes the child",
        );
        const children = await daemon.listWorkers(workspace.workspaceId, {
            origin: "model",
            parentWorkerId: context.workerId,
        });
        assert.equal(children.length, 1);
        assert.deepEqual(children[0], {
            id: task.workerId,
            name: taskId,
            created_at: children[0]?.created_at,
            origin: "model",
            parentWorkerId: context.workerId,
        });

        const terminated: Array<{ loopId: number }> = [];
        const unsubscribe = daemon.subscribeToEvents((_workspaceId, method, params) => {
            if (method === "loop/terminated") terminated.push(params as { loopId: number });
        });
        try {
            const accepted = await daemon.runLoop({
                workspaceId: workspace.workspaceId,
                workerId: task.workerId,
                prompt: "produce the composed result",
                source: `a2a://peer/contexts/${contextId}/tasks/${taskId}`,
            });
            await waitFor(
                () => terminated,
                (events) => events.some(({ loopId }) => loopId === accepted.loopId),
            );

            const loops = await daemon.listWorkerLoops({
                workspaceId: workspace.workspaceId,
                workerId: task.workerId,
            });
            const own = loops.find(({ id }) => id === accepted.loopId);
            assert.deepEqual(own, {
                id: accepted.loopId,
                workerId: task.workerId,
                sequence: own?.sequence,
                status: 200,
                prompt: "produce the composed result",
                promptSource: `a2a://peer/contexts/${contextId}/tasks/${taskId}`,
                terminatedAt: own?.terminatedAt,
                terminalResult: {
                    status: 200,
                    content: "composed result",
                    mimetype: "text/markdown",
                },
            });
            assert.equal(typeof own?.terminatedAt, "string");
        } finally {
            unsubscribe();
        }
    });
});
