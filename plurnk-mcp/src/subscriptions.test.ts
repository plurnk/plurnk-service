import assert from "node:assert/strict";
import test from "node:test";
import type { Client, McpSubscription, SubscriptionFilter } from "@modelcontextprotocol/client";
import Subscriptions from "./subscriptions.ts";

interface FakeListenCall {
    readonly filter: SubscriptionFilter & { readonly taskIds?: string[] };
    closed: boolean;
}

const createFakeClient = (capabilities: {
    readonly resourcesSubscribe?: boolean;
    readonly resourcesListChanged?: boolean;
    readonly toolsListChanged?: boolean;
}) => {
    const calls: FakeListenCall[] = [];
    const client = {
        autoOpenedSubscription: undefined,
        getDiscoverResult: () => ({
            capabilities: {
                ...(capabilities.toolsListChanged ? { tools: { listChanged: true } } : {}),
                ...(capabilities.resourcesSubscribe || capabilities.resourcesListChanged
                    ? {
                          resources: {
                              ...(capabilities.resourcesSubscribe ? { subscribe: true } : {}),
                              ...(capabilities.resourcesListChanged ? { listChanged: true } : {}),
                          },
                      }
                    : {}),
            },
        }),
        listen: async (filter: SubscriptionFilter & { readonly taskIds?: string[] }): Promise<McpSubscription> => {
            let resolveClosed!: (reason: "local" | "remote") => void;
            const closedPromise = new Promise<"local" | "remote">((resolve) => {
                resolveClosed = resolve;
            });
            const record: FakeListenCall = { filter, closed: false };
            calls.push(record);
            return {
                honoredFilter: filter,
                closed: closedPromise,
                close: async () => {
                    if (!record.closed) {
                        record.closed = true;
                        resolveClosed("local");
                    }
                },
            };
        },
    } as unknown as Client;
    return { client, calls };
};

const flushSubscriptions = async (): Promise<void> => {
    for (let i = 0; i < 6; i += 1) {
        await new Promise<void>((resolve) => queueMicrotask(resolve));
    }
};

test("{§mcp-subscriptions} selectResource release handles and deselectResource maintain reference-counted resource filters and clean teardown", async () => {
    const { client, calls } = createFakeClient({ resourcesSubscribe: true, tasks: undefined } as {
        resourcesSubscribe: boolean;
    });
    const subs = new Subscriptions(client, {
        timeout: 5_000,
        retry: { floorMs: 50, ceilingMs: 200 },
        tasks: true,
    });

    assert.equal(subs.hasResource("fixture://a"), false);
    assert.equal(subs.deselectResource("fixture://a"), false);

    // 1. Overlapping selectResource calls on the same URI share one filter until the last handle releases
    const releaseA1 = await subs.selectResource("fixture://a");
    assert.equal(subs.hasResource("fixture://a"), true);
    assert.equal(calls.length, 1);
    assert.deepEqual(calls.at(-1)?.filter, { resourceSubscriptions: ["fixture://a"] });

    const releaseA2 = await subs.selectResource("fixture://a");
    assert.equal(calls.length, 1, "second caller reuses active URI subscription without redundant listen()");

    const releaseB = await subs.selectResource("fixture://b");
    assert.equal(calls.length, 2);
    assert.deepEqual(calls.at(-1)?.filter, { resourceSubscriptions: ["fixture://a", "fixture://b"] });
    assert.equal(calls[0]?.closed, true, "prior subscription closed after replacement");

    // Releasing first handle for fixture://a keeps fixture://a subscribed
    releaseA1();
    releaseA1(); // idempotent
    await flushSubscriptions();
    assert.equal(subs.hasResource("fixture://a"), true);
    assert.equal(calls.length, 2);

    // Releasing second handle for fixture://a drops fixture://a from filter while keeping fixture://b
    releaseA2();
    await flushSubscriptions();
    assert.equal(subs.hasResource("fixture://a"), false);
    assert.equal(calls.length, 3);
    assert.deepEqual(calls.at(-1)?.filter, { resourceSubscriptions: ["fixture://b"] });

    // Explicit deselectResource removes fixture://b and closes the underlying non-resident subscription
    assert.equal(subs.deselectResource("fixture://b"), true);
    assert.equal(subs.deselectResource("fixture://b"), false);
    await flushSubscriptions();
    assert.equal(subs.hasResource("fixture://b"), false);
    assert.equal(calls.at(-1)?.closed, true, "empty non-resident filter closes the active listen stream");

    // Subsequent releaseB() is a safe no-op
    releaseB();

    // Task selection + release symmetry before retire()
    const releaseTask = subs.selectTask("task-1");
    await flushSubscriptions();
    assert.deepEqual(calls.at(-1)?.filter, { taskIds: ["task-1"] });
    releaseTask();
    await flushSubscriptions();
    assert.equal(calls.at(-1)?.closed, true);

    await subs.retire();
    assert.equal(subs.deselectResource("fixture://a"), false);
    await assert.rejects(() => subs.selectResource("fixture://a"), /MCP subscriptions are closed/u);
    assert.throws(() => subs.selectTask("task-2"), /MCP subscriptions are closed/u);
});
