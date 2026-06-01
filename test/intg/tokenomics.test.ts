import test from "node:test";
import assert from "node:assert/strict";
import type { PrepMethod } from "../../src/core/Db.ts";
import type { EditStatement, UrlPath } from "@plurnk/plurnk-grammar";
import Engine from "../../src/core/Engine.ts";
import SchemeRegistry from "../../src/core/SchemeRegistry.ts";
import { openMigrated, insertSession, insertRun, insertLoop, insertTurn, DEFAULT_MIMETYPES } from "./_helpers.ts";

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

test("[§14.2-tokenomics-v0] EDIT stores entry_channels.tokens from the active tokenizer", async () => {
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

test("[§14.2-tokenomics-v0] dispatched op stores log_entries.tokens from tx+rx", async () => {
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
