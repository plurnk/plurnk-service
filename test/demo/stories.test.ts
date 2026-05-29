// Storyline demos against a seeded project fixture. Each test is a
// natural user prompt — no syntax hints, no mention of EXEC/EDIT/READ.
// The model navigates real files (notes.md, src/config.json,
// src/app.js, data/users.json, package.json) and we assert outcomes:
// file content after edit, response text after query, etc.
//
// Patterns adopted from rummy's test/e2e/stories/:
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
import { readFile as readPath } from "node:fs/promises";
import Engine from "../../src/core/Engine.ts";
import SchemeRegistry from "../../src/core/SchemeRegistry.ts";
import Exec from "../../src/schemes/Exec.ts";
import { Mimetypes } from "@plurnk/plurnk-mimetypes";
import type { Db, PrepMethod } from "../../src/core/Db.ts";
import { loadActiveProvider, resolveActiveAlias } from "../../src/core/ProviderRegistry.ts";
import type { Provider } from "../../src/core/ProviderRegistry.ts";
import { PATHS } from "../../src/index.ts";
import { attachYolo } from "../../src/server/yolo.ts";
import { openMigrated, insertSession, insertRun, insertLoop } from "../intg/_helpers.ts";
import { seedDemoFixture } from "./_fixture.ts";

const TIMEOUT = 480_000; // 8 minutes — matches rummy's story timeout.

const makeMimetypes = async (provider: Provider): Promise<Mimetypes> => {
    const m = new Mimetypes({ tokenize: async (text) => provider.countTokens(text) });
    await m.ready();
    return m;
};

const SYSTEM_PROMPT = await readPath(PATHS.instructionsSystem, "utf8");

const buildProvider = async (): Promise<Provider> => {
    const alias = resolveActiveAlias();
    if (alias === null) throw new Error("PLURNK_MODEL not set; demo tests require a configured model alias");
    const provider = await loadActiveProvider();
    if (provider === null) throw new Error("loadActiveProvider returned null");
    return provider;
};

const lastTurnContent = async (db: Db, turnId: number): Promise<string> => {
    const row = await (db.test_get_turn as PrepMethod).get<{ packet: string }>({ id: turnId });
    const packet = JSON.parse(row?.packet ?? "{}") as { assistant?: { content?: string } };
    return packet.assistant?.content ?? "";
};

interface StoryOpts {
    label: string;
    prompt: string;
    maxTurns?: number;
}

interface StoryResult {
    db: Db;
    workspace: string;
    cleanup: () => Promise<void>;
    sessionId: number;
    runId: number;
    loopId: number;
    turnIds: number[];
    finalStatus: number;
    lastContent: string;
    dump: () => Promise<void>;
}

const runStory = async (opts: StoryOpts): Promise<StoryResult> => {
    const provider = await buildProvider();
    const fixture = await seedDemoFixture(opts.label);
    const db = await openMigrated();
    const schemes = new SchemeRegistry();
    const exec = schemes.get("exec") as Exec;
    const engine = new Engine({ db, schemes, mimetypes: await makeMimetypes(provider) });
    attachYolo(engine, db);
    const sessionId = await insertSession(db, `demo-${opts.label}-${crypto.randomUUID()}`);
    await (db.test_set_session_project_root as PrepMethod).run({ id: sessionId, project_root: fixture.workspace });
    const runId = await insertRun(db, sessionId);
    const loopId = await insertLoop(db, runId, 1, opts.prompt);
    await (db.engine_set_loop_flags as PrepMethod).run({
        loop_id: loopId, flags: JSON.stringify({ yolo: true }),
    });

    const result = await engine.runLoop({
        provider, sessionId, runId, loopId,
        ...(opts.maxTurns !== undefined ? { maxTurns: opts.maxTurns } : {}),
        messages: [
            { role: "system", content: SYSTEM_PROMPT },
            { role: "user", content: opts.prompt },
        ],
    });
    console.error(`[story:${opts.label}] turns=${result.turnIds.length} finalStatus=${result.finalStatus} reason=${result.reason} hitMaxTurns=${result.hitMaxTurns}`);
    await exec.idle();

    const lastTurnId = result.turnIds[result.turnIds.length - 1];
    const lastContent = lastTurnId !== undefined ? await lastTurnContent(db, lastTurnId) : "";

    const dump = async (): Promise<void> => {
        for (const turnId of result.turnIds) {
            const row = await (db.test_get_turn as PrepMethod).get<{ packet: string; status: number }>({ id: turnId });
            const packet = JSON.parse(row?.packet ?? "{}") as { assistant?: { content?: string } };
            const content = packet.assistant?.content ?? "";
            console.error(`--- turn ${turnId} status=${row?.status} ---`);
            console.error(content.slice(0, 2000));
        }
    };

    return {
        db, workspace: fixture.workspace, cleanup: async () => { await db.close(); await fixture.cleanup(); },
        sessionId, runId, loopId,
        turnIds: result.turnIds,
        finalStatus: result.finalStatus,
        lastContent, dump,
    };
};

test("story: find a single value in a JSON config", { timeout: TIMEOUT }, async () => {
    // src/config.json has { db, pool, host }. Scoped prompt: ONE value.
    // Comment in rummy: "earlier open-ended phrasings let the model
    // over-define adjacent unknowns and stall on Completion."
    const story = await runStory({
        label: "config-lookup",
        prompt: "Look in src/config.json and tell me ONLY the value of the `host` field. Don't report any other settings.",
    });
    try {
        if (story.finalStatus !== 200 || !/db\.internal/.test(story.lastContent)) await story.dump();
        assert.equal(story.finalStatus, 200);
        assert.match(story.lastContent, /db\.internal/,
            `final reply contains the host value; got: ${story.lastContent.slice(0, 200)}`);
    } finally { await story.cleanup(); }
});

test("story: read the codename from notes.md", { timeout: TIMEOUT }, async () => {
    const story = await runStory({
        label: "codename",
        prompt: "The project's codename is recorded somewhere in notes.md. Read it and tell me the codename. Just the codename, nothing else.",
    });
    try {
        if (story.finalStatus !== 200 || !/phoenix/i.test(story.lastContent)) await story.dump();
        assert.equal(story.finalStatus, 200);
        assert.match(story.lastContent, /phoenix/i,
            `final reply mentions the codename; got: ${story.lastContent.slice(0, 200)}`);
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
        prompt: "What's on line 2 of src/app.js? Tell me what the line says.",
    });
    try {
        if (story.finalStatus !== 200 || !/express/.test(story.lastContent)) await story.dump();
        assert.equal(story.finalStatus, 200);
        assert.match(story.lastContent, /express/,
            `final reply contains the line 2 content; got: ${story.lastContent.slice(0, 200)}`);
    } finally { await story.cleanup(); }
});

test("story: locate a pattern in a file by regex", { timeout: TIMEOUT }, async () => {
    // Natural prompt that benefits from READ regex matcher. notes.md
    // contains "The project codename is: phoenix\n". The model may extract
    // via a regex-style matcher or by reading and reasoning; either way,
    // the outcome is reporting "phoenix" back.
    const story = await runStory({
        label: "regex-find",
        prompt: "In notes.md, find the project codename. Just report the codename, nothing else.",
    });
    try {
        if (story.finalStatus !== 200 || !/phoenix/i.test(story.lastContent)) await story.dump();
        assert.equal(story.finalStatus, 200);
        assert.match(story.lastContent, /phoenix/i,
            `final reply contains the codename; got: ${story.lastContent.slice(0, 200)}`);
    } finally { await story.cleanup(); }
});

test("story: extract one specific value from a structured config", { timeout: TIMEOUT }, async () => {
    // Natural prompt that should benefit from matcher composition:
    // model can READ the config, get a regex match, then jsonpath against
    // the log entry to extract the value. Or it can do the whole thing in
    // one matcher. Either path is fine; the outcome is mentioning "5".
    const story = await runStory({
        label: "extract-pool",
        prompt: "What's the pool size in src/config.json? Just the number.",
    });
    try {
        if (story.finalStatus !== 200 || !/\b5\b/.test(story.lastContent)) await story.dump();
        assert.equal(story.finalStatus, 200);
        assert.match(story.lastContent, /\b5\b/,
            `final reply contains the pool size (5); got: ${story.lastContent.slice(0, 200)}`);
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

test("story: pull the host field from a JSON config", { timeout: TIMEOUT }, async () => {
    // src/config.json: {db:postgres, pool:5, host:db.internal}.
    // jsonpath path: $.host → "db.internal"
    const story = await runStory({
        label: "host-field",
        prompt: "What's the value of the `host` field in src/config.json?",
    });
    try {
        if (story.finalStatus !== 200 || !/db\.internal/.test(story.lastContent)) await story.dump();
        assert.equal(story.finalStatus, 200);
        assert.match(story.lastContent, /db\.internal/);
    } finally { await story.cleanup(); }
});

test("story: extract all h1 headings from an HTML page", { timeout: TIMEOUT }, async () => {
    // data/users.html has one h1 "Team Roster".
    // xpath path: //h1/text() → ["Team Roster"]
    // Fallback: regex /<h1>(.+?)<\/h1>/ or full READ + visual parse.
    const story = await runStory({
        label: "html-headings",
        prompt: "Read data/users.html and tell me what the page's heading says.",
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
        prompt: "How many files are in the src/ directory of this project? Reply with just the number.",
    });
    try {
        if (story.finalStatus !== 200 || !/\b2\b/.test(story.lastContent)) await story.dump();
        assert.equal(story.finalStatus, 200);
        assert.match(story.lastContent, /\b2\b/,
            `final reply contains the count (2); got: ${story.lastContent.slice(0, 200)}`);
    } finally { await story.cleanup(); }
});
