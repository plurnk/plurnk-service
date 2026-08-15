// SPEC {§packet} — the FIND-served catalog is the complete, unranked directory
// for one addressed owner. A real turn updates its search projection; this test
// reads the same catalog surface and asserts every selected entry is listed.

import test from "node:test";
import assert from "node:assert/strict";
import Engine from "../../src/core/Engine.ts";
import SchemeRegistry from "../../src/core/SchemeRegistry.ts";
import EntryManifest from "../../src/schemes/_entry-manifest.ts";
import type { CatalogEntry } from "../../src/schemes/_entry-manifest.ts";
import ChannelWrite from "../../src/core/ChannelWrite.ts";
import { Mock } from "@plurnk/plurnk-providers";
import { Results } from "@plurnk/plurnk-schemes";
import { openMigrated, insertWorkspace, insertWorker, insertLoop, seedEntryWithChannel, makeSchemeCtx, DEFAULT_MIMETYPES } from "./_helpers.ts";

const indexingTurn = {
    assistant: {
        content: "# PLAN0\nfinish indexing\n\n## SEND0 [200]\ndone",
        reasoning: null,
    },
};

test("the commons catalog is complete and unranked — every selected entry, no `shown`, never itself", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `manifest-${crypto.randomUUID()}`);
        const workerId = await insertWorker(db, workspaceId);
        const loopId = await insertLoop(db, workerId, 1, "what's available?");

        // Two commons-owned entries the directory must enumerate.
        await seedEntryWithChannel(db, { workspaceId, scheme: "worker", pathname: "/france/capital", channel: "body", content: "Paris", mimetype: "text/markdown" });
        await seedEntryWithChannel(db, { workspaceId, scheme: "worker", pathname: "/germany/capital", channel: "body", content: "Berlin\nis the capital", mimetype: "text/markdown" });

        // A real turn maintains the search index; the catalog is the
        // read-only render FIND serves — there is no manifest.json entry.
        const engine = new Engine({ db, schemes: new SchemeRegistry(), mimetypes: DEFAULT_MIMETYPES });
        const provider = new Mock({ contextWindow: 100000, responses: [indexingTurn] });
        await engine.runTurn({ provider, workspaceId, workerId, loopId, messages: [] });

        const catalog = await EntryManifest.catalogRowsFor(makeSchemeCtx({ db, workspaceId, workerId }));
        const paths = catalog.map(([channel]) => channel.path);

        // Completeness: every seeded entry is listed.
        assert.ok(paths.includes("worker:///france/capital"), `catalog lists france; got ${JSON.stringify(paths)}`);
        assert.ok(paths.includes("worker:///germany/capital"), `catalog lists germany; got ${JSON.stringify(paths)}`);
        // It does not list itself.
        assert.ok(!paths.includes("worker:///manifest.json"), "catalog has no synthetic manifest entry");
        // Unranked directory: NO `shown` (or any visibility/relevance) field anywhere.
        for (const [channel] of catalog) assert.equal("shown" in channel, false, `no \`shown\` field — the directory is unranked (offender: ${channel.path})`);

        // Shape: a non-empty, default-first array of channel metadata; exceptional
        // parser evidence is independently covered below.
        const germany = catalog.find(([channel]) => channel.path === "worker:///germany/capital");
        assert.ok(germany !== undefined, "germany entry present");
        assert.equal(germany.length, 1);
        const [gbody] = germany;
        assert.equal(gbody.path, "worker:///germany/capital", "the default channel carries the bare resource URI");
        assert.equal(gbody.mimetype, "text/markdown");
        assert.equal(typeof gbody.weight, "number", "weight is the re-counted curation depth");
        assert.ok(gbody.lines >= 1, "lines is the content extent from process().totalLines");
    } finally { await db.close(); }
});

test("catalog projection selects exactly one owner", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `manifest-owner-${crypto.randomUUID()}`);
        const workerId = await insertWorker(db, workspaceId);
        await seedEntryWithChannel(db, {
            workspaceId,
            scheme: "worker",
            pathname: "/shared.md",
            content: "commons",
        });
        await seedEntryWithChannel(db, {
            workspaceId,
            ownerId: workerId,
            scheme: "worker",
            pathname: "/private.md",
            content: "worker",
        });
        const ctx = makeSchemeCtx({ db, workspaceId, workerId });

        assert.deepEqual(
            (await EntryManifest.catalogRowsFor(ctx)).map(([channel]) => channel.path),
            ["worker:///shared.md"],
            "an omitted owner means the shared commons, never every workspace row",
        );
        assert.deepEqual(
            (await EntryManifest.catalogRowsFor(ctx, undefined, workerId)).map(([channel]) => channel.path),
            ["worker:///private.md"],
            "an explicit owner selects only that owner's private entries",
        );
    } finally { await db.close(); }
});

test("manifest build survives a malformed application/json entry — degrades to a line count, never crashes the turn (-32603)", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `manifest-badjson-${crypto.randomUUID()}`);
        const workerId = await insertWorker(db, workspaceId);
        const loopId = await insertLoop(db, workerId, 1, "what's available?");

        // A valid JSON entry plus one whose body is malformed — the kind of imperfect
        // JSON a small model writes. buildManifestBody calls mimetypes.process() per
        // entry for its line count, and process() validates application/json and THROWS
        // SyntaxError on a parse error. Uncaught, that crashed the whole manifest build
        // (and the turn → daemon -32603). One bad entry must not take down everything.
        await seedEntryWithChannel(db, { workspaceId, scheme: "worker", pathname: "/good.json", channel: "body", content: '{"ok":true}', mimetype: "application/json" });
        await seedEntryWithChannel(db, { workspaceId, scheme: "worker", pathname: "/bad.json", channel: "body", content: '{\n  "a": 1\n  "b": 2\n}', mimetype: "application/json" });

        const engine = new Engine({ db, schemes: new SchemeRegistry(), mimetypes: DEFAULT_MIMETYPES });
        const provider = new Mock({ contextWindow: 100000, responses: [indexingTurn] });
        await engine.runTurn({ provider, workspaceId, workerId, loopId, messages: [] });

        // The turn's pump survived the malformed entry (no -32603); the catalog renders it degraded.
        const catalog = await EntryManifest.catalogRowsFor(makeSchemeCtx({ db, workspaceId, workerId }));
        const paths = catalog.map(([channel]) => channel.path);
        assert.ok(paths.includes("worker:///good.json"), `valid entry listed; got ${JSON.stringify(paths)}`);
        assert.ok(paths.includes("worker:///bad.json"), "malformed entry still listed (degraded, not crashed)");
        const bad = catalog.find(([channel]) => channel.path === "worker:///bad.json");
        assert.ok(bad !== undefined && bad[0].lines >= 1, "malformed entry degraded to a line count");
    } finally { await db.close(); }
});

test("{§scheme-catalog-parse-issues} catalog quietly marks parser recovery without disabling the derivation", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `manifest-parse-issues-${crypto.randomUUID()}`);
        const workerId = await insertWorker(db, workspaceId);
        const loopId = await insertLoop(db, workerId, 1, "what's available?");
        const brokenId = await seedEntryWithChannel(db, {
            workspaceId,
            scheme: "worker",
            pathname: "/broken.ts",
            channel: "body",
            content: "const x = ;",
            mimetype: "text/typescript",
        });
        await db.test_seed_channel.run({
            entry_id: brokenId,
            name: "notes",
            content: "auxiliary channel",
            mimetype: "text/plain",
            state: "static",
        });
        await seedEntryWithChannel(db, {
            workspaceId,
            scheme: "worker",
            pathname: "/clean.ts",
            channel: "body",
            content: "const x = 1;",
            mimetype: "text/typescript",
        });

        const engine = new Engine({ db, schemes: new SchemeRegistry(), mimetypes: DEFAULT_MIMETYPES });
        const provider = new Mock({ contextWindow: 100000, responses: [indexingTurn] });
        await engine.runTurn({ provider, workspaceId, workerId, loopId, messages: [] });

        const catalog = await EntryManifest.catalogRowsFor(makeSchemeCtx({ db, workspaceId, workerId }));
        const broken = catalog.find(([channel]) => channel.path === "worker:///broken.ts");
        const clean = catalog.find(([channel]) => channel.path === "worker:///clean.ts");
        assert.equal(broken?.[0].parseIssues, 1);
        const notes = broken?.find((channel) => channel.path === "worker:///broken.ts#notes");
        assert.equal(notes !== undefined && "parseIssues" in notes, false, "the body derivation never labels an unparsed sibling channel");
        assert.equal(clean !== undefined && "parseIssues" in clean[0], false, "clean source carries no success badge");

        const derivation = await db.test_derivation_disposition.get<{ disposition: string }>({ entry_id: brokenId });
        assert.notEqual(derivation?.disposition, "failed", "advisory parser recovery leaves indexing available");
    } finally { await db.close(); }
});

test("a JSON entry large enough to tile builds through the live embedder — the every-worker crash, end-to-end", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `manifest-jsontile-${crypto.randomUUID()}`);
        const workerId = await insertWorker(db, workspaceId);
        const loopId = await insertLoop(db, workerId, 1, "what's available?");

        // A VALID JSON document large enough to exceed the embedder window, so it tiles —
        // and each tile is an invalid JSON fragment. With the embedder live in
        // DEFAULT_MIMETYPES, the manifest build's deriveEmbeddings runs the tile+embed path:
        // the exact code that crashed every worker, exercised end-to-end against the real model.
        const big = JSON.stringify(Object.fromEntries(
            Array.from({ length: 80 }, (_, i) => [`key_${i}`, `value number ${i} with several descriptive words here`]),
        ), null, 2);
        await seedEntryWithChannel(db, { workspaceId, scheme: "worker", pathname: "/big.json", channel: "body", content: big, mimetype: "application/json" });

        const engine = new Engine({ db, schemes: new SchemeRegistry(), mimetypes: DEFAULT_MIMETYPES });
        const provider = new Mock({ contextWindow: 100000, responses: [indexingTurn] });
        await engine.runTurn({ provider, workspaceId, workerId, loopId, messages: [] });

        // The turn's pump tiled+embedded the large JSON without crashing; the catalog lists it.
        const catalog = await EntryManifest.catalogRowsFor(makeSchemeCtx({ db, workspaceId, workerId }));
        assert.ok(catalog.some(([channel]) => channel.path === "worker:///big.json"), "the large JSON entry is listed in the catalog");
    } finally { await db.close(); }
});

test("{§stream-catalog-lifecycle} catalog distinguishes active, closed, killed, failed, and static entries", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `manifest-stream-state-${crypto.randomUUID()}`);
        const workerId = await insertWorker(db, workspaceId);

        await seedEntryWithChannel(db, { workspaceId, ownerId: workerId, scheme: "worker", pathname: "/static/note", channel: "body", content: "x", mimetype: "text/markdown" });
        const seedStream = async (pathname: string, result?: ReturnType<typeof Results.failure> | { status: number }): Promise<void> => {
            const entryId = await seedEntryWithChannel(db, {
                workspaceId,
                ownerId: workerId,
                scheme: "sh",
                pathname,
                channel: "stdout",
                content: result === undefined ? "running..." : "",
                mimetype: "text/stream",
            });
            const subscriptionId = await ChannelWrite.openSubscription(db, {
                workerId,
                entryId,
                scheme: "sh",
                handle: `sh: ${pathname}`,
            });
            if (result !== undefined) await ChannelWrite.closeSubscription(db, { subscriptionId, result });
        };
        await seedStream("/1/1/1");
        await seedStream("/1/1/2", { status: 200 });
        await seedStream("/1/1/3", Results.failure("executor:sh", "killed", 499, "killed"));
        await seedStream("/1/1/4", Results.failure("executor:sh", "failed", 503, "failed"));

        const catalog = await EntryManifest.catalogRowsFor(makeSchemeCtx({
            db,
            workspaceId,
            defaultChannelFor: (scheme) => scheme === "sh" ? "stdout" : "body",
        }), undefined, workerId) as CatalogEntry[];
        const active = catalog.find(([channel]) => channel.path === "sh:///1/1/1");
        const closed = catalog.find(([channel]) => channel.path === "sh:///1/1/2");
        const killed = catalog.find(([channel]) => channel.path === "sh:///1/1/3");
        const failed = catalog.find(([channel]) => channel.path === "sh:///1/1/4");
        const stat = catalog.find(([channel]) => channel.path === "worker:///static/note");
        assert.ok(active !== undefined && closed !== undefined && killed !== undefined && failed !== undefined && stat !== undefined);
        assert.equal(active[0].stream?.state, "active");
        assert.equal(typeof (active[0].stream?.state === "active" ? active[0].stream.seconds : undefined), "number");
        assert.deepEqual(closed[0].stream, { state: "closed", status: 200 });
        assert.deepEqual(killed[0].stream, { state: "killed", status: 499 });
        assert.deepEqual(failed[0].stream, { state: "failed", status: 503 });
        assert.equal(stat[0].stream, undefined, "an entry with no subscription is not presented as a stream");
    } finally { await db.close(); }
});

test("[note4] manifest groups addressable channels default-first — default bare, non-default #fragment", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `note4-${crypto.randomUUID()}`);
        const workerId = await insertWorker(db, workspaceId);
        // A multi-channel exec stream entry at sh:///1/1/2 (stdout is the default channel, + stderr).
        const id = await seedEntryWithChannel(db, { workspaceId, ownerId: workerId, scheme: "sh", pathname: "/1/1/2", channel: "stdout", content: "out", mimetype: "text/stream" });
        await db.test_seed_channel.run({ entry_id: id, name: "stderr", content: "err", mimetype: "text/stream", state: "static" });
        await db.test_seed_channel.run({ entry_id: id, name: "preview(\\", content: "detail", mimetype: "text/stream", state: "static" });
        await seedEntryWithChannel(db, {
            workspaceId,
            ownerId: workerId,
            scheme: "https",
            pathname: "/example.test/x?literal=)&encoded=%29",
            channel: "body",
            content: "network",
            mimetype: "text/plain",
        });
        // sh's default channel is stdout (the Exec handler) — resolve it so stdout is [0], stderr a #fragment.
        const ctx = makeSchemeCtx({ db, workspaceId, defaultChannelFor: (s) => (s === "sh" ? "stdout" : "body") });
        const catalog = await EntryManifest.catalogRowsFor(ctx, undefined, workerId);
        const stream = catalog.find(([channel]) => channel.path === "sh:///1/1/2");
        assert.ok(stream, "exec stream listed");
        assert.deepEqual(
            stream.map((channel) => channel.path),
            ["sh:///1/1/2", "sh:///1/1/2#preview\\(\\\\", "sh:///1/1/2#stderr"],
            "the default is first and bare; non-default channels use target-slot spelling",
        );
        assert.ok(
            catalog.some(([channel]) => channel.path === "https://example.test/x?literal=\\)&encoded=%29"),
            "network catalog paths preserve literal and percent-encoded query identity",
        );
    } finally { await db.close(); }
});
