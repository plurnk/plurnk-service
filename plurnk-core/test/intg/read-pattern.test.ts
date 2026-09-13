// {§read-pattern} — a pattern on a READ selects the lines it renders: every line a match touches,
// with the ordinary anchors, inside the scope. Zero matches is an empty read, never a failure.
import test from "node:test";
import assert from "node:assert/strict";
import type { MatcherBody, ReadStatement } from "@plurnk/plurnk-contracts";
import Engine from "../../src/core/Engine.ts";
import SchemeRegistry from "../../src/core/SchemeRegistry.ts";
import Worker from "../../src/schemes/Worker.ts";
import { openMigrated, seedEnvelope, makeSchemeCtx, DEFAULT_MIMETYPES } from "./_helpers.ts";
import { urlPath, editStmt, readStmt } from "./_dsl.ts";

const setup = async (content = "alpha\nTODO one\nbeta\nTODO two\ngamma") => {
    const db = await openMigrated();
    const env = await seedEnvelope(db, `ws-${crypto.randomUUID()}`, { producer: "client" });
    const engine = new Engine({ db, schemes: new SchemeRegistry(), mimetypes: DEFAULT_MIMETYPES });
    await new Worker().edit(editStmt(urlPath("worker", "/notes.md"), content), makeSchemeCtx({ db, workspaceId: env.workspaceId, workerId: env.workerId }));
    let sequence = 0;
    const dispatch = (statement: ReadStatement) => {
        sequence += 1;
        return engine.dispatch({ statement, workspaceId: env.workspaceId, workerId: env.workerId, loopId: env.loopId, turnId: env.turnId, sequence, origin: "client" });
    };
    return { db, dispatch };
};

test("READ by pattern renders exactly the matching lines with their physical ordinals and anchors", async () => {
    const { db, dispatch } = await setup();
    try {
        const regex: MatcherBody = { dialect: "regex", raw: "/^TODO/", pattern: "^TODO", flags: "" };
        const r = await dispatch(readStmt(urlPath("worker", "/notes.md"), null, regex));
        assert.equal(r.status, 200, JSON.stringify(r));
        assert.equal(r.content, "TODO one\nTODO two");
        assert.deepEqual(r.lineOrdinals, [2, 4], "the lines keep their physical ordinals");
        assert.equal(r.matched, 2);
        assert.equal((r.lineAnchors as string[]).length, 2, "every rendered line carries its anchor");
        assert.deepEqual(r.range, { unit: "line", total: 5, requested: [2, 4], returned: [2, 4] });
    } finally { await db.close(); }
});

test("a scope bounds the lines a READ pattern may select; matched counts inside it", async () => {
    const { db, dispatch } = await setup();
    try {
        const r = await dispatch(readStmt(urlPath("worker", "/notes.md"), { marks: [1, 2] }, { dialect: "glob", raw: "TODO" }));
        assert.equal(r.status, 200, JSON.stringify(r));
        assert.equal(r.content, "TODO one");
        assert.deepEqual(r.lineOrdinals, [2]);
        assert.equal(r.matched, 1);
    } finally { await db.close(); }
});

test("zero matches read as empty (204) with matched 0", async () => {
    const { db, dispatch } = await setup();
    try {
        const r = await dispatch(readStmt(urlPath("worker", "/notes.md"), null, { dialect: "glob", raw: "DONE" }));
        assert.equal(r.status, 204, JSON.stringify(r));
        assert.equal(r.matched, 0);
        assert.equal(r.content, "");
    } finally { await db.close(); }
});

test("a whole-resource pattern READ pages through the selected lines, never the unselected ones", async () => {
    const lines = Array.from({ length: 40 }, (_, index) => index % 2 === 0 ? `keep ${index + 1}` : `skip ${index + 1}`);
    const { db, dispatch } = await setup(lines.join("\n"));
    try {
        const r = await dispatch(readStmt(urlPath("worker", "/notes.md"), null, { dialect: "glob", raw: "keep" }));
        assert.equal(r.status, 200, JSON.stringify(r));
        assert.equal(r.matched, 20, "every selected line counts, beyond the page");
        assert.deepEqual(r.lineOrdinals, Array.from({ length: 16 }, (_, index) => index * 2 + 1), "the first page holds the first sixteen selected lines");
        assert.doesNotMatch(String(r.content), /skip/);
    } finally { await db.close(); }
});

test("a resource-selecting dialect on a READ is refused", async () => {
    const { db, dispatch } = await setup();
    try {
        const r = await dispatch(readStmt(urlPath("worker", "/notes.md"), null, { dialect: "fts", raw: "~TODO" }));
        assert.equal(r.status, 400, JSON.stringify(r));
        assert.match(String(r.problem?.type), /\/pattern-dialect-unsupported$/);
    } finally { await db.close(); }
});

// {§read-fan-out} — a pattern READ over a glob is grep: one ordinary exact pattern READ receipt per
// matching path, in the FIND's order; no match is one 204 on the glob; a survey dialect stays a FIND.
test("a pattern READ over a glob fans out into one exact pattern READ receipt per matching path", async () => {
    const db = await openMigrated();
    const env = await seedEnvelope(db, `ws-${crypto.randomUUID()}`, { producer: "client" });
    const engine = new Engine({ db, schemes: new SchemeRegistry(), mimetypes: DEFAULT_MIMETYPES });
    const ctx = makeSchemeCtx({ db, workspaceId: env.workspaceId, workerId: env.workerId });
    try {
        for (const [name, content] of [["pets_dogs.md", "cats\nbut I love dogs.\nfish\nHistorically, dogs have been..."], ["pets_cats.md", "Most cats are afraid of dogs."], ["pets_fish.md", "Fish are quiet."]] as const) {
            await new Worker().edit(editStmt(urlPath("worker", `/${name}`), content), ctx);
        }
        let sequence = 0;
        const dispatch = async (statement: ReadStatement) => {
            sequence += 1;
            const result = await engine.dispatch({ statement, workspaceId: env.workspaceId, workerId: env.workerId, loopId: env.loopId, turnId: env.turnId, sequence, origin: "client" });
            sequence += ((result.rowsWritten as number | undefined) ?? 1) - 1;
            return result;
        };
        const rows = async () => (await db.test_log_entries_by_loop.all<{ op: string; pathname: string | null; status_rx: number; rx: string; sequence: number }>({ loop_id: env.loopId }))
            .filter((row) => row.op === "READ" || row.op === "FIND").sort((a, b) => a.sequence - b.sequence);

        const grep = await dispatch(readStmt(urlPath("worker", "/pets_*.md"), null, { dialect: "regex", raw: "/dogs/i", pattern: "dogs", flags: "i" }));
        assert.equal(grep.status, 200, JSON.stringify(grep));
        assert.equal(grep.rowsWritten, 2, "one receipt per matching path; the fishless file writes none");
        const receipts = await rows();
        assert.deepEqual(receipts.map(({ op, pathname, status_rx }) => [op, pathname, status_rx]), [["READ", "/pets_cats.md", 200], ["READ", "/pets_dogs.md", 200]], "each receipt is an exact READ of one matching path, in the FIND's order");
        const dogs = JSON.parse(receipts[1]!.rx) as { content: string; lineOrdinals: number[]; matched: number; lineAnchors: string[] };
        assert.equal(dogs.content, "but I love dogs.\nHistorically, dogs have been...");
        assert.deepEqual(dogs.lineOrdinals, [2, 4], "the lines keep their physical ordinals inside their own file");
        assert.equal(dogs.matched, 2);
        assert.equal(dogs.lineAnchors.length, 2, "every rendered line carries its anchor, so the receipt is an EDIT coordinate source");
        const cats = JSON.parse(receipts[0]!.rx) as { content: string; matched: number };
        assert.deepEqual([cats.content, cats.matched], ["Most cats are afraid of dogs.", 1]);

        const none = await dispatch(readStmt(urlPath("worker", "/pets_*.md"), null, { dialect: "glob", raw: "hamster" }));
        assert.equal(none.status, 204, JSON.stringify(none));
        assert.equal(none.matched, 0);
        const empty = (await rows()).at(-1)!;
        assert.deepEqual([empty.op, empty.pathname, empty.status_rx], ["READ", "/pets_*.md", 204], "no matching path is one 204 receipt on the authored glob");

        const scoped = await dispatch(readStmt(urlPath("worker", "/pets_*.md"), { marks: [1, 2] }, { dialect: "glob", raw: "dogs" }));
        assert.equal(scoped.status, 200, JSON.stringify(scoped));
        assert.equal(scoped.rowsWritten, 2);
        const scopedDogs = JSON.parse((await rows()).at(-1)!.rx) as { content: string; matched: number };
        assert.deepEqual([scopedDogs.content, scopedDogs.matched], ["but I love dogs.", 1], "the authored scope bounds every fanned-out READ");

        const survey = await dispatch(readStmt(urlPath("worker", "/pets_*.md"), null, { dialect: "fts", raw: "~dogs" }));
        assert.ok(survey.status < 400, JSON.stringify(survey));
        assert.equal((await rows()).at(-1)!.op, "FIND", "a resource dialect on a glob READ is the FIND survey it always was");
    } finally { await db.close(); }
});
