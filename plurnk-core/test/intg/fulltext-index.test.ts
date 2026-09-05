// {§persistent-search-index} Index the complete addressed READ body.
import test from "node:test";
import assert from "node:assert/strict";
import type { LineMarker, UrlPath } from "@plurnk/plurnk-contracts";
import type { ResolvedEditStatement } from "@plurnk/plurnk-schemes";
import type { Db } from "../../src/core/Db.ts";
import Worker from "../../src/schemes/Worker.ts";
import SearchIndex from "../../src/schemes/_search-index.ts";
import { openMigrated, insertWorkspace, insertWorker, makeSchemeCtx } from "./_helpers.ts";

const url = (pathname: string): UrlPath => ({
    kind: "url", raw: `worker:///${pathname}`, scheme: "worker",
    username: null, password: null, hostname: null, port: null,
    pathname: `/${pathname}`, query: null, fragment: null,
});
const fullReplace: LineMarker = { marks: [1, -1] };
const editStmt = (target: UrlPath, body: string, marker: LineMarker | null = null): ResolvedEditStatement => ({
    metadata: null,
    op: "EDIT", annotation: null, delimiter: "", target, lineMarker: marker, body,
    position: { line: 1, column: 1 },
});
const fts = async (db: Db, workspaceId: number, query: string): Promise<string[]> => {
    const rows = await db.test_fts_search.all<{ pathname: string }>({ workspace_id: workspaceId, query });
    return rows.map((r) => r.pathname);
};

test("persistent-index maintenance indexes body content into derivation_fts and re-indexes on change", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `fts-${crypto.randomUUID()}`);
        const workerId = await insertWorker(db, workspaceId);
        const ctx = makeSchemeCtx({ db, workspaceId, workerId });
        await new Worker().edit(editStmt(url("pay.ts"), "export function processPayment() {}\n"), ctx);
        await new Worker().edit(editStmt(url("auth.ts"), "export function authenticate() {}\n"), ctx);
        await SearchIndex.maintain(ctx);

        assert.deepEqual(await fts(db, workspaceId, "processPayment"), ["/pay.ts"]);
        assert.deepEqual(await fts(db, workspaceId, "authenticate"), ["/auth.ts"]);
        assert.deepEqual(await fts(db, workspaceId, "nonexistent"), []);

        // Change pay.ts: re-index must drop the old term and add the new one;
        // auth.ts is unchanged (gate skips it) and stays indexed.
        await new Worker().edit(editStmt(url("pay.ts"), "export function refund() {}\n", fullReplace), ctx);
        await SearchIndex.maintain(ctx);
        assert.deepEqual(await fts(db, workspaceId, "processPayment"), [], "old term gone after re-index");
        assert.deepEqual(await fts(db, workspaceId, "refund"), ["/pay.ts"], "new term indexed");
        assert.deepEqual(await fts(db, workspaceId, "authenticate"), ["/auth.ts"], "unchanged entry stays indexed");
    } finally { db.close(); }
});

test("search artifacts index the exact READ body rather than a hidden mimetype projection", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `fts-readable-${crypto.randomUUID()}`);
        const workerId = await insertWorker(db, workspaceId);
        const ctx = makeSchemeCtx({ db, workspaceId, workerId });
        await new Worker().edit(
            editStmt(url("authored.html"), "<main data-rawonlymarker=\"yes\">Visible prose</main>\n"),
            ctx,
        );
        await SearchIndex.maintain(ctx);

        assert.deepEqual(
            await fts(db, workspaceId, "rawonlymarker"),
            ["/authored.html"],
            "an authored HTML file is indexed in the same verbatim coordinate space READ exposes",
        );
    } finally { db.close(); }
});
