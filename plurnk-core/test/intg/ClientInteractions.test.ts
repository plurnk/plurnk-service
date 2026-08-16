import test from "node:test";
import assert from "node:assert/strict";
import type {
    ClientInteractionPendingEvent,
} from "../../src/core/ClientInteractions.ts";
import ClientInteractions from "../../src/core/ClientInteractions.ts";
import { openMigrated, seedEnvelope } from "./_helpers.ts";

const request = {
    toolName: "choose_repository",
    arguments: { owner: "plurnk" },
    message: "Choose the repository to inspect.",
    responseSchema: {
        type: "object",
        properties: { repository: { type: "string" } },
        required: ["repository"],
        additionalProperties: false,
    },
} as const;

test("{§client-interactions}: a pending request is durable, projected, resolved once, then removed", async (t) => {
    const db = await openMigrated();
    t.after(() => db.close());
    const ids = await seedEnvelope(db, `interaction-${crypto.randomUUID()}`);
    const interactions = new ClientInteractions(db);
    const observed = Promise.withResolvers<ClientInteractionPendingEvent>();
    interactions.onPending(observed.resolve);

    const awaiting = interactions.request(request, ids);
    const pending = await observed.promise;

    assert.deepEqual(pending, {
        interactionId: pending.interactionId,
        ...ids,
        request,
    });
    assert.deepEqual(await interactions.list(ids.workspaceId), [{
        interactionId: pending.interactionId,
        workerId: ids.workerId,
        loopId: ids.loopId,
        turnId: ids.turnId,
        request,
    }]);

    await interactions.resolve(pending.interactionId, {
        status: "resolved",
        payload: { repository: "plurnk-service" },
    });
    assert.deepEqual(await awaiting, {
        status: "resolved",
        payload: { repository: "plurnk-service" },
    });
    assert.deepEqual(await interactions.list(ids.workspaceId), []);
    await assert.rejects(
        interactions.resolve(pending.interactionId, { status: "cancelled" }),
        /Client interaction .* is not pending/,
    );
});

test("{§client-interactions}: owner cancellation removes the durable request and rejects its waiter", async (t) => {
    const db = await openMigrated();
    t.after(() => db.close());
    const ids = await seedEnvelope(db, `interaction-abort-${crypto.randomUUID()}`);
    const interactions = new ClientInteractions(db);
    const observed = Promise.withResolvers<ClientInteractionPendingEvent>();
    interactions.onPending(observed.resolve);
    const controller = new AbortController();

    const awaiting = interactions.request(request, ids, controller.signal);
    await observed.promise;
    const reason = new Error("owning operation stopped");
    controller.abort(reason);

    await assert.rejects(awaiting, (error: unknown) => error === reason);
    assert.deepEqual(await interactions.list(ids.workspaceId), []);
});

test("{§client-interactions}: insertion requires one exact workspace/worker/loop/turn ownership chain", async (t) => {
    const db = await openMigrated();
    t.after(() => db.close());
    const first = await seedEnvelope(db, `interaction-owner-a-${crypto.randomUUID()}`);
    const second = await seedEnvelope(db, `interaction-owner-b-${crypto.randomUUID()}`);
    const interactions = new ClientInteractions(db);

    await assert.rejects(
        interactions.request(request, { ...first, workspaceId: second.workspaceId }),
        /coordinates do not identify one operation/,
    );
    assert.deepEqual(await db.client_interaction_list.all({ workspace_id: first.workspaceId }), []);
    assert.deepEqual(await db.client_interaction_list.all({ workspace_id: second.workspaceId }), []);
});

test("{§client-interactions}: boot recovery removes a request whose process-local owner vanished", async (t) => {
    const db = await openMigrated();
    t.after(() => db.close());
    const ids = await seedEnvelope(db, `interaction-recovery-${crypto.randomUUID()}`);
    const inserted = await db.client_interaction_insert.get({
        workspace_id: ids.workspaceId,
        worker_id: ids.workerId,
        loop_id: ids.loopId,
        turn_id: ids.turnId,
        request: JSON.stringify(request),
    });
    assert.ok(inserted !== undefined);

    await db.recovery_remove_ownerless_client_interactions.run();

    assert.deepEqual(await db.client_interaction_list.all({ workspace_id: ids.workspaceId }), []);
});
