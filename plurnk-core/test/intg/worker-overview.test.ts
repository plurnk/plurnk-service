import assert from "node:assert/strict";
import test from "node:test";
import { PlurnkParser } from "@plurnk/plurnk-parser";
import { Mock, type MockResponse } from "@plurnk/plurnk-providers";
import Engine from "../../src/core/Engine.ts";
import SchemeRegistry from "../../src/core/SchemeRegistry.ts";
import MessageAbandonment from "../../src/server/MessageAbandonment.ts";
import WorkerOverview from "../../src/server/WorkerOverview.ts";
import { DEFAULT_MIMETYPES } from "./_scheme.ts";
import { insertLoop, insertWorker, insertWorkspace, openMigrated } from "./_db.ts";

const frame = (heading: string, body: string | null = null) => PlurnkParser.frame(heading, body);
const said = (...statements: string[]): MockResponse => ({ assistant: { content: statements.join("\n\n"), reasoning: null } });

// {§worker-finished-reply}: the matrix of replies that finish and replies that do not, across one worker's loops, its
// child, its fork, a bookkeeping worker and a same-named worker in another workspace.
test("{§worker-finished-reply} {§application-worker-overview} a worker's latest finished reply is its newest delivered completion", async (t) => {
    const db = await openMigrated();
    t.after(() => db.close());
    const workspaceId = await insertWorkspace(db, `overview-${crypto.randomUUID()}`);
    const alice = await insertWorker(db, workspaceId, null, "alice");
    const engine = new Engine({ db, schemes: new SchemeRegistry(), mimetypes: DEFAULT_MIMETYPES,
        injectWorker: async ({ workerId, prompt }) => {
            const loops = await db.test_fork_loops.all({ worker_id: workerId });
            const loopId = await insertLoop(db, workerId, loops.length + 1, prompt);
            return { action: "enqueued_new_loop", loopId, message: `message://fork/${loopId}` };
        } });
    const read = (scope: number | null = workspaceId, limit = 50) =>
        WorkerOverview.read(db, { workspaceId: scope, limit, excerptChars: 12, pending: async () => [], projectLabel: () => null });
    const placeOf = async (workerId: number) => (await read()).workers.find(({ id }) => id === workerId);
    const replyOf = async (workerId: number) => (await placeOf(workerId))?.reply ?? null;
    const run = async (workerId: number, loopId: number, ...turns: MockResponse[]) => {
        const provider = new Mock({ contextWindow: 100_000, responses: turns });
        for (const _turn of turns) await engine.runTurn({ provider, workspaceId, workerId, loopId, messages: [] });
    };
    const ask = async (sequence: number, source = `acp://operator/threads/alice/messages/q${sequence}`) => {
        const loopId = await insertLoop(db, alice, sequence);
        await engine.injectIntoLoop(loopId, `Question ${sequence}.`, [], source);
        return loopId;
    };

    assert.equal(await replyOf(alice), null, "a worker that never answered has no finished reply");
    await run(alice, await ask(1), said(frame("SEND", "Still working on it.")));
    assert.equal(await replyOf(alice), null, "a progress reply finishes nothing");
    const first = await ask(2);
    await run(alice, first, said(frame("SEND [200]", "First answer, in full.\nWith detail.")));
    const answered = await replyOf(alice);
    assert.deepEqual([answered?.completion, answered?.excerpt, answered?.continued, answered?.coordinate.split("/")[0]], [200, "First answer", true, "2"],
        "a completion reply finishes, its excerpt cut to the setting");
    assert.ok(typeof answered?.at === "number" && answered.at > 0, "its stamp is Unix milliseconds");
    await run(alice, await ask(3), said(frame("SEND [499]", "Stopped: the input is missing.")));
    const cancelled = await replyOf(alice);
    assert.deepEqual([cancelled?.completion, cancelled?.excerpt], [499, "Stopped: the"], "a cancelling reply finishes too");
    assert.ok((cancelled?.id ?? 0) > (answered?.id ?? 0));
    await run(alice, await ask(4), said(frame("SEND [200]"), frame("SEND [200]", "Speech after the completion.")));
    const empty = await replyOf(alice);
    assert.deepEqual([empty?.completion, empty?.excerpt, empty?.continued], [200, "", false],
        "an empty completion is the latest finished reply, and speech that completed nothing never replaces it");
    await run(alice, await ask(5), said(frame("SEND (acp://operator/threads/alice/messages/missing) [200]", "Lost.")));
    assert.equal((await replyOf(alice))?.id, empty?.id, "a failed delivery finishes nothing");
    // {§message-abandonment}: a message another worker sent, left open by a loop that ended.
    const abandoned = await ask(6, "worker://boss");
    assert.equal(await MessageAbandonment.complete(engine, db, workspaceId, alice, abandoned, 499), 1, "the daemon answers the abandoned message");
    const after = await placeOf(alice);
    assert.equal(after?.reply?.id, empty?.id, "the daemon's own 499 is not the model's reply");
    assert.notEqual(after?.lifecycle, "completed", "the lifecycle is the newest loop's, whatever the latest reply");

    const scout = await insertWorker(db, workspaceId, alice, "scout");
    await run(scout, await insertLoop(db, scout, 1, "Scout the field."), said(frame("SEND [200]", "Scouted.")));
    assert.deepEqual([(await replyOf(scout))?.excerpt, (await replyOf(alice))?.id], ["Scouted.", empty?.id], "a child's reply is the child's");
    await run(alice, await ask(7), said(frame("FORK (worker://twin)", "Carry on from here.")));
    const twin = (await read()).workers.find(({ name }) => name === "twin");
    assert.deepEqual([twin?.kind, twin?.reply], ["fork", null], "a fork's copied history holds no reply of its own");
    await insertWorker(db, workspaceId, null, `_bookkeeping-${crypto.randomUUID()}`, "_plurnk");
    const other = await insertWorkspace(db, `overview-other-${crypto.randomUUID()}`);
    const namesake = await insertWorker(db, other, null, "alice");

    const scoped = await read();
    assert.deepEqual(new Set(scoped.workers.map(({ name }) => name)), new Set(["alice", "scout", "twin"]), "places only, and only the workspace's");
    assert.deepEqual(scoped.workspaces.map(({ id }) => id), [workspaceId]);
    const daemon = await read(null);
    const ours = daemon.workers.filter(({ id }) => [alice, scout, twin?.id, namesake].includes(id));
    assert.deepEqual(ours.map(({ id }) => id), [scout, alice, ...[twin?.id ?? 0, namesake].toSorted((a, b) => b - a)],
        "the daemon's places, most recently finished first, then the rest newest first");
    assert.deepEqual(daemon.workers.filter(({ name }) => name === "alice").map(({ workspaceId: owner }) => owner).toSorted((a, b) => a - b), [workspaceId, other].toSorted((a, b) => a - b),
        "a same-named worker in another workspace is a place of its own");
    assert.equal((await read(workspaceId, 1)).omitted, 2, "the bound counts what it leaves out");
    // {§acp-status-descendants} The gates a place waits on, as the status tree counts them: such a place is held past the bound.
    const twinId = twin?.id ?? 0;
    const gated = await WorkerOverview.read(db, { workspaceId, limit: 1, excerptChars: 12, projectLabel: () => null,
        pending: async () => [{ workerId: twinId }, { workerId: twinId }] });
    assert.deepEqual([gated.workers.map(({ id, gates }) => [id, gates]), gated.omitted], [[[scout, 0], [twinId, 2]], 1],
        "the first in order, and every place waiting on a gate, with its gates");
});
