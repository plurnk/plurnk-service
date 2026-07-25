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
// Patterns adopted from rummy's test/e2e/stories/:
//   - Project fixture: real files the model can read/edit/query.
//   - Scoped prompts: "find exactly N values" / "edit this specific
//     thing" — gives gemma a clear stopping point. Open-ended phrasings
//     let small models over-investigate and stall on Completion.
//   - 8-minute timeout: gemma's reasoning takes time on multi-step.
//   - Outcome assertions only: file content, response text. Not op shapes.

import test from "node:test";
import { cannedWeb, CANNED_QUOTE, CANNED_SAVINGS, CANNED_VERSION } from "./_web-fixture.ts";
import type { WebFetch } from "../../src/schemes/Exec.ts";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Db } from "../../src/core/Db.ts";
import { liveWorkspace, liveLoop } from "../_live-harness.ts";
import { seedDemoFixture } from "./_fixture.ts";
import WorldState from "../../src/core/world-state.ts";

const TIMEOUT = 480_000; // 8 minutes — matches rummy's story timeout.

interface StoryOpts {
    label: string;
    prompt: string;
    maxTurns?: number;
    flags?: Record<string, unknown>;
    fetchWeb?: WebFetch; // #530 — the canned-web gate fixture's page source (absent = the real guarded fetcher)
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

const assertRetrievedWebBody = async (story: StoryResult): Promise<void> => {
    const reads = await story.db.test_count_model_https_default_reads.get<{ n: number }>();
    assert.ok((reads?.n ?? 0) > 0, "the model READ a materialized HTTPS entry without channel knowledge — discovery alone is not retrieval");
};

const runStory = async (opts: StoryOpts): Promise<StoryResult> => {
    const fixture = await seedDemoFixture(opts.label);
    const s = await liveWorkspace({ name: `demo-${opts.label}-${crypto.randomUUID()}`, projectRoot: fixture.workspace, ...(opts.fetchWeb !== undefined ? { fetchWeb: opts.fetchWeb } : {}) });
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
    // {§fs-world-state} — every demo story doubles as a world-state audit: whatever the model
    // did, the world it leaves behind is lawful (the run59 class self-names here, not in bench).
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

interface ChainOpts { label: string; prompts: string[]; maxTurns?: number; onStep?: (index: number, workspace: string) => Promise<void>;     fetchWeb?: WebFetch;
}
interface ChainStep { finalStatus: number; lastContent: string; turnIds: number[]; }
interface ChainResult { workspace: string; steps: ChainStep[]; db: Db; cleanup: () => Promise<void>; }

// Multi-prompt story: ONE workspace, prompts fired in sequence (each its own loop.run), so
// workspace state persists — the model works with its OWN prior output across turns (an authored
// file it must re-READ and revise, a fact it must recall). Same fixture + teardown discipline as
// runStory: a liveLoop throw lands before the caller holds the result, so tear down here.
const runStoryChain = async (opts: ChainOpts): Promise<ChainResult> => {
    const fixture = await seedDemoFixture(opts.label);
    const s = await liveWorkspace({ name: `demo-${opts.label}-${crypto.randomUUID()}`, projectRoot: fixture.workspace, ...(opts.fetchWeb !== undefined ? { fetchWeb: opts.fetchWeb } : {}) });
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
    // Comment in rummy: "earlier open-ended phrasings let the model
    // over-define adjacent unknowns and stall on Completion."
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

test("story: answer a question with a web search (canned gate — #530)", { timeout: TIMEOUT }, async () => {
    // The Web Search Epic's composition through the REAL machinery with DETERMINISTIC content:
    // EXEC[search] → a local SearXNG-shaped stub → the one-load flow (survivor pages served by
    // the sink's injectable WebFetch, canned) → ambient narration → the model answers from what
    // it retrieved. The MODEL is still live; the WEB is not — a gate must not generate its own
    // nondeterminism (#530: an unautopsiable red from variable page sizes).
    const web = await cannedWeb();
    const prevSearx = process.env.PLURNK_EXECS_SEARCH_SEARXNG_URL;
    process.env.PLURNK_EXECS_SEARCH_SEARXNG_URL = web.searxngUrl;
    try {
        const story = await runStory({
            label: "web-search",
            prompt: "Search the web for the latest stable Node.js version, retrieve the authoritative page, and tell me in one sentence.",
            maxTurns: 8,
            fetchWeb: web.fetchWeb,
        });
        try {
            const searchEntries = await story.db.test_count_entries_by_scheme.get<{ n: number }>({ scheme: "search" });
            const ok = story.finalStatus === 200 && (searchEntries?.n ?? 0) > 0 && story.lastContent.includes(CANNED_VERSION);
            if (!ok) await story.dump();
            assert.ok((searchEntries?.n ?? 0) > 0, "a search results entry exists — the model actually reached for the tool");
            await assertRetrievedWebBody(story);
            assert.equal(story.finalStatus, 200);
            assert.ok(story.lastContent.includes(CANNED_VERSION), `the answer carries the CANNED version ${CANNED_VERSION} — retrieved, not recalled; got: ${story.lastContent.slice(0, 200)}`);
        } finally { await story.cleanup(); }
    } finally {
        if (prevSearx === undefined) delete process.env.PLURNK_EXECS_SEARCH_SEARXNG_URL; else process.env.PLURNK_EXECS_SEARCH_SEARXNG_URL = prevSearx;
        await web.close();
    }
});

test("story: search, retrieve, and report a measured claim from a page (canned)", { timeout: TIMEOUT }, async () => {
    const web = await cannedWeb();
    const previous = process.env.PLURNK_EXECS_SEARCH_SEARXNG_URL;
    process.env.PLURNK_EXECS_SEARCH_SEARXNG_URL = web.searxngUrl;
    try {
        const story = await runStory({
            label: "web-research-claim",
            prompt: "Search the web for Project Aurora's inference report. By how much did it reduce inference cost?",
            maxTurns: 8,
            fetchWeb: web.fetchWeb,
        });
        try {
            const pages = await story.db.test_count_entries_by_scheme.get<{ n: number }>({ scheme: "https" });
            const ok = story.finalStatus === 200 && story.lastContent.toLowerCase().includes(CANNED_SAVINGS);
            if (!ok) await story.dump();
            assert.ok((pages?.n ?? 0) > 0, "search materialized retrievable web pages");
            await assertRetrievedWebBody(story);
            assert.equal(story.finalStatus, 200);
            assert.match(story.lastContent, /37\s*(?:percent|%)/i);
        } finally { await story.cleanup(); }
    } finally {
        if (previous === undefined) delete process.env.PLURNK_EXECS_SEARCH_SEARXNG_URL; else process.env.PLURNK_EXECS_SEARCH_SEARXNG_URL = previous;
        await web.close();
    }
});

test("story: search and recover an exact statement from a transcript page (canned)", { timeout: TIMEOUT }, async () => {
    const web = await cannedWeb();
    const previous = process.env.PLURNK_EXECS_SEARCH_SEARXNG_URL;
    process.env.PLURNK_EXECS_SEARCH_SEARXNG_URL = web.searxngUrl;
    try {
        const story = await runStory({
            label: "web-transcript-quote",
            prompt: "Search the web for Secretary Rowan's recent AI infrastructure interview. What did Rowan say was the bottleneck?",
            maxTurns: 8,
            fetchWeb: web.fetchWeb,
        });
        try {
            const searchEntries = await story.db.test_count_entries_by_scheme.get<{ n: number }>({ scheme: "search" });
            const ok = story.finalStatus === 200 && story.lastContent.toLowerCase().includes(CANNED_QUOTE);
            if (!ok) await story.dump();
            assert.ok((searchEntries?.n ?? 0) > 0, "the model used web search rather than answering from fixture files");
            await assertRetrievedWebBody(story);
            assert.equal(story.finalStatus, 200);
            assert.match(story.lastContent, /power,\s*not demand/i);
        } finally { await story.cleanup(); }
    } finally {
        if (previous === undefined) delete process.env.PLURNK_EXECS_SEARCH_SEARXNG_URL; else process.env.PLURNK_EXECS_SEARCH_SEARXNG_URL = previous;
        await web.close();
    }
});

test("story: answer a question with a web search (LIVE — #530, in the default sweep)", { timeout: TIMEOUT }, async () => {
    // The live-web form runs by DEFAULT (#530, meta reversal): the demo stage is a DISCOVERY
    // instrument, not a release gate that must stay green — a red on variable web content is the
    // highest-signal thing it produces (the product is fragile on exactly the input real customers
    // supply). Its failing db is KEPT (keep-on-fail, #410) to autopsy the red — flake vs regression
    // is decided by the specimen, never by deleting the test. The canned gate above stays the
    // deterministic REGRESSION pin; this discovers NEW fragility. A red is a finding, not a light.
    const story = await runStory({
        label: "web-search-live",
        prompt: "Who was the spouse of President Igor Nikolaevich Smirnov?",
        maxTurns: 8,
    });
    try {
        const searchEntries = await story.db.test_count_entries_by_scheme.get<{ n: number }>({ scheme: "search" });
        const ok = story.finalStatus === 200 && (searchEntries?.n ?? 0) > 0 && /(Zhannetta|Lotnik)/i.test(story.lastContent);
        if (!ok) await story.dump();
        assert.ok((searchEntries?.n ?? 0) > 0, "a search results entry exists — the model actually reached for the tool");
        assert.equal(story.finalStatus, 200);
        assert.match(story.lastContent, /(Zhannetta|Lotnik)/i, `the answer names Zhannetta Nikolaevna Lotnik; got: ${story.lastContent.slice(0, 200)}`);
    } finally { await story.cleanup(); }
});

test("story: retrieve and summarize a live web page", { timeout: TIMEOUT }, async () => {
    const story = await runStory({
        label: "web-retrieve-live",
        prompt: "Summarize the fifth paragraph of Marilyn Monroe's Wikipedia entry.",
        maxTurns: 8,
    });
    try {
        const ok = story.finalStatus === 200 && story.lastContent.trim().length > 20;
        if (!ok) await story.dump();
        await assertRetrievedWebBody(story);
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
        const listsFinding = /(?:^|\n)\s*\d+[.)]\s+\S/m.test(story.lastContent);
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

// --- xpath / jsonpath demos (auto-activate when plurnk-mimetypes#3 lands) ---
//
// These demos exercise the dialect the model is MOST likely to reach for
// given the prompt: natural language that asks for structured extraction
// against JSON or HTML. Currently jsonpath/xpath return 501 in matcher.ts;
// the model will see that and fall back to regex / EXEC / full-read.
// The assertions still validate the outcome (the answer reaches SEND);
// when the sibling lands and matcher.ts wires through, the model will
// reach for jsonpath/xpath directly and the same demos pass via that path.

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
    // then must re-READ its OWN prior work and EDIT it shorter (the refine turn renders the
    // line-numbered diff of what changed — §edit-result-render), then MOVE it out of the root.
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
        assert.equal(chain.steps[0].finalStatus, 200, "the brief was authored");
        assert.ok(sizes[0] > 200, `the draft has substantial prose; got ${sizes[0]} chars`);
        assert.equal(chain.steps[1].finalStatus, 200, "the refine turn concluded");
        assert.ok(sizes[1] > 0 && sizes[1] < sizes[0], `the refined brief is shorter (${sizes[1]} < ${sizes[0]} chars)`);
        assert.equal(chain.steps[2].finalStatus, 200, "the file-away turn concluded");
        const inDrafts = await readFile(join(chain.workspace, "drafts", "brief.md"), "utf8").catch(() => null);
        assert.ok(inDrafts !== null && inDrafts.trim().length > 0, "brief.md was relocated under drafts/");
    } finally { await chain.cleanup(); }
});

test("story: remember a fact, then recall it later", { timeout: TIMEOUT }, async () => {
    // known:// persistent-memory round-trip. The deploy key is in NO file — a correct recall on a
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

test("story: ask mode answers directly — no EXEC reach, no 403 spiral (#367/#386)", { timeout: TIMEOUT }, async () => {
    // The #367 probe shape: ask mode gates EXEC out and the capability sheet renders the
    // 'EXEC operations disabled' line (#386) — silence invited confabulated commands, a 403
    // cycle, and a 508 strike-out. A question that TEMPTS a shell answer must conclude 200
    // with prose, never touch the rail.
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


// {§fs-world-state} Phase-4 (#546) — the edit-heavy belief test: the run59 shape on our own
// terms. The model CREATES a file (O_EXCL + git auto-add admission), revises its OWN creation
// (the address round-trip: the name it minted must resolve back), and reports it — then the
// world is audited and the created file's identity is asserted to be exactly ONE row (the
// 227× fragmentation class, pinned at the demo rung).
test("story: create a decisions doc, then revise it — the world stays lawful (#546)", { timeout: TIMEOUT * 2 }, async () => {
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
        // the identity pin: one file, one row — under every spelling the model used across three loops.
        const row = await chain.db.test_count_rows_for_pathname.get<{ n: number }>({ pathname: "docs/decisions.md" });
        assert.equal(row?.n, 1, "the created file is exactly ONE row — the 227× class stays dead at the demo rung");
    } finally { await chain.cleanup(); }
});
