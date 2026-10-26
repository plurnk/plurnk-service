import assert from "node:assert/strict";
import test from "node:test";
import { Mock } from "@plurnk/plurnk-providers";
import { makeMockResponse } from "./_mock.ts";
import { waitFor, withDaemon } from "./_rpc.ts";
import RuntimeSession from "../../src/core/RuntimeSession.ts";

test("{§notifications-loop-packet} {§application-loop-observation} {§methods-session-read}{§methods-session-list}{§methods-session-loops}: exterior adapters observe exact topology and durable loop state", async () => {
    const provider = new Mock({
        contextWindow: 16_384,
        responses: [makeMockResponse("````SEND [200]\ncomposed result\n````", 10)],
    });

    await withDaemon(provider, async (_db, daemon) => {
        const workspace = await daemon.createWorkspace({
            name: `application-topology-${crypto.randomUUID()}`,
            projectRoot: null,
        });
        const contextId = crypto.randomUUID();
        const taskId = crypto.randomUUID();
        const context = await daemon.createSession({
            workspaceId: workspace.workspaceId,
            name: contextId,
        });
        assert.deepEqual(
            await daemon.readSession({ workspaceId: workspace.workspaceId, identity: { name: taskId } }),
            null,
            "an absent exact lookup is singular and explicit",
        );
        const task = await daemon.forkSession({
            workspaceId: workspace.workspaceId,
            sessionId: context.sessionId,
            name: taskId,
        });
        assert.equal(
            (await daemon.readSession({ workspaceId: workspace.workspaceId, identity: { id: task.sessionId } }))?.name,
            taskId,
        );

        const roots = await daemon.listSessions(workspace.workspaceId, {
            origin: "model",
            parentSessionId: null,
        });
        const projectedContext = roots.find(({ id }) => id === context.sessionId);
        assert.ok(projectedContext);
        assert.deepEqual(projectedContext, {
            id: context.sessionId,
            name: contextId,
            created_at: projectedContext.created_at,
            origin: "model",
            owner: "_plurnk",
            parentSessionId: null,
            // {§application-session-observation} — a root session with no loop yet (#523).
            kind: "root",
            lifecycle: "idle",
            // {§place-hiding} — shown.
            hidden_at: null,
        });
        assert.equal(typeof projectedContext.created_at, "string");
        // {§methods-session-list} — an omitted parent filter returns every lineage
        // position; the child is listed beside its root, not hidden behind it.
        const everyPosition = await daemon.listSessions(workspace.workspaceId, { origin: "model" });
        assert.deepEqual(
            everyPosition.map(({ id }) => id).toSorted((left, right) => left - right),
            [context.sessionId, task.sessionId].toSorted((left, right) => left - right),
        );
        assert.ok(
            (await daemon.listSessions(workspace.workspaceId)).some(({ id }) => id === task.sessionId),
            "a query-less listing includes the child",
        );
        const children = await daemon.listSessions(workspace.workspaceId, {
            origin: "model",
            parentSessionId: context.sessionId,
        });
        assert.equal(children.length, 1);
        assert.deepEqual(children[0], {
            id: task.sessionId,
            name: taskId,
            created_at: children[0]?.created_at,
            origin: "model",
            owner: "_plurnk",
            parentSessionId: context.sessionId,
            // forkSession mints a FORK child (fork boundary set); no loop has run on it yet.
            kind: "fork",
            lifecycle: "idle",
            hidden_at: null,
        });

        const terminated: Array<{ loopId: number }> = [];
        const packets: Array<{ sessionId: number; loopId: number; packetCount: number }> = [];
        const unsubscribe = daemon.subscribeToEvents((_workspaceId, method, params) => {
            if (method === "loop/terminated") terminated.push(params as { loopId: number });
            if (method === "loop/packet") packets.push(params as { sessionId: number; loopId: number; packetCount: number });
        });
        try {
            const accepted = await daemon.runLoop({
                workspaceId: workspace.workspaceId,
                sessionId: task.sessionId,
                prompt: "produce the composed result",
                source: `acp://peer/contexts/${contextId}/tasks/${taskId}`,
            });
            await waitFor(
                () => terminated,
                (events) => events.some(({ loopId }) => loopId === accepted.loopId),
            );

            const loops = await daemon.listSessionLoops({
                workspaceId: workspace.workspaceId,
                sessionId: task.sessionId,
            });
            const own = loops.find(({ id }) => id === accepted.loopId);
            assert.deepEqual(own, {
                id: accepted.loopId,
                sessionId: task.sessionId,
                sequence: own?.sequence,
                status: 200,
                prompt: "produce the composed result",
                promptSource: `acp://peer/contexts/${contextId}/tasks/${taskId}`,
                claimedAt: own?.claimedAt,
                terminatedAt: own?.terminatedAt,
                terminalResult: {
                    status: 200,
                },
                packetCount: 1,
                waitUntil: null,
                // {§session-obligations} A peer's task is no session's operation.
                invocation: null,
            });
            assert.equal(typeof own?.terminatedAt, "string");
            assert.equal(typeof own?.claimedAt, "string");
            assert.ok(Date.parse(own.claimedAt!) <= Date.parse(own.terminatedAt!), "a loop first runs before it concludes");
            const messages = await daemon.readMessages({ workspaceId: workspace.workspaceId, sessionId: task.sessionId });
            assert.deepEqual(messages.filter(({ direction }) => direction === "outbound").map(({ body }) => body), ["composed result"]);
            assert.deepEqual(packets.map(({ sessionId, loopId, packetCount }) => ({ sessionId, loopId, packetCount })),
                [{ sessionId: task.sessionId, loopId: accepted.loopId, packetCount: 1 }], "packet chronology broadcasts once when inference evidence becomes durable");
        } finally {
            unsubscribe();
        }
    });
});

test("{§methods-session-read} {§session-name-minting}: an exact read resolves every name a listing returns, the runtime session's included", async () => {
    await withDaemon(new Mock({ contextWindow: 16_384, responses: [] }), async (db, daemon) => {
        const workspace = await daemon.createWorkspace({ name: `session-read-${crypto.randomUUID()}`, projectRoot: null });
        const runtimeId = await RuntimeSession.ensure(db, workspace.workspaceId);
        const listed = (await daemon.listSessions(workspace.workspaceId)).find(({ id }) => id === runtimeId);
        assert.ok(listed !== undefined, "the listing returns the runtime session");
        const byName = await daemon.readSession({ workspaceId: workspace.workspaceId, identity: { name: listed.name } });
        assert.deepEqual(byName, await daemon.readSession({ workspaceId: workspace.workspaceId, identity: { id: runtimeId } }),
            "the listed name resolves the listed session: a lookup is no minting door");
        assert.equal(byName?.origin, "_plurnk", "and the reader sees what it is, so it can refuse to bind it");
        assert.equal(await daemon.readSession({ workspaceId: workspace.workspaceId, identity: { name: "_absent" } }), null,
            "a name no session carries is absent, not malformed");
    });
});
