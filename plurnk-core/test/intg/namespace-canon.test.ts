// The address-canon acceptance set (#546 iteration two; grammar's #545 pin matrix 1–3).
// [§fs-answer-in-canon] — every engine-authored address renders the one wire-canon form
// (bare git-pathspec); the log-COLUMN half of the law rides the Dispatcher chunk of the
// same epic. [§fs-canonical-name]'s storage half is asserted via the fixpoint on rows.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ReadStatement, EditStatement, UrlPath } from "@plurnk/plurnk-grammar";
import File from "../../src/schemes/File.ts";
import Namespace from "../../src/core/namespace.ts";
import EntryCrud from "../../src/schemes/_entry-crud.ts";
import Owner from "../../src/core/Owner.ts";
import type { PrepMethod } from "../../src/core/Db.ts";
import { openMigrated, insertWorkspace, insertWorker, makeSchemeCtx, DEFAULT_MIMETYPES, rootWorkspace } from "./_helpers.ts";

const fileUrl = (pathname: string): UrlPath => ({
    kind: "url", raw: `file://${pathname}`, scheme: "file",
    username: null, password: null, hostname: null, port: null,
    pathname, params: {}, fragment: null,
});
const readStmt = (pathname: string): ReadStatement => ({ op: "READ", suffix: "", signal: null, target: fileUrl(pathname), lineMarker: null, body: null, position: { line: 1, column: 1 } });
const editStmt = (pathname: string, body: string): EditStatement => ({ op: "EDIT", suffix: "", signal: null, target: fileUrl(pathname), lineMarker: null, body, position: { line: 1, column: 1 } } as unknown as EditStatement);

const setup = async () => {
    const root = await mkdtemp(join(tmpdir(), "plurnk-canon-"));
    const db = await openMigrated();
    const workspaceId = await insertWorkspace(db, `canon-${crypto.randomUUID()}`);
    await rootWorkspace(db, workspaceId, root);
    const workerId = await insertWorker(db, workspaceId);
    const ctx = makeSchemeCtx({ db, workspaceId, workerId, mimetypes: DEFAULT_MIMETYPES });
    return { root, db, workspaceId, ctx };
};

test("[§fs-namei] pin 1+2: every spelling of one member resolves to the ONE row — bare, slashed, dotted, out-and-back-in", async () => {
    const { root, db, workspaceId, ctx } = await setup();
    try {
        await mkdir(join(root, "src"), { recursive: true });
        await writeFile(join(root, "src/main.js"), "the one file\n");
        await EntryCrud.writeEntry("src/main.js", { channels: { body: { content: "the one file\n", mimetype: "text/markdown" } }, tags: [] }, ctx, "file");

        const rootBase = root; // e.g. /tmp/plurnk-canon-XXXX
        const spellings = ["src/main.js", "/src/main.js", "./src/main.js", "src/./main.js", "a/../src/main.js", `../${rootBase.split("/").at(-1)}/src/main.js`];
        for (const spelling of spellings) {
            const r = await new File().read(readStmt(spelling), ctx);
            assert.equal(r.status, 200, `READ(${spelling}) resolves the member`);
            assert.equal(r.content, "the one file\n", `READ(${spelling}) reads the SAME row`);
        }
        const rows = await (db.test_count_entry_rows as PrepMethod).get<{ n: number }>({ workspace_id: workspaceId, pathname: "src/main.js" });
        assert.equal(rows?.n, 1, "one identity under every spelling");
    } finally { await db.close(); await rm(root, { recursive: true, force: true }); }
});

test("[§fs-answer-in-canon] pin 3: EDIT via a slashed spelling answers in bare canon and mints NO shadow row", async () => {
    const { root, db, workspaceId, ctx } = await setup();
    try {
        await writeFile(join(root, "note.md"), "original\n");
        const seeded = await (db.crud_insert_workspace_entry as PrepMethod).get<{ id: number }>({ workspace_id: workspaceId, owner_id: await Owner.commonsId(db, workspaceId), scheme: "file", pathname: "note.md" });
        assert.ok(seeded);
        const before = await (db.test_entries_count_all as PrepMethod).get<{ n: number }>({});

        const r = await new File().edit(editStmt("/note.md", "revised\n"), ctx);
        assert.equal(r.status, 202, "the slashed spelling proposes against the member");
        const attrs = r.attrs as { path: string };
        assert.equal(attrs.path, "note.md", "the engine answers in wire canon — never an echo of the model's spelling");
        assert.match((r as { body?: string }).body ?? "", /^Index: note\.md/, "the diff header speaks canon");

        const after = await (db.test_entries_count_all as PrepMethod).get<{ n: number }>({});
        assert.equal(after?.n, before?.n, "no shadow row minted via the alternate spelling (the id-42854 pin)");
    } finally { await db.close(); await rm(root, { recursive: true, force: true }); }
});

test("[§fs-canonical-name] the storage fixpoint: every file-class row is its own canon", async () => {
    const { root, db, workspaceId, ctx } = await setup();
    try {
        await writeFile(join(root, "a.md"), "a\n");
        await EntryCrud.writeEntry("a.md", { channels: { body: { content: "a\n", mimetype: "text/markdown" } }, tags: [] }, ctx, "file");
        const rows = await (db.test_file_pathnames as PrepMethod).all<{ pathname: string }>({ workspace_id: workspaceId });
        assert.ok(rows.length > 0);
        for (const { pathname } of rows) {
            assert.ok(Namespace.isCanonical(pathname, root), `stored key '${pathname}' is its own canon — the world-state predicate`);
        }
    } finally { await db.close(); await rm(root, { recursive: true, force: true }); }
});
