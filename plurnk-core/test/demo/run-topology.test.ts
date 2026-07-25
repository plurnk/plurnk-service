// Topology probes — a REAL model is invited, never forced, to compose parent/child worker
// topologies. Task correctness is the demo verdict; observed worker creation is reported
// separately and is NOT a release gate. Deterministic integration owns the lifecycle contract,
// while bench evaluates whether models choose and use delegation effectively.
//
// AUTO-PROMPTING NOTE (owner's injection smell): there is none here. The child's prompt is the
// model's verbatim EDIT body (it authors it); the parent's wake is resume-in-place — the child's
// result arrives as a FOLDED collect-delta (a SEND from worker://<name> [status]: deliverable) the
// parent READS, never a synthetic prompt. The only prompt in a topology is the one the model writes.

import test from "node:test";
import assert from "node:assert/strict";
import { liveWorkspace, liveLoop } from "../_live-harness.ts";
import { seedDemoFixture } from "./_fixture.ts";

const TIMEOUT = 900_000; // 15 min — the op-bound (grammar 0.74.51) segments each actor into more
// turns, and a 4-actor fan-out serializes on a single test llama-server slot (~4.5min fresh, more
// under sweep load). Production multi-slot backends run the workers in parallel; the test env can't.

const runStory = async (opts: { label: string; prompt: string; maxTurns?: number }) => {
    const fixture = await seedDemoFixture(opts.label);
    const s = await liveWorkspace({ name: `topo-${opts.label}-${crypto.randomUUID()}`, projectRoot: fixture.workspace });
    // The inner deadline UNDERCUTS the test timeout: at a tie the test cancels first, the body
    // dangles awaiting loop/terminated, and cleanup is unreachable — the leaked daemon handles
    // then wedge the whole tier (the process can't exit, the runner waits forever).
    let loop;
    try {
        loop = await liveLoop(
            s, 2, { prompt: opts.prompt, ...(opts.maxTurns !== undefined ? { maxTurns: opts.maxTurns } : {}) }, { timeoutMs: TIMEOUT - 90_000 }, // 90s cleanup headroom: tearing down a fan-out's parent + 3 worker daemons + in-flight execs takes longer than a single run, and a mid-teardown test-timeout wedges the tier
        );
    } catch (err) {
        await s.cleanup().catch((e) => console.error(`[topo:${opts.label}] workspace cleanup after failure:`, e));
        await fixture.cleanup().catch((e) => console.error(`[topo:${opts.label}] fixture cleanup after failure:`, e));
        throw err;
    }
    const { finalStatus, hitMaxTurns, turnIds, lastContent } = loop;
    const workers = await s.db.envelope_list_workers_for_workspace.all<{ id: number; name: string; origin: string }>({ workspace_id: s.workspaceId });
    const modelWorkers = workers.filter(({ origin }) => origin === "model");
    const delegatedWorkers = Math.max(0, modelWorkers.length - 1);
    console.error(`[topo:${opts.label}] turns=${turnIds.length} finalStatus=${finalStatus} hitMaxTurns=${hitMaxTurns} delegatedWorkers=${delegatedWorkers} delegation=${delegatedWorkers > 0 ? "observed" : "not-observed"}`);
    const dump = async (): Promise<void> => {
        // All runs in the workspace — see the children too, not just the parent.
        console.error(`workers: ${workers.map((r) => `${r.id}:${r.name}`).join(", ")}`);
        for (const turnId of turnIds) {
            const row = await s.db.test_get_turn.get<{ packet: string; status: number }>({ id: turnId });
            const packet = JSON.parse(row?.packet ?? "{}") as { assistant?: { content?: string } };
            console.error(`--- turn ${turnId} status=${row?.status} ---\n${(packet.assistant?.content ?? "").slice(0, 1500)}`);
        }
    };
    return { finalStatus, lastContent, delegatedWorkers, dump, cleanup: async () => { await s.cleanup(); await fixture.cleanup(); } };
};

test("topo probe: answer a lookup task that invites delegation", { timeout: TIMEOUT }, async () => {
    const story = await runStory({
        label: "delegate",
        prompt: "Have a separate worker look up the project codename in notes.md, then tell me what it found.",
    });
    try {
        if (story.finalStatus !== 200 || !/phoenix/i.test(story.lastContent)) await story.dump();
        assert.equal(story.finalStatus, 200, "the lookup task concluded");
        assert.match(story.lastContent, /phoenix/i, `final reply carries the correct result; got: ${story.lastContent.slice(0, 200)}`);
    } finally { await story.cleanup(); }
});

test("topo probe: answer a multi-part task that invites fan-out", { timeout: TIMEOUT }, async () => {
    const story = await runStory({
        label: "fanout",
        prompt: "src/config.json has three settings: db, pool, and host. Have a separate worker look up each one, then give me all three values together.",
        maxTurns: 12,
    });
    try {
        const ok = /db\.internal/.test(story.lastContent);
        if (story.finalStatus !== 200 || !ok) await story.dump();
        assert.equal(story.finalStatus, 200, "the multi-part task concluded");
        assert.match(story.lastContent, /db\.internal/, `the report includes the host value; got: ${story.lastContent.slice(0, 250)}`);
    } finally { await story.cleanup(); }
});

test("topo probe: answer a dependent two-stage task that invites a pipeline", { timeout: TIMEOUT }, async () => {
    const story = await runStory({
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
