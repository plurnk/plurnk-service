// plurnk:/// is the internal-events scheme. Currently used for prompts at
// plurnk:///prompt/<loop_id>; future internal model-interactions land here.
// Manifest-level writableBy is open; the edit handler rejects model writes
// to plurnk:///prompt/* (engine + client own those paths).

import test from "node:test";
import assert from "node:assert/strict";
import Plurnk from "../../src/schemes/Plurnk.ts";
import type { PrepMethod } from "../../src/core/Db.ts";
import { openMigrated, insertSession, insertRun, makeSchemeCtx } from "./_helpers.ts";
import { urlPath, editStmt, readStmt } from "./_dsl.ts";

const setup = async () => {
    const db = await openMigrated();
    const sessionId = await insertSession(db, `ws-${crypto.randomUUID()}`);
    const runId = await insertRun(db, sessionId);
    return { db, sessionId, runId };
};

test("plurnk:/// scheme manifest: open writability, body channel, text/markdown", () => {
    assert.deepEqual(Plurnk.manifest.channels, { body: "text/markdown" });
    assert.equal(Plurnk.manifest.defaultChannel, "body");
    assert.equal(Plurnk.manifest.modelVisible, true);
    assert.ok(Plurnk.manifest.writableBy.includes("model"));
    assert.ok(Plurnk.manifest.writableBy.includes("client"));
    assert.ok(Plurnk.manifest.writableBy.includes("plurnk"));
});

test("system EDIT plurnk:///prompt/<loop_id> creates the entry", async () => {
    const { db, sessionId, runId } = await setup();
    try {
        const p = new Plurnk();
        const r = await p.edit(
            editStmt(urlPath("plurnk", "/prompt/1"), "what is the capital of france?"),
            makeSchemeCtx({ db, sessionId, runId, writer: "plurnk" }),
        );
        assert.equal(r.status, 201);
        const body = (await (db.test_get_channel as PrepMethod).get<{ content: string }>({ entry_id: r.entryId, name: "body" }))?.content;
        assert.equal(body, "what is the capital of france?");
    } finally { await db.close(); }
});

test("model EDIT plurnk:///prompt/* rejected with 403 (engine/client own prompts)", async () => {
    const { db, sessionId, runId } = await setup();
    try {
        const r = await new Plurnk().edit(
            editStmt(urlPath("plurnk", "/prompt/1"), "fake prompt"),
            makeSchemeCtx({ db, sessionId, runId, writer: "model" }),
        );
        assert.equal(r.status, 403);
        assert.equal(r.entryId, null);
    } finally { await db.close(); }
});

test("model EDIT plurnk:///<non-prompt-path> is allowed", async () => {
    const { db, sessionId, runId } = await setup();
    try {
        const r = await new Plurnk().edit(
            editStmt(urlPath("plurnk", "/scratch/notes"), "model thoughts"),
            makeSchemeCtx({ db, sessionId, runId, writer: "model" }),
        );
        assert.equal(r.status, 201);
    } finally { await db.close(); }
});

test("READ plurnk:///prompt/<loop_id> returns the prompt body", async () => {
    const { db, sessionId, runId } = await setup();
    try {
        const p = new Plurnk();
        await p.edit(editStmt(urlPath("plurnk", "/prompt/1"), "hello"), makeSchemeCtx({ db, sessionId, runId, writer: "plurnk" }));
        const r = await p.read(readStmt(urlPath("plurnk", "/prompt/1")), makeSchemeCtx({ db, sessionId, writer: "model" }));
        assert.equal(r.status, 200);
        assert.equal(r.content, "hello");
    } finally { await db.close(); }
});
