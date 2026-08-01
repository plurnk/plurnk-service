// User Note 5 — the catalog is ordered by mtime (entries.updated_at), oldest-modified
// first / newest last, so the prompt-cache prefix (dormant entries) stays stable across
// turns and churn clusters at the tail. A re-edited entry moves to the tail while the rest
// hold their positions. catalogRowsFor renders engine_list_workspace_entries' order verbatim.

import test from "node:test";
import assert from "node:assert/strict";
import { setTimeout as sleep } from "node:timers/promises";
import type { EditStatement, LineMarker, UrlPath } from "@plurnk/plurnk-contracts";
import Worker from "../../src/schemes/Worker.ts";
import EntryManifest from "../../src/schemes/_entry-manifest.ts";
import { openMigrated, insertWorkspace, insertWorker, makeSchemeCtx } from "./_helpers.ts";

const url = (p: string): UrlPath => ({ kind: "url", raw: `worker:///${p}`, scheme: "worker", username: null, password: null, hostname: null, port: null, pathname: `/${p}`, params: {}, fragment: null });
const fullReplace: LineMarker = { marks: [1, -1] };
const editStmt = (target: UrlPath, body: string, marker: LineMarker | null = null): EditStatement => ({ op: "EDIT", suffix: "", signal: null, target, lineMarker: marker, body, position: { line: 1, column: 1 } });

test("catalog is mtime-ordered — a re-edited entry sorts to the tail, the rest hold their prefix", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `mtime-${crypto.randomUUID()}`);
        const workerId = await insertWorker(db, workspaceId);
        const ctx = makeSchemeCtx({ db, workspaceId, workerId });
        const k = new Worker();
        // Distinct sub-second mtimes via short spacing; a re-edit of `a` makes it newest.
        await k.edit(editStmt(url("a.md"), "alpha"), ctx); await sleep(10);
        await k.edit(editStmt(url("b.md"), "bravo"), ctx); await sleep(10);
        await k.edit(editStmt(url("c.md"), "charlie"), ctx); await sleep(10);
        await k.edit(editStmt(url("a.md"), "alpha-2", fullReplace), ctx); // re-edit a — now most-recently-modified

        const catalog = await EntryManifest.catalogRowsFor(ctx);
        const known = catalog.map((e) => e.path).filter((p) => p.startsWith("worker:///"));
        assert.deepEqual(known, ["worker:///b.md", "worker:///c.md", "worker:///a.md"],
            "b, c, then the re-edited a at the tail — oldest-modified first");
    } finally { await db.close(); }
});
