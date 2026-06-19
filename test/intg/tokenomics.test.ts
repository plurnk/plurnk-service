import test from "node:test";
import assert from "node:assert/strict";
import type { PrepMethod } from "../../src/core/Db.ts";
import type { EditStatement, UrlPath, PlurnkStatement } from "@plurnk/plurnk-grammar";
import Engine from "../../src/core/Engine.ts";
import SchemeRegistry from "../../src/core/SchemeRegistry.ts";
import { openMigrated, insertSession, insertRun, insertLoop, insertTurn, DEFAULT_MIMETYPES, packetSection } from "./_helpers.ts";
import { Mock } from "@plurnk/plurnk-providers";
import { urlPath as anyUrl, editStmt as anyEdit, sendStmt } from "./_dsl.ts";

// Tokenomics Phase 1: real token counts are stored at write time (SPEC §tokenomics).
// entry_channels.tokens comes from the entry write helpers via ctx.tokenize;
// log_entries.tokens from Engine.#writeLog over tx+rx. Both route through the
// engine's #tokenize — here the divisor tripwire default (no provider wired in
// the bare Engine), so the expected counts are deterministic: ceil(len/4).

const urlPath = (pathname: string): UrlPath => ({
    kind: "url", raw: `known:///${pathname}`, scheme: "known",
    username: null, password: null, hostname: null, port: null,
    pathname: `/${pathname}`, params: {}, fragment: null,
});

const editStmt = (pathname: string, body: string): EditStatement => ({
    op: "EDIT", suffix: "", signal: null,
    target: urlPath(pathname), lineMarker: null, body,
    position: { line: 1, column: 1 },
});

const setup = async () => {
    const db = await openMigrated();
    const sessionId = await insertSession(db, `tok-${crypto.randomUUID()}`);
    const runId = await insertRun(db, sessionId);
    const loopId = await insertLoop(db, runId, 1, "p");
    const turnId = await insertTurn(db, loopId, 1, 200);
    const engine = new Engine({ db, schemes: new SchemeRegistry(), mimetypes: DEFAULT_MIMETYPES });
    return { db, engine, sessionId, runId, loopId, turnId };
};

test("[§tokenomics-tokens-stored-at-write] EDIT stores entry_channels.tokens from the active tokenizer", async () => {
    const { db, engine, sessionId, runId, loopId, turnId } = await setup();
    try {
        const content = "alpha beta gamma delta";
        const result = await engine.dispatch({
            statement: editStmt("/notes", content),
            sessionId, runId, loopId, turnId, sequence: 1, origin: "model",
        }) as { status: number; entryId: number | null };
        assert.equal(result.status, 201);
        assert.ok(result.entryId !== null);
        const ch = await (db.tok_channel_tokens as PrepMethod).get<{ tokens: number }>({ entry_id: result.entryId, name: "body" });
        // Bare Engine uses the divisor tripwire: ceil(len/4).
        assert.equal(ch?.tokens, Math.ceil(content.length / 4));
        assert.ok((ch?.tokens ?? 0) > 0, "tokens populated at write, not the old hardcoded 0");
    } finally { await db.close(); }
});

test("[§tokenomics-tokens-stored-at-write] dispatched op stores log_entries.tokens from tx+rx", async () => {
    const { db, engine, sessionId, runId, loopId, turnId } = await setup();
    try {
        let logEntryId = 0;
        await engine.dispatch({
            statement: editStmt("/x", "hello world"),
            sessionId, runId, loopId, turnId, sequence: 1, origin: "model",
            onDispatch: (id: number) => { logEntryId = id; },
        });
        assert.ok(logEntryId > 0, "a log entry was written");
        const row = await (db.tok_log_tokens as PrepMethod).get<{ tokens: number }>({ id: logEntryId });
        assert.ok((row?.tokens ?? 0) > 0, "log row tokens populated from tx+rx, not 0");
    } finally { await db.close(); }
});

test("[§tokenomics-tokens-stored-at-write] entry_channels.tokens uses the injected provider tokenizer, not the divisor fallback", async () => {
    const db = await openMigrated();
    try {
        const sessionId = await insertSession(db, `tok-prov-${crypto.randomUUID()}`);
        const runId = await insertRun(db, sessionId);
        const loopId = await insertLoop(db, runId, 1, "p");
        const turnId = await insertTurn(db, loopId, 1, 200);
        // Inject a distinctive tokenizer (constant 100) — unmistakably not ceil(len/4).
        const engine = new Engine({ db, schemes: new SchemeRegistry(), mimetypes: DEFAULT_MIMETYPES, tokenize: () => 100 });
        const result = await engine.dispatch({
            statement: editStmt("/notes", "alpha beta gamma"),
            sessionId, runId, loopId, turnId, sequence: 1, origin: "model",
        }) as { status: number; entryId: number | null };
        const ch = await (db.tok_channel_tokens as PrepMethod).get<{ tokens: number }>({ entry_id: result.entryId, name: "body" });
        assert.equal(ch?.tokens, 100, "tokens come from the injected provider tokenizer, not the chars/4 fallback");
    } finally { await db.close(); }
});

test("[§tokenomics-render-weight-budget] budget headline shows ceiling/usage/free, measured from the assembled packet", async () => {
    const db = await openMigrated();
    try {
        const sessionId = await insertSession(db, `tok-bud-${crypto.randomUUID()}`);
        const runId = await insertRun(db, sessionId);
        const loopId = await insertLoop(db, runId, 1, "p");
        const engine = new Engine({ db, schemes: new SchemeRegistry(), mimetypes: DEFAULT_MIMETYPES });
        const provider = new Mock({ contextSize: 100000, responses: [{ assistant: { content: "", reasoning: null, ops: [sendStmt(200)] } }] });
        const result = await engine.runTurn({ provider, sessionId, runId, loopId, messages: [{ role: "system", content: "SD" }, { role: "user", content: "go" }] });
        const row = await (db.test_get_packet as PrepMethod).get<{ packet: string }>({ id: result.turnId });
        const budget = packetSection(JSON.parse(row!.packet), "budget");
        const m = budget.match(/ceiling (\d+) · usage (\d+) \(\d+%\) · free (\d+)/);
        assert.ok(m, `budget headline carries ceiling/usage/free; got: ${budget}`);
        const ceiling = Number(m![1]); const usage = Number(m![2]); const free = Number(m![3]);
        assert.ok(usage > 0, "usage is the measured render-weight, not zero or a leftover placeholder");
        assert.equal(usage + free, ceiling, "usage + free = ceiling (the accounting closes)");
    } finally { await db.close(); }
});

test("[§tokenomics-turn-totals] budget groups render-weight by turn, oldest first", async () => {
    const db = await openMigrated();
    try {
        const sessionId = await insertSession(db, `tok-turn-${crypto.randomUUID()}`);
        const runId = await insertRun(db, sessionId);
        const loopId = await insertLoop(db, runId, 1, "p");
        const engine = new Engine({ db, schemes: new SchemeRegistry(), mimetypes: DEFAULT_MIMETYPES });
        const reply = (ops: PlurnkStatement[]) => new Mock({ contextSize: 100000, responses: [{ assistant: { content: "", reasoning: null, ops } }] });
        // Two turns each write to the log → two distinct loop/turn coordinates (1/1, 1/2).
        await engine.runTurn({ provider: reply([anyEdit(anyUrl("known", "a"), "alpha beta gamma delta"), sendStmt(200)]), sessionId, runId, loopId, messages: [{ role: "system", content: "SD" }, { role: "user", content: "go" }] });
        await engine.runTurn({ provider: reply([anyEdit(anyUrl("known", "b"), "epsilon zeta eta theta"), sendStmt(200)]), sessionId, runId, loopId, messages: [{ role: "system", content: "SD" }, { role: "user", content: "go" }] });
        const t3 = await engine.runTurn({ provider: reply([sendStmt(200)]), sessionId, runId, loopId, messages: [{ role: "system", content: "SD" }, { role: "user", content: "go" }] });
        const budget = packetSection(JSON.parse((await (db.test_get_packet as PrepMethod).get<{ packet: string }>({ id: t3.turnId }))!.packet), "budget");
        assert.match(budget, /Turns:\n\| turn \| tokens \|/, "per-turn table present");
        assert.match(budget, /\| 1\/1 \|/, "turn 1/1 row present");
        assert.match(budget, /\| 1\/2 \|/, "turn 1/2 row present");
        assert.ok(budget.indexOf("| 1/1 |") < budget.indexOf("| 1/2 |"), "oldest turn first — the grinder's rollback order");
    } finally { await db.close(); }
});

test("[§tokenomics-largest-entries] budget lists the heaviest log entries by their log:/// handle, heaviest first", async () => {
    const db = await openMigrated();
    try {
        const sessionId = await insertSession(db, `tok-heavy-${crypto.randomUUID()}`);
        const runId = await insertRun(db, sessionId);
        const loopId = await insertLoop(db, runId, 1, "p");
        const engine = new Engine({ db, schemes: new SchemeRegistry(), mimetypes: DEFAULT_MIMETYPES });
        const reply = (ops: PlurnkStatement[]) => new Mock({ contextSize: 100000, responses: [{ assistant: { content: "", reasoning: null, ops } }] });
        // A heavy edit (seq 1) and a tiny edit (seq 2) in one turn; read the next turn's budget.
        const heavy = "lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor incididunt ut labore et dolore magna aliqua ".repeat(2);
        await engine.runTurn({ provider: reply([anyEdit(anyUrl("known", "big"), heavy), anyEdit(anyUrl("known", "small"), "x"), sendStmt(200)]), sessionId, runId, loopId, messages: [{ role: "system", content: "SD" }, { role: "user", content: "go" }] });
        const t2 = await engine.runTurn({ provider: reply([sendStmt(200)]), sessionId, runId, loopId, messages: [{ role: "system", content: "SD" }, { role: "user", content: "go" }] });
        const budget = packetSection(JSON.parse((await (db.test_get_packet as PrepMethod).get<{ packet: string }>({ id: t2.turnId }))!.packet), "budget");
        assert.match(budget, /Heaviest items:\n\| item \| tokens \|/, "heaviest-items table present");
        // Every listed item is a log:/// handle (log items, not catalog entries), heaviest-first.
        const rows = budget.split("\n").filter((l) => /^\| log:\/\/\//.test(l));
        assert.ok(rows.length >= 2, `at least two entries listed; got ${rows.length}`);
        const tokens = rows.map((l) => Number(l.split("|")[2].trim()));
        for (let i = 1; i < tokens.length; i++) {
            assert.ok(tokens[i - 1] >= tokens[i], `heaviest first — non-increasing: ${tokens.join(", ")}`);
        }
        assert.ok(tokens[0] > tokens[tokens.length - 1], "the heavy edit genuinely outweighs the tiny ones");
    } finally { await db.close(); }
});

test("[§tokenomics-context-percent] budget headline shows usage as a percent of the ceiling", async () => {
    const db = await openMigrated();
    try {
        const sessionId = await insertSession(db, `tok-pct-${crypto.randomUUID()}`);
        const runId = await insertRun(db, sessionId);
        const loopId = await insertLoop(db, runId, 1, "p");
        const engine = new Engine({ db, schemes: new SchemeRegistry(), mimetypes: DEFAULT_MIMETYPES });
        const provider = new Mock({ contextSize: 100000, responses: [{ assistant: { content: "", reasoning: null, ops: [sendStmt(200)] } }] });
        const result = await engine.runTurn({ provider, sessionId, runId, loopId, messages: [{ role: "system", content: "SD" }, { role: "user", content: "go" }] });
        const budget = packetSection(JSON.parse((await (db.test_get_packet as PrepMethod).get<{ packet: string }>({ id: result.turnId }))!.packet), "budget");
        const m = budget.match(/ceiling (\d+) · usage (\d+) \((\d+)%\) · free (\d+)/);
        assert.ok(m, `headline carries usage percent; got: ${budget}`);
        const ceiling = Number(m![1]); const usage = Number(m![2]); const percent = Number(m![3]);
        assert.equal(percent, Math.round((usage / ceiling) * 100), "percent reconciles to usage/ceiling");
    } finally { await db.close(); }
});

test("[§tokenomics-over-budget-floor] over budget, free floors at 0 and percent passes 100 — the overshoot is honest", async () => {
    const db = await openMigrated();
    try {
        const sessionId = await insertSession(db, `tok-over-${crypto.randomUUID()}`);
        const runId = await insertRun(db, sessionId);
        const loopId = await insertLoop(db, runId, 1, "p");
        const engine = new Engine({ db, schemes: new SchemeRegistry(), mimetypes: DEFAULT_MIMETYPES });
        // Tiny window → ceiling 9; the packet's own scaffolding alone blows past it.
        const provider = new Mock({ contextSize: 10, responses: [{ assistant: { content: "", reasoning: null, ops: [sendStmt(200)] } }] });
        const result = await engine.runTurn({ provider, sessionId, runId, loopId, messages: [{ role: "system", content: "SD" }, { role: "user", content: "go" }] });
        const budget = packetSection(JSON.parse((await (db.test_get_packet as PrepMethod).get<{ packet: string }>({ id: result.turnId }))!.packet), "budget");
        const m = budget.match(/ceiling (\d+) · usage (\d+) \((\d+)%\) · free (\d+)/);
        assert.ok(m, `headline present; got: ${budget}`);
        const usage = Number(m![2]); const percent = Number(m![3]); const free = Number(m![4]);
        assert.ok(usage > 9, `usage ${usage} exceeds the ceiling of 9`);
        assert.equal(free, 0, "free floors at 0 — never negative");
        assert.ok(percent > 100, `percent ${percent} honestly passes 100 when over budget`);
    } finally { await db.close(); }
});
