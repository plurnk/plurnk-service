// {§terminal-evidence} — a terminal rules the loop over and keeps its status, but never decides the
// model said nothing: it cites what the last turn left unconcluded, at the address that already
// holds it. {§engine-rails} — and it names the source that actually crossed.
import test from "node:test";
import assert from "node:assert/strict";
import Engine from "../../src/core/Engine.ts";
import SchemeRegistry from "../../src/core/SchemeRegistry.ts";
import { Mock } from "@plurnk/plurnk-providers";
import type { MockResponse } from "@plurnk/plurnk-providers";
import { openMigrated, insertWorkspace, insertWorker, insertLoop, logEntries, DEFAULT_MIMETYPES } from "./_helpers.ts";
import { statement } from "./reasoning-fixture.ts";

const said = (content: string): MockResponse => ({ assistant: { content, reasoning: null }, assistantRaw: null });

const setup = async () => {
    const db = await openMigrated();
    const workspaceId = await insertWorkspace(db, `terminal-${crypto.randomUUID()}`);
    const workerId = await insertWorker(db, workspaceId, null, "alice");
    const loopId = await insertLoop(db, workerId, 1, "What is two plus two?");
    const engine = new Engine({ db, schemes: new SchemeRegistry(), mimetypes: DEFAULT_MIMETYPES });
    return { db, engine, workspaceId, workerId, loopId };
};

const problemOf = (result: { result: { problem?: Record<string, unknown> } }) => {
    assert.ok(result.result.problem !== undefined, "a terminal is a failure and carries a problem");
    return result.result.problem;
};

test("{§terminal-evidence}: a strike threshold crossed by unfenced prose keeps its 500 and cites what was said", async () => {
    const { db, engine, workspaceId, workerId, loopId } = await setup();
    try {
        const provider = new Mock({ contextWindow: 100_000, responses: [
            said("Let me think about this."),
            said("Two plus two."),
            said("The answer is four."),
        ] });
        const loop = await engine.runLoop({
            provider, workspaceId, workerId, loopId, maxTurns: 10, maxStrikes: 3,
            messages: [{ role: "user", content: "What is two plus two?" }],
        });
        const problem = problemOf(loop);

        assert.equal(loop.result.status, 500, "the engine ruled the loop failed and the status never softens");
        assert.equal(problem.type, "https://problems.plurnk.xyz/engine/rails/strike-threshold");
        assert.match(
            problem.detail as string,
            /consecutive turns performed no operation\.$/,
            "a turn that attempted nothing did not fail an operation",
        );

        // The citation, not the bytes. Turn 1 is initialization, so the three model turns are 2-4.
        assert.equal(problem.unconcluded, "ops://alice/1/4", "the terminal cites the last unconcluded emission");
        assert.ok(!JSON.stringify(problem).includes("The answer is four"), "cited, never embedded");

        // And the citation is not a dead link.
        const cited = await engine.look({
            workspaceId, workerId, loopId,
            statement: statement(`\`\`\`\`READ (${problem.unconcluded as string})\`\`\`\``),
        });
        assert.equal(cited.status, 200);
        assert.ok("content" in cited);
        assert.equal(cited.content, "The answer is four.", "what the model last said is reachable at the cited address");
    } finally { await db.close(); }
});

test("{§terminal-evidence}: a terminal whose last turn acted carries no `unconcluded` at all", async () => {
    const { db, engine, workspaceId, workerId, loopId } = await setup();
    try {
        // Two empty turns strike, then a turn that performs a real operation — and the ceiling ends
        // the loop there. Nothing was left unconcluded, so nothing is cited.
        const provider = new Mock({ contextWindow: 100_000, responses: [
            said("Thinking."),
            said("Still thinking."),
            said("````NOTE\nchecked\n````"),
        ] });
        const loop = await engine.runLoop({
            provider, workspaceId, workerId, loopId, maxTurns: 3, maxStrikes: 10,
            messages: [{ role: "user", content: "What is two plus two?" }],
        });
        const problem = problemOf(loop);

        assert.equal(loop.result.status, 429, "the turn ceiling is its own terminal");
        assert.ok(!("unconcluded" in problem), "an absent member is not an empty one");
    } finally { await db.close(); }
});

test("{§terminal-evidence}: the turn ceiling cites an unconcluded last turn too", async () => {
    const { db, engine, workspaceId, workerId, loopId } = await setup();
    try {
        const provider = new Mock({ contextWindow: 100_000, responses: [
            said("````NOTE\nworking\n````"),
            said("I believe the answer is four."),
        ] });
        const loop = await engine.runLoop({
            provider, workspaceId, workerId, loopId, maxTurns: 2, maxStrikes: 10,
            messages: [{ role: "user", content: "What is two plus two?" }],
        });
        const problem = problemOf(loop);

        assert.equal(loop.result.status, 429);
        assert.equal(problem.unconcluded, "ops://alice/1/3", "every terminal keeps the evidence, not only the strike rail");
    } finally { await db.close(); }
});

test("{§empty-turn}: an empty turn's fingerprint is its text — saying the same thing IS a cycle", async () => {
    const { db, engine, workspaceId, workerId, loopId } = await setup();
    try {
        const same = said("I am thinking about it.");
        const provider = new Mock({ contextWindow: 100_000, responses: [same, same, same] });
        const loop = await engine.runLoop({
            provider, workspaceId, workerId, loopId, maxTurns: 10, maxStrikes: 3,
            messages: [{ role: "user", content: "What is two plus two?" }],
        });
        const problem = problemOf(loop);

        assert.equal(loop.result.status, 508, "a model repeating itself verbatim is a loop, and still says so");
        assert.match(problem.detail as string, /its operations and results repeated\.$/);
        assert.equal(problem.unconcluded, "ops://alice/1/4", "a cycle terminal keeps the evidence too");
    } finally { await db.close(); }
});

test("{§engine-rails}: a threshold crossed by failed operations still says operations failed", async () => {
    const { db, engine, workspaceId, workerId, loopId } = await setup();
    try {
        // A READ of a worker that does not exist is a hard operation failure, three turns running.
        const bad = said("````READ (worker://nobody/1)````");
        const provider = new Mock({ contextWindow: 100_000, responses: [bad, bad, bad] });
        const loop = await engine.runLoop({
            provider, workspaceId, workerId, loopId, maxTurns: 10, maxStrikes: 3,
            messages: [{ role: "user", content: "What is two plus two?" }],
        });
        const problem = problemOf(loop);

        assert.ok(loop.result.status === 500 || loop.result.status === 508, "a rail crossing, by whichever source");
        assert.doesNotMatch(
            problem.detail as string,
            /performed no operation/,
            "turns that attempted operations are not reported as turns that attempted none",
        );
        assert.ok(!("unconcluded" in problem), "operations ran, so nothing was left unconcluded");
    } finally { await db.close(); }
});

test("{§terminal-evidence}: the citation reaches the parent, the reader best placed to judge it", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `terminal-parent-${crypto.randomUUID()}`);
        const parent = await insertWorker(db, workspaceId, null, "lead");
        const parentLoop = await insertLoop(db, parent, 1, "Have the reviewer look at the draft.");
        const child = await insertWorker(db, workspaceId, parent, "reviewer");
        const childLoop = await insertLoop(db, child, 1, "Review the draft.");
        const engine = new Engine({ db, schemes: new SchemeRegistry(), mimetypes: DEFAULT_MIMETYPES });

        // The child answers in prose three times and never fences: the rail rules it over.
        await engine.runLoop({
            provider: new Mock({ contextWindow: 100_000, responses: [
                said("Reading the draft now."),
                said("A few notes are forming."),
                said("The draft is sound but the second section drifts."),
            ] }),
            workspaceId, workerId: child, loopId: childLoop, maxTurns: 10, maxStrikes: 3,
            messages: [{ role: "user", content: "Review the draft." }],
        });

        const turn = await engine.runTurn({
            provider: new Mock({ contextWindow: 100_000, responses: [{ assistant: { content: "````NOTE\nchecking\n````", reasoning: null } }] }),
            messages: [], workspaceId, workerId: parent, loopId: parentLoop,
        });
        const packet = JSON.parse((await db.test_get_packet.get<{ packet: string }>({ id: turn.turnId }))!.packet);
        const observed = logEntries(packet).find(({ source, path }) => source === "worker://reviewer" && path === "ops://reviewer/1");
        assert.ok(observed !== undefined, "the child's termination reaches its parent");

        const rendered = JSON.stringify(observed);
        assert.match(rendered, /ops:\/\/reviewer\/1\/4/, "the parent is handed the address of what the child last said");
        assert.doesNotMatch(rendered, /the second section drifts/, "cited, never embedded: the child's words do not ride into the parent's packet");
    } finally { await db.close(); }
});

test("{§terminal-evidence}: an explicit KILL concludes after recovery without replacing the earlier answer", async () => {
    const { db, engine, workspaceId, workerId, loopId } = await setup();
    try {
        const provider = new Mock({ contextWindow: 100_000, responses: [said("The answer is four."), said("````KILL\n````")] });
        const loop = await engine.runLoop({
            provider, workspaceId, workerId, loopId, maxTurns: 10, maxStrikes: 3,
            messages: [{ role: "user", content: "What is two plus two?" }],
        });
        assert.equal(loop.result.status, 200, "{§kill-conclusion} requests completion before the rail can rule");
        const answer = await engine.look({ workspaceId, workerId, loopId, statement: statement("````READ (ops://alice/1)````") });
        assert.ok("content" in answer);
        assert.equal(answer.content, "The answer is four.", "and the loop's own address is the answer, not a citation");
    } finally { await db.close(); }
});
