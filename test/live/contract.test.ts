// Live coverage of contract surfaces (landed under #171): READ <L>, READ regex
// matcher, EDIT <L>, FIND regex, COPY <L> source range, SEND[410] #fragment
// channel delete.
//
// Each test is ONE natural sentence that can only mean ONE op — the op is NEVER
// spelled out. Showing the literal op triggers model meta-awareness about the
// "mission" (it loops on that meta-confusion instead of acting) and tests the
// parser rather than the intent→op mapping that is the real surface. Verify
// FORENSICALLY against the db: state-changing ops by entry/channel content,
// read-only ops by the op's logged rx. Never assert on the model's narration.

import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import Engine from "../../src/core/Engine.ts";
import SchemeRegistry from "../../src/core/SchemeRegistry.ts";
import { Mimetypes } from "@plurnk/plurnk-mimetypes";
import type { Db, PrepMethod } from "../../src/core/Db.ts";
import { resolveActiveAlias } from "@plurnk/plurnk-providers";
import ProviderInstantiate from "../../src/core/ProviderInstantiate.ts";
import type { Provider } from "@plurnk/plurnk-providers";
import { Paths } from "../../src/index.ts";
import Yolo from "../../src/server/yolo.ts";
import { openMigrated, insertSession, insertRun, insertLoop } from "../intg/_helpers.ts";

const TIMEOUT = 240_000;

const makeMimetypes = async (provider: Provider): Promise<Mimetypes> => {
    const m = new Mimetypes({ tokenize: async (text) => provider.countTokens(text) });
    await m.ready();
    return m;
};

const SYSTEM_PROMPT = await readFile(Paths.instructionsSystem, "utf8");
const PERSONA = await readFile(Paths.defaultPersona, "utf8");
const REQUIREMENTS = await readFile(Paths.defaultRequirements, "utf8");

const buildProvider = async (): Promise<Provider> => {
    const alias = resolveActiveAlias();
    if (alias === null) throw new Error("PLURNK_MODEL not set; live tests require a configured model alias");
    const provider = await ProviderInstantiate.loadActiveProvider();
    if (provider === null) throw new Error("loadActiveProvider returned null");
    return provider;
};

interface LiveSetup {
    db: Db;
    engine: Engine;
    provider: Provider;
    sessionId: number;
    runId: number;
}

const liveSetup = async (label: string): Promise<LiveSetup> => {
    const provider = await buildProvider();
    const db = await openMigrated();
    const engine = new Engine({ db, schemes: new SchemeRegistry(), mimetypes: await makeMimetypes(provider) });
    Yolo.attachYolo(engine, db);
    const sessionId = await insertSession(db, `live-contract-${label}-${crypto.randomUUID()}`);
    const runId = await insertRun(db, sessionId);
    return { db, engine, provider, sessionId, runId };
};

// Run one loop to completion. We assert against the db afterward, never the
// model's output — so this hands back nothing.
const runLoop = async (s: LiveSetup, prompt: string, maxTurns = 8): Promise<void> => {
    const loopId = await insertLoop(s.db, s.runId, 1, prompt);
    await (s.db.engine_set_loop_flags as PrepMethod).run({ loop_id: loopId, flags: JSON.stringify({ yolo: true }) });
    await s.engine.runLoop({
        provider: s.provider, sessionId: s.sessionId, runId: s.runId, loopId, maxTurns,
        persona: PERSONA, requirements: REQUIREMENTS,
        messages: [
            { role: "system", content: SYSTEM_PROMPT },
            { role: "user", content: prompt },
        ],
    });
};

// Seed an entry directly (returns its id, for attaching more channels). The
// precondition state is the test's job to build, not the model's to stumble through.
const seed = async (s: LiveSetup, pathname: string, content: string, mimetype = "text/markdown"): Promise<number> => {
    const e = await (s.db.crud_insert_session_entry as PrepMethod).get<{ id: number }>({ session_id: s.sessionId, scheme: "known", pathname });
    if (e === undefined) throw new Error("seed: insert returned no row");
    await (s.db.crud_write_channel as PrepMethod).run({ entry_id: e.id, name: "body", content, mimetype, tokens: 0, state: "static" });
    return e.id;
};

// Post-index, no entry's content is auto-shown: every seeded entry stays
// READ/FIND-able, but the model must emit the op to reach it (never answering
// from what it can already see). `seedHidden` is kept as a named alias for the
// tests that lean on that — now equivalent to `seed`.
const seedHidden = seed;

// Forensic read-backs — assert what the OP did to the db, never what the model
// said. readBody: an entry's body content (undefined once the channel/entry is
// gone). lastRx: the latest rx the engine logged for an op this run (what a READ
// actually sliced, what a FIND actually matched).
const readBody = async (s: LiveSetup, pathname: string): Promise<string | undefined> => {
    const row = await (s.db.test_get_body_by_pathname as PrepMethod).get<{ content: string }>({ pathname });
    return row?.content;
};

const lastRx = async (s: LiveSetup, op: string): Promise<string> => {
    const row = await (s.db.test_get_log_rx_by_run_op as PrepMethod).get<{ rx: string }>({ run_id: s.runId, op });
    return row?.rx ?? "";
};

test("live: READ <L> — slice the second line of an entry", { timeout: TIMEOUT }, async () => {
    const s = await liveSetup("read-L");
    try {
        await seedHidden(s, "/lines.md", "alpha\nbeta\ngamma");
        await runLoop(s, "What is on the second line of known:///lines.md?");
        const rx = await lastRx(s, "READ");
        assert.match(rx, /beta/);
        assert.doesNotMatch(rx, /alpha|gamma/); // a <2> slice, not a whole-file read
    } finally { await s.db.close(); }
});

test("live: READ regex — extract a pattern from an entry's content", { timeout: TIMEOUT }, async () => {
    const s = await liveSetup("read-regex");
    try {
        await seedHidden(s, "/doc.md", "hello world hello again");
        await runLoop(s, "Find every occurrence of the word `hello` in known:///doc.md.");
        assert.match(await lastRx(s, "READ"), /hello/);
    } finally { await s.db.close(); }
});

test("live: EDIT <L> — replace the second line of an entry", { timeout: TIMEOUT }, async () => {
    const s = await liveSetup("edit-L");
    try {
        await seed(s, "/poem.md", "roses are red\nviolets are blue");
        // The prompt IS the test: one sentence that can only mean EDIT<2>.
        await runLoop(s, "Replace the second line of known:///poem.md with `violets are bright`.");
        assert.equal(await readBody(s, "/poem.md"), "roses are red\nviolets are bright");
    } finally { await s.db.close(); }
});

test("live: FIND regex — filter known entries by pathname", { timeout: TIMEOUT }, async () => {
    const s = await liveSetup("find-regex");
    try {
        await seedHidden(s, "/apple.md", "a");
        await seedHidden(s, "/apricot.md", "b");
        await seedHidden(s, "/banana.md", "c");
        await runLoop(s, "Which known entries have a pathname starting with `/ap`?");
        assert.match(await lastRx(s, "FIND"), /apple|apricot/);
    } finally { await s.db.close(); }
});

test("live: COPY <L> — copy a line range into a new entry", { timeout: TIMEOUT }, async () => {
    const s = await liveSetup("copy-L");
    try {
        await seed(s, "/src.md", "one\ntwo\nthree\nfour");
        await runLoop(s, "Copy the second and third lines of known:///src.md into a new entry known:///slice.md.");
        // lines 2-3 only; the trailing newline varies with the model's path
        // (a COPY slice keeps it; a READ-then-EDIT reconstruction may drop it).
        assert.match(await readBody(s, "/slice.md") ?? "", /^two\nthree\n?$/);
    } finally { await s.db.close(); }
});

test("live: MOVE to /dev/null — delete an entry", { timeout: TIMEOUT }, async () => {
    const s = await liveSetup("delete");
    try {
        await seed(s, "/obsolete.md", "no longer needed");
        // The grammar teaches "delete entries by MOVE to /dev/null" — the model
        // earns the op from a plain delete request; we verify the entry is gone.
        await runLoop(s, "Delete the entry known:///obsolete.md.");
        assert.equal(await readBody(s, "/obsolete.md"), undefined);
    } finally { await s.db.close(); }
});
