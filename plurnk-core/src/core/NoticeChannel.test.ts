import test from "node:test";
import assert from "node:assert/strict";
import NoticeChannel from "./NoticeChannel.ts";

test("NoticeChannel validates, broadcasts, and drains one transient observation", () => {
    const broadcasts: unknown[] = [];
    const channel = new NoticeChannel({
        notify: (_workspaceId, payload) => broadcasts.push(payload),
    });
    const notice = {
        source: "engine:turn",
        kind: "turn_awaiting_model",
        level: "info" as const,
        message: "awaiting model response",
    };

    channel.push(1, 3, 2, notice);

    assert.deepEqual(broadcasts, [{ workerId: 3, loopId: 2, notice }]);
    assert.deepEqual(channel.drain(2), [notice]);
    assert.deepEqual(channel.drain(2), []);
});

test("NoticeChannel rejects a malformed observation before fan-out", () => {
    const broadcasts: unknown[] = [];
    const channel = new NoticeChannel({
        notify: (_workspaceId, payload) => broadcasts.push(payload),
    });

    assert.throws(
        () => channel.push(1, 3, 2, {
            source: "engine:turn",
            kind: "turn_awaiting_model",
        } as never),
        /invalid Notice/,
    );
    assert.deepEqual(broadcasts, []);
});

test("NoticeChannel broadcasts derivation progress live but retains only its current state", () => {
    const broadcasts: unknown[] = [];
    const channel = new NoticeChannel({
        notify: (_workspaceId, payload) => broadcasts.push(payload),
    });
    const preparing = {
        source: "engine:derivation",
        kind: "embed_progress",
        phase: "preparing",
        completed: 0,
        total: 10,
        percent: 0,
        level: "info" as const,
    };
    const indexing = { ...preparing, phase: "indexing", completed: 4, percent: 40 };
    const complete = { ...preparing, phase: "complete", completed: 10, percent: 100 };

    channel.push(1, 3, 2, preparing);
    channel.push(1, 3, 2, indexing);
    channel.push(1, 3, 2, complete);

    assert.equal(broadcasts.length, 3, "each live state remains observable to attached clients");
    assert.deepEqual(channel.drain(2), [complete], "the next model packet receives state, not progress history");
});

test("NoticeChannel broadcasts every provider checkpoint but buffers only its current state", () => {
    const broadcasts: unknown[] = [];
    const channel = new NoticeChannel({
        notify: (_workspaceId, payload) => broadcasts.push(payload),
    });
    const retrying = {
        source: "engine:provider",
        kind: "provider_unavailable",
        level: "warn" as const,
        message: "Network failure: retrying in 5s.",
    };
    const stillRetrying = { ...retrying, message: "Network failure: retrying in 10s." };
    const parked = { ...retrying, level: "error" as const, message: "Network failure: the recovery budget is spent; the loop is parked." };

    channel.push(1, 3, 2, retrying);
    channel.push(1, 3, 2, stillRetrying);
    channel.push(1, 3, 2, parked);

    assert.equal(broadcasts.length, 3, "attached clients observe every checkpoint live");
    assert.deepEqual(channel.drain(2), [parked], "the next model packet receives only the terminal provider state");

    const recovered = {
        source: "engine:provider",
        kind: "provider_recovered",
        level: "info" as const,
        message: "Provider recovered after 2 failed calls.",
    };
    channel.push(1, 3, 2, retrying);
    channel.push(1, 3, 2, recovered);
    assert.deepEqual(channel.drain(2), [recovered], "recovery supersedes the stale unavailable state");
});
