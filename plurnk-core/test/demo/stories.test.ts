// Storyline demos against a seeded project fixture. Each test is a
// natural user prompt — no syntax hints, no mention of EXEC/EDIT/READ.
// The model navigates real files (notes.md, src/config.json,
// src/app.js, data/users.json, package.json) and we assert outcomes:
// file content after edit, response text after query, etc.
//
// Driven through the REAL prod loop — loop.run via the daemon. workspace.create
// pins the fixture as project_root; PLURNK_SERVICE_GIT_AUTO makes its git-committed
// files members the production way (no hand-registered catalog), and Exec
// defaults its cwd to project_root. runStory boots the prod Daemon directly
// (rather than the auto-closing withDaemon) only because the db must stay open
// for the post-loop forensic asserts; the loop itself is 100% prod.
//
// Model-story doctrine:
//   - Project fixture: real files the model can read/edit/query.
//   - Scoped prompts: "find exactly N values" / "edit this specific
//     thing" — gives gemma a clear stopping point. Open-ended phrasings
//     let small models over-investigate and stall on Completion.
//   - 8-minute timeout: gemma's reasoning takes time on multi-step.
//   - Outcome assertions only: file content, response text. Not op shapes.

import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Db } from "../../src/core/Db.ts";
import { liveWorkspace, liveLoop } from "../_live-harness.ts";
import { seedDemoFixture } from "./_fixture.ts";
import WorldState from "../intg/world-state.ts";

const TIMEOUT = Number(process.env.PLURNK_SERVICE_LIVE_TIMEOUT ?? 600_000);

interface StoryOpts {
    label: string;
    prompt: string;
    maxTurns?: number;
    flags?: Record<string, unknown>;
}

interface StoryResult {
    db: Db;
    workspace: string;
    cleanup: () => Promise<void>;
    turnIds: number[];
    finalStatus: number;
    lastContent: string;
    dump: () => Promise<void>;
}

const assertMaterializedWebPage = async (story: StoryResult): Promise<void> => {
    const pages = await story.db.test_count_entries_by_scheme.get<{ n: number }>({ scheme: "https" });
    assert.ok((pages?.n ?? 0) > 0, "the search flow materialized a primary web page");
};

const runStory = async (opts: StoryOpts): Promise<StoryResult> => {
    const fixture = await seedDemoFixture(opts.label);
    const s = await liveWorkspace({ name: `demo-${opts.label}-${crypto.randomUUID()}`, projectRoot: fixture.workspace });
    // A liveLoop throw (loop.run rejection, waitFor timeout) happens BEFORE the caller holds the
    // StoryResult, so its finally-cleanup is unreachable — tear down HERE or the orphaned daemon's
    // handles (ws pair, db worker) keep the child process alive after the worker and wedge the tier.
    let loop;
    try {
        loop = await liveLoop(
            s, 2,
            { prompt: opts.prompt, ...(opts.maxTurns !== undefined ? { maxTurns: opts.maxTurns } : {}), ...(opts.flags !== undefined ? { flags: opts.flags } : {}) },
            { timeoutMs: TIMEOUT - 30_000 }, // undercut the test timeout: the inner throw must land while cleanup is still reachable
        );
    } catch (err) {
        await s.cleanup().catch((e) => console.error(`[story:${opts.label}] workspace cleanup after failure:`, e));
        await fixture.cleanup().catch((e) => console.error(`[story:${opts.label}] fixture cleanup after failure:`, e));
        throw err;
    }
    const { finalStatus, hitMaxTurns, turnIds, lastContent } = loop;
    console.error(`[story:${opts.label}] turns=${turnIds.length} finalStatus=${finalStatus} hitMaxTurns=${hitMaxTurns}`);
    // {§fs-world-state} — every demo story also audits the world the model leaves behind.
    const wsViolations = await WorldState.check(s.db);
    assert.deepEqual(wsViolations, [], `[story:${opts.label}] the world stays lawful after the story`);

    const dump = async (): Promise<void> => {
        for (const turnId of turnIds) {
            const row = await s.db.test_get_turn.get<{ packet: string; status: number }>({ id: turnId });
            const packet = JSON.parse(row?.packet ?? "{}") as { assistant?: { content?: string } };
            console.error(`--- turn ${turnId} status=${row?.status} ---`);
            console.error((packet.assistant?.content ?? "").slice(0, 2000));
        }
    };

    return {
        db: s.db, workspace: fixture.workspace,
        cleanup: async () => { await s.cleanup(); await fixture.cleanup(); },
        turnIds, finalStatus, lastContent, dump,
    };
};

interface ChainOpts { label: string; prompts: string[]; maxTurns?: number; onStep?: (index: number, workspace: string) => Promise<void>;
}
interface ChainStep { finalStatus: number; lastContent: string; turnIds: number[]; }
interface ChainResult { workspace: string; steps: ChainStep[]; db: Db; cleanup: () => Promise<void>; }

// Multi-prompt story: ONE workspace, prompts fired in sequence (each its own loop.run), so
// workspace state persists — the model works with its OWN prior output across turns (an authored
// file it must re-READ and revise, a fact it must recall). Same fixture + teardown discipline as
// runStory: a liveLoop throw lands before the caller holds the result, so tear down here.
const runStoryChain = async (opts: ChainOpts): Promise<ChainResult> => {
    const fixture = await seedDemoFixture(opts.label);
    const s = await liveWorkspace({ name: `demo-${opts.label}-${crypto.randomUUID()}`, projectRoot: fixture.workspace });
    const teardown = async () => { await s.cleanup(); await fixture.cleanup(); };
    const steps: ChainStep[] = [];
    try {
        let id = 2;
        for (const prompt of opts.prompts) {
            const loop = await liveLoop(
                s, id++,
                { prompt, ...(opts.maxTurns !== undefined ? { maxTurns: opts.maxTurns } : {}) },
                { timeoutMs: TIMEOUT - 30_000 },
            );
            steps.push({ finalStatus: loop.finalStatus, lastContent: loop.lastContent, turnIds: loop.turnIds });
            console.error(`[chain:${opts.label}] step ${steps.length} turns=${loop.turnIds.length} finalStatus=${loop.finalStatus}`);
            if (opts.onStep !== undefined) await opts.onStep(steps.length - 1, fixture.workspace);
        }
    } catch (err) {
        await teardown().catch((e) => console.error(`[chain:${opts.label}] cleanup after failure:`, e));
        throw err;
    }
    // {§fs-world-state} — the chain leaves a lawful world, audited like every story.
    const chainViolations = await WorldState.check(s.db);
    assert.deepEqual(chainViolations, [], `[chain:${opts.label}] the world stays lawful after the chain`);
    return { workspace: fixture.workspace, steps, db: s.db, cleanup: teardown };
};

test("story: find a single value in a JSON config", { timeout: TIMEOUT }, async () => {
    // src/config.json has { db, pool, host }. Scoped prompt: ONE value.
    // A single-value question gives the model a crisp completion boundary;
    // open-ended phrasing invites unrelated investigation.
    const story = await runStory({
        label: "config-lookup",
        prompt: "What database host does src/config.json use?",
    });
    try {
        if (story.finalStatus !== 200 || !/db\.internal/.test(story.lastContent)) await story.dump();
        assert.equal(story.finalStatus, 200);
        assert.match(story.lastContent, /db\.internal/,
            `final reply contains the host value; got: ${story.lastContent.slice(0, 200)}`);
    } finally { await story.cleanup(); }
});

test("{§search-gate} story: answer a question through live web search and retrieval", { timeout: TIMEOUT }, async () => {
    // The whole composition in one story, live end to end: EXEC[search] → a real
    // SearXNG → survivor pages materialized as ordinary https:// entries → the model
    // answers from what it retrieved. The subject is release-current, so weights
    // alone can't answer it honestly — the tool is the path of least resistance,
    // not a scripted op. A materialized HTTPS body and a substantive answer from a
    // real page are the positive control; a model that can't close is honestly red.
    const story = await runStory({
        label: "web-search",
        prompt: "Search the web for the latest stable Node.js version and tell me in one sentence.",
        maxTurns: 8,
    });
    try {
        const searchEntries = await story.db.test_count_entries_by_scheme.get<{ n: number }>({ scheme: "search" });
        const ok = story.finalStatus === 200 && (searchEntries?.n ?? 0) > 0 && /\d{2}/.test(story.lastContent);
        if (!ok) await story.dump();
        assert.ok((searchEntries?.n ?? 0) > 0, "a search results entry exists — the model actually reached for the tool");
        await assertMaterializedWebPage(story);
        assert.equal(story.finalStatus, 200);
        assert.match(story.lastContent, /\d{2}/, `the answer carries a version number; got: ${story.lastContent.slice(0, 200)}`);
    } finally { await story.cleanup(); }
});

test("{§search-gate} story: answer a question through live web discovery", { timeout: TIMEOUT }, async () => {
    // Live discovery: a breaking release-current question not present in static training
    // weights — the story diagnoses research judgment against the real web.
    // Its benchmark artifact remains available for autopsy. {§test-artifact-retention}
    const story = await runStory({
        label: "web-search-live",
        prompt: "Who is the current United States Federal Reserve Chairman?",
        maxTurns: 8,
    });
    try {
        const ok = story.finalStatus === 200 && /Warsh/i.test(story.lastContent);
        if (!ok) await story.dump();
        assert.equal(story.finalStatus, 200);
        assert.match(story.lastContent, /Warsh/i, `the answer names Warsh; got: ${story.lastContent.slice(0, 200)}`);
    } finally { await story.cleanup(); }
});

test("story: retrieve and summarize a live web page", { timeout: TIMEOUT }, async () => {
    const story = await runStory({
        label: "web-retrieve-live",
        prompt: "Summarize the fifth paragraph of Marilyn Monroe's Wikipedia entry.",
        maxTurns: 30,
    });
    try {
        const ok = story.finalStatus === 200 && story.lastContent.trim().length > 20;
        if (!ok) await story.dump();
        await assertMaterializedWebPage(story);
        assert.equal(story.finalStatus, 200);
        assert.ok(story.lastContent.trim().length > 20, `the answer contains a substantive summary; got: ${story.lastContent.slice(0, 200)}`);
    } finally { await story.cleanup(); }
});

test("story: read the codename from notes.md", { timeout: TIMEOUT }, async () => {
    const story = await runStory({
        label: "codename",
        prompt: "What's the project codename? It's in notes.md.",
    });
    try {
        if (story.finalStatus !== 200 || !/phoenix/i.test(story.lastContent)) await story.dump();
        assert.equal(story.finalStatus, 200);
        assert.match(story.lastContent, /phoenix/i,
            `final reply mentions the codename; got: ${story.lastContent.slice(0, 200)}`);
    } finally { await story.cleanup(); }
});

test("story: self-audit — the model critiques its own packet for errors and ambiguities", { timeout: TIMEOUT }, async () => {
    // Meta-prompt (owner request): the model audits the packet it was handed, surfacing
    // instruction errors / inconsistencies / ambiguities neither the author nor the operator
    // sees from inside. Diagnostic, not pass/fail — the findings ARE the deliverable, so they
    // are always dumped to the test log for review.
    const story = await runStory({
        label: "packet-audit",
        prompt: "I am evaluating my agent interface. Please evaluate the instructions and information in this packet for errors, issues, inconsistencies, and ambiguities and list your findings numerically.",
    });
    try {
        console.error("\n===== PACKET SELF-AUDIT FINDINGS =====");
        console.error(story.lastContent);
        console.error("===== END SELF-AUDIT =====\n");
        assert.equal(story.finalStatus, 200, "the audit loop concludes cleanly");
        const listsFinding = /(?:^|\n)\s*(?:#{1,6}[ \t]+)?\d+[.)]\s+\S/m.test(story.lastContent);
        const explicitlyFindsNone = /\b(?:no|did not find any)\s+(?:material\s+)?(?:errors|issues|inconsistencies|ambiguities|findings)\b/i.test(story.lastContent);
        assert.ok(listsFinding || explicitlyFindsNone, `the audit must list a numbered finding or explicitly report none; got: ${story.lastContent.slice(0, 200)}`);
    } finally { await story.cleanup(); }
});

test("story: edit a TODO comment in src/app.js", { timeout: TIMEOUT }, async () => {
    // app.js has `// TODO: add error handling`. Model replaces it with
    // an exact-text replacement and we verify on disk.
    const story = await runStory({
        label: "edit-todo",
        prompt: 'In src/app.js, replace the comment "// TODO: add error handling" with "// error handler configured". Read the file first if you need to.',
    });
    try {
        if (story.finalStatus !== 200) await story.dump();
        assert.equal(story.finalStatus, 200);
        const onDisk = await readFile(join(story.workspace, "src/app.js"), "utf8");
        assert.match(onDisk, /\/\/ error handler configured/,
            "new comment landed on disk");
        assert.doesNotMatch(onDisk, /\/\/ TODO: add error handling/,
            "old TODO comment removed");
    } finally { await story.cleanup(); }
});

test("story: pull just one line out of a file", { timeout: TIMEOUT }, async () => {
    // Natural prompt that benefits from READ <L>. The model may also read
    // the whole file and report the line; either way, the holistic outcome
    // (mentioning the line content) is what we assert. Line 2 of the
    // fixture's src/app.js is `const app = express();`.
    const story = await runStory({
        label: "one-line",
        prompt: "What's on line 2 of src/app.js?",
    });
    try {
        if (story.finalStatus !== 200 || !/express/.test(story.lastContent)) await story.dump();
        assert.equal(story.finalStatus, 200);
        assert.match(story.lastContent, /express/,
            `final reply contains the line 2 content; got: ${story.lastContent.slice(0, 200)}`);
    } finally { await story.cleanup(); }
});

// Structured matcher demos. The assertions pin the user-visible answer without
// prescribing whether the model uses JSONPath, XPath, another matcher, or a complete READ.

test("story: list every admin user from a JSON file", { timeout: TIMEOUT }, async () => {
    // data/users.json: [{name:Alice,role:admin}, {name:Bob,role:viewer}].
    // jsonpath path: $.[?(@.role=='admin')].name → ["Alice"]
    // Fallback paths: regex match on lines / EXEC + jq / full READ + reason.
    const story = await runStory({
        label: "list-admins",
        prompt: "In data/users.json, who has the 'admin' role? List each admin's name.",
    });
    try {
        if (story.finalStatus !== 200 || !/Alice/.test(story.lastContent)) await story.dump();
        assert.equal(story.finalStatus, 200);
        assert.match(story.lastContent, /Alice/,
            `final reply names the admin; got: ${story.lastContent.slice(0, 200)}`);
    } finally { await story.cleanup(); }
});

test("story: extract all h1 headings from an HTML page", { timeout: TIMEOUT }, async () => {
    // data/users.html has one h1 "Team Roster".
    // xpath path: //h1/text() → ["Team Roster"]
    // Fallback: regex /<h1>(.+?)<\/h1>/ or full READ + visual parse.
    const story = await runStory({
        label: "html-headings",
        prompt: "What does the heading on data/users.html say?",
    });
    try {
        if (story.finalStatus !== 200 || !/Team Roster/i.test(story.lastContent)) await story.dump();
        assert.equal(story.finalStatus, 200);
        assert.match(story.lastContent, /Team Roster/i);
    } finally { await story.cleanup(); }
});

test("story: pull email addresses out of an HTML element's attribute", { timeout: TIMEOUT }, async () => {
    // data/users.html: <user email="alice@x.com">, <user email="bob@x.com">, <user email="carol@x.com">.
    // xpath path: //user/@email → ["alice@x.com", "bob@x.com", "carol@x.com"]
    const story = await runStory({
        label: "html-attrs",
        prompt: "List the email addresses for every user in data/users.html.",
    });
    try {
        if (story.finalStatus !== 200 || !/alice@x\.com/.test(story.lastContent)) await story.dump();
        assert.equal(story.finalStatus, 200);
        assert.match(story.lastContent, /alice@x\.com/);
        assert.match(story.lastContent, /bob@x\.com/);
        assert.match(story.lastContent, /carol@x\.com/);
    } finally { await story.cleanup(); }
});

test("story: report the number of files in a directory", { timeout: TIMEOUT }, async () => {
    // src/ has 2 files: app.js, config.json.
    const story = await runStory({
        label: "count-files",
        prompt: "How many files are in the src/ directory?",
    });
    try {
        if (story.finalStatus !== 200 || !/\b2\b/.test(story.lastContent)) await story.dump();
        assert.equal(story.finalStatus, 200);
        assert.match(story.lastContent, /\b2\b/,
            `final reply contains the count (2); got: ${story.lastContent.slice(0, 200)}`);
    } finally { await story.cleanup(); }
});

test("story: draft a brief, tighten it, then file it away", { timeout: TIMEOUT }, async () => {
    // Authoring → refinement → reorganization in ONE workspace. The model creates prose (brief.md),
    // then must re-READ its OWN prior work and EDIT it shorter (the refine turn renders its
    // bounded landed receipt — {§edit-result-receipt-projection}), then MOVE it out of the root.
    // Outcome asserts on disk, snapshotting size BEFORE the move. All natural prompts.
    const sizes: number[] = [];
    const chain = await runStoryChain({
        label: "authoring",
        maxTurns: 10,
        prompts: [
            "Write me a short brief — two or three paragraphs — on why the printing press changed the world, and save it as brief.md.",
            "That's longer than I need. Cut it down to a single tight paragraph.",
            "Perfect. Now move brief.md into a drafts/ folder to keep my workspace tidy.",
        ],
        onStep: async (i, ws) => {
            // Snapshot brief.md's size after the draft (0) and the tighten (1), BEFORE the move (2) relocates it.
            if (i <= 1) sizes[i] = (await readFile(join(ws, "brief.md"), "utf8").catch(() => "")).trim().length;
        },
    });
    try {
        assert.ok(sizes[0] > 200, `the draft has substantial prose; got ${sizes[0]} chars`);
        assert.ok(sizes[1] > 0 && sizes[1] < sizes[0], `the refined brief is shorter (${sizes[1]} < ${sizes[0]} chars)`);
        const inDrafts = await readFile(join(chain.workspace, "drafts", "brief.md"), "utf8").catch(() => null);
        assert.ok(inDrafts !== null, "brief.md was relocated under drafts/");
        assert.equal(inDrafts.trim().length, sizes[1], "the relocated file is the refined brief");
        assert.doesNotMatch(inDrafts.trim(), /\n\s*\n/, "the refined brief is one paragraph");
        const atRoot = await readFile(join(chain.workspace, "brief.md"), "utf8").catch(() => null);
        assert.equal(atRoot, null, "the move left no brief.md at the workspace root");
    } finally { await chain.cleanup(); }
});

test("story: remember a fact, then recall it later", { timeout: TIMEOUT }, async () => {
    // worker:// persistent-memory round-trip. The deploy key is in NO file — a correct recall on a
    // LATER turn proves the model stored it in its own memory and retrieved it. Natural prompts.
    const chain = await runStoryChain({
        label: "memory",
        maxTurns: 6,
        prompts: [
            "Hang onto this for me: the staging deploy key is SK-7788-QRT.",
            "Remind me — what was that staging deploy key?",
        ],
    });
    try {
        assert.equal(chain.steps[1].finalStatus, 200, "the recall turn concluded");
        assert.match(chain.steps[1].lastContent, /SK-7788-QRT/,
            `recalled the key from memory; got: ${chain.steps[1].lastContent.slice(0, 200)}`);
    } finally { await chain.cleanup(); }
});

test("story: compute a value too big for arithmetic shortcuts", { timeout: TIMEOUT }, async () => {
    // 25! = 15511210043330985984000000 overflows 64-bit, so shell arithmetic can't do it — the
    // model reaches for a real runtime (node BigInt / python). Natural prompt; the exact value proves it.
    const story = await runStory({
        label: "compute",
        prompt: "What's 25 factorial?",
        maxTurns: 6,
    });
    try {
        const wanted = /15,?511,?210,?043,?330,?985,?984,?000,?000/;
        if (story.finalStatus !== 200 || !wanted.test(story.lastContent)) await story.dump();
        assert.equal(story.finalStatus, 200);
        assert.match(story.lastContent, wanted,
            `computed 25! exactly; got: ${story.lastContent.slice(0, 200)}`);
    } finally { await story.cleanup(); }
});

test("{§tools-loop-affinity}: ask mode answers a shell-tempting question in prose", { timeout: TIMEOUT }, async () => {
    // Deterministic coverage pins the sheet and gate; this story probes model use.
    const story = await runStory({
        label: "ask-steer",
        prompt: "How many files are in this project, roughly? A ballpark from what you can see is fine.",
        maxTurns: 6,
        flags: { mode: "ask" },
    });
    try {
        if (story.finalStatus !== 200) await story.dump();
        assert.equal(story.finalStatus, 200, "ask mode concluded (no 403-cycle 508, no max_turns)");
        assert.ok(story.lastContent.length > 0, "a direct prose answer landed");
    } finally { await story.cleanup(); }
});


// {§fs-world-state} — create, revise, and reread one model-authored file across loops.
test("{§fs-world-state}: create and revise a decisions document without fragmenting identity", { timeout: TIMEOUT * 2 }, async () => {
    const chain = await runStoryChain({
        label: "world-state-edit",
        prompts: [
            "Create a new file docs/decisions.md that lists exactly two architecture decisions as bullet points: we use express, and we use sqlite.",
            "In docs/decisions.md, change the sqlite decision to postgres. Leave the express one alone.",
            "Read docs/decisions.md and tell me both decisions in one sentence.",
        ],
    });
    try {
        for (const [i, step] of chain.steps.entries()) {
            assert.equal(step.finalStatus, 200, `step ${i + 1} concluded`);
        }
        const onDisk = await readFile(join(chain.workspace, "docs/decisions.md"), "utf8");
        assert.match(onDisk, /express/i, "the surviving decision is on disk");
        assert.match(onDisk, /postgres/i, "the revision landed on disk");
        assert.doesNotMatch(onDisk, /sqlite/i, "the revised decision is gone");
        assert.match(chain.steps[2].lastContent, /express/i, "the model reports its own work");
        assert.match(chain.steps[2].lastContent, /postgres/i);
        // {§entry-identity-no-null}: one file remains one row across all three loops.
        const row = await chain.db.test_count_rows_for_pathname.get<{ n: number }>({ pathname: "docs/decisions.md" });
        assert.equal(row?.n, 1, "the created file has exactly one durable identity");
    } finally { await chain.cleanup(); }
});
