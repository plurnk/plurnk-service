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
        provider, sessionId, runId, loopId, maxTurns: opts.maxTurns ?? 12,
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

test("story: report the number of files in a directory", { timeout: TIMEOUT }, async () => {
    // src/ has 2 files: app.js, config.json. Scoped: just the count.
    // Generous maxTurns: gemma explores several commands (find/ls/wc)
    // before committing to an answer. Solo runs typically converge at
    // 8-12 turns; suite runs (parallel-overloaded gemma) need more
    // headroom before SEND[200] lands.
    const story = await runStory({
        label: "count-files",
        prompt: "How many files are in the src/ directory of this project? Reply with just the number.",
        maxTurns: 20,
    });
    try {
        if (story.finalStatus !== 200 || !/\b2\b/.test(story.lastContent)) await story.dump();
        assert.equal(story.finalStatus, 200);
        assert.match(story.lastContent, /\b2\b/,
            `final reply contains the count (2); got: ${story.lastContent.slice(0, 200)}`);
    } finally { await story.cleanup(); }
});
