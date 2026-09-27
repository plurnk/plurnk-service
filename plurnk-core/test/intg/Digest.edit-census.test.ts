// {§digest-edit-census} — every model EDIT counted by the form it authored, how it landed, and
// whether it came back to a path within two model turns.
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { testArtifactPath } from "../../../scripts/test-artifacts.ts";
import Digest from "../../src/digest/Digest.ts";
import DigestRender from "../../src/digest/DigestRender.ts";
import type { Db } from "../../src/core/Db.ts";
import { insertLoop, insertTurn, insertWorker, insertWorkspace, openMigrated } from "./_helpers.ts";

const TMP_DIR = testArtifactPath("core");

interface EditFixture {
    workerId: number; loopId: number; turnId: number; sequence: number;
    pathname: string; marker: string | null; pattern?: string | null; status: number; origin?: "model" | "_plurnk";
}

// One EDIT log row as the dispatcher writes it: the statement in tx, the marker beside it.
const insertEdit = async (db: Db, fixture: EditFixture): Promise<number> => {
    const statement = { op: "EDIT", path: fixture.pathname, lineMarker: fixture.marker === null ? null : JSON.parse(fixture.marker), pattern: fixture.pattern ?? null, body: "x" };
    const row = await db.engine_insert_log_entry.get<{ id: number }>({
        worker_id: fixture.workerId, loop_id: fixture.loopId, turn_id: fixture.turnId, sequence: fixture.sequence,
        origin: fixture.origin ?? "model", source: null, model_call_id: null,
        op: "EDIT", signal: null,
        scheme: "file", username: null, password: null, hostname: null, port: null,
        pathname: fixture.pathname, query: null, fragment: null, lineMarker: fixture.marker,
        tx: JSON.stringify(statement), mimetype_tx: "application/json",
        // A refusal is a Problem-bearing result; the digest validates every stored result ({§validation-topology}).
        rx: JSON.stringify(fixture.status >= 400
            ? { status: fixture.status, problem: { type: "https://problems.plurnk.xyz/test/edit-refused", title: "Edit refused", status: fixture.status, detail: "The witness refusal." } }
            : { status: fixture.status }),
        mimetype_rx: "application/json", status_rx: fixture.status, weight: 0,
        state: "resolved", outcome: null, attrs: "{}", initial_folded: null,
    });
    if (row === undefined) throw new Error("edit-census fixture log row did not insert");
    return row.id;
};

test("{§digest-edit-census}: the form is read from the authored marker and pattern", () => {
    const form = (marker: string | null, pattern: string | null = null): string => DigestRender.editForm({ line_marker: marker, pattern });
    assert.equal(form('{"marks":["@abcde"]}'), "hash");
    assert.equal(form('{"marks":[42]}'), "line");
    assert.equal(form('{"marks":["@abcde","@fghij"]}'), "range");
    assert.equal(form('{"marks":[3,5]}'), "range");
    assert.equal(form('{"marks":["@abcde",1,"@abcde",1]}'), "insert");
    assert.equal(form('{"marks":[42,1,42,1]}'), "insert");
    assert.equal(form('{"marks":[2,3,3,6]}'), "column");
    assert.equal(form('{"marks":[0]}'), "prepend");
    assert.equal(form('{"marks":[-1]}'), "append");
    assert.equal(form('{"marks":["@abcde",1,2]}'), "offset");
    assert.equal(form(null, "/foo/"), "pattern");
    assert.equal(form('{"marks":["@abcde"]}', "/foo/"), "pattern", "a matcher names the selection whatever marker rides beside it");
    assert.equal(form(null), "whole");
});

test("{§digest-edit-census}: a worker's EDITs are counted by form, refusal and revisit, on the summary and in digest.json", async () => {
    const dbPath = join(TMP_DIR, `edit-census-${crypto.randomUUID()}.db`);
    const db = await openMigrated(dbPath);
    const ids: Record<string, number> = {};
    try {
        const workspaceId = await insertWorkspace(db, "edit-census");
        const workerId = await insertWorker(db, workspaceId, null, "editor");
        await insertWorker(db, workspaceId, null, "bystander");
        const loopId = await insertLoop(db, workerId, 1, "edit things");
        const turns = await Promise.all([1, 2, 3, 4].map((sequence) => insertTurn(db, loopId, sequence, 200)));
        const base = { workerId, loopId };
        ids.hash = await insertEdit(db, { ...base, turnId: turns[0]!, sequence: 1, pathname: "src/a.py", marker: '{"marks":["@abcde"]}', status: 200 });
        ids.whole = await insertEdit(db, { ...base, turnId: turns[0]!, sequence: 2, pathname: "src/b.py", marker: null, status: 201 });
        ids.harness = await insertEdit(db, { ...base, turnId: turns[0]!, sequence: 3, pathname: "worker:///_plurnk/x.md", marker: null, status: 201, origin: "_plurnk" });
        // Turn 2 returns to a.py one turn later: a revisit.
        ids.insert = await insertEdit(db, { ...base, turnId: turns[1]!, sequence: 1, pathname: "src/a.py", marker: '{"marks":["@abcde",1,"@abcde",1]}', status: 200 });
        ids.pattern = await insertEdit(db, { ...base, turnId: turns[2]!, sequence: 1, pathname: "src/c.py", marker: null, pattern: "/foo/", status: 200 });
        // Turn 4: a.py again, two turns after its last edit (a revisit, refused); b.py three turns after (not one).
        ids.range = await insertEdit(db, { ...base, turnId: turns[3]!, sequence: 1, pathname: "src/a.py", marker: '{"marks":[3,5]}', status: 400 });
        ids.column = await insertEdit(db, { ...base, turnId: turns[3]!, sequence: 2, pathname: "src/b.py", marker: '{"marks":[1,3,2,4]}', status: 200 });
        ids.append = await insertEdit(db, { ...base, turnId: turns[3]!, sequence: 3, pathname: "src/d.py", marker: '{"marks":[-1]}', status: 200 });
    } finally { await db.close(); }

    const digestDir = join(TMP_DIR, `edit-census-out-${crypto.randomUUID()}`);
    Digest.run({ dbPath, digestDir });

    const markdown = await readFile(join(digestDir, "digest.md"), "utf8");
    assert.match(markdown, /^EDITs: {6}7 · hash=1 range=1 insert=1 column=1 append=1 pattern=1 whole=1 · refused=1 · revisits=2$/mu,
        "the worker summary counts every model EDIT by form, the refusal, and the two returns to a.py; the harness EDIT is not the model's");
    assert.match(markdown, /^EDITs: {6}\(no edits\)$/mu, "a worker without EDITs says so");

    const json = JSON.parse(await readFile(join(digestDir, "digest.json"), "utf8")) as {
        workers: Array<{ name: string; edit_census: { edits: number; refused: number; revisits: number; forms: Record<string, number> } | null }>;
        log_entries: Array<{ id: number; edit_form?: string; edit_revisit?: boolean }>;
    };
    const editor = json.workers.find((worker) => worker.name === "editor");
    assert.deepEqual(editor?.edit_census, {
        edits: 7, refused: 1, revisits: 2,
        forms: { hash: 1, line: 0, range: 1, insert: 1, column: 1, prepend: 0, append: 1, offset: 0, pattern: 1, whole: 1 },
    });
    const stamped = new Map(json.log_entries.filter((entry) => entry.edit_form !== undefined).map((entry) => [entry.id, entry]));
    assert.deepEqual(
        Object.fromEntries(Object.entries(ids).map(([name, id]) => [name, stamped.get(id) === undefined ? null : `${stamped.get(id)!.edit_form}${stamped.get(id)!.edit_revisit ? "+revisit" : ""}`])),
        { hash: "hash", whole: "whole", harness: null, insert: "insert+revisit", pattern: "pattern", range: "range+revisit", column: "column", append: "append" },
        "every model EDIT row carries its form and revisit flag; the harness row carries neither",
    );
});
