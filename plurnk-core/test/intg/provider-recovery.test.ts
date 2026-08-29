// {§provider-recovery} — a transient provider failure never ends a loop: the turn records the
// failure, backs off, and re-issues its call; when the recovery budget is spent the loop parks
// like a [202] wait and the next prompt resumes it with its log intact.
import test from "node:test";
import assert from "node:assert/strict";
import { Mock, ProviderError } from "@plurnk/plurnk-providers";
import Daemon from "../../src/server/Daemon.ts";
import { insertWorkspace, insertWorker, openMigrated, viableWindow } from "./_helpers.ts";
import { makeMockResponse } from "./_rpc.ts";

// A provider whose next `failures` calls drop with a transient network failure.
class Flaky extends Mock {
    failures: number;
    calls = 0;
    readonly requests: string[] = [];
    constructor(failures: number, signals: readonly number[]) {
        super({
            contextWindow: viableWindow() * 4,
            responses: signals.map((signal) => makeMockResponse(signal === 102
                ? "# PLAN0\ncontinue after provider recovery\n\n## FIND0 (worker:///**)\n\n## SEND0 [102]\ncontinue"
                : "## SEND0 [200]\ndone", 20)),
        });
        this.failures = failures;
    }
    override async generate(...args: Parameters<Mock["generate"]>): ReturnType<Mock["generate"]> {
        this.calls += 1;
        this.requests.push(JSON.stringify(args[0].messages));
        if (this.failures <= 0) return super.generate(...args);
        this.failures -= 1;
        const accounting = { provider: "provider:mock", model: this.model, outcome: "error" as const, cost: { kind: "unknown" as const, reason: "connection reset by peer" } };
        const settle = await args[0].observeRequest?.({ provider: "provider:mock", model: this.model });
        await settle?.(accounting);
        throw new ProviderError("mock", "network_failure", "connection reset by peer", { accounting: [accounting] });
    }
}

type Terminated = { loopId: number; result: { status: number }; turnIds: number[] };

const withEnv = async (overrides: Record<string, string>, run: () => Promise<void>): Promise<void> => {
    const prior = new Map(Object.keys(overrides).map((key) => [key, process.env[key]]));
    Object.assign(process.env, overrides);
    try { await run(); } finally {
        for (const [key, value] of prior) {
            if (value === undefined) delete process.env[key];
            else process.env[key] = value;
        }
    }
};

const untilTerminated = async (events: Terminated[], seen: number): Promise<Terminated> => {
    const start = Date.now();
    while (events.length <= seen) {
        if (Date.now() - start > 60_000) throw new Error("no loop/terminated within 60s");
        await new Promise((resolve) => setTimeout(resolve, 10));
    }
    return events[seen]!;
};

test("{§provider-recovery} two dropped provider calls are absorbed inside the turn; the loop concludes 200", async () => {
    await withEnv({ PLURNK_SERVICE_PROVIDER_RECOVERY: "20000", PLURNK_SERVICE_PROVIDER_RECOVERY_BACKOFF: "10" }, async () => {
        const db = await openMigrated();
        const workspaceId = await insertWorkspace(db, `recovery-${crypto.randomUUID()}`);
        const workerId = await insertWorker(db, workspaceId, null, "conversation", "model");
        const provider = new Flaky(2, [102, 200]);
        const daemon = new Daemon({ db, provider });
        await daemon.start();
        const terminated: Terminated[] = [];
        daemon.subscribeToEvents((_w, method, params) => { if (method === "loop/terminated") terminated.push(params as Terminated); });
        try {
            const started = await daemon.runLoop({ workspaceId, workerId, prompt: "hello", policy: { proposals: "accept" } });
            const done = await untilTerminated(terminated, 0);
            assert.equal(done.loopId, started.loopId);
            assert.equal(done.result.status, 200, "the loop concludes despite two dropped calls");
            assert.equal(provider.calls, 4, "two failed calls, the recovered response, and one genuinely new model turn");
            assert.equal(done.turnIds.length, 3, "one initialization turn and two inference turns — recovery never opens a turn");
            const rows = await db.test_log_entries_by_loop.all<{ op: string | null; status_rx: number; origin: string; source: string | null }>({ loop_id: started.loopId });
            const failures = rows.filter((row) => row.source === "provider" && row.status_rx === 503);
            assert.equal(failures.length, 2, "every dropped call is a durable _plurnk problem row");
            assert.equal(
                new Set(provider.requests.slice(0, 3)).size,
                1,
                "same-turn outage recovery reissues the exact frozen model messages",
            );
            assert.notEqual(provider.requests[3], provider.requests[2], "the next admitted turn builds a genuinely new packet");
            assert.match(provider.requests[3]!, /## Errors/u, "settled provider failures surface normally in the next packet");
            assert.doesNotMatch(provider.requests[3]!, /retrying in/u, "the next packet carries no stale recovery checkpoint");
            const turnId = done.turnIds[1];
            assert.ok(turnId !== undefined);
            const calls = await db.test_model_calls.all<{ state: string }>({ turn_id: turnId });
            const requests = await db.test_provider_requests.all<{ outcome: string }>({ turn_id: turnId });
            assert.deepEqual(calls.map(({ state }) => state), ["error", "error", "response"]);
            assert.deepEqual(requests.map(({ outcome }) => outcome), ["error", "error", "response"], "request freezing drops no durable failure evidence");
        } finally {
            await daemon.stop();
            await db.close();
        }
    });
});

test("{§provider-recovery} a spent recovery budget parks the loop as 202; the next prompt resumes it", async () => {
    await withEnv({ PLURNK_SERVICE_PROVIDER_RECOVERY: "0", PLURNK_SERVICE_PROVIDER_RECOVERY_BACKOFF: "10" }, async () => {
        const db = await openMigrated();
        const workspaceId = await insertWorkspace(db, `recovery-park-${crypto.randomUUID()}`);
        const workerId = await insertWorker(db, workspaceId, null, "conversation", "model");
        const provider = new Flaky(99, [200]);
        const daemon = new Daemon({ db, provider });
        await daemon.start();
        const terminated: Terminated[] = [];
        daemon.subscribeToEvents((_w, method, params) => { if (method === "loop/terminated") terminated.push(params as Terminated); });
        try {
            const started = await daemon.runLoop({ workspaceId, workerId, prompt: "hello", policy: { proposals: "accept" } });
            // A parked loop is not terminated: it is the [202] wait, observed on the loop itself.
            const status = async () => (await db.engine_loop_status.get<{ status: number }>({ loop_id: started.loopId }))?.status;
            const start = Date.now();
            while (await status() !== 202) {
                if (Date.now() - start > 60_000) throw new Error(`the loop did not park within 60s (status ${await status()})`);
                await new Promise((resolve) => setTimeout(resolve, 10));
            }
            assert.equal(terminated.length, 0, "parking is not a termination");
            const rows = await db.test_log_entries_by_loop.all<{ status_rx: number; source: string | null }>({ loop_id: started.loopId });
            assert.equal(rows.filter((row) => row.source === "provider" && row.status_rx === 503).length, 1, "the failure that spent the budget is durable");

            // The provider is back: the next prompt wakes the parked loop and it concludes.
            provider.failures = 0;
            const resumed = await daemon.runLoop({ workspaceId, workerId, prompt: "continue", policy: { proposals: "accept" } });
            const done = await untilTerminated(terminated, 0);
            assert.equal(done.result.status, 200, "the resumed loop concludes");
            assert.equal(resumed.loopId, started.loopId, "the parked loop itself resumes — the chain is never dropped");
        } finally {
            await daemon.stop();
            await db.close();
        }
    });
});
