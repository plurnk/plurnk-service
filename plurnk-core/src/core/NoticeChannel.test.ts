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

    channel.push(1, 2, notice);

    assert.deepEqual(broadcasts, [{ loopId: 2, notice }]);
    assert.deepEqual(channel.drain(2), [notice]);
    assert.deepEqual(channel.drain(2), []);
});

test("NoticeChannel rejects a malformed observation before fan-out", () => {
    const broadcasts: unknown[] = [];
    const channel = new NoticeChannel({
        notify: (_workspaceId, payload) => broadcasts.push(payload),
    });

    assert.throws(
        () => channel.push(1, 2, {
            source: "engine:turn",
            kind: "turn_awaiting_model",
        } as never),
        /invalid Notice/,
    );
    assert.deepEqual(broadcasts, []);
});
