// SPEC §packet — plurnk:///manifest.json is the complete, unranked directory of the
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
        await seedEntryWithChannel(db, { sessionId, runId, scheme: "known", pathname: "/france/capital", channel: "body", content: "Paris", mimetype: "text/markdown" });
        await seedEntryWithChannel(db, { sessionId, runId, scheme: "known", pathname: "/germany/capital", channel: "body", content: "Berlin\nis the capital", mimetype: "text/markdown" });

        // A real turn rewrites plurnk:///manifest.json (Engine.runTurn line 702).
        const engine = new Engine({ db, schemes: new SchemeRegistry(), mimetypes: DEFAULT_MIMETYPES });
        const provider = new Mock({ contextSize: 100000, responses: [emptyTurn] });
        await engine.runTurn({ provider, sessionId, runId, loopId, messages: [] });

        // Parse the materialized catalog body.
        const entryId = (await (db.test_get_entry_id_by_scheme_pathname as PrepMethod).get<{ id: number }>({ scheme: "plurnk", pathname: "/manifest.json" }))?.id;
        assert.notEqual(entryId, undefined, "the turn materialized plurnk:///manifest.json");
        const body = await (db.test_get_channel as PrepMethod).get<{ content: string }>({ entry_id: entryId, name: "body" });
        const catalog = JSON.parse(body?.content ?? "[]") as CatalogItem[];
        const paths = catalog.map((e) => e.path);

        // Completeness: every seeded entry is listed.
        assert.ok(paths.includes("known:///france/capital"), `catalog lists france; got ${JSON.stringify(paths)}`);
        assert.ok(paths.includes("known:///germany/capital"), `catalog lists germany; got ${JSON.stringify(paths)}`);
        // It does not list itself.
        assert.ok(!paths.includes("plurnk:///manifest.json"), "catalog does not list itself");
        // Unranked directory: NO `shown` (or any visibility/relevance) field anywhere.
        for (const e of catalog) assert.equal("shown" in e, false, `no \`shown\` field — the directory is unranked (offender: ${e.path})`);

        // Shape: { path, channels: { <name>: { mimetype, tokens, lines } } }.
        const germany = catalog.find((e) => e.path === "known:///germany/capital");
        assert.ok(germany !== undefined, "germany entry present");
        // note 4 — the default (body) channel is keyed by the entry's addressable URI, not "body".
        assert.deepEqual(Object.keys(germany.channels), ["known:///germany/capital"], "default channel keyed by its URI");
        const gbody = germany.channels["known:///germany/capital"];
        assert.equal(gbody.mimetype, "text/markdown");
        assert.equal(typeof gbody.tokens, "number", "tokens is the re-counted provider depth");
        assert.ok(gbody.lines >= 1, "lines is the content extent from process().totalLines");
    } finally { await db.close(); }
});

test("manifest build survives a malformed application/json entry — degrades to a line count, never crashes the turn (-32603)", async () => {
    const db = await openMigrated();
    try {
        const sessionId = await insertSession(db, `manifest-badjson-${crypto.randomUUID()}`);
        const runId = await insertRun(db, sessionId);
        const loopId = await insertLoop(db, runId, 1, "what's available?");

        // A valid JSON entry plus one whose body is malformed — the kind of imperfect
        // JSON a small model writes. buildManifestBody calls mimetypes.process() per
        // entry for its line count, and process() validates application/json and THROWS
        // SyntaxError on a parse error. Uncaught, that crashed the whole manifest build
        // (and the turn → daemon -32603). One bad entry must not take down everything.
        await seedEntryWithChannel(db, { sessionId, runId, scheme: "known", pathname: "/good.json", channel: "body", content: '{"ok":true}', mimetype: "application/json" });
        await seedEntryWithChannel(db, { sessionId, runId, scheme: "known", pathname: "/bad.json", channel: "body", content: '{\n  "a": 1\n  "b": 2\n}', mimetype: "application/json" });

        const engine = new Engine({ db, schemes: new SchemeRegistry(), mimetypes: DEFAULT_MIMETYPES });
        const provider = new Mock({ contextSize: 100000, responses: [emptyTurn] });
        await engine.runTurn({ provider, sessionId, runId, loopId, messages: [] });

        const entryId = (await (db.test_get_entry_id_by_scheme_pathname as PrepMethod).get<{ id: number }>({ scheme: "plurnk", pathname: "/manifest.json" }))?.id;
        assert.notEqual(entryId, undefined, "the manifest materialized despite the malformed entry");
        const body = await (db.test_get_channel as PrepMethod).get<{ content: string }>({ entry_id: entryId, name: "body" });
        const catalog = JSON.parse(body?.content ?? "[]") as CatalogItem[];
        const paths = catalog.map((e) => e.path);
        assert.ok(paths.includes("known:///good.json"), `valid entry listed; got ${JSON.stringify(paths)}`);
        assert.ok(paths.includes("known:///bad.json"), "malformed entry still listed (degraded, not crashed)");
        const bad = catalog.find((e) => e.path === "known:///bad.json");
        assert.ok(bad !== undefined && bad.channels["known:///bad.json"].lines >= 1, "malformed entry degraded to a line count");
    } finally { await db.close(); }
});

test("a JSON entry large enough to tile builds through the live embedder — the every-run crash, end-to-end", async () => {
    const db = await openMigrated();
    try {
        const sessionId = await insertSession(db, `manifest-jsontile-${crypto.randomUUID()}`);
        const runId = await insertRun(db, sessionId);
        const loopId = await insertLoop(db, runId, 1, "what's available?");

        // A VALID JSON document large enough to exceed the embedder window, so it tiles —
        // and each tile is an invalid JSON fragment. With the embedder live in
        // DEFAULT_MIMETYPES, the manifest build's deriveEmbeddings runs the tile+embed path:
        // the exact code that crashed every run, exercised end-to-end against the real model.
        const big = JSON.stringify(Object.fromEntries(
            Array.from({ length: 80 }, (_, i) => [`key_${i}`, `value number ${i} with several descriptive words here`]),
        ), null, 2);
        await seedEntryWithChannel(db, { sessionId, runId, scheme: "known", pathname: "/big.json", channel: "body", content: big, mimetype: "application/json" });

        const engine = new Engine({ db, schemes: new SchemeRegistry(), mimetypes: DEFAULT_MIMETYPES });
        const provider = new Mock({ contextSize: 100000, responses: [emptyTurn] });
        await engine.runTurn({ provider, sessionId, runId, loopId, messages: [] });

        const entryId = (await (db.test_get_entry_id_by_scheme_pathname as PrepMethod).get<{ id: number }>({ scheme: "plurnk", pathname: "/manifest.json" }))?.id;
        assert.notEqual(entryId, undefined, "the manifest materialized — the tiled JSON entry did not crash the turn");
        const body = await (db.test_get_channel as PrepMethod).get<{ content: string }>({ entry_id: entryId, name: "body" });
        const catalog = JSON.parse(body?.content ?? "[]") as CatalogItem[];
        assert.ok(catalog.some((e) => e.path === "known:///big.json"), "the large JSON entry is listed in the catalog");
    } finally { await db.close(); }
});

test("[#21] manifest stamps live seconds= on an active stream, absent for static entries", async () => {
    const db = await openMigrated();
    try {
        const sessionId = await insertSession(db, `manifest-secs-${crypto.randomUUID()}`);
        const runId = await insertRun(db, sessionId);

        // A static entry (no subscription) + an exec entry with an open stream.
        await seedEntryWithChannel(db, { sessionId, runId, scheme: "known", pathname: "/static/note", channel: "body", content: "x", mimetype: "text/markdown" });
        const execId = await seedEntryWithChannel(db, { sessionId, runId, scheme: "sh", pathname: "/1/1/1", channel: "stdout", content: "running...", mimetype: "text/stream" });
        await ChannelWrite.openSubscription(db, { runId, entryId: execId, scheme: "sh", handle: "sh: sleep 30" });

        const catalog = await EntryManifest.catalogRowsFor(makeSchemeCtx({ db, sessionId })) as Array<{ path: string; seconds?: number; channels: object }>;

        const stream = catalog.find((e) => e.path === "sh:///1/1/1");
        const stat = catalog.find((e) => e.path === "known:///static/note");
        assert.ok(stream !== undefined && stat !== undefined, "both entries listed");
        assert.equal(typeof stream.seconds, "number", "active stream carries a live seconds= clock");
        assert.ok((stream.seconds ?? -1) >= 0, "seconds is non-negative elapsed");
        assert.equal(stat.seconds, undefined, "a static entry has no seconds (no open subscription)");
    } finally { await db.close(); }
});

test("[note4] manifest keys channels by addressable URI — default bare, non-default #fragment", async () => {
    const db = await openMigrated();
    try {
        const sessionId = await insertSession(db, `note4-${crypto.randomUUID()}`);
        const runId = await insertRun(db, sessionId);
        // A multi-channel exec stream entry at sh:///1/1/2 (stdout is the default channel, + stderr).
        const id = await seedEntryWithChannel(db, { sessionId, runId, scheme: "sh", pathname: "/1/1/2", channel: "stdout", content: "out", mimetype: "text/stream" });
        await (db.test_seed_channel as PrepMethod).run({ entry_id: id, name: "stderr", content: "err", mimetype: "text/stream", state: "static" });
        // sh's default channel is stdout (the Exec handler) — resolve it so stdout keys bare, stderr by #fragment.
        const ctx = makeSchemeCtx({ db, sessionId, defaultChannelFor: (s) => (s === "sh" ? "stdout" : "body") });
        const catalog = await EntryManifest.catalogRowsFor(ctx) as Array<{ path: string; channels: Record<string, unknown> }>;
        const stream = catalog.find((e) => e.path === "sh:///1/1/2");
        assert.ok(stream, "exec stream listed");
        assert.deepEqual(Object.keys(stream.channels).toSorted(), ["sh:///1/1/2", "sh:///1/1/2#stderr"],
            "stdout (default) keyed by the bare URI; stderr by #stderr — the model READs either verbatim");
    } finally { await db.close(); }
});
