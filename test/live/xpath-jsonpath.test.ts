// Live xpath/jsonpath coverage. Each test SEEDS its entry (the model never writes
// the JSON/HTML), so a green means the model actually drove the matcher — not that
// it recited a value it had just authored. The wildcard + compose-chain green the full stack —
// addressing, authority-fold (§scheme-address), matcher (verified deterministically: $.host => 200
// "db.internal"), structural <L>. The two single-value probes are RED under live gemma: the loop SENDs
// before it consumes its own READ result. Per [[never blame the model]] that's a packet question —
// deferred to the post-epic live/demo sweep (AGENTS § Demo-surfaced backlog), not a model verdict.

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
import { parseDsl } from "../intg/_rpc.ts";

const TIMEOUT = 240_000;

const makeMimetypes = async (provider: Provider): Promise<Mimetypes> => {
    const m = new Mimetypes();
    await m.ready();
    return m;
};

const SYSTEM_PROMPT = await readFile(Paths.instructionsSystem, "utf8");

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

// Seed the entry a READ of `reference` addresses, resolving (scheme, pathname) through the SAME
// grammar parse the READ uses — so seed and read can't drift on the RFC-3986 authority/path split
// (known:///x => empty authority + path-abempty "/x"). The model never WRITES the content, so a green
// proves it drove the matcher, not its memory.
const seed = async (s: LiveSetup, reference: string, content: string, mimetype: string): Promise<void> => {
    const read = parseDsl(`<<PLAN::PLAN\n<<READ(${reference}):x:READ`).find((st) => st.op === "READ") as { target: { scheme: string | null; pathname: string } } | undefined;
    if (read === undefined) throw new Error(`seed: unparseable reference ${reference}`);
    const e = await (s.db.crud_insert_session_entry as PrepMethod).get<{ id: number }>({ session_id: s.sessionId, scheme: read.target.scheme, pathname: read.target.pathname });
    if (e === undefined) throw new Error("seed: insert returned no row");
    await (s.db.crud_write_channel as PrepMethod).run({ entry_id: e.id, name: "body", content, mimetype, tokens: 0, state: "static" });
};

test("live: jsonpath $.field on known:///config.json extracts a value", { timeout: TIMEOUT }, async () => {
    const s = await liveSetup("jsonpath-field");
    try {
        await seed(s, "known:///config.json", '{"host":"db.internal","pool":5}', "application/json");
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
        await seed(s, "known:///team.json", '{"users":[{"name":"Alice"},{"name":"Bob"}]}', "application/json");
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

test("live: xpath //h1/text() on known:///page.html extracts heading text", { timeout: TIMEOUT }, async () => {
    const s = await liveSetup("xpath-h1");
    try {
        await seed(s, "known:///page.html", "<html><body><h1>Welcome</h1></body></html>", "text/html");
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
        await seed(s, "known:///team.json", '{"users":[{"name":"Alice"},{"name":"Bob"}]}', "application/json");
        const prompt = [
            "Three-step probe. The entry known:///team.json already holds a JSON object with a users array.",
            "1) <<READ(known:///team.json):$.users[*].name:READ",
            "   (the result lands at log:///1/1/2 as a JSON array of match rows)",
            "2) <<READ(log:///1/1/2)<1>::READ",
            "   (structural <L> picks the 1st match; result is [{line,matched:Alice}])",
            "3) <<SEND[200]:Alice:SEND",
        ].join("\n");
        const r = await runLoop(s, prompt);
        assert.equal(r.status, 200);
        assert.match(r.lastContent, /Alice/);
    } finally { await s.db.close(); }
});
