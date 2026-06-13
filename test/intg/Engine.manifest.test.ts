// SPEC §packet — plurnk://manifest.json is the complete, unranked directory of the
// session's entries, rewritten every turn by Engine.runTurn. This drives the
// LIVE path: a real turn materializes the manifest; we parse its body and assert
// the directory contract — every entry listed, NO `shown`/relevance field, the
// catalog never lists itself.

import test from "node:test";
import assert from "node:assert/strict";
import Engine from "../../src/core/Engine.ts";
import SchemeRegistry from "../../src/core/SchemeRegistry.ts";
import EntryManifest from "../../src/schemes/_entry-manifest.ts";
import ChannelWrite from "../../src/core/ChannelWrite.ts";
import { Mock } from "@plurnk/plurnk-providers";
import type { PlurnkStatement } from "@plurnk/plurnk-grammar";
import type { PrepMethod } from "../../src/core/Db.ts";
import { openMigrated, insertSession, insertRun, insertLoop, seedEntryWithChannel, makeSchemeCtx, DEFAULT_MIMETYPES } from "./_helpers.ts";

const emptyTurn = { assistant: { content: "", ops: [] as PlurnkStatement[], reasoning: null } };

type CatalogItem = { path: string; shown?: unknown; channels: Record<string, { mimetype: string; tokens: number; lines: number }> };

test("[§packet-manifest-catalog] manifest.json is the complete, unranked directory — every entry, no `shown`, never itself", async () => {
    const db = await openMigrated();
    try {
        const sessionId = await insertSession(db, `manifest-${crypto.randomUUID()}`);
        const runId = await insertRun(db, sessionId);
        const loopId = await insertLoop(db, runId, 1, "what's available?");

        // Two session entries the directory must enumerate.
        await seedEntryWithChannel(db, { sessionId, runId, scheme: "known", pathname: "france/capital", channel: "body", content: "Paris", mimetype: "text/markdown" });
        await seedEntryWithChannel(db, { sessionId, runId, scheme: "known", pathname: "germany/capital", channel: "body", content: "Berlin\nis the capital", mimetype: "text/markdown" });

        // A real turn rewrites plurnk://manifest.json (Engine.runTurn line 702).
        const engine = new Engine({ db, schemes: new SchemeRegistry(), mimetypes: DEFAULT_MIMETYPES });
        const provider = new Mock({ contextSize: 100000, responses: [emptyTurn] });
        await engine.runTurn({ provider, sessionId, runId, loopId, messages: [] });

        // Parse the materialized catalog body.
        const entryId = (await (db.test_get_entry_id_by_scheme_pathname as PrepMethod).get<{ id: number }>({ scheme: "plurnk", pathname: "manifest.json" }))?.id;
        assert.notEqual(entryId, undefined, "the turn materialized plurnk://manifest.json");
        const body = await (db.test_get_channel as PrepMethod).get<{ content: string }>({ entry_id: entryId, name: "body" });
        const catalog = JSON.parse(body?.content ?? "[]") as CatalogItem[];
        const paths = catalog.map((e) => e.path);

        // Completeness: every seeded entry is listed.
        assert.ok(paths.includes("known://france/capital"), `catalog lists france; got ${JSON.stringify(paths)}`);
        assert.ok(paths.includes("known://germany/capital"), `catalog lists germany; got ${JSON.stringify(paths)}`);
        // It does not list itself.
        assert.ok(!paths.includes("plurnk://manifest.json"), "catalog does not list itself");
        // Unranked directory: NO `shown` (or any visibility/relevance) field anywhere.
        for (const e of catalog) assert.equal("shown" in e, false, `no \`shown\` field — the directory is unranked (offender: ${e.path})`);

        // Shape: { path, channels: { <name>: { mimetype, tokens, lines } } }.
        const germany = catalog.find((e) => e.path === "known://germany/capital");
        assert.ok(germany !== undefined, "germany entry present");
        assert.deepEqual(Object.keys(germany.channels), ["body"], "one body channel");
        assert.equal(germany.channels.body.mimetype, "text/markdown");
        assert.equal(typeof germany.channels.body.tokens, "number", "tokens is the re-counted provider depth");
        assert.ok(germany.channels.body.lines >= 1, "lines is the content extent from process().totalLines");
    } finally { await db.close(); }
});

test("[#21] manifest stamps live seconds= on an active stream, absent for static entries", async () => {
    const db = await openMigrated();
    try {
        const sessionId = await insertSession(db, `manifest-secs-${crypto.randomUUID()}`);
        const runId = await insertRun(db, sessionId);

        // A static entry (no subscription) + an exec entry with an open stream.
        await seedEntryWithChannel(db, { sessionId, runId, scheme: "known", pathname: "static/note", channel: "body", content: "x", mimetype: "text/markdown" });
        const execId = await seedEntryWithChannel(db, { sessionId, runId, scheme: "exec", pathname: "sh/1/1/1", channel: "stdout", content: "running...", mimetype: "text/stream" });
        await ChannelWrite.openSubscription(db, { runId, entryId: execId, scheme: "exec", handle: "sh: sleep 30" });

        const body = await EntryManifest.buildManifestBody(makeSchemeCtx({ db, sessionId }));
        const catalog = JSON.parse(body) as Array<{ path: string; seconds?: number; channels: object }>;

        const stream = catalog.find((e) => e.path === "exec://sh/1/1/1");
        const stat = catalog.find((e) => e.path === "known://static/note");
        assert.ok(stream !== undefined && stat !== undefined, "both entries listed");
        assert.equal(typeof stream.seconds, "number", "active stream carries a live seconds= clock");
        assert.ok((stream.seconds ?? -1) >= 0, "seconds is non-negative elapsed");
        assert.equal(stat.seconds, undefined, "a static entry has no seconds (no open subscription)");
    } finally { await db.close(); }
});
