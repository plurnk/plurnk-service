// Live xpath/jsonpath coverage. Structural prompts walk the model
// through the dialect; assertions verify wire-level emission against
// the matcher contract. Tests are skipped at the engine level when the
// matcher returns 501 (sibling-pending); they auto-activate when
// plurnk-mimetypes#3 lands.

import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import Engine from "../../src/core/Engine.ts";
import SchemeRegistry from "../../src/core/SchemeRegistry.ts";
import { Mimetypes } from "@plurnk/plurnk-mimetypes";
import type { Db, PrepMethod } from "../../src/core/Db.ts";
import { loadActiveProvider, resolveActiveAlias } from "../../src/core/ProviderRegistry.ts";
import type { Provider } from "../../src/core/ProviderRegistry.ts";
import { PATHS } from "../../src/index.ts";
import { attachYolo } from "../../src/server/yolo.ts";
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
    attachYolo(engine, db);
    const sessionId = await insertSession(db, `live-xpjp-${label}-${crypto.randomUUID()}`);
    const runId = await insertRun(db, sessionId);
    return { db, engine, provider, sessionId, runId };
};

const runLoop = async (s: LiveSetup, prompt: string, maxTurns = 8): Promise<{ status: number; turnIds: number[]; lastContent: string; sawSibling501: boolean }> => {
    const loopId = await insertLoop(s.db, s.runId, 1, prompt);
    await (s.db.engine_set_loop_flags as PrepMethod).run({ loop_id: loopId, flags: JSON.stringify({ yolo: true }) });
    const result = await s.engine.runLoop({
        provider: s.provider, sessionId: s.sessionId, runId: s.runId, loopId, maxTurns,
        messages: [
            { role: "system", content: SYSTEM_PROMPT },
            { role: "user", content: prompt },
        ],
    });
    // Sniff for the sibling-pending 501 in any of the run's log entries —
    // if matcher.ts is still stubbed out the model will hit it.
    type LogRow = { rx: string };
    const rxRows = await (s.db.test_list_log_rx_for_run as PrepMethod | undefined)?.all<LogRow>({ run_id: s.runId }) ?? [];
    const sawSibling501 = rxRows.some((row) => (row.rx ?? "").includes("plurnk-mimetypes#3"));
    const lastTurnId = result.turnIds[result.turnIds.length - 1];
    let lastContent = "";
    if (lastTurnId !== undefined) {
        const row = await (s.db.test_get_turn as PrepMethod).get<{ packet: string }>({ id: lastTurnId });
        const packet = JSON.parse(row?.packet ?? "{}") as { assistant?: { content?: string } };
        lastContent = packet.assistant?.content ?? "";
    }
    return { status: result.finalStatus, turnIds: result.turnIds, lastContent, sawSibling501 };
};

test("live: jsonpath $.field on known://config.json extracts a value", { timeout: TIMEOUT }, async () => {
    const s = await liveSetup("jsonpath-field");
    try {
        const prompt = [
            "Three-step probe:",
            '1) <<EDIT(known:///config.json):{"host":"db.internal","pool":5}:EDIT',
            "2) <<READ(known:///config.json):$.host:READ",
            "3) <<SEND[200]:<the host value>:SEND",
        ].join("\n");
        const r = await runLoop(s, prompt);
        if (r.sawSibling501) {
            console.error("[pending plurnk-mimetypes#3] jsonpath $.field — skipping assertion");
            return;
        }
        assert.equal(r.status, 200);
        assert.match(r.lastContent, /db\.internal/);
    } finally { await s.db.close(); }
});

test("live: jsonpath $.users[*].name wildcard extracts list", { timeout: TIMEOUT }, async () => {
    const s = await liveSetup("jsonpath-wildcard");
    try {
        const prompt = [
            "Three-step probe:",
            '1) <<EDIT(known:///team.json):{"users":[{"name":"Alice"},{"name":"Bob"}]}:EDIT',
            "2) <<READ(known:///team.json):$.users[*].name:READ",
            "3) <<SEND[200]:<both names in any form>:SEND",
        ].join("\n");
        const r = await runLoop(s, prompt);
        if (r.sawSibling501) {
            console.error("[pending plurnk-mimetypes#3] jsonpath wildcard — skipping assertion");
            return;
        }
        assert.equal(r.status, 200);
        assert.match(r.lastContent, /Alice/);
        assert.match(r.lastContent, /Bob/);
    } finally { await s.db.close(); }
});

test("live: xpath //h1/text() on known://page.html extracts heading text", { timeout: TIMEOUT }, async () => {
    const s = await liveSetup("xpath-h1");
    try {
        const prompt = [
            "Three-step probe:",
            "1) <<EDIT(known:///page.html):<html><body><h1>Welcome</h1></body></html>:EDIT",
            "2) <<READ(known:///page.html)://h1/text():READ",
            "3) <<SEND[200]:<the h1 text>:SEND",
        ].join("\n");
        const r = await runLoop(s, prompt);
        if (r.sawSibling501) {
            console.error("[pending plurnk-mimetypes#3] xpath //h1/text() — skipping assertion");
            return;
        }
        assert.equal(r.status, 200);
        assert.match(r.lastContent, /Welcome/);
    } finally { await s.db.close(); }
});

test("live: jsonpath compose-chain — extract then pick first via structural <L>", { timeout: TIMEOUT }, async () => {
    // Exercises the killer composition: matcher result is JSON; structural
    // <L> on the log entry picks the Nth match without jsonpath syntax.
    const s = await liveSetup("compose-jsonpath-L");
    try {
        const prompt = [
            "Four-step probe:",
            '1) <<EDIT(known:///team.json):{"users":[{"name":"Alice"},{"name":"Bob"}]}:EDIT',
            "2) <<READ(known:///team.json):$.users[*].name:READ",
            "   (the result lands at log://1/2/1 as a JSON array of match rows)",
            "3) <<READ(log://1/2/1)<1>::READ",
            "   (structural <L> picks the 1st match; result is [{line,matched:Alice}])",
            "4) <<SEND[200]:Alice:SEND",
        ].join("\n");
        const r = await runLoop(s, prompt);
        if (r.sawSibling501) {
            console.error("[pending plurnk-mimetypes#3] jsonpath compose-chain — skipping assertion");
            return;
        }
        assert.equal(r.status, 200);
        assert.match(r.lastContent, /Alice/);
    } finally { await s.db.close(); }
});
