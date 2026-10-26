import SessionName from "../../src/core/SessionName.ts";
// SPEC {§packet} — the FIND-served catalog is the complete, unranked directory
// for one addressed owner. A real turn updates its search projection; this test
// reads the same catalog surface and asserts every selected entry is listed.

import test from "node:test";
import assert from "node:assert/strict";
import Engine from "../../src/core/Engine.ts";
import SchemeRegistry from "../../src/core/SchemeRegistry.ts";
import EntryManifest from "../../src/schemes/_entry-manifest.ts";
import ChannelWrite from "../../src/core/ChannelWrite.ts";
import { Mock } from "@plurnk/plurnk-providers";
import { Results } from "@plurnk/plurnk-schemes";
import { openMigrated, insertWorkspace, insertSession, insertLoop, seedEntryWithChannel } from "./_db.ts";
import { makeSchemeCtx, DEFAULT_MIMETYPES } from "./_scheme.ts";

const indexingTurn = {
    assistant: {
        content: "\n````SEND\ndone\n````",
        reasoning: null,
    },
};

test("{§packet} the commons catalog is complete and unranked — every selected entry, no `shown`, never itself", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `manifest-${crypto.randomUUID()}`);
        const sessionId = await insertSession(db, workspaceId);
        const loopId = await insertLoop(db, sessionId, 1, "what's available?");

        // Two commons-owned entries the directory must enumerate.
        await seedEntryWithChannel(db, { workspaceId, scheme: "workspace", pathname: "/france/capital", channel: "body", content: "Paris", mimetype: "text/markdown" });
        await seedEntryWithChannel(db, { workspaceId, scheme: "workspace", pathname: "/germany/capital", channel: "body", content: "Berlin\nis the capital", mimetype: "text/markdown" });

        // A real turn maintains the search index; the catalog is the
        // read-only render FIND serves — there is no manifest.json entry.
        const engine = new Engine({ db, schemes: new SchemeRegistry(), mimetypes: DEFAULT_MIMETYPES });
        const provider = new Mock({ contextWindow: 100000, responses: [indexingTurn] });
        await engine.runTurn({ provider, workspaceId, sessionId, loopId, messages: [] });

        const catalog = await EntryManifest.catalogRowsFor(makeSchemeCtx({ db, workspaceId, sessionId }));
        const paths = catalog.map(([channel]) => channel.path);

        // Completeness: every seeded entry is listed.
        assert.ok(paths.includes("workspace:///france/capital"), `catalog lists france; got ${JSON.stringify(paths)}`);
        assert.ok(paths.includes("workspace:///germany/capital"), `catalog lists germany; got ${JSON.stringify(paths)}`);
        // It does not list itself.
        assert.ok(!paths.includes("workspace:///manifest.json"), "catalog has no synthetic manifest entry");
        // Unranked directory: NO `shown` (or any visibility/relevance) field anywhere.
        for (const [channel] of catalog) assert.equal("shown" in channel, false, `no \`shown\` field — the directory is unranked (offender: ${channel.path})`);

        // Shape: a non-empty, default-first array of channel metadata; exceptional
        // parser evidence is independently covered below.
        const germany = catalog.find(([channel]) => channel.path === "workspace:///germany/capital");
        assert.ok(germany !== undefined, "germany entry present");
        assert.equal(germany.length, 1);
        const [gbody] = germany;
        assert.equal(gbody.path, "workspace:///germany/capital", "the default channel carries the bare resource URI");
        assert.equal(gbody.mimetype, "text/markdown");
        assert.equal(gbody.weight, Math.ceil("Berlin\nis the capital".length / 2), "weight is the stored curation depth, never re-counted from a body");
        assert.equal(gbody.lines, 2, "lines is the stored extent: a trailing newline would terminate the last line");
    } finally { await db.close(); }
});

test("{§packet} catalog projection selects by literal authority, or the whole workspace when omitted", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `manifest-owner-${crypto.randomUUID()}`);
        const sessionId = await insertSession(db, workspaceId, null, "alice");
        await seedEntryWithChannel(db, {
            workspaceId,
            scheme: "workspace",
            pathname: "/shared.md",
            content: "commons",
        });
        await seedEntryWithChannel(db, {
            workspaceId,
            authority: await SessionName.forId(db, sessionId),
            scheme: "session",
            pathname: "/private.md",
            content: "session",
        });
        const ctx = makeSchemeCtx({ db, workspaceId, sessionId });

        assert.deepEqual(
            (await EntryManifest.catalogRowsFor(ctx)).map(([channel]) => channel.path),
            ["workspace:///shared.md", "session://alice/private.md"],
            "an omitted authority includes every workspace namespace",
        );
        assert.deepEqual(
            (await EntryManifest.catalogRowsFor(ctx, undefined, "alice")).map(([channel]) => channel.path),
            ["session://alice/private.md"],
            "an explicit authority selects that literal namespace",
        );
        assert.deepEqual(
            (await EntryManifest.catalogRowsFor(ctx, "workspace", "")).map(([channel]) => channel.path),
            ["workspace:///shared.md"],
            "an empty authority is the commons, not an omitted filter",
        );
        assert.deepEqual(await EntryManifest.catalogRowsFor(ctx, "https", "alice"), [],
            "scheme and authority filters intersect");
    } finally { await db.close(); }
});

test("{§packet} manifest build survives a malformed application/json entry — degrades to a line count, never crashes the turn (-32603)", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `manifest-badjson-${crypto.randomUUID()}`);
        const sessionId = await insertSession(db, workspaceId);
        const loopId = await insertLoop(db, sessionId, 1, "what's available?");

        // A valid JSON entry plus one whose body is malformed — the kind of imperfect
        // JSON a small model writes. buildManifestBody calls mimetypes.process() per
        // entry for its line count, and process() validates application/json and THROWS
        // SyntaxError on a parse error. Uncaught, that crashed the whole manifest build
        // (and the turn → daemon -32603). One bad entry must not take down everything.
        await seedEntryWithChannel(db, { workspaceId, scheme: "workspace", pathname: "/good.json", channel: "body", content: '{"ok":true}', mimetype: "application/json" });
        await seedEntryWithChannel(db, { workspaceId, scheme: "workspace", pathname: "/bad.json", channel: "body", content: '{\n  "a": 1\n  "b": 2\n}', mimetype: "application/json" });

        const engine = new Engine({ db, schemes: new SchemeRegistry(), mimetypes: DEFAULT_MIMETYPES });
        const provider = new Mock({ contextWindow: 100000, responses: [indexingTurn] });
        await engine.runTurn({ provider, workspaceId, sessionId, loopId, messages: [] });

        // The turn's pump survived the malformed entry (no -32603); the catalog renders it degraded.
        const catalog = await EntryManifest.catalogRowsFor(makeSchemeCtx({ db, workspaceId, sessionId }));
        const paths = catalog.map(([channel]) => channel.path);
        assert.ok(paths.includes("workspace:///good.json"), `valid entry listed; got ${JSON.stringify(paths)}`);
        assert.ok(paths.includes("workspace:///bad.json"), "malformed entry still listed (degraded, not crashed)");
        const bad = catalog.find(([channel]) => channel.path === "workspace:///bad.json");
        assert.ok(bad !== undefined && bad[0].lines >= 1, "malformed entry degraded to a line count");
    } finally { await db.close(); }
});

test("{§scheme-catalog-parse-issues} catalog quietly marks parser recovery without disabling the derivation", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `manifest-parse-issues-${crypto.randomUUID()}`);
        const sessionId = await insertSession(db, workspaceId);
        const loopId = await insertLoop(db, sessionId, 1, "what's available?");
        const brokenId = await seedEntryWithChannel(db, {
            workspaceId,
            scheme: "workspace",
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
            scheme: "workspace",
            pathname: "/clean.ts",
            channel: "body",
            content: "const x = 1;",
            mimetype: "text/typescript",
        });

        const engine = new Engine({ db, schemes: new SchemeRegistry(), mimetypes: DEFAULT_MIMETYPES });
        const provider = new Mock({ contextWindow: 100000, responses: [indexingTurn] });
        await engine.runTurn({ provider, workspaceId, sessionId, loopId, messages: [] });

        const catalog = await EntryManifest.catalogRowsFor(makeSchemeCtx({ db, workspaceId, sessionId }));
        const broken = catalog.find(([channel]) => channel.path === "workspace:///broken.ts");
        const clean = catalog.find(([channel]) => channel.path === "workspace:///clean.ts");
        assert.equal(broken?.[0].parseIssues, 1);
        const notes = broken?.find((channel) => channel.path === "workspace:///broken.ts#notes");
        assert.equal(notes !== undefined && "parseIssues" in notes, false, "one channel's parser issues never label a sibling channel");
        assert.equal(clean !== undefined && "parseIssues" in clean[0], false, "clean source carries no success badge");

        const derivation = await db.test_derivation_disposition.get<{ disposition: string }>({ entry_id: brokenId });
        assert.notEqual(derivation?.disposition, "failed", "advisory parser recovery leaves indexing available");
    } finally { await db.close(); }
});

test("{§scheme-catalog-aside} catalog projects a bounded aside on only its exact markdown channel", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `manifest-summary-${crypto.randomUUID()}`);
        const sessionId = await insertSession(db, workspaceId);
        const loopId = await insertLoop(db, sessionId, 1, "what's available?");
        const long = "x".repeat(300);
        const entryId = await seedEntryWithChannel(db, {
            workspaceId,
            scheme: "workspace",
            pathname: "/tool.md",
            channel: "body",
            content: `# Tool\n\n## Summary\n\n${long}\n\n## Example\n\nDetails.`,
            mimetype: "text/markdown",
        });
        await db.test_seed_channel.run({
            entry_id: entryId,
            name: "notes",
            content: "No summary here.",
            mimetype: "text/markdown",
            state: "static",
        });

        const engine = new Engine({ db, schemes: new SchemeRegistry(), mimetypes: DEFAULT_MIMETYPES });
        const provider = new Mock({ contextWindow: 100000, responses: [indexingTurn] });
        await engine.runTurn({ provider, workspaceId, sessionId, loopId, messages: [] });

        const catalog = await EntryManifest.catalogRowsFor(makeSchemeCtx({ db, workspaceId, sessionId }));
        const tool = catalog.find(([channel]) => channel.path === "workspace:///tool.md");
        assert.equal(Array.from(tool![0].aside!).length, 256);
        assert.equal(tool![0].aside, `${"x".repeat(255)}…`);
        assert.equal("aside" in tool![1], false, "one channel's aside never labels a sibling channel");
    } finally { await db.close(); }
});

test("{§channel-selection-visibility} catalog names a projected channel and its differently typed source", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `manifest-source-mimetype-${crypto.randomUUID()}`);
        const sessionId = await insertSession(db, workspaceId);
        const entryId = await seedEntryWithChannel(db, {
            workspaceId,
            scheme: "file",
            pathname: "/picture.png",
            content: "PNG image, 640×640 px, 37022 bytes",
            mimetype: "text/markdown",
        });
        await db.test_set_entry_attributes.run({
            entry_id: entryId,
            attributes: JSON.stringify({ sourceProjection: { mimetype: "image/png" } }),
        });

        const catalog = await EntryManifest.catalogRowsFor(makeSchemeCtx({ db, workspaceId, sessionId }));
        const picture = catalog.find(([channel]) => channel.path.endsWith("picture.png"));
        assert.ok(picture !== undefined, `picture is cataloged; got ${JSON.stringify(catalog)}`);
        assert.equal(picture[0].mimetype, "text/markdown");
        assert.equal(picture[0].sourceMimetype, "image/png");
    } finally { await db.close(); }
});

test("{§persistent-search-index} a large JSON entry is indexed and cataloged before inference", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `manifest-json-${crypto.randomUUID()}`);
        const sessionId = await insertSession(db, workspaceId);
        const loopId = await insertLoop(db, sessionId, 1, "what's available?");

        const big = JSON.stringify(Object.fromEntries(
            Array.from({ length: 80 }, (_, i) => [`key_${i}`, `value number ${i} with several descriptive words here`]),
        ), null, 2);
        await seedEntryWithChannel(db, { workspaceId, scheme: "workspace", pathname: "/big.json", channel: "body", content: big, mimetype: "application/json" });

        const engine = new Engine({ db, schemes: new SchemeRegistry(), mimetypes: DEFAULT_MIMETYPES });
        const provider = new Mock({ contextWindow: 100000, responses: [indexingTurn] });
        await engine.runTurn({ provider, workspaceId, sessionId, loopId, messages: [] });

        const catalog = await EntryManifest.catalogRowsFor(makeSchemeCtx({ db, workspaceId, sessionId }));
        assert.ok(catalog.some(([channel]) => channel.path === "workspace:///big.json"), "the large JSON entry is listed in the catalog");
    } finally { await db.close(); }
});

test("{§stream-catalog-lifecycle} catalog distinguishes active, closed, killed, failed, and static entries", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `manifest-stream-state-${crypto.randomUUID()}`);
        const sessionId = await insertSession(db, workspaceId, null, "alice");

        await seedEntryWithChannel(db, { workspaceId, authority: await SessionName.forId(db, sessionId), scheme: "session", pathname: "/static/note", channel: "body", content: "x", mimetype: "text/markdown" });
        const seedStream = async (pathname: string, result?: ReturnType<typeof Results.failure> | { status: number }): Promise<void> => {
            const entryId = await seedEntryWithChannel(db, {
                workspaceId,
                scheme: "sh",
                pathname,
                channel: "stdout",
                content: result === undefined ? "running..." : "",
                mimetype: "text/stream",
            });
            const subscriptionId = await ChannelWrite.openSubscription(db, {
                sessionId,
                entryId,
                scheme: "sh",
                handle: `sh: ${pathname}`,
            });
            if (result !== undefined) await ChannelWrite.closeSubscription(db, { subscriptionId, result });
        };
        await seedStream("/1/1/1/sh");
        await seedStream("/1/1/2/sh", { status: 200 });
        await seedStream("/1/1/3/sh", Results.failure("executor:sh", "killed", 499, "killed"));
        await seedStream("/1/1/4/sh", Results.failure("executor:sh", "failed", 503, "failed"));

        const catalog = await EntryManifest.catalogRowsFor(makeSchemeCtx({
            db,
            workspaceId,
            defaultChannelFor: (scheme) => scheme === "sh" ? "stdout" : "body",
        }));
        const active = catalog.find(([channel]) => channel.path === "sh:///1/1/1/sh");
        const closed = catalog.find(([channel]) => channel.path === "sh:///1/1/2/sh");
        const killed = catalog.find(([channel]) => channel.path === "sh:///1/1/3/sh");
        const failed = catalog.find(([channel]) => channel.path === "sh:///1/1/4/sh");
        const stat = catalog.find(([channel]) => channel.path === "session://alice/static/note");
        assert.ok(active !== undefined && closed !== undefined && killed !== undefined && failed !== undefined && stat !== undefined);
        assert.equal(active[0].stream?.state, "active");
        assert.equal(typeof (active[0].stream?.state === "active" ? active[0].stream.seconds : undefined), "number");
        assert.deepEqual(closed[0].stream, { state: "closed", status: 200 });
        assert.deepEqual(killed[0].stream, { state: "killed", status: 499 });
        assert.deepEqual(failed[0].stream, { state: "failed", status: 503 });
        assert.equal(stat[0].stream, undefined, "an entry with no subscription is not presented as a stream");
    } finally { await db.close(); }
});

test("{§packet} [note4] manifest groups addressable channels default-first — default bare, non-default #fragment", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `note4-${crypto.randomUUID()}`);
        await insertSession(db, workspaceId);
        // A multi-channel exec stream entry at sh:///1/1/2/sh (stdout is the default channel, + stderr).
        const id = await seedEntryWithChannel(db, { workspaceId, scheme: "sh", pathname: "/1/1/2/sh", channel: "stdout", content: "out", mimetype: "text/stream" });
        await db.test_seed_channel.run({ entry_id: id, name: "stderr", content: "err", mimetype: "text/stream", state: "static" });
        await db.test_seed_channel.run({ entry_id: id, name: "preview(\\", content: "detail", mimetype: "text/stream", state: "static" });
        await seedEntryWithChannel(db, {
            workspaceId,
            scheme: "https",
            authority: "example.test",
            pathname: "/x?literal=)&encoded=%29",
            channel: "body",
            content: "network",
            mimetype: "text/plain",
        });
        // sh's default channel is stdout (the Exec handler) — resolve it so stdout is [0], stderr a #fragment.
        const ctx = makeSchemeCtx({ db, workspaceId, defaultChannelFor: (s) => (s === "sh" ? "stdout" : "body") });
        const catalog = await EntryManifest.catalogRowsFor(ctx);
        const stream = catalog.find(([channel]) => channel.path === "sh:///1/1/2/sh");
        assert.ok(stream, "exec stream listed");
        assert.deepEqual(
            stream.map((channel) => channel.path),
            ["sh:///1/1/2/sh", "sh:///1/1/2/sh#preview\\(\\\\", "sh:///1/1/2/sh#stderr"],
            "the default is first and bare; non-default channels use target-slot spelling",
        );
        assert.ok(
            catalog.some(([channel]) => channel.path === "https://example.test/x?literal=\\)&encoded=%29"),
            "network catalog paths preserve literal and percent-encoded query identity",
        );
    } finally { await db.close(); }
});
