// note 13 — the manifest catalog surfaces each entry's tags (entry_tags), so the model
// sees its own categorization in the directory it READs (and can FIND by tag) without a
// separate read. Untagged entries omit the field — no empty-array clutter.

import test from "node:test";
import assert from "node:assert/strict";
import type { EditStatement, UrlPath } from "@plurnk/plurnk-grammar";
import Known from "../../src/schemes/Known.ts";
import EntryManifest from "../../src/schemes/_entry-manifest.ts";
import { openMigrated, insertSession, insertRun, makeSchemeCtx } from "./_helpers.ts";

const url = (pathname: string): UrlPath => ({
    kind: "url", raw: `known:///${pathname}`, scheme: "known",
    username: null, password: null, hostname: null, port: null,
    pathname: `/${pathname}`, params: {}, fragment: null,
});
const taggedEdit = (target: UrlPath, body: string, tags: string[]): EditStatement => ({
    op: "EDIT", suffix: "", signal: tags, target, lineMarker: null, body, position: { line: 1, column: 1 },
});

test("[§packet-manifest-catalog] the manifest catalog surfaces each entry's tags (note 13)", async () => {
    const db = await openMigrated();
    try {
        const sessionId = await insertSession(db, `mtags-${crypto.randomUUID()}`);
        const runId = await insertRun(db, sessionId);
        const ctx = makeSchemeCtx({ db, sessionId, runId });
        await new Known().edit(taggedEdit(url("plan.md"), "the plan", ["wip", "draft"]), ctx);
        await new Known().edit(taggedEdit(url("done.md"), "shipped", []), ctx);

        const catalog = JSON.parse(await EntryManifest.buildManifestBody(ctx)) as Array<{ path: string; tags?: string[] }>;
        const plan = catalog.find((e) => e.path.endsWith("plan.md"));
        assert.deepEqual(plan?.tags, ["draft", "wip"], "the tagged entry carries its entry_tags in the catalog, sorted");
        const done = catalog.find((e) => e.path.endsWith("done.md"));
        assert.equal(done?.tags, undefined, "an untagged entry omits the tags field (no empty-array clutter)");
    } finally { await db.close(); }
});
