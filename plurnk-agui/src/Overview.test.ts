import test from "node:test";
import assert from "node:assert/strict";
import type { ApplicationOverviewWorker, ApplicationWorkerOverview } from "@plurnk/plurnk-contracts";
import Overview from "./Overview.ts";

const worker = (id: number, over: Partial<ApplicationOverviewWorker> = {}): ApplicationOverviewWorker => ({
    workspaceId: 3, id, name: `w${id}`, parentWorkerId: null, kind: "root", lifecycle: "completed", gates: 0, reply: null, ...over,
});
const reply = (id: number, excerpt = "Done.") => ({ id, coordinate: `1/1/${id}`, completion: 200 as const, at: 1_792_008_000_000, excerpt, continued: false });
const overview = (workers: ApplicationOverviewWorker[], over: Partial<ApplicationWorkerOverview> = {}): ApplicationWorkerOverview => ({
    workers, workspaces: [{ id: 3, name: "ws", projectRoot: null, projectLabel: null }], omitted: 0, ...over,
});
const state = (value: ApplicationWorkerOverview) => Overview.state(value, null, "http://daemon.test");

test("{§agui-overview-state} the state holds workspaces and workers by id, each reply's words by reference, the held workers in order", () => {
    const held = state(overview([worker(7, { reply: reply(40) }), worker(5)]));
    assert.deepEqual(Object.keys(held.workers).toSorted(), ["5", "7"], "a map by id carries no order");
    assert.deepEqual(held.recent, [7, 5], "the order travels as its own list");
    assert.deepEqual(held.workers["7"]?.reply?.body, {
        url: "http://daemon.test/agui/3/7/entry?target=log%3A%2F%2F%2F1%2F1%2F40%2FSEND", mimeType: "text/plain",
    }, "the reply's words at the entry route, read from its own worker");
    assert.equal(held.workers["5"]?.reply, null);
    assert.deepEqual([held.scope, held.omitted, Object.keys(held.workspaces)], [{ workspaceId: null }, 0, ["3"]]);
});

test("{§agui-overview-updates} a change travels as the patches that make it: added, replaced and removed by id, the order and the count replaced", () => {
    const before = state(overview([worker(7, { reply: reply(40) }), worker(5)]));
    assert.deepEqual(Overview.patches(before, before), [], "nothing changed, nothing travels");
    const after = state(overview([worker(5, { reply: reply(41, "Now.") }), worker(7, { reply: reply(40), lifecycle: "running" }), worker(9)],
        { omitted: 2, workspaces: [{ id: 3, name: "renamed", projectRoot: null, projectLabel: null }] }));
    assert.deepEqual(Overview.patches(before, after), [
        { op: "replace", path: "/plurnk/overview/workspaces/3", value: after.workspaces["3"] },
        { op: "replace", path: "/plurnk/overview/workers/5", value: after.workers["5"] },
        { op: "replace", path: "/plurnk/overview/workers/7", value: after.workers["7"] },
        { op: "add", path: "/plurnk/overview/workers/9", value: after.workers["9"] },
        { op: "replace", path: "/plurnk/overview/recent", value: [5, 7, 9] },
        { op: "replace", path: "/plurnk/overview/omitted", value: 2 },
    ]);
    const smaller = state(overview([worker(5, { reply: reply(41, "Now.") })], { workspaces: [] }));
    assert.deepEqual(Overview.patches(after, smaller).filter(({ op }) => op === "remove"), [
        { op: "remove", path: "/plurnk/overview/workspaces/3" },
        { op: "remove", path: "/plurnk/overview/workers/7" },
        { op: "remove", path: "/plurnk/overview/workers/9" },
    ], "a worker or workspace the overview no longer holds is removed");
});
