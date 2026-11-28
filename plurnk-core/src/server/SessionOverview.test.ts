import test from "node:test";
import assert from "node:assert/strict";
import SessionOverview from "./SessionOverview.ts";

test("{§application-session-observation} places are held most recently finished first, then newest, every active or gated place past the bound", () => {
    const places = [
        { id: 1, replyId: 10, lifecycle: "completed" as const },
        { id: 2, replyId: null, lifecycle: "idle" as const },
        { id: 3, replyId: 30, lifecycle: "completed" as const },
        { id: 4, replyId: null, lifecycle: "idle" as const },
        { id: 5, replyId: 20, lifecycle: "completed" as const },
    ];
    const hold = (limit: number, gates: ReadonlyMap<number, number> = new Map()): [number[], number] => {
        const { held, omitted } = SessionOverview.hold(places, gates, limit);
        return [held.map(({ id }) => id), omitted];
    };
    assert.deepEqual(hold(10), [[3, 5, 1, 4, 2], 0], "finished replies newest first, then the places without one, newest first");
    assert.deepEqual(hold(2), [[3, 5], 3], "the bound holds the first in that order and counts the rest");
    assert.deepEqual(hold(2, new Map([[2, 1]])), [[3, 5, 2], 2], "a place waiting on a gate is held past the bound, at its place in the order");
    assert.deepEqual(hold(1, new Map([[3, 2]])), [[3], 4], "a gated place within the bound is held once");
    assert.deepEqual(
        SessionOverview.hold(
            [
                { id: 1, replyId: 30, lifecycle: "completed" },
                { id: 2, replyId: 20, lifecycle: "completed" },
                { id: 6, replyId: null, lifecycle: "running" },
                { id: 5, replyId: null, lifecycle: "parked" },
                { id: 4, replyId: null, lifecycle: "queued" },
                { id: 3, replyId: null, lifecycle: "idle" },
            ],
            new Map(),
            1,
        ),
        {
            held: [
                { id: 1, replyId: 30, lifecycle: "completed" },
                { id: 6, replyId: null, lifecycle: "running" },
                { id: 5, replyId: null, lifecycle: "parked" },
                { id: 4, replyId: null, lifecycle: "queued" },
            ],
            omitted: 2,
        },
        "running, parked, and queued places are held past the bound while completed and idle places past the bound are omitted",
    );
    assert.deepEqual(SessionOverview.hold([], new Map(), 5), { held: [], omitted: 0 }, "an empty scope");
});
