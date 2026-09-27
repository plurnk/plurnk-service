// {§notifications-outside-event}: one admitted emission's text outside every operation broadcasts
// once, verbatim, to the clients attached to the loop's workspace and to no other.

import test from "node:test";
import assert from "node:assert/strict";
import { rpcCall, subscribeNotifications, flush, connect, withDaemon } from "./_rpc.ts";

test("{§notifications-outside-event} notifyOutsideEvent broadcasts the exact payload to the loop's workspace only", async () => {
    await withDaemon(null, async (_db, daemon, addr) => {
        const wsA = await connect(addr);
        const wsB = await connect(addr);
        try {
            const workspaceA = ((await rpcCall(wsA, 1, "workspace.create", { name: "outside-A" })).result as { id: number }).id;
            await rpcCall(wsB, 1, "workspace.create", { name: "outside-B" });
            const aEvents = subscribeNotifications(wsA, "outside/event");
            const bEvents = subscribeNotifications(wsB, "outside/event");
            const event = { workerId: 7, loopId: 42, turnId: 9, coordinate: "alice-1-3", text: "Thinking out loud.", tokens: 9 };
            daemon.notifyOutsideEvent(workspaceA, event);
            await flush();
            // {§notifications-envelope-carries-workspaceid}: the envelope stamps the scope; the payload is otherwise exact.
            assert.deepEqual(aEvents(), [{ ...event, workspaceId: workspaceA }], "the payload arrives once, exactly as emitted");
            assert.deepEqual(bEvents(), [], "another workspace's client sees nothing");
        } finally { wsA.close(); wsB.close(); }
    });
});
