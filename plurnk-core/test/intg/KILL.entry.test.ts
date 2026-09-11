// {§kill-scope-entry} — KILL on an entry deletes it (or one #channel); the untaught KILL
// delete idiom is gone with the signal slot. Engine regression coverage.

import test from "node:test";
import assert from "node:assert/strict";
import type { KillStatement, MatcherBody, SendStatement } from "@plurnk/plurnk-contracts";
import Engine from "../../src/core/Engine.ts";
import SchemeRegistry from "../../src/core/SchemeRegistry.ts";
import Worker from "../../src/schemes/Worker.ts";
import { openMigrated, seedEnvelope, makeSchemeCtx, DEFAULT_MIMETYPES } from "./_helpers.ts";
import { urlPath, editStmt, killStmt, sendStmt } from "./_dsl.ts";

const setup = async () => {
    const db = await openMigrated();
    const env = await seedEnvelope(db, `ws-${crypto.randomUUID()}`, { producer: "client" });
    const engine = new Engine({ db, schemes: new SchemeRegistry(), mimetypes: DEFAULT_MIMETYPES });
    return { db, ...env, engine };
};

const dispatch = (engine: Engine, env: { workspaceId: number; workerId: number; loopId: number; turnId: number }, statement: SendStatement | KillStatement, sequence = 1) =>
    engine.dispatch({ statement, ...env, sequence, origin: "client" });

test("KILL(worker:///x) deletes the entry (side-effect; not model-facing)", async () => {
    const { db, workspaceId, workerId, loopId, turnId, engine } = await setup();
    try {
        await new Worker().edit(editStmt(urlPath("worker", "/doomed"), "tomorrow"), makeSchemeCtx({ db, workspaceId, workerId }));
        const beforeDelete = await db.test_get_entry_id_by_pathname.get<{ id: number }>({ pathname: "/doomed" });
        assert.ok(beforeDelete !== undefined);

        const r = await dispatch(engine, { workspaceId, workerId, loopId, turnId }, killStmt(urlPath("worker", "/doomed")));
        assert.equal(r.status, 200);

        const afterDelete = await db.test_get_entry_id_by_pathname.get<{ id: number }>({ pathname: "/doomed" });
        assert.equal(afterDelete, undefined, "entry removed");
    } finally { await db.close(); }
});

test("KILL on missing entry returns 404", async () => {
    const { db, workspaceId, workerId, loopId, turnId, engine } = await setup();
    try {
        const r = await dispatch(engine, { workspaceId, workerId, loopId, turnId }, killStmt(urlPath("worker", "/nope")));
        assert.equal(r.status, 404);
    } finally { await db.close(); }
});

test("KILL with #fragment deletes that channel only; entry remains", async () => {
    const { db, workspaceId, workerId, loopId, turnId, engine } = await setup();
    try {
        await new Worker().edit(editStmt(urlPath("worker", "/x"), "body"), makeSchemeCtx({ db, workspaceId, workerId }));
        const r = await dispatch(engine, { workspaceId, workerId, loopId, turnId }, killStmt(urlPath("worker", "/x", "body")));
        assert.equal(r.status, 200);

        const stillThere = await db.test_get_entry_id_by_pathname.get<{ id: number }>({ pathname: "/x" });
        assert.ok(stillThere !== undefined, "entry row still present");
        const channel = await db.test_get_channel.get<{ name: string }>({ entry_id: stillThere?.id, name: "body" });
        assert.equal(channel, undefined, "body channel was removed");
    } finally { await db.close(); }
});

test("KILL with #fragment on missing channel returns 404", async () => {
    const { db, workspaceId, workerId, loopId, turnId, engine } = await setup();
    try {
        await new Worker().edit(editStmt(urlPath("worker", "/y"), "body"), makeSchemeCtx({ db, workspaceId, workerId }));
        const r = await dispatch(engine, { workspaceId, workerId, loopId, turnId }, killStmt(urlPath("worker", "/y", "nonexistent")));
        assert.equal(r.status, 404);
    } finally { await db.close(); }
});

// {§kill-scope-entry}
test("a scoped KILL deletes one span of an entry through the EDIT path; the log row records the KILL", async () => {
    const { db, workspaceId, workerId, loopId, turnId, engine } = await setup();
    try {
        await new Worker().edit(editStmt(urlPath("worker", "/notes.md"), "alpha\nbeta\ngamma"), makeSchemeCtx({ db, workspaceId, workerId }));
        const r = await dispatch(engine, { workspaceId, workerId, loopId, turnId }, killStmt(urlPath("worker", "/notes.md"), { marks: [2] }));
        assert.equal(r.status, 200, `the span deletion lands: ${JSON.stringify(r)}`);
        const body = await db.test_get_channel_by_pathname.get<{ content: string }>({ pathname: "/notes.md", name: "body" });
        assert.equal(body?.content, "alpha\ngamma", "exactly the scoped line is gone");
        const row = await db.test_first_log_entry_for_turn.get<{ op: string; lineMarker: string | null }>({ turn_id: turnId });
        assert.equal(row?.op, "KILL", "the receipt is the model's own operation");
        // {§edit-receipt-removed-text} — the deletion receipt quotes what it took.
        const receiptRow = await db.test_first_log_entry_for_turn.get<{ rx: string | null }>({ turn_id: turnId });
        assert.match(String(receiptRow?.rx), /"removedText":"beta"/, `the removed line rides the receipt: ${String(receiptRow?.rx).slice(0, 300)}`);
    } finally { await db.close(); }
});

// {§kill-pattern} — a pattern on an entry KILL deletes each matching line as one batch of
// line deletions; the receipt quotes the first and last lines it took.
test("a whole entry KILL with a pattern deletes exactly the matching lines and records the KILL", async () => {
    const { db, workspaceId, workerId, loopId, turnId, engine } = await setup();
    try {
        await new Worker().edit(editStmt(urlPath("worker", "/notes.md"), "alpha\nbeta\ngamma\nbeta again\ndelta"), makeSchemeCtx({ db, workspaceId, workerId }));
        const matcher: MatcherBody = { dialect: "regex", raw: "/beta/", pattern: "beta", flags: "" };
        const r = await dispatch(engine, { workspaceId, workerId, loopId, turnId }, killStmt(urlPath("worker", "/notes.md"), null, matcher));
        assert.equal(r.status, 200, `the pattern deletion lands: ${JSON.stringify(r)}`);
        assert.equal(r.matched, 2, "every matching line counts once");
        const body = await db.test_get_channel_by_pathname.get<{ content: string }>({ pathname: "/notes.md", name: "body" });
        assert.equal(body?.content, "alpha\ngamma\ndelta", "exactly the matching lines are gone");
        const receipt = r.receipt as { effect: { removedText?: string } } | undefined;
        assert.equal(receipt?.effect.removedText, "beta", "the receipt quotes the first line it took");
        const last = r.last as { removedText?: string } | undefined;
        assert.equal(last?.removedText, "beta again", "and the last one");
        const row = await db.test_first_log_entry_for_turn.get<{ op: string }>({ turn_id: turnId });
        assert.equal(row?.op, "KILL", "the log row is the model's own operation");
    } finally { await db.close(); }
});

// {§kill-pattern} — a scope bounds the lines the pattern may touch; zero matches change nothing.
test("a scoped entry KILL with a pattern matches only inside the scope and reports zero matches as 204", async () => {
    const { db, workspaceId, workerId, loopId, turnId, engine } = await setup();
    try {
        await new Worker().edit(editStmt(urlPath("worker", "/notes.md"), "alpha\nbeta\ngamma\nbeta again"), makeSchemeCtx({ db, workspaceId, workerId }));
        const literal: MatcherBody = { dialect: "glob", raw: "beta" };
        const nothing = await dispatch(engine, { workspaceId, workerId, loopId, turnId }, killStmt(urlPath("worker", "/notes.md"), { marks: [3] }, literal));
        assert.equal(nothing.status, 204, `no line in scope matches: ${JSON.stringify(nothing)}`);
        assert.equal(nothing.matched, 0);
        assert.equal((await db.test_get_channel_by_pathname.get<{ content: string }>({ pathname: "/notes.md", name: "body" }))?.content, "alpha\nbeta\ngamma\nbeta again", "nothing was deleted");
        const one = await dispatch(engine, { workspaceId, workerId, loopId, turnId }, killStmt(urlPath("worker", "/notes.md"), { marks: [1, 2] }, literal), 2);
        assert.equal(one.status, 200, `the in-scope match is deleted: ${JSON.stringify(one)}`);
        assert.equal(one.matched, 1);
        assert.equal((await db.test_get_channel_by_pathname.get<{ content: string }>({ pathname: "/notes.md", name: "body" }))?.content, "alpha\ngamma\nbeta again", "the out-of-scope match stays");
    } finally { await db.close(); }
});

// {§kill-pattern} — a matcher that selects resources rather than text is refused before any read.
test("an entry KILL with a full-text pattern is refused; nothing is deleted", async () => {
    const { db, workspaceId, workerId, loopId, turnId, engine } = await setup();
    try {
        await new Worker().edit(editStmt(urlPath("worker", "/notes.md"), "alpha\nbeta"), makeSchemeCtx({ db, workspaceId, workerId }));
        const r = await dispatch(engine, { workspaceId, workerId, loopId, turnId }, killStmt(urlPath("worker", "/notes.md"), null, { dialect: "fts", raw: "~beta" }));
        assert.equal(r.status, 400, JSON.stringify(r));
        assert.match(String(r.problem?.type), /\/pattern-dialect-unsupported$/);
        assert.equal((await db.test_get_channel_by_pathname.get<{ content: string }>({ pathname: "/notes.md", name: "body" }))?.content, "alpha\nbeta", "nothing was deleted");
    } finally { await db.close(); }
});

test("a recipient SEND to an entry scheme returns 501 (entry schemes carry no messages)", async () => {
    const { db, workspaceId, workerId, loopId, turnId, engine } = await setup();
    try {
        await new Worker().edit(editStmt(urlPath("worker", "/x"), "body"), makeSchemeCtx({ db, workspaceId, workerId }));
        const r = await dispatch(engine, { workspaceId, workerId, loopId, turnId }, sendStmt(urlPath("worker", "/x"), "hello"));
        assert.equal(r.status, 501);
    } finally { await db.close(); }
});

test("KILL(worker:///x) deletes unknown entry", async () => {
    const { db, workspaceId, workerId, loopId, turnId, engine } = await setup();
    try {
        await new Worker().edit(editStmt(urlPath("worker", "/topic"), "open question"), makeSchemeCtx({ db, workspaceId, workerId }));

        const r = await dispatch(engine, { workspaceId, workerId, loopId, turnId }, killStmt(urlPath("worker", "/topic")));
        assert.equal(r.status, 200);
        const gone = await db.test_get_entry_id_by_pathname.get<{ id: number }>({ pathname: "/topic" });
        assert.equal(gone, undefined);
    } finally { await db.close(); }
});

test("KILL cascades to entry channels", async () => {
    const { db, workspaceId, workerId, loopId, turnId, engine } = await setup();
    try {
        const k = new Worker();
        await k.edit(editStmt(urlPath("worker", "/doomed"), "body"), makeSchemeCtx({ db, workspaceId, workerId }));
        const entryRow = await db.test_get_entry_id_by_pathname.get<{ id: number }>({ pathname: "/doomed" });
        const entryId = entryRow!.id;
        assert.ok(((await db.test_count_channels_for_entry.get<{ n: number }>({ entry_id: entryId }))?.n ?? 0) > 0);

        const r = await dispatch(engine, { workspaceId, workerId, loopId, turnId }, killStmt(urlPath("worker", "/doomed")));
        assert.equal(r.status, 200);

        assert.equal((await db.test_count_channels_for_entry.get<{ n: number }>({ entry_id: entryId }))?.n, 0);
    } finally { await db.close(); }
});
