import { serverProposals } from "./_approval.ts";
// {§exec-lifetime} — the fence states how long its run may live, and nothing else. The scope slot
// is text coordinates, which an execution has none of; an unreadable lifetime is refused by name
// before anything spawns. Real daemon, real `sh`, no proposal review (the run is consented).

import assert from "node:assert/strict";
import test from "node:test";
import { Mock } from "@plurnk/plurnk-providers";
import { connect, rpcCall, runLoopToTerminal, waitForDb, withDaemon } from "./_rpc.ts";
import { makeRawMockResponse } from "./_mock.ts";
import { namedModelSession } from "./_sessions.ts";

const refusal = async (fence: string, name: string): Promise<{ status: number; problem: { type: string; detail: string; recovery?: string } }> => {
    const mock = new Mock({ contextWindow: 100_000, responses: [
        makeRawMockResponse(`${fence}\nsleep 0\n\`\`\`\`\n\n\`\`\`\`WAIT\nObserve the refusal.\n\`\`\`\``, 10),
        makeRawMockResponse("````SEND [200]\nRefused; done.\n````", 10),
    ] });
    let row: { status: number; problem: { type: string; detail: string; recovery?: string } } | undefined;
    await withDaemon(mock, async (db, daemon, addr) => {
        const client = await connect(addr);
        try {
            await rpcCall(client, 1, "workspace.create", { name });
            const [workspace] = await daemon.listWorkspaces();
            const sessionId = await namedModelSession(daemon, workspace.id, "main");
            await runLoopToTerminal(client, 2, { prompt: "Run it.", sessionId });
            const rows = await db.engine_render_log.all<{ op: string; origin: string; status_rx: number; rx: string }>({ session_id: sessionId });
            const refused = rows.find(({ op, origin }) => op === "sh" && origin === "model");
            assert.ok(refused, `the refused execution is a row: ${JSON.stringify(rows.map(({ op, status_rx }) => [op, status_rx]))}`);
            row = { status: refused.status_rx, problem: JSON.parse(refused.rx).problem };
        } finally { client.close(); }
    });
    assert.ok(row);
    return row;
};

test("{§exec-lifetime} {§diagnostic-observation}: a scope on an execution is refused, saying only that", { timeout: 120_000 }, async () => {
    const { status, problem } = await refusal("````sh <30,5>", "exec-scope");
    assert.equal(status, 400);
    assert.match(problem.type, /scheme\/exec\/scope-unsupported$/u);
    assert.equal(problem.detail, "An execution takes no scope.");
    assert.equal(problem.recovery, undefined);
});

test("{§exec-lifetime}: an unreadable lifetime is refused before the spawn, with every form it could take", { timeout: 120_000 }, async () => {
    const { status, problem } = await refusal('````sh [{"lifetime": "30"}]', "exec-lifetime-invalid");
    assert.equal(status, 400);
    assert.match(problem.type, /scheme\/exec\/lifetime-invalid$/u);
    assert.match(problem.detail, /'30' is not a lifetime/u);
    assert.match(problem.recovery ?? "", /"30s", "30m", "2h".*"loop", "turn", or "detached"/u);
});

test("{§exec-lifetime}: a tool's opaque metadata is still its own — the service reads no lifetime from it", { timeout: 120_000 }, async () => {
    // {§executor-metadata} — `sh` takes the option-array shape, so a block that is not that shape is
    // the tool's to refuse. The service must not refuse it first in the name of `lifetime`.
    const { status, problem } = await refusal("````sh [ custom syntax ]", "exec-lifetime-opaque");
    assert.equal(status, 400);
    assert.match(problem.type, /executor\/metadata\/metadata-invalid$/u, "the executor's own refusal, not the service's");
    assert.doesNotMatch(problem.detail, /lifetime/u);
});

test("{§exec-lifetime}: a turn-scoped run is reaped at the next pre-turn; a loop-bound one at the loop's end", { timeout: 120_000 }, async (approvalContext) => {
    serverProposals(approvalContext, "accept");
    const mock = new Mock({ contextWindow: 100_000, responses: [
        makeRawMockResponse('````sh [{"lifetime": "turn"}]\nsleep 45\n````\n\n````NOTE\nBackgrounded for this turn only.\n````', 10),
        makeRawMockResponse("````NOTE\nThe next turn begins; the turn-scoped run is gone.\n````", 10),
        makeRawMockResponse("````SEND [200]\nDone.\n````", 10),
    ] });
    await withDaemon(mock, async (db, daemon, addr) => {
        const client = await connect(addr);
        try {
            await rpcCall(client, 1, "workspace.create", { name: "exec-lifetime-turn" });
            const [workspace] = await daemon.listWorkspaces();
            const sessionId = await namedModelSession(daemon, workspace.id, "main");
            const { finalStatus } = await runLoopToTerminal(client, 2, { prompt: "Background it.", sessionId });
            assert.equal(finalStatus, 200, "the loop concluded without waiting on a stream it no longer holds");
            const open = await db.test_count_active_subscriptions.get<{ n: number }>({});
            assert.equal(open?.n, 0, "the turn-scoped stream did not survive into the subsequent turn");
        } finally { client.close(); }
    });
});

// {§exec-lifetime} {§notifications-loop-terminated} A loop-bound run ends with its loop, whichever segment of the loop
// spawned it: reaped at the loop's terminal, its stream concluded before that terminal is announced.
for (const spawnedBy of ["the ending segment", "a segment before a park"] as const) {
    test(`{§exec-lifetime}: a loop-bound run spawned by ${spawnedBy} is reaped at its loop's terminal`, { timeout: 120_000 }, async (t) => {
        serverProposals(t, "accept");
        const window = process.env.PLURNK_SERVICE_OPTIMISTIC_WAIT_MS;
        process.env.PLURNK_SERVICE_OPTIMISTIC_WAIT_MS = "0";
        t.after(() => {
            if (window === undefined) delete process.env.PLURNK_SERVICE_OPTIMISTIC_WAIT_MS;
            else process.env.PLURNK_SERVICE_OPTIMISTIC_WAIT_MS = window;
        });
        const parks = spawnedBy === "a segment before a park";
        const mock = new Mock({ contextWindow: 100_000, responses: [
            makeRawMockResponse(`\`\`\`\`sh\nsleep 45\n\`\`\`\`\n\n${parks ? "````WAIT [1]\nWaiting on it.\n````" : "````NOTE\nWorking on.\n````"}`, 10),
            makeRawMockResponse("````NOTE\nWorking on.\n````", 10),
        ] });
        await withDaemon(mock, async (db, daemon) => {
            const { workspaceId } = await daemon.createWorkspace({ name: `exec-lifetime-${parks ? "parked" : "ending"}` });
            const sessionId = await namedModelSession(daemon, workspaceId, "main");
            const order: string[] = [];
            const off = daemon.subscribeToEvents((_workspaceId: number | null, method: string, params: unknown) => {
                const event = params as { scheme?: string; loopId?: number; result?: { status: number } };
                if (method === "stream/concluded" && event.scheme === "sh") order.push(`concluded ${event.result?.status}`);
                if (method === "loop/terminated") order.push(`terminated ${event.loopId} ${event.result?.status}`);
            });
            try {
                // The turn ceiling ends the loop in the segment after its spawn, or after the park, while the run still runs.
                const { loopId } = await daemon.runLoop({ workspaceId, sessionId, prompt: "Background it.", maxTurns: parks ? 2 : 1 });
                await waitForDb(async () => order, (events) => events.some((event) => event.startsWith("terminated")), { timeoutMs: 60_000 });
                assert.deepEqual(order, ["concluded 499", `terminated ${loopId} 429`], "the run is reaped before its loop's terminal is announced");
                const open = await db.test_count_active_subscriptions.get<{ n: number }>({});
                assert.equal(open?.n, 0, "no stream outlives its loop");
            } finally {
                off();
            }
        });
    });
}
