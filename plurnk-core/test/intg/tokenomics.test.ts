import test from "node:test";
import assert from "node:assert/strict";
import type { PrepMethod } from "../../src/core/Db.ts";
import type { EditStatement, UrlPath, PlurnkStatement } from "@plurnk/plurnk-grammar";
import Engine from "../../src/core/Engine.ts";
import SchemeRegistry from "../../src/core/SchemeRegistry.ts";
import { openMigrated, insertSession, insertRun, insertLoop, insertTurn, DEFAULT_MIMETYPES, packetSection } from "./_helpers.ts";
import { Mock } from "@plurnk/plurnk-providers";
import { urlPath as anyUrl, editStmt as anyEdit, sendStmt } from "./_dsl.ts";

// The budget assertions here pin the TABULAR baseline; #440's default is the mermaid form ([§budget-mermaid]).
process.env.PLURNK_SERVICE_BUDGET_MERMAID = "off";

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

test("[§tokenomics-tokens-stored-at-write] EDIT stores entry_channels.tokens from the model-agnostic ruler", async () => {
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
        // The write-time stamp is the model-agnostic ruler (§tokenomics-agnostic-ruler): ceil(len/2).
        assert.equal(ch?.tokens, Math.ceil(content.length / 2));
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

test("[§tokenomics-tokens-stored-at-write] entry_channels.tokens honors an injected ruler override (test seam)", async () => {
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
        assert.equal(ch?.tokens, 100, "the write stamp honors the injected tokenize (test seam); production injects the chars/2 ruler");
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
        const m = budget.match(/Token Ceiling (\d+) · Token Usage (\d+) \((?:<1|\d+)%\) · Tokens Free (\d+)/);
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
        // A window the floor fits but the fat log pushes past 50% occupancy — the tables render
        // only under pressure now (§tokenomics-pressure-gates-on-occupancy).
        const reply = (ops: PlurnkStatement[]) => new Mock({ contextSize: 3000, responses: [{ assistant: { content: "", reasoning: null, ops } }] });
        // Two turns each write to the log → two distinct loop/turn coordinates (1/1, 1/2).
        await engine.runTurn({ provider: reply([anyEdit(anyUrl("known", "a"), "alpha beta gamma delta ".repeat(80)), sendStmt(200)]), sessionId, runId, loopId, messages: [{ role: "system", content: "SD" }, { role: "user", content: "go" }] });
        await engine.runTurn({ provider: reply([anyEdit(anyUrl("known", "b"), "epsilon zeta eta theta ".repeat(80)), sendStmt(200)]), sessionId, runId, loopId, messages: [{ role: "system", content: "SD" }, { role: "user", content: "go" }] });
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
        // A window sized so the fat log lands BETWEEN the 50% occupancy gate and the grinder: too
        // tight and the grinder folds the fixture itself (folded rows collapse occupancy back under
        // the gate — exactly what the 0.74.49 teaching growth exposed at 3000).
        const reply = (ops: PlurnkStatement[]) => new Mock({ contextSize: 6500, responses: [{ assistant: { content: "", reasoning: null, ops } }] }); // unfolded ≈4.6k (heavy row 3.6k open) → ~78%: above the gate, under the grinder
        // A heavy edit (seq 1) and a tiny edit (seq 2) in one turn; read the next turn's budget.
        const heavy = "lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor incididunt ut labore et dolore magna aliqua ".repeat(60);
        await engine.runTurn({ provider: reply([anyEdit(anyUrl("known", "big"), heavy), anyEdit(anyUrl("known", "small"), "x"), sendStmt(200)]), sessionId, runId, loopId, messages: [{ role: "system", content: "SD" }, { role: "user", content: "go" }] });
        const t2 = await engine.runTurn({ provider: reply([sendStmt(200)]), sessionId, runId, loopId, messages: [{ role: "system", content: "SD" }, { role: "user", content: "go" }] });
        const budget = packetSection(JSON.parse((await (db.test_get_packet as PrepMethod).get<{ packet: string }>({ id: t2.turnId }))!.packet), "budget");
        assert.match(budget, /Heaviest items \(FOLD targets — folding reclaims their tokens\):\n\| item \| tokens \|/, "heaviest-items table present, verb attached — the lever is named where the targets are listed");
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
        const m = budget.match(/Token Ceiling (\d+) · Token Usage (\d+) \((<1|\d+)%\) · Tokens Free (\d+)/);
        assert.ok(m, `headline carries usage percent; got: ${budget}`);
        const ceiling = Number(m![1]); const usage = Number(m![2]); const pct = m![3];
        const exact = (usage / ceiling) * 100;
        // The budget-% fix: a positive usage under 1% renders "<1", not a rounded-down 0%.
        if (exact > 0 && exact < 1) {
            assert.equal(pct, "<1", `sub-1% usage renders as <1, not 0%; exact=${exact}`);
        } else {
            assert.equal(Number(pct), Math.round(exact), "percent reconciles to round(usage/ceiling)");
        }
    } finally { await db.close(); }
});

test("[§tokenomics-over-budget-floor] the UN-FOLDABLE hard-413 record renders the overshoot honestly (free floors at 0, percent passes 100) — never delivered to the model", async () => {
    const db = await openMigrated();
    try {
        const sessionId = await insertSession(db, `tok-over-${crypto.randomUUID()}`);
        const runId = await insertRun(db, sessionId);
        const loopId = await insertLoop(db, runId, 1, "p");
        const prevPart = ["CONTEXT_WINDOW", "REASONING", "COMPLETION", "SAFETY"].map((k) => process.env[`PLURNK_SERVICE_${k}`]);
        process.env.PLURNK_SERVICE_CONTEXT_WINDOW = "9";
        process.env.PLURNK_SERVICE_REASONING = "0";
        process.env.PLURNK_SERVICE_COMPLETION = "0";
        process.env.PLURNK_SERVICE_SAFETY = "0";
        const engine = new Engine({ db, schemes: new SchemeRegistry(), mimetypes: DEFAULT_MIMETYPES });
        ["CONTEXT_WINDOW", "REASONING", "COMPLETION", "SAFETY"].forEach((k, i) => {
            if (prevPart[i] === undefined) delete process.env[`PLURNK_SERVICE_${k}`]; else process.env[`PLURNK_SERVICE_${k}`] = prevPart[i];
        });
        // Pinned CONTEXT_WINDOW 9 under a 10 window, zero reserves → promptBudget 9; the packet's own
        // scaffolding alone blows past it and CANNOT fold under
        // (turn 1, nothing to roll back) → the un-foldable corner case. The loop hard-413s rather than
        // DELIVER an over-budget packet; the stored record below is engine forensics, NOT a packet the
        // model saw — the grinder never sends a >100% packet (a delivered budget is always ≤100%).
        const provider = new Mock({ contextSize: 10, responses: [{ assistant: { content: "", reasoning: null, ops: [sendStmt(200)] } }] });
        const result = await engine.runTurn({ provider, sessionId, runId, loopId, messages: [{ role: "system", content: "SD" }, { role: "user", content: "go" }] });
        assert.equal(result.status, 413, "un-foldable → hard-413; the loop fails rather than deliver an over-budget packet");
        // The STORED failure record renders the overshoot honestly — never clamped to hide the degenerate state.
        const budget = packetSection(JSON.parse((await (db.test_get_packet as PrepMethod).get<{ packet: string }>({ id: result.turnId }))!.packet), "budget");
        const m = budget.match(/Token Ceiling (\d+) · Token Usage (\d+) \((\d+)%\) · Tokens Free (\d+)/);
        assert.ok(m, `headline present; got: ${budget}`);
        const usage = Number(m![2]); const percent = Number(m![3]); const free = Number(m![4]);
        assert.ok(usage > 9, `usage ${usage} exceeds the ceiling of 9`);
        assert.equal(free, 0, "free floors at 0 — never negative");
        assert.ok(percent > 100, `percent ${percent} honestly recorded past 100 in the failure record`);
    } finally { await db.close(); }
});

test("[§tokenomics-pressure-gates-on-occupancy] a high-headroom window renders NO curation tables — headline only", async () => {
    // #308 (the bench grok run): the Turns/Heaviest tables are a standing FOLD-target list; a
    // model with 75%+ free burned turns on token hygiene. Below half the ceiling, numbers only.
    const db = await openMigrated();
    try {
        const sessionId = await insertSession(db, `tok-headroom-${crypto.randomUUID()}`);
        const runId = await insertRun(db, sessionId);
        const loopId = await insertLoop(db, runId, 1, "p");
        const engine = new Engine({ db, schemes: new SchemeRegistry(), mimetypes: DEFAULT_MIMETYPES });
        const reply = (ops: PlurnkStatement[]) => new Mock({ contextSize: 100000, responses: [{ assistant: { content: "", reasoning: null, ops } }] });
        await engine.runTurn({ provider: reply([anyEdit(anyUrl("known", "note"), "some content worth logging"), sendStmt(200)]), sessionId, runId, loopId, messages: [{ role: "system", content: "SD" }, { role: "user", content: "go" }] });
        const t2 = await engine.runTurn({ provider: reply([sendStmt(200)]), sessionId, runId, loopId, messages: [{ role: "system", content: "SD" }, { role: "user", content: "go" }] });
        const budget = packetSection(JSON.parse((await (db.test_get_packet as PrepMethod).get<{ packet: string }>({ id: t2.turnId }))!.packet), "budget");
        assert.match(budget, /Token Ceiling \d+/, "the headline gauge always renders");
        assert.doesNotMatch(budget, /Heaviest items/, "no FOLD-target list at low occupancy");
        assert.doesNotMatch(budget, /Turns:/, "no per-turn table at low occupancy");
        assert.doesNotMatch(budget, /Log entries:/, "no log-weight line at low occupancy — numbers only");
    } finally { await db.close(); }
});

test("[§tokenomics-content-hash-identity] content_hash is a stable per-content identity — identical content, identical hash; no per-model keying", async () => {
    const { contentHash } = await import("../../src/core/content-hash.ts");
    const h = contentHash("same bytes");
    assert.equal(h, contentHash("same bytes"), "deterministic: identical content → identical hash");
    assert.notEqual(h, contentHash("other bytes"), "distinct content → distinct hash");
    assert.match(h, /^[0-9a-f]{64}$/, "a sha256 hex identity");
});
