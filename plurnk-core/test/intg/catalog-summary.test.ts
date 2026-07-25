// engine_scheme_catalog_summary — the per-scheme entry tally that sources the turn-0 foist,
// so the model sees which schemes hold content without probing FIND(worker:///**) every turn.

import test from "node:test";
import assert from "node:assert/strict";
import type { EditStatement, UrlPath } from "@plurnk/plurnk-grammar";
import Worker from "../../src/schemes/Worker.ts";
import { openMigrated, insertWorkspace, insertWorker, makeHandlerCtx, makeSchemeCtx } from "./_helpers.ts";

const url = (scheme: string, pathname: string): UrlPath => ({
    kind: "url", raw: `${scheme}:///${pathname}`, scheme,
    username: null, password: null, hostname: null, port: null,
    pathname: `/${pathname}`, params: {}, fragment: null,
});
const editStmt = (target: UrlPath, body: string): EditStatement => ({
    op: "EDIT", suffix: "", signal: null, target, lineMarker: null, body,
    position: { line: 1, column: 1 },
});

test("[catalog] engine_scheme_catalog_summary tallies distinct entries per scheme", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `catalog-${crypto.randomUUID()}`);
        const workerId = await insertWorker(db, workspaceId);
        const ctx = makeSchemeCtx({ db, workspaceId, workerId });
        await new Worker().edit(editStmt(url("worker", "a.md"), "alpha beta"), ctx);
        await new Worker().edit(editStmt(url("worker", "b.md"), "gamma"), ctx);
        const Skill = (await import("../../src/schemes/Skill.ts")).default;
        await new Skill().edit(editStmt(url("skill", "q"), "a recipe"), makeHandlerCtx(ctx, Skill.manifest));

        const rows = await db.engine_scheme_catalog_summary.all<{ scheme: string | null; entries: number }>({ workspace_id: workspaceId });
        const byScheme = new Map(rows.map((r) => [r.scheme, r]));
        assert.equal(byScheme.get("worker")?.entries, 2, "two commons entries tallied as distinct");
        assert.equal(byScheme.get("skill")?.entries, 1, "one skill entry tallied");
    } finally { db.close(); }
});
