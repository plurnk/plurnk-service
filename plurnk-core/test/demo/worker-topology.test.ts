// Topology probes — a REAL model is invited, never forced, to compose parent/child worker
// topologies. Task correctness is the demo verdict; observed worker creation is reported
// separately and is NOT a release gate. Deterministic integration owns the lifecycle contract,
// while bench evaluates whether models choose and use delegation effectively.
//
// AUTO-PROMPTING NOTE (owner's injection smell): there is none here. The child's prompt is the
// model's verbatim EDIT body (it authors it); the parent's wake is resume-in-place — the child's
// result arrives as a body-suppressed collect-delta (a SEND from worker://<name> [status]: deliverable) the
// parent READS, never a synthetic prompt. The only prompt in a topology is the one the model writes.

import { liveTest as test } from "../live-test.ts";
import assert from "node:assert/strict";
import { liveWorkspace, liveLoop } from "../_live-harness.ts";
import { seedDemoFixture } from "./_fixture.ts";
import { failAfterCleanup } from "../live-failure.ts";
import { readWorkerTopology } from "../WorkerTopology.ts";

const runStory = async (opts: { signal: AbortSignal; label: string; prompt: string; maxTurns?: number }) => {
    const fixture = await seedDemoFixture(opts.label);
    const lifetime = new AsyncDisposableStack();
    lifetime.defer(fixture.cleanup);
    const cleanup = () => lifetime.disposeAsync();
    try {
        const s = await liveWorkspace({ name: `topo-${opts.label}-${crypto.randomUUID()}`, projectRoot: fixture.workspace });
        lifetime.defer(s.cleanup);
        const loop = await liveLoop(
            s, 2, { prompt: opts.prompt, ...(opts.maxTurns !== undefined ? { maxTurns: opts.maxTurns } : {}) }, { signal: opts.signal },
        );
        const { finalStatus, hitMaxTurns, turnIds, lastContent } = loop;
        const { workers, delegatedWorkers } = await readWorkerTopology(s.db, s.workspaceId);
        console.error(`[topo:${opts.label}] turns=${turnIds.length} finalStatus=${finalStatus} hitMaxTurns=${hitMaxTurns} delegatedWorkers=${delegatedWorkers} delegation=${delegatedWorkers > 0 ? "observed" : "not-observed"}`);
        const dump = async (): Promise<void> => {
            // All workers in the workspace — see the children too, not just the parent.
            console.error(`workers: ${workers.map((r) => `${r.id}:${r.name}`).join(", ")}`);
            for (const turnId of turnIds) {
                const row = await s.db.test_get_turn.get<{ packet: string; status: number }>({ id: turnId });
                const packet = JSON.parse(row?.packet ?? "{}") as { assistant?: { content?: string } };
                console.error(`--- turn ${turnId} status=${row?.status} ---\n${(packet.assistant?.content ?? "").slice(0, 1500)}`);
            }
        };
        return { finalStatus, lastContent, delegatedWorkers, dump, cleanup };
    } catch (error) {
        return await failAfterCleanup(error, cleanup);
    }
};

test("topo probe: answer a lookup task that invites delegation", async (t) => {
    const story = await runStory({
        signal: t.signal,
        label: "delegate",
        prompt: "Have a separate worker look up the project codename in notes.md, then tell me what it found.",
    });
    try {
        if (story.finalStatus !== 200 || !/phoenix/i.test(story.lastContent)) await story.dump();
        assert.equal(story.finalStatus, 200, "the lookup task concluded");
        assert.match(story.lastContent, /phoenix/i, `final reply carries the correct result; got: ${story.lastContent.slice(0, 200)}`);
    } finally { await story.cleanup(); }
});

test("topo probe: answer a multi-part task that invites fan-out", async (t) => {
    const story = await runStory({
        signal: t.signal,
        label: "fanout",
        prompt: "src/config.json has three settings: db, pool, and host. Have a separate worker look up each one, then give me all three values together.",
        maxTurns: 12,
    });
    try {
        const expected = [/\bpostgres\b/i, /\b5\b/, /\bdb\.internal\b/];
        if (story.finalStatus !== 200 || expected.some((value) => !value.test(story.lastContent))) await story.dump();
        assert.equal(story.finalStatus, 200, "the multi-part task concluded");
        for (const value of expected) {
            assert.match(story.lastContent, value, `the report includes every requested setting; got: ${story.lastContent.slice(0, 250)}`);
        }
    } finally { await story.cleanup(); }
});

test("topo probe: answer a dependent two-stage task that invites a pipeline", async (t) => {
    const story = await runStory({
        signal: t.signal,
        label: "pipeline",
        prompt: "First have a worker count how many users are in data/users.json. Then have a second worker check whether that count is more than 2. Give me the final yes-or-no answer.",
        maxTurns: 14,
    });
    try {
        if (story.finalStatus !== 200) await story.dump();
        assert.equal(story.finalStatus, 200, "the dependent task concluded");
        assert.match(story.lastContent, /\byes\b/i, `3 users IS more than 2 → the final answer is yes; got: ${story.lastContent.slice(0, 250)}`);
    } finally { await story.cleanup(); }
});
