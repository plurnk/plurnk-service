// engine_scheme_catalog_summary — per-scheme entry and shallow-map row tallies that source
// the turn-0 foist, so its optional range is valid for the projection it actually renders.

import test from "node:test";
import assert from "node:assert/strict";
import type { UrlPath } from "@plurnk/plurnk-contracts";
import type { ResolvedEditStatement } from "@plurnk/plurnk-schemes";
import Worker from "../../src/schemes/Worker.ts";
import EntryCrud from "../../src/schemes/_entry-crud.ts";
import { openMigrated, insertWorkspace, insertWorker, makeHandlerCtx, makeSchemeCtx } from "./_helpers.ts";

const url = (scheme: string, pathname: string): UrlPath => ({
    kind: "url", raw: `${scheme}:///${pathname}`, scheme,
    username: null, password: null, hostname: null, port: null,
    pathname: `/${pathname}`, query: null, fragment: null,
});
const editStmt = (target: UrlPath, body: string): ResolvedEditStatement => ({
    op: "EDIT", annotation: null, delimiter: "", signal: null, target, lineMarker: null, body,
    position: { line: 1, column: 1 },
});

test("[catalog] engine_scheme_catalog_summary tallies distinct entries per scheme", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `catalog-${crypto.randomUUID()}`);
        const workerId = await insertWorker(db, workspaceId);
        const ctx = makeSchemeCtx({ db, workspaceId, workerId });
        await new Worker().edit(editStmt(url("worker", "a.md"), "alpha beta"), ctx);
        await new Worker().edit(editStmt(url("worker", "notes/b.md"), "gamma"), ctx);
        await new Worker().edit(editStmt(url("worker", "notes/deep/c.md"), "delta"), ctx);
        const Skill = (await import("../../src/schemes/Skill.ts")).default;
        await new Skill().edit(editStmt(url("skill", "q"), "a recipe"), makeHandlerCtx(ctx, Skill.manifest));
        await EntryCrud.writeEntry({ authority: "", pathname: "README.md" }, {
            channels: { body: { content: "root", mimetype: "text/markdown" } },
        }, ctx, "file");
        await EntryCrud.writeEntry({ authority: "", pathname: "src/a.ts" }, {
            channels: { body: { content: "a", mimetype: "text/typescript" } },
        }, ctx, "file");
        await EntryCrud.writeEntry({ authority: "", pathname: "src/deep/b.ts" }, {
            channels: { body: { content: "b", mimetype: "text/typescript" } },
        }, ctx, "file");
        await EntryCrud.writeEntry({ authority: "example.com:8443", pathname: "/x" }, {
            channels: { body: { content: "one", mimetype: "text/plain" } },
        }, ctx, "https");
        await EntryCrud.writeEntry({ authority: "example.com", pathname: "/8443:x" }, {
            channels: { body: { content: "two", mimetype: "text/plain" } },
        }, ctx, "https");

        const rows = await db.engine_scheme_catalog_summary.all<{ scheme: string; entries: number; shallow_items: number }>({ workspace_id: workspaceId });
        const byScheme = new Map(rows.map((r) => [r.scheme, r]));
        assert.equal(byScheme.get("worker")?.entries, 3, "three commons entries tallied as distinct");
        assert.equal(byScheme.get("worker")?.shallow_items, 2, "one root entry plus one notes/** scope form the shallow map");
        assert.equal(byScheme.get("skill")?.entries, 1, "one skill entry tallied");
        assert.equal(byScheme.get("file")?.entries, 3, "three project entries tallied as distinct");
        assert.equal(byScheme.get("file")?.shallow_items, 2, "one root file plus one src/** scope form the shallow map");
        assert.equal(byScheme.get("https")?.entries, 2, "resource authorities remain distinct");
        assert.equal(byScheme.get("https")?.shallow_items, 2, "authority and pathname boundaries cannot collide in the shallow tally");
    } finally { db.close(); }
});
