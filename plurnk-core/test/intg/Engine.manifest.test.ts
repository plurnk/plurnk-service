// SPEC {§packet} — the FIND-served catalog is the complete, unranked directory of
// workspace entries. A real turn updates its search projection; this test reads
// the same catalog surface and asserts every entry is listed with no visibility field.

import test from "node:test";
import assert from "node:assert/strict";
import Engine from "../../src/core/Engine.ts";
import SchemeRegistry from "../../src/core/SchemeRegistry.ts";
import EntryManifest from "../../src/schemes/_entry-manifest.ts";
import type { CatalogEntry } from "../../src/schemes/_entry-manifest.ts";
import ChannelWrite from "../../src/core/ChannelWrite.ts";
import { Mock } from "@plurnk/plurnk-providers";
import { Results } from "@plurnk/plurnk-schemes";
import type { PlurnkStatement } from "@plurnk/plurnk-contracts";
import { openMigrated, insertWorkspace, insertWorker, insertLoop, seedEntryWithChannel, makeSchemeCtx, DEFAULT_MIMETYPES } from "./_helpers.ts";

const emptyTurn = { assistant: { content: "", ops: [] as PlurnkStatement[], reasoning: null } };

type CatalogItem = { path: string; shown?: unknown; channels: Record<string, { mimetype: string; tokens: number; lines: number }> };

test("the catalog is the complete, unranked directory — every entry, no `shown`, never itself", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `manifest-${crypto.randomUUID()}`);
        const workerId = await insertWorker(db, workspaceId);
        const loopId = await insertLoop(db, workerId, 1, "what's available?");

        // Two workspace entries the directory must enumerate.
        await seedEntryWithChannel(db, { workspaceId, workerId, scheme: "worker", pathname: "/france/capital", channel: "body", content: "Paris", mimetype: "text/markdown" });
        await seedEntryWithChannel(db, { workspaceId, workerId, scheme: "worker", pathname: "/germany/capital", channel: "body", content: "Berlin\nis the capital", mimetype: "text/markdown" });

        // A real turn maintains the search index; the catalog is the
        // read-only render FIND serves — there is no manifest.json entry.
        const engine = new Engine({ db, schemes: new SchemeRegistry(), mimetypes: DEFAULT_MIMETYPES });
        const provider = new Mock({ contextWindow: 100000, responses: [emptyTurn] });
        await engine.runTurn({ provider, workspaceId, workerId, loopId, messages: [] });

        const catalog = await EntryManifest.catalogRowsFor(makeSchemeCtx({ db, workspaceId, workerId })) as CatalogItem[];
        const paths = catalog.map((e) => e.path);

        // Completeness: every seeded entry is listed.
        assert.ok(paths.includes("worker:///france/capital"), `catalog lists france; got ${JSON.stringify(paths)}`);
        assert.ok(paths.includes("worker:///germany/capital"), `catalog lists germany; got ${JSON.stringify(paths)}`);
        // It does not list itself.
        assert.ok(!paths.includes("worker:///manifest.json"), "catalog has no synthetic manifest entry");
        // Unranked directory: NO `shown` (or any visibility/relevance) field anywhere.
        for (const e of catalog) assert.equal("shown" in e, false, `no \`shown\` field — the directory is unranked (offender: ${e.path})`);

        // Shape: { path, channels: { <name>: { mimetype, tokens, lines } } }.
        const germany = catalog.find((e) => e.path === "worker:///germany/capital");
        assert.ok(germany !== undefined, "germany entry present");
        // note 4 — the default (body) channel is keyed by the entry's addressable URI, not "body".
        assert.deepEqual(Object.keys(germany.channels), ["worker:///germany/capital"], "default channel keyed by its URI");
        const gbody = germany.channels["worker:///germany/capital"];
        assert.equal(gbody.mimetype, "text/markdown");
        assert.equal(typeof gbody.tokens, "number", "tokens is the re-counted provider depth");
        assert.ok(gbody.lines >= 1, "lines is the content extent from process().totalLines");
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
        await seedEntryWithChannel(db, { workspaceId, workerId, scheme: "worker", pathname: "/good.json", channel: "body", content: '{"ok":true}', mimetype: "application/json" });
        await seedEntryWithChannel(db, { workspaceId, workerId, scheme: "worker", pathname: "/bad.json", channel: "body", content: '{\n  "a": 1\n  "b": 2\n}', mimetype: "application/json" });

        const engine = new Engine({ db, schemes: new SchemeRegistry(), mimetypes: DEFAULT_MIMETYPES });
        const provider = new Mock({ contextWindow: 100000, responses: [emptyTurn] });
        await engine.runTurn({ provider, workspaceId, workerId, loopId, messages: [] });

        // The turn's pump survived the malformed entry (no -32603); the catalog renders it degraded.
        const catalog = await EntryManifest.catalogRowsFor(makeSchemeCtx({ db, workspaceId, workerId })) as CatalogItem[];
        const paths = catalog.map((e) => e.path);
        assert.ok(paths.includes("worker:///good.json"), `valid entry listed; got ${JSON.stringify(paths)}`);
        assert.ok(paths.includes("worker:///bad.json"), "malformed entry still listed (degraded, not crashed)");
        const bad = catalog.find((e) => e.path === "worker:///bad.json");
        assert.ok(bad !== undefined && bad.channels["worker:///bad.json"].lines >= 1, "malformed entry degraded to a line count");
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
        await seedEntryWithChannel(db, { workspaceId, workerId, scheme: "worker", pathname: "/big.json", channel: "body", content: big, mimetype: "application/json" });

        const engine = new Engine({ db, schemes: new SchemeRegistry(), mimetypes: DEFAULT_MIMETYPES });
        const provider = new Mock({ contextWindow: 100000, responses: [emptyTurn] });
        await engine.runTurn({ provider, workspaceId, workerId, loopId, messages: [] });

        // The turn's pump tiled+embedded the large JSON without crashing; the catalog lists it.
        const catalog = await EntryManifest.catalogRowsFor(makeSchemeCtx({ db, workspaceId, workerId })) as CatalogItem[];
        assert.ok(catalog.some((e) => e.path === "worker:///big.json"), "the large JSON entry is listed in the catalog");
    } finally { await db.close(); }
});

test("{§stream-catalog-lifecycle} catalog distinguishes active, closed, killed, failed, and static entries", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `manifest-stream-state-${crypto.randomUUID()}`);
        const workerId = await insertWorker(db, workspaceId);

        await seedEntryWithChannel(db, { workspaceId, workerId, scheme: "worker", pathname: "/static/note", channel: "body", content: "x", mimetype: "text/markdown" });
        const seedStream = async (pathname: string, result?: ReturnType<typeof Results.failure> | { status: number }): Promise<void> => {
            const entryId = await seedEntryWithChannel(db, {
                workspaceId,
                workerId,
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

        const catalog = await EntryManifest.catalogRowsFor(makeSchemeCtx({ db, workspaceId })) as CatalogEntry[];
        const active = catalog.find((e) => e.path === "sh:///1/1/1");
        const closed = catalog.find((e) => e.path === "sh:///1/1/2");
        const killed = catalog.find((e) => e.path === "sh:///1/1/3");
        const failed = catalog.find((e) => e.path === "sh:///1/1/4");
        const stat = catalog.find((e) => e.path === "worker:///static/note");
        assert.ok(active !== undefined && closed !== undefined && killed !== undefined && failed !== undefined && stat !== undefined);
        assert.equal(active.stream?.state, "active");
        assert.equal(typeof (active.stream?.state === "active" ? active.stream.seconds : undefined), "number");
        assert.deepEqual(closed.stream, { state: "closed", status: 200 });
        assert.deepEqual(killed.stream, { state: "killed", status: 499 });
        assert.deepEqual(failed.stream, { state: "failed", status: 503 });
        assert.equal(stat.stream, undefined, "an entry with no subscription is not presented as a stream");
    } finally { await db.close(); }
});

test("[note4] manifest keys channels by addressable URI — default bare, non-default #fragment", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `note4-${crypto.randomUUID()}`);
        const workerId = await insertWorker(db, workspaceId);
        // A multi-channel exec stream entry at sh:///1/1/2 (stdout is the default channel, + stderr).
        const id = await seedEntryWithChannel(db, { workspaceId, workerId, scheme: "sh", pathname: "/1/1/2", channel: "stdout", content: "out", mimetype: "text/stream" });
        await db.test_seed_channel.run({ entry_id: id, name: "stderr", content: "err", mimetype: "text/stream", state: "static" });
        // sh's default channel is stdout (the Exec handler) — resolve it so stdout keys bare, stderr by #fragment.
        const ctx = makeSchemeCtx({ db, workspaceId, defaultChannelFor: (s) => (s === "sh" ? "stdout" : "body") });
        const catalog = await EntryManifest.catalogRowsFor(ctx) as Array<{ path: string; channels: Record<string, unknown> }>;
        const stream = catalog.find((e) => e.path === "sh:///1/1/2");
        assert.ok(stream, "exec stream listed");
        assert.deepEqual(Object.keys(stream.channels).toSorted(), ["sh:///1/1/2", "sh:///1/1/2#stderr"],
            "stdout (default) keyed by the bare URI; stderr by #stderr — the model READs either verbatim");
    } finally { await db.close(); }
});
