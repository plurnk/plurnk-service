// Topology demos — a REAL model (gemma) composing parent/child run topologies: delegate, fan-out,
// pipeline. These exercise run:// spawn + SEND[202] hibernation + the child-wake + reading the
// collect-delta on resume. Forensic by intent: a stumble teaches us where the TEACHING is thin
// (spawn syntax? when to 202 vs 200? noticing the folded collect-delta?), not just pass/fail.
//
// AUTO-PROMPTING NOTE (owner's injection smell): there is none here. The child's prompt is the
// model's verbatim EDIT body (it authors it); the parent's wake is resume-in-place — the child's
// result arrives as a FOLDED collect-delta (a SEND from run://<name> [status]: deliverable) the
// parent READS, never a synthetic prompt. The only prompt in a topology is the one the model writes.

import test from "node:test";
import assert from "node:assert/strict";
import type { Db, PrepMethod } from "../../src/core/Db.ts";
import { liveSession, liveLoop } from "../_live-harness.ts";
import { seedDemoFixture } from "./_fixture.ts";

const TIMEOUT = 900_000; // 15 min — the op-bound (grammar 0.74.51) segments each actor into more
// turns, and a 4-actor fan-out serializes on a single test llama-server slot (~4.5min fresh, more
// under sweep load). Production multi-slot backends run the workers in parallel; the test env can't.

const runStory = async (opts: { label: string; prompt: string; maxTurns?: number }) => {
    const fixture = await seedDemoFixture(opts.label);
    const s = await liveSession({ name: `topo-${opts.label}-${crypto.randomUUID()}`, projectRoot: fixture.workspace });
    // The inner deadline UNDERCUTS the test timeout: at a tie the test cancels first, the body
    // dangles awaiting loop/terminated, and cleanup is unreachable — the leaked daemon handles
    // then wedge the whole tier (the process can't exit, the runner waits forever).
    let loop;
    try {
        loop = await liveLoop(
            s, 2, { prompt: opts.prompt, ...(opts.maxTurns !== undefined ? { maxTurns: opts.maxTurns } : {}) }, { timeoutMs: TIMEOUT - 90_000 }, // 90s cleanup headroom: tearing down a fan-out's parent + 3 worker daemons + in-flight execs takes longer than a single run, and a mid-teardown test-timeout wedges the tier
        );
    } catch (err) {
        await s.cleanup().catch((e) => console.error(`[topo:${opts.label}] session cleanup after failure:`, e));
        await fixture.cleanup().catch((e) => console.error(`[topo:${opts.label}] fixture cleanup after failure:`, e));
        throw err;
    }
    const { finalStatus, hitMaxTurns, turnIds, lastContent } = loop;
    console.error(`[topo:${opts.label}] turns=${turnIds.length} finalStatus=${finalStatus} hitMaxTurns=${hitMaxTurns}`);
    const dump = async (): Promise<void> => {
        // All runs in the session — see the children too, not just the parent.
        const runs = await (s.db.envelope_list_runs_for_session as PrepMethod).all<{ id: number; name: string }>({ session_id: s.sessionId });
        console.error(`runs: ${runs.map((r) => `${r.id}:${r.name}`).join(", ")}`);
        for (const turnId of turnIds) {
            const row = await (s.db.test_get_turn as PrepMethod).get<{ packet: string; status: number }>({ id: turnId });
            const packet = JSON.parse(row?.packet ?? "{}") as { assistant?: { content?: string } };
            console.error(`--- turn ${turnId} status=${row?.status} ---\n${(packet.assistant?.content ?? "").slice(0, 1500)}`);
        }
    };
    return { db: s.db as Db, finalStatus, lastContent, turnIds, dump, cleanup: async () => { await s.cleanup(); await fixture.cleanup(); } };
};

test("topo: delegate a lookup to a child run and report its result", { timeout: TIMEOUT }, async () => {
    // The simplest topology: spawn one worker, hibernate, wake on its conclusion, report what it found.
    const story = await runStory({
        label: "delegate",
        prompt: "Have a separate worker look up the project codename in notes.md, then tell me what it found.",
    });
    try {
        if (story.finalStatus !== 200 || !/phoenix/i.test(story.lastContent)) await story.dump();
        assert.equal(story.finalStatus, 200, "the parent delegated, hibernated, woke on the child, and concluded");
        assert.match(story.lastContent, /phoenix/i, `final reply carries the worker's result; got: ${story.lastContent.slice(0, 200)}`);
    } finally { await story.cleanup(); }
});

test("topo: fan-out three workers and join their results", { timeout: TIMEOUT }, async () => {
    // Fan-out + join: three parallel workers, hibernate, wake as each concludes, aggregate.
    const story = await runStory({
        label: "fanout",
        prompt: "src/config.json has three settings: db, pool, and host. Have a separate worker look up each one, then give me all three values together.",
        maxTurns: 12,
    });
    try {
        const ok = /db\.internal/.test(story.lastContent);
        if (story.finalStatus !== 200 || !ok) await story.dump();
        assert.equal(story.finalStatus, 200, "the parent fanned out, waited for all workers, and concluded");
        assert.match(story.lastContent, /db\.internal/, `the joined report includes the host value; got: ${story.lastContent.slice(0, 250)}`);
    } finally { await story.cleanup(); }
});

test("topo: a two-stage pipeline of dependent workers", { timeout: TIMEOUT }, async () => {
    // Sequential dependency: worker A's result feeds worker B. The parent waits between stages.
    const story = await runStory({
        label: "pipeline",
        prompt: "First have a worker count how many users are in data/users.json. Then have a second worker check whether that count is more than 2. Give me the final yes-or-no answer.",
        maxTurns: 14,
    });
    try {
        if (story.finalStatus !== 200) await story.dump();
        assert.equal(story.finalStatus, 200, "the parent ran both stages, hibernating between, and concluded");
        assert.match(story.lastContent, /\byes\b/i, `3 users IS more than 2 → the final answer is yes; got: ${story.lastContent.slice(0, 250)}`);
    } finally { await story.cleanup(); }
});
