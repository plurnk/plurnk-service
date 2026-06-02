import test from "node:test";
import assert from "node:assert/strict";
import type { PrepMethod } from "../../src/core/Db.ts";
import type { EditStatement, UrlPath } from "@plurnk/plurnk-grammar";
import Engine from "../../src/core/Engine.ts";
import SchemeRegistry from "../../src/core/SchemeRegistry.ts";
import { openMigrated, insertSession, insertRun, insertLoop, insertTurn, DEFAULT_MIMETYPES } from "./_helpers.ts";
import { Mock } from "@plurnk/plurnk-providers";
import { urlPath as anyUrl, editStmt as anyEdit, sendStmt } from "./_dsl.ts";

// Tokenomics Phase 1: real token counts are stored at write time (SPEC §14.2).
// entry_channels.tokens comes from the entry write helpers via ctx.tokenize;
// log_entries.tokens from Engine.#writeLog over tx+rx. Both route through the
// engine's #tokenize — here the divisor tripwire default (no provider wired in
// the bare Engine), so the expected counts are deterministic: ceil(len/4).

const urlPath = (pathname: string): UrlPath => ({
    kind: "url", raw: `known://${pathname}`, scheme: "known",
    username: null, password: null, hostname: null, port: null,
    pathname, params: {}, fragment: null,
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

test("[§14.2-tokens-stored-at-write] EDIT stores entry_channels.tokens from the active tokenizer", async () => {
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

test("[§14.2-tokens-stored-at-write] dispatched op stores log_entries.tokens from tx+rx", async () => {
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

test("[§14.2-tokens-stored-at-write] entry_channels.tokens uses the injected provider tokenizer, not the divisor fallback", async () => {
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

test("[§14.2-render-weight-budget] budget headline shows ceiling/usage/free, measured from the assembled packet", async () => {
    const db = await openMigrated();
    try {
        const sessionId = await insertSession(db, `tok-bud-${crypto.randomUUID()}`);
        const runId = await insertRun(db, sessionId);
        const loopId = await insertLoop(db, runId, 1, "p");
        const engine = new Engine({ db, schemes: new SchemeRegistry(), mimetypes: DEFAULT_MIMETYPES });
        const provider = new Mock({ contextSize: 100000, responses: [{ assistant: { content: "", reasoning: null, ops: [sendStmt(200)] } }] });
        const result = await engine.runTurn({ provider, sessionId, runId, loopId, messages: [{ role: "system", content: "SD" }, { role: "user", content: "go" }] });
        const row = await (db.test_get_packet as PrepMethod).get<{ packet: string }>({ id: result.turnId });
        const budget = (JSON.parse(row!.packet) as { user: { telemetry: { budget: string } } }).user.telemetry.budget;
        const m = budget.match(/ceiling (\d+) · usage (\d+) \(\d+%\) · free (\d+)/);
        assert.ok(m, `budget headline carries ceiling/usage/free; got: ${budget}`);
        const ceiling = Number(m![1]); const usage = Number(m![2]); const free = Number(m![3]);
        assert.ok(usage > 0, "usage is the measured render-weight, not zero or a leftover placeholder");
        assert.equal(usage + free, ceiling, "usage + free = ceiling (the accounting closes)");
    } finally { await db.close(); }
});

test("[§14.2-per-scheme-balance] budget breaks the log down by scheme, render-weight", async () => {
    const db = await openMigrated();
    try {
        const sessionId = await insertSession(db, `tok-scheme-${crypto.randomUUID()}`);
        const runId = await insertRun(db, sessionId);
        const loopId = await insertLoop(db, runId, 1, "p");
        const engine = new Engine({ db, schemes: new SchemeRegistry(), mimetypes: DEFAULT_MIMETYPES });
        // Turn 1: act on two schemes → two log entries (known, unknown). Turn 2's
        // budget reflects the run's log, so the per-scheme table carries both.
        const t1 = new Mock({ contextSize: 100000, responses: [{ assistant: { content: "", reasoning: null, ops: [
            anyEdit(anyUrl("known", "a"), "alpha beta gamma delta epsilon zeta"),
            anyEdit(anyUrl("unknown", "b"), "x"),
            sendStmt(200),
        ] } }] });
        await engine.runTurn({ provider: t1, sessionId, runId, loopId, messages: [{ role: "system", content: "SD" }, { role: "user", content: "go" }] });
        const t2prov = new Mock({ contextSize: 100000, responses: [{ assistant: { content: "", reasoning: null, ops: [sendStmt(200)] } }] });
        const t2 = await engine.runTurn({ provider: t2prov, sessionId, runId, loopId, messages: [{ role: "system", content: "SD" }, { role: "user", content: "go" }] });
        const budget = (JSON.parse((await (db.test_get_packet as PrepMethod).get<{ packet: string }>({ id: t2.turnId }))!.packet) as { user: { telemetry: { budget: string } } }).user.telemetry.budget;
        assert.match(budget, /\| scheme \| entries \| tokens \|/, "per-scheme log table present");
        assert.match(budget, /\| known \|/, "groups the known-scheme log entries");
        assert.match(budget, /\| unknown \|/, "groups the unknown-scheme log entries");
    } finally { await db.close(); }
});

test("[§14.2-hot-switch-recompute] a session model change recomputes stored tokens against the new tokenizer", async () => {
    const db = await openMigrated();
    try {
        // DEFERRED (§14.2): switching the session's model should walk entry_channels
        // + log_entries and recompute tokens against the new tokenizer. No recompute
        // path exists; this red flips green when it lands.
        const engine = new Engine({ db, schemes: new SchemeRegistry() });
        assert.notEqual(
            (engine as unknown as Record<string, unknown>).recomputeTokens, undefined,
            "engine must expose a token-recompute path for hot model switch (§14.2) — DEFERRED/UNBUILT",
        );
    } finally { await db.close(); }
});

test("[§14.2-context-percent] budget headline shows usage as a percent of the ceiling", async () => {
    const db = await openMigrated();
    try {
        const sessionId = await insertSession(db, `tok-pct-${crypto.randomUUID()}`);
        const runId = await insertRun(db, sessionId);
        const loopId = await insertLoop(db, runId, 1, "p");
        const engine = new Engine({ db, schemes: new SchemeRegistry(), mimetypes: DEFAULT_MIMETYPES });
        const provider = new Mock({ contextSize: 100000, responses: [{ assistant: { content: "", reasoning: null, ops: [sendStmt(200)] } }] });
        const result = await engine.runTurn({ provider, sessionId, runId, loopId, messages: [{ role: "system", content: "SD" }, { role: "user", content: "go" }] });
        const budget = (JSON.parse((await (db.test_get_packet as PrepMethod).get<{ packet: string }>({ id: result.turnId }))!.packet) as { user: { telemetry: { budget: string } } }).user.telemetry.budget;
        const m = budget.match(/ceiling (\d+) · usage (\d+) \((\d+)%\) · free (\d+)/);
        assert.ok(m, `headline carries usage percent; got: ${budget}`);
        const ceiling = Number(m![1]); const usage = Number(m![2]); const percent = Number(m![3]);
        assert.equal(percent, Math.round((usage / ceiling) * 100), "percent reconciles to usage/ceiling");
    } finally { await db.close(); }
});
