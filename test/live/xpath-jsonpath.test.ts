// Live xpath/jsonpath coverage. Each test SEEDS its entry (the model never writes
// the JSON/HTML), so a green means the model actually drove the matcher — not that
// it recited a value it had just authored. As of 2026-06-02 all four pass on
// localhost: plurnk-mimetypes#3 has landed and the dialects are wired through.

import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import Engine from "../../src/core/Engine.ts";
import SchemeRegistry from "../../src/core/SchemeRegistry.ts";
import { Mimetypes } from "@plurnk/plurnk-mimetypes";
import type { Db, PrepMethod } from "../../src/core/Db.ts";
import { resolveActiveAlias } from "@plurnk/plurnk-providers";
import { loadActiveProvider } from "../../src/core/ProviderInstantiate.ts";
import type { Provider } from "@plurnk/plurnk-providers";
import { PATHS } from "../../src/index.ts";
import Yolo from "../../src/server/yolo.ts";
import { openMigrated, insertSession, insertRun, insertLoop } from "../intg/_helpers.ts";

const TIMEOUT = 240_000;

const makeMimetypes = async (provider: Provider): Promise<Mimetypes> => {
    const m = new Mimetypes({ tokenize: async (text) => provider.countTokens(text) });
    await m.ready();
    return m;
};

const SYSTEM_PROMPT = await readFile(PATHS.instructionsSystem, "utf8");

const buildProvider = async (): Promise<Provider> => {
    const alias = resolveActiveAlias();
    if (alias === null) throw new Error("PLURNK_MODEL not set; live tests require a configured model alias");
    const provider = await loadActiveProvider();
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
    const sessionId = await insertSession(db, `live-xpjp-${label}-${crypto.randomUUID()}`);
    const runId = await insertRun(db, sessionId);
    return { db, engine, provider, sessionId, runId };
};

const runLoop = async (s: LiveSetup, prompt: string, maxTurns = 8): Promise<{ status: number; turnIds: number[]; lastContent: string }> => {
    const loopId = await insertLoop(s.db, s.runId, 1, prompt);
    await (s.db.engine_set_loop_flags as PrepMethod).run({ loop_id: loopId, flags: JSON.stringify({ yolo: true }) });
    const result = await s.engine.runLoop({
        provider: s.provider, sessionId: s.sessionId, runId: s.runId, loopId, maxTurns,
        messages: [
            { role: "system", content: SYSTEM_PROMPT },
            { role: "user", content: prompt },
        ],
    });
    const lastTurnId = result.turnIds[result.turnIds.length - 1];
    let lastContent = "";
    if (lastTurnId !== undefined) {
        const row = await (s.db.test_get_turn as PrepMethod).get<{ packet: string }>({ id: lastTurnId });
        const packet = JSON.parse(row?.packet ?? "{}") as { assistant?: { content?: string } };
        lastContent = packet.assistant?.content ?? "";
    }
    return { status: result.finalStatus, turnIds: result.turnIds, lastContent };
};

// Seed an entry directly with its mimetype. Crucially: the model never WRITES the
// JSON/HTML, so it can't answer from memory — it must actually exercise the matcher
// to extract a value it never saw. Model-driven setup masked the dialect; this forces it.
const seed = async (s: LiveSetup, pathname: string, content: string, mimetype: string): Promise<void> => {
    const e = await (s.db.crud_insert_session_entry as PrepMethod).get<{ id: number }>({ session_id: s.sessionId, scheme: "known", pathname });
    if (e === undefined) throw new Error("seed: insert returned no row");
    await (s.db.crud_write_channel as PrepMethod).run({ entry_id: e.id, name: "body", content, mimetype, tokens: 0, state: "static" });
    await (s.db.crud_write_visibility as PrepMethod).run({ run_id: s.runId, entry_id: e.id, channel: "body" });
};

test("live: jsonpath $.field on known://config.json extracts a value", { timeout: TIMEOUT }, async () => {
    const s = await liveSetup("jsonpath-field");
    try {
        await seed(s, "/config.json", '{"host":"db.internal","pool":5}', "application/json");
        const prompt = [
            "Two-step probe. The entry known:///config.json already holds a JSON object with host and pool fields.",
            "1) <<READ(known:///config.json):$.host:READ",
            "2) <<SEND[200]:<the host value>:SEND",
        ].join("\n");
        const r = await runLoop(s, prompt);
        assert.equal(r.status, 200);
        assert.match(r.lastContent, /db\.internal/);
    } finally { await s.db.close(); }
});

test("live: jsonpath $.users[*].name wildcard extracts list", { timeout: TIMEOUT }, async () => {
    const s = await liveSetup("jsonpath-wildcard");
    try {
        await seed(s, "/team.json", '{"users":[{"name":"Alice"},{"name":"Bob"}]}', "application/json");
        const prompt = [
            "Two-step probe. The entry known:///team.json already holds a JSON object with a users array.",
            "1) <<READ(known:///team.json):$.users[*].name:READ",
            "2) <<SEND[200]:<both names in any form>:SEND",
        ].join("\n");
        const r = await runLoop(s, prompt);
        assert.equal(r.status, 200);
        assert.match(r.lastContent, /Alice/);
        assert.match(r.lastContent, /Bob/);
    } finally { await s.db.close(); }
});

test("live: xpath //h1/text() on known://page.html extracts heading text", { timeout: TIMEOUT }, async () => {
    const s = await liveSetup("xpath-h1");
    try {
        await seed(s, "/page.html", "<html><body><h1>Welcome</h1></body></html>", "text/html");
        const prompt = [
            "Two-step probe. The entry known:///page.html already holds an HTML page with an h1 heading.",
            "1) <<READ(known:///page.html)://h1/text():READ",
            "2) <<SEND[200]:<the h1 text>:SEND",
        ].join("\n");
        const r = await runLoop(s, prompt);
        assert.equal(r.status, 200);
        assert.match(r.lastContent, /Welcome/);
    } finally { await s.db.close(); }
});

test("live: jsonpath compose-chain — extract then pick first via structural <L>", { timeout: TIMEOUT }, async () => {
    // Exercises the killer composition: matcher result is JSON; structural
    // <L> on the log entry picks the Nth match without jsonpath syntax.
    const s = await liveSetup("compose-jsonpath-L");
    try {
        await seed(s, "/team.json", '{"users":[{"name":"Alice"},{"name":"Bob"}]}', "application/json");
        const prompt = [
            "Three-step probe. The entry known:///team.json already holds a JSON object with a users array.",
            "1) <<READ(known:///team.json):$.users[*].name:READ",
            "   (the result lands at log://1/1/2 as a JSON array of match rows)",
            "2) <<READ(log://1/1/2)<1>::READ",
            "   (structural <L> picks the 1st match; result is [{line,matched:Alice}])",
            "3) <<SEND[200]:Alice:SEND",
        ].join("\n");
        const r = await runLoop(s, prompt);
        assert.equal(r.status, 200);
        assert.match(r.lastContent, /Alice/);
    } finally { await s.db.close(); }
});
