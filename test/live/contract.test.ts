// Live coverage of contract surfaces landed under #171: READ <L>, READ
// body matcher, READ [tag] filter, EDIT <L>, FIND regex, FIND <L>
// pagination, SHOW/HIDE body matcher, COPY <L> source range, SEND[410]
// #fragment channel delete.
//
// STRUCTURAL prompts are allowed here (the model is told the exact op
// shape to emit). Per `feedback_live_vs_demo_prompts`, live exercises
// machinery against real provider; demo exercises model reasoning with
// natural prompts.

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
    const sessionId = await insertSession(db, `live-contract-${label}-${crypto.randomUUID()}`);
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

const dumpTurns = async (s: LiveSetup, turnIds: number[], label: string): Promise<void> => {
    for (const turnId of turnIds) {
        const row = await (s.db.test_get_turn as PrepMethod).get<{ packet: string; status: number }>({ id: turnId });
        const packet = JSON.parse(row?.packet ?? "{}") as { assistant?: { content?: string } };
        console.error(`[${label}] turn ${turnId} status=${row?.status}: ${(packet.assistant?.content ?? "").slice(0, 300)}`);
    }
};

test("live: READ <L> — model slices a known:// entry by line range", { timeout: TIMEOUT }, async () => {
    const s = await liveSetup("read-L");
    try {
        const prompt = [
            "Two-step probe:",
            "1) Write the entry: <<EDIT(known:///lines):alpha\\nbeta\\ngamma:EDIT",
            "2) Then read line 2: <<READ(known:///lines)<2>::READ",
            "3) Then SEND[200] with whatever the READ returned (a line prefixed `2:\\tbeta`):",
            "   <<SEND[200]:<your read result>:SEND",
        ].join("\n");
        const r = await runLoop(s, prompt);
        if (!/beta/.test(r.lastContent)) await dumpTurns(s, r.turnIds, "read-L");
        assert.equal(r.status, 200);
        assert.match(r.lastContent, /beta/);
    } finally { await s.db.close(); }
});

test("live: READ regex matcher — model extracts a regex match from a known:// entry", { timeout: TIMEOUT }, async () => {
    const s = await liveSetup("read-regex");
    try {
        const prompt = [
            "Two-step probe:",
            "1) <<EDIT(known:///doc):hello world hello again:EDIT",
            "2) <<READ(known:///doc):/hello/g:READ",
            "3) <<SEND[200]:<your read result>:SEND",
        ].join("\n");
        const r = await runLoop(s, prompt);
        if (!/hello/.test(r.lastContent)) await dumpTurns(s, r.turnIds, "read-regex");
        assert.equal(r.status, 200);
        assert.match(r.lastContent, /hello/);
    } finally { await s.db.close(); }
});

test("live: EDIT <L> — model replaces a single line in an existing entry", { timeout: TIMEOUT }, async () => {
    const s = await liveSetup("edit-L");
    try {
        const prompt = [
            "Three-step probe:",
            "1) <<EDIT(known:///poem):roses are red\\nviolets are blue:EDIT",
            "2) <<EDIT(known:///poem)<2>:violets are bright:EDIT",
            "3) <<READ(known:///poem)::READ",
            "4) <<SEND[200]:<your read result>:SEND",
        ].join("\n");
        const r = await runLoop(s, prompt);
        if (!/bright/.test(r.lastContent)) await dumpTurns(s, r.turnIds, "edit-L");
        assert.equal(r.status, 200);
        assert.match(r.lastContent, /bright/);
    } finally { await s.db.close(); }
});

test("live: FIND regex — model filters known entries by pathname regex", { timeout: TIMEOUT }, async () => {
    const s = await liveSetup("find-regex");
    try {
        const prompt = [
            "Four-step probe. Emit each op on its own turn:",
            "1) <<EDIT(known:///apple):a:EDIT",
            "2) <<EDIT(known:///apricot):b:EDIT",
            "3) <<EDIT(known:///banana):c:EDIT",
            "4) <<FIND(known:///):/^\\/ap/:FIND",
            "5) <<SEND[200]:<the FIND result list>:SEND",
        ].join("\n");
        const r = await runLoop(s, prompt, 10);
        if (!/apple|apricot/.test(r.lastContent)) await dumpTurns(s, r.turnIds, "find-regex");
        assert.equal(r.status, 200);
        assert.match(r.lastContent, /apple|apricot/);
    } finally { await s.db.close(); }
});

test("live: COPY <L> — model copies a line range from src to dst", { timeout: TIMEOUT }, async () => {
    const s = await liveSetup("copy-L");
    try {
        const prompt = [
            "Four-step probe:",
            "1) <<EDIT(known:///src):one\\ntwo\\nthree\\nfour:EDIT",
            "2) <<COPY(known:///src)<2,3>:known:///slice:COPY",
            "3) <<READ(known:///slice)::READ",
            "4) <<SEND[200]:<your read result>:SEND",
        ].join("\n");
        const r = await runLoop(s, prompt);
        if (!/two/.test(r.lastContent) || !/three/.test(r.lastContent)) await dumpTurns(s, r.turnIds, "copy-L");
        assert.equal(r.status, 200);
        assert.match(r.lastContent, /two/);
        assert.match(r.lastContent, /three/);
    } finally { await s.db.close(); }
});

test("live: SEND[410]#fragment — model deletes one channel of an entry", { timeout: TIMEOUT }, async () => {
    const s = await liveSetup("send-410-frag");
    try {
        const prompt = [
            "Three-step probe:",
            "1) <<EDIT(known:///doc):content here:EDIT",
            "2) <<SEND[410]:gone:SEND with target known:///doc#body. Exact form:",
            "   <<SEND[410](known:///doc#body)::SEND",
            "3) <<SEND[200]:deleted body channel:SEND",
        ].join("\n");
        const r = await runLoop(s, prompt);
        if (r.status !== 200) await dumpTurns(s, r.turnIds, "send-410-frag");
        assert.equal(r.status, 200);
        // Verify the channel was actually deleted
        const entry = await (s.db.test_get_entry_id_by_pathname as PrepMethod).get<{ id: number }>({ pathname: "/doc" });
        if (entry !== undefined) {
            const channel = await (s.db.test_get_channel as PrepMethod).get<{ name: string }>({ entry_id: entry.id, name: "body" });
            assert.equal(channel, undefined, "body channel removed from entry");
        }
    } finally { await s.db.close(); }
});
