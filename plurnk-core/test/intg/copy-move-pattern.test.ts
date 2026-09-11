// {§copy-move-pattern} — a pattern on a COPY or MOVE source selects whole matching lines; the
// destination is a place named by its scope. Zero matches change nothing.
import test from "node:test";
import assert from "node:assert/strict";
import type { CopyStatement, MatcherBody, MoveStatement } from "@plurnk/plurnk-contracts";
import Engine from "../../src/core/Engine.ts";
import SchemeRegistry from "../../src/core/SchemeRegistry.ts";
import Worker from "../../src/schemes/Worker.ts";
import { openMigrated, seedEnvelope, makeSchemeCtx, DEFAULT_MIMETYPES } from "./_helpers.ts";
import { urlPath, editStmt, copyStmt, moveStmt } from "./_dsl.ts";

const setup = async () => {
    const db = await openMigrated();
    const env = await seedEnvelope(db, `ws-${crypto.randomUUID()}`, { producer: "client" });
    const engine = new Engine({ db, schemes: new SchemeRegistry(), mimetypes: DEFAULT_MIMETYPES });
    await new Worker().edit(editStmt(urlPath("worker", "/notes.md"), "alpha\nTODO one\nbeta\nTODO two\ngamma"), makeSchemeCtx({ db, workspaceId: env.workspaceId, workerId: env.workerId }));
    let sequence = 0;
    const dispatch = (statement: CopyStatement | MoveStatement) => {
        sequence += 1;
        return engine.dispatch({ statement, workspaceId: env.workspaceId, workerId: env.workerId, loopId: env.loopId, turnId: env.turnId, sequence, origin: "client" });
    };
    const body = async (pathname: string) => (await db.test_get_channel_by_pathname.get<{ content: string }>({ pathname, name: "body" }))?.content;
    return { db, dispatch, body };
};

const literal: MatcherBody = { dialect: "glob", raw: "TODO" };
const withSource = <T extends CopyStatement | MoveStatement>(statement: T, matcher: MatcherBody): T => ({ ...statement, source: { ...statement.source, matcher } });

test("COPY by pattern lands exactly the matching lines and leaves the source alone", async () => {
    const { db, dispatch, body } = await setup();
    try {
        const r = await dispatch(withSource(copyStmt(urlPath("worker", "/notes.md"), urlPath("worker", "/todos.md")), literal));
        assert.equal(r.status, 201, JSON.stringify(r));
        assert.equal(r.matched, 2, "the receipt counts the selected lines");
        // Whole-line selections carry their separators, exactly as a scoped COPY does.
        assert.equal(await body("/todos.md"), "TODO one\nTODO two\n");
        assert.equal(await body("/notes.md"), "alpha\nTODO one\nbeta\nTODO two\ngamma", "COPY reads only");
    } finally { await db.close(); }
});

test("a scoped source bounds the lines a pattern may select", async () => {
    const { db, dispatch, body } = await setup();
    try {
        const r = await dispatch(withSource(copyStmt(urlPath("worker", "/notes.md"), urlPath("worker", "/todos.md"), { marks: [1, 3] }), literal));
        assert.equal(r.status, 201, JSON.stringify(r));
        assert.equal(r.matched, 1);
        assert.equal(await body("/todos.md"), "TODO one\n");
    } finally { await db.close(); }
});

test("zero matches copy nothing and answer 204", async () => {
    const { db, dispatch, body } = await setup();
    try {
        const r = await dispatch(withSource(copyStmt(urlPath("worker", "/notes.md"), urlPath("worker", "/todos.md")), { dialect: "glob", raw: "DONE" }));
        assert.equal(r.status, 204, JSON.stringify(r));
        assert.equal(r.matched, 0);
        assert.equal(await body("/todos.md"), undefined, "no destination was created");
    } finally { await db.close(); }
});

test("MOVE by pattern retires exactly the matching lines from the source", async () => {
    const { db, dispatch, body } = await setup();
    try {
        // A pattern works line by line, so `^` anchors each line without an explicit `m` flag.
        const regex: MatcherBody = { dialect: "regex", raw: "/^TODO/", pattern: "^TODO", flags: "" };
        const r = await dispatch(withSource(moveStmt(urlPath("worker", "/notes.md"), urlPath("worker", "/todos.md")), regex));
        assert.equal(r.status, 201, JSON.stringify(r));
        assert.equal(r.matched, 2);
        assert.equal(await body("/todos.md"), "TODO one\nTODO two\n");
        assert.equal(await body("/notes.md"), "alpha\nbeta\ngamma", "only the moved lines left the source");
        const effects = r.effects as ReadonlyArray<{ target: string; action: string }>;
        assert.deepEqual(effects.map(({ target, action }) => `${action} ${target}`), [
            "create worker:///todos.md", "update worker:///notes.md", "update worker:///notes.md",
        ], "one destination effect, one source effect per retired line");
    } finally { await db.close(); }
});

test("MOVE by pattern within one channel appends the lines and removes them where they were", async () => {
    const { db, dispatch, body } = await setup();
    try {
        const r = await dispatch(withSource(moveStmt(urlPath("worker", "/notes.md"), urlPath("worker", "/notes.md"), null, { marks: [-1] }), literal));
        assert.equal(r.status, 200, JSON.stringify(r));
        assert.equal(r.matched, 2);
        assert.equal(await body("/notes.md"), "alpha\nbeta\ngamma\nTODO one\nTODO two\n");
    } finally { await db.close(); }
});

test("a pattern on the destination is refused: a destination is a place", async () => {
    const { db, dispatch, body } = await setup();
    try {
        const statement = copyStmt(urlPath("worker", "/notes.md"), urlPath("worker", "/todos.md"));
        const r = await dispatch({ ...statement, destination: { ...statement.destination, matcher: literal } });
        assert.equal(r.status, 400, JSON.stringify(r));
        assert.match(String(r.problem?.type), /\/pattern-destination-unsupported$/);
        assert.equal(await body("/todos.md"), undefined);
    } finally { await db.close(); }
});

test("a resource-selecting dialect on a transfer source is refused before any read", async () => {
    const { db, dispatch } = await setup();
    try {
        const r = await dispatch(withSource(copyStmt(urlPath("worker", "/notes.md"), urlPath("worker", "/todos.md")), { dialect: "fts", raw: "~TODO" }));
        assert.equal(r.status, 400, JSON.stringify(r));
        assert.match(String(r.problem?.type), /\/pattern-dialect-unsupported$/);
    } finally { await db.close(); }
});
