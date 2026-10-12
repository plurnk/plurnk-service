import { serverProposals } from "./_approval.ts";
// {§worker-scheme-spawn} ping/pong between a parent and the worker it names: the first WORK creates the
// worker and the parent parks on it; the child's answer wakes the parent; a second WORK to the same name is
// a message to the live worker, not a second worker and not a refusal; its answer wakes the parent again.
import test from "node:test";
import assert from "node:assert/strict";
import { Mock } from "@plurnk/plurnk-providers";
import { PlurnkParser } from "@plurnk/plurnk-parser";
import type { PlurnkStatement } from "@plurnk/plurnk-contracts";
import { rpcCall, connect, withDaemon, runLoopToTerminal, subscribeNotifications, flush } from "./_rpc.ts";
import { makeMockResponse, fixtureExecutors } from "./_mock.ts";

const parseOne = (input: string): PlurnkStatement => {
    const parsed = PlurnkParser.parseStatements(input, { executors: fixtureExecutors(input) });
    const item = parsed.items.find((x) => x.kind === "statement");
    if (item?.kind !== "statement") throw new Error(`no statement parsed from ${input}`);
    return item.statement;
};

test("{§worker-scheme-spawn} ping/pong: WORK spawns a worker once, then WORK to the same name messages it; both answers reach the parent", async (approvalContext) => {
    serverProposals(approvalContext, "accept");
    // Causality orders the queue: the child cannot run before the parent names it, and the parent cannot
    // resume before the child answers, so one Mock serves both workers deterministically.
    const mock = new Mock({ contextWindow: 16384, responses: [
        makeMockResponse("````WORK (worker://pong)\nping 1\n````\n\n````WAIT\nawaiting pong\n````", 10),
        makeMockResponse("````SEND [200]\npong 1\n````", 10),
        makeMockResponse("````WORK (worker://pong)\nping 2\n````\n\n````WAIT\nawaiting pong again\n````", 10),
        makeMockResponse("````SEND [200]\npong 2\n````", 10),
        makeMockResponse("````SEND [200]\nheard pong 1 and pong 2\n````", 10),
    ] });
    await withDaemon(mock, async (db, _daemon, addr) => {
        const ws = await connect(addr);
        try {
            await rpcCall(ws, 1, "workspace.create", { name: "ping-pong" });
            const terminated = subscribeNotifications(ws, "loop/terminated");
            const { finalStatus, modelWorkerId, turnIds } = await runLoopToTerminal(ws, 2, { prompt: "play ping pong with a worker named pong, twice" });
            assert.equal(finalStatus, 200, "the parent concluded after both answers");
            assert.equal(mock.remaining, 0, "every scripted turn ran, in causal order");
            const workers = ((await rpcCall(ws, 3, "workspace.workers", {})).result as { workers: Array<{ id: number; name: string; origin: string }> }).workers;
            const pong = workers.filter((worker) => worker.name === "pong");
            assert.equal(pong.length, 1, "the second WORK addressed the existing worker and created no second one");
            assert.equal(workers.filter((worker) => worker.origin === "model").length, 2, "exactly the parent and pong");
            const childLoops = (await db.test_count_loops_by_worker.get<{ n: number }>({ worker_id: pong[0]!.id }))!.n;
            assert.equal(childLoops, 2, "the message woke pong as a second loop");
            const rows = await db.engine_render_log.all<{ op: string; status_rx: number; rx: string }>({ worker_id: modelWorkerId! });
            const works = rows.filter((row) => row.op === "WORK");
            assert.deepEqual(works.map((row) => row.status_rx), [200, 200], "both WORKs succeeded: one spawn, one message");
            assert.doesNotMatch(works[0]!.rx, /"delivered":"message"/u, "the first WORK's receipt is a spawn");
            assert.match(works[1]!.rx, /"delivered":"message"/u, "the second WORK's receipt says it was a message");
            const last = await db.test_get_packet.get<{ packet: string }>({ id: turnIds!.at(-1)! });
            assert.match(last!.packet, /pong 1/u, "the parent's final packet carries the first answer");
            assert.match(last!.packet, /pong 2/u, "and the second");
            await flush();
            const concluded = (terminated() as Array<{ result: { status: number } }>).filter((t) => t.result.status === 200);
            assert.ok(concluded.length >= 3, `the parent and both of pong's loops concluded 200; saw ${JSON.stringify((terminated() as Array<{ result: { status: number } }>).map((t) => t.result.status))}`);
        } finally { ws.close(); }
    });
});

test("{§worker-scheme-spawn} a held name: FORK is 409 naming the working forms, WORK with env is refused by name, WORK with no body is the empty-prompt refusal", async (approvalContext) => {
    serverProposals(approvalContext, "accept");
    const mock = new Mock({ contextWindow: 16384, responses: [
        makeMockResponse("````WORK (worker://pong)\nping\n````\n\n````WAIT\nawaiting pong\n````", 10),
        makeMockResponse("````SEND [200]\npong\n````", 10),
        makeMockResponse("````SEND [200]\ndone\n````", 10),
    ] });
    await withDaemon(mock, async (db, daemon, addr) => {
        const ws = await connect(addr);
        try {
            const created = await rpcCall(ws, 1, "workspace.create", { name: "held-name" });
            const workspaceId = (created.result as { id: number }).id;
            const { finalStatus, modelWorkerId } = await runLoopToTerminal(ws, 2, { prompt: "spawn pong and wait" });
            assert.equal(finalStatus, 200);
            const problemOf = (result: { status: number }): { type?: string; recovery?: string; worker?: string } =>
                ((result as { problem?: { type?: string; recovery?: string; worker?: string } }).problem ?? {});
            const dispatch = (statement: string) => daemon.dispatchAsClient({ workspaceId, workerId: modelWorkerId!, statement: parseOne(statement) });

            const fork = await dispatch("````FORK (worker://pong)\nbranch it\n````");
            assert.equal(fork.status, 409, "a branch needs a name no worker holds");
            assert.match(problemOf(fork).type ?? "", /worker-name-conflict$/u);
            assert.equal(problemOf(fork).worker, "pong");
            assert.match(problemOf(fork).recovery ?? "", /WORK or SEND \(worker:\/\/pong\)/u, "the receipt names the working forms");

            const env = await dispatch("````WORK (worker://pong) [{\"env\": {\"ENV_WITNESS\": \"x\"}}]\nmore work\n````");
            assert.equal(env.status, 400, "a message takes no env");
            assert.match(problemOf(env).type ?? "", /metadata-unsupported$/u);

            const empty = await dispatch("````WORK (worker://pong)\n\n````");
            assert.equal(empty.status, 422, "no body, no message");
            assert.match(problemOf(empty).type ?? "", /spawn-prompt-empty$/u);

            const loops = (await db.test_count_loops_by_worker.get<{ n: number }>({ worker_id: (await db.worker_resolve_by_name.get<{ id: number }>({ workspace_id: workspaceId, name: "pong" }))!.id }))!.n;
            assert.equal(loops, 1, "none of the refusals delivered anything to pong");
            const workers = ((await rpcCall(ws, 3, "workspace.workers", {})).result as { workers: Array<{ name: string }> }).workers;
            assert.equal(workers.filter((worker) => worker.name === "pong").length, 1, "and none created a worker");
        } finally { ws.close(); }
    });
});
