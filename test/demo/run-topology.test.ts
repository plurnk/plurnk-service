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

const TIMEOUT = 600_000; // 10 min — topologies run more turns than a single-run story.

const runStory = async (opts: { label: string; prompt: string; maxTurns?: number }) => {
    const fixture = await seedDemoFixture(opts.label);
    const s = await liveSession({ name: `topo-${opts.label}-${crypto.randomUUID()}`, projectRoot: fixture.workspace });
    const { finalStatus, hitMaxTurns, turnIds, lastContent } = await liveLoop(
        s, 2, { prompt: opts.prompt, ...(opts.maxTurns !== undefined ? { maxTurns: opts.maxTurns } : {}) }, { timeoutMs: TIMEOUT },
    );
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
        prompt: "Delegate this to a separate worker run: spawn a worker and have it read the project codename out of notes.md. Hibernate until the worker finishes, then tell me ONLY the codename it found.",
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
        prompt: "src/config.json has three settings: db, pool, and host. Spawn THREE separate worker runs — one to look up each value — then hibernate until all three have reported back, and give me all three values together.",
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
        prompt: "Run this as a two-stage pipeline. Stage 1: spawn a worker to count how many users are in data/users.json. Once it reports the count, Stage 2: spawn a second worker that tells you whether that count is greater than 2. Hibernate while each stage runs, then give me the final yes/no answer.",
        maxTurns: 14,
    });
    try {
        if (story.finalStatus !== 200) await story.dump();
        assert.equal(story.finalStatus, 200, "the parent ran both stages, hibernating between, and concluded");
        assert.match(story.lastContent, /\b(yes|true|greater|more than)\b/i, `final answer resolves the comparison; got: ${story.lastContent.slice(0, 250)}`);
    } finally { await story.cleanup(); }
});
