// Integration coverage for SPEC {§channels} channel-topology contract tags that
// previously had no test. Each test name carries its §-anchor and exercises
// the real path for one tagged sentence in SPEC.md {§channels}.

import test from "node:test";
import assert from "node:assert/strict";
import type { MatcherBody } from "@plurnk/plurnk-contracts";
import Worker from "../../src/schemes/Worker.ts";
import Exec from "../../src/schemes/Exec.ts";
import EntryFind from "../../src/schemes/_entry-find.ts";
import SearchIndex from "../../src/schemes/_search-index.ts";
import Owner from "../../src/core/Owner.ts";
import DbChannelCaps from "../../src/core/caps/DbChannelCaps.ts";
import type { Db } from "../../src/core/Db.ts";
import Engine from "../../src/core/Engine.ts";
import SchemeRegistry from "../../src/core/SchemeRegistry.ts";
import { lookThroughScheme, mimetypesFixture, openMigrated, insertWorkspace, insertWorker, makeSchemeCtx, schemeManifest, seedEntryWithChannel, testExecutors } from "./_helpers.ts";
import { urlPath, editStmt, findStmt, fullReplace, readStmt, regex } from "./_dsl.ts";
import { resourcePaths } from "./_find.ts";

const setup = async () => {
    const db = await openMigrated();
    const workspaceId = await insertWorkspace(db, `ws-${crypto.randomUUID()}`);
    const workerId = await insertWorker(db, workspaceId);
    return { db, workspaceId, workerId };
};

// Seed a multi-channel exec entry (stdout + stderr) directly, bypassing the
// subprocess. exec is the production multi-channel vehicle (Worker is single-
// channel); fragment routing in _entry-ops.ts is exercised through Exec's
// manifest (defaultChannel="stdout").
const seedExecEntry = async (
    db: Db,
    workspaceId: number,
    workerId: number,
    pathname: string,
    stdout: string,
    stderr: string,
): Promise<number> => {
    const entryId = await seedEntryWithChannel(db, {
        workspaceId, ownerId: workerId, scheme: "exec", pathname, channel: "stdout", content: stdout, mimetype: "text/stream",
    });
    // Second channel on the SAME entry — the (entry_id, name) keying means a
    // distinct name is a distinct row under the same entry.
    await db.test_seed_channel.run({
        entry_id: entryId, name: "stderr", content: stderr, mimetype: "text/stream", state: "static",
    });
    return entryId;
};

test("fragment targets the named channel; fragment-less targets default", async () => {
    const { db, workspaceId, workerId } = await setup();
    try {
        await seedExecEntry(db, workspaceId, workerId, "/run/abc", "OUT-content", "ERR-content");
        const readExec = (statement: ReturnType<typeof readStmt>) => lookThroughScheme(
            "exec",
            null,
            statement,
            makeSchemeCtx({ db, workspaceId, workerId }),
        );

        // Fragment `#stderr` selects the named (non-default) channel.
        const frag = await readExec(readStmt(urlPath("exec", "/run/abc", "stderr")));
        assert.equal(frag.status, 200);
        assert.equal(frag.channel, "stderr");
        assert.equal(frag.content, "ERR-content");

        // Fragment-less resolves to the scheme's defaultChannel (stdout).
        const dflt = await readExec(readStmt(urlPath("exec", "/run/abc")));
        assert.equal(dflt.status, 200);
        assert.equal(dflt.channel, "stdout");
        assert.equal(dflt.content, "OUT-content");
    } finally { await db.close(); }
});

test("{§find-channel-selection}: FIND matches the explicitly addressed channel", async () => {
    const { db, workspaceId, workerId } = await setup();
    try {
        await seedExecEntry(
            db,
            workspaceId,
            workerId,
            "/run/abc",
            "ordinary output",
            "stderr-only diagnostic",
        );
        const exec = new Exec();
        const core = makeSchemeCtx({
            db,
            workspaceId,
            workerId,
            defaultChannelFor: () => Exec.manifest.defaultChannel,
        });
        const result = await exec.find(
            findStmt(urlPath("exec", "/run/abc", "stderr"), regex("stderr-only")),
            core,
        );

        assert.equal(result.status, 200);
        assert.equal(result.matchingPathCount, 1);
        assert.equal(result.matchLocationCount, 1);
        // A regex row carries its matched text ({§find-result-projection}).
        assert.deepEqual(result.results, [{
            channel: "stderr",
            matched: "stderr-only",
            region: {
                startLine: 1,
                startColumn: 1,
                endLine: 1,
                endColumn: 12,
            },
        }]);
    } finally { await db.close(); }
});

test("{§find-channel-selection}: channel-scoped catalog FIND excludes resources lacking that channel", async () => {
    const { db, workspaceId, workerId } = await setup();
    try {
        await seedExecEntry(db, workspaceId, workerId, "/run/complete", "out", "err");
        await seedEntryWithChannel(db, {
            workspaceId,
            ownerId: workerId,
            scheme: "exec",
            pathname: "/run/stdout-only",
            channel: "stdout",
            content: "out only",
            mimetype: "text/stream",
        });
        const exec = new Exec();
        const core = makeSchemeCtx({
            db,
            workspaceId,
            workerId,
            defaultChannelFor: () => Exec.manifest.defaultChannel,
        });

        const broad = await exec.find(
            findStmt(urlPath("exec", "/run/*", "stderr")),
            core,
        );
        assert.equal(broad.status, 200);
        assert.deepEqual(resourcePaths(broad), ["exec:///run/complete"]);
        assert.deepEqual(
            broad.results[0],
            [
                { path: "exec:///run/complete", mimetype: "text/stream", weight: 1, lines: 1 },
                { path: "exec:///run/complete#stderr", mimetype: "text/stream", weight: 1, lines: 1 },
            ],
            "the selected channel controls eligibility while the catalog keeps the resource's complete default-first channel group",
        );

        const missing = await exec.find(
            findStmt(urlPath("exec", "/run/stdout-only", "stderr")),
            core,
        );
        assert.equal(missing.status, 404);
        assert.equal(missing.problem?.type, "https://problems.plurnk.xyz/scheme/exec/entry-not-found");
        assert.equal(missing.problem?.target, "exec:///run/stdout-only#stderr");
    } finally { await db.close(); }
});

test("{§channel-selection-unknown-channel-400}: FIND rejects an undeclared channel with the declared universe", async () => {
    const { db, workspaceId, workerId } = await setup();
    try {
        await seedExecEntry(db, workspaceId, workerId, "/run/abc", "out", "err");
        const result = await new Exec().find(
            findStmt(urlPath("exec", "/run/abc", "results"), regex("anything")),
            makeSchemeCtx({
                db,
                workspaceId,
                workerId,
                defaultChannelFor: () => Exec.manifest.defaultChannel,
            }),
        );

        assert.equal(result.status, 400);
        assert.equal(result.problem?.type, "https://problems.plurnk.xyz/scheme/exec/channel-not-found");
        assert.equal(result.problem?.requestedChannel, "results");
        assert.deepEqual(result.problem?.availableChannels, ["stdout", "stderr"]);
        assert.equal(result.problem?.recovery, "Use one of the available channels: #stdout, #stderr.");
    } finally { await db.close(); }
});

test("{§find-semantic-selection}: semantic FIND ranks the addressed channel's derivation", async () => {
    const { db, workspaceId, workerId } = await setup();
    try {
        const manifest = schemeManifest(
            "multi",
            { body: "text/markdown", contracts: "text/markdown" },
            "body",
        );
        const entryId = await seedEntryWithChannel(db, {
            workspaceId,
            scheme: "multi",
            pathname: "/tool.md",
            channel: "body",
            content: "ordinary description",
            mimetype: "text/markdown",
        });
        await db.test_seed_channel.run({
            entry_id: entryId,
            name: "contracts",
            content: "exclusivecontractneedle input schema",
            mimetype: "text/markdown",
            state: "static",
        });
        const ctx = makeSchemeCtx({
            db,
            workspaceId,
            workerId,
            defaultChannelFor: () => manifest.defaultChannel,
        });
        await SearchIndex.maintain(ctx);

        const result = await EntryFind.findWorkspaceEntries(
            findStmt(
                urlPath("multi", "/**", "contracts"),
                { dialect: "semantic", raw: "exclusivecontractneedle" } as MatcherBody,
            ),
            ctx,
            manifest,
            { ownerId: await Owner.commonsId(db, workspaceId) },
        );

        assert.equal(result.status, 200);
        assert.deepEqual(resourcePaths(result), ["multi:///tool.md"]);
    } finally { await db.close(); }
});

test("{§relation-indexed-dialects}: graph FIND resolves evidence in the addressed channel", async () => {
    const { db, workspaceId, workerId } = await setup();
    try {
        const manifest = schemeManifest(
            "multi",
            { body: "text/markdown", contracts: "text/markdown" },
            "body",
        );
        const seed = async (pathname: string, body: string, contracts: string): Promise<void> => {
            const entryId = await seedEntryWithChannel(db, {
                workspaceId,
                scheme: "multi",
                pathname,
                channel: "body",
                content: body,
                mimetype: "text/markdown",
            });
            await db.test_seed_channel.run({
                entry_id: entryId,
                name: "contracts",
                content: contracts,
                mimetype: "text/markdown",
                state: "static",
            });
        };
        await seed("/a.ts", "no symbols here", "export function foo() {}\n");
        await seed("/b.ts", "no references here", "import { foo } from \"./a\";\nfoo();\n");
        const mimetypes = mimetypesFixture({
            process: async (input: { content: string; hint: string }) => ({
                mimetype: input.hint,
                ok: true,
                totalLines: input.content.split("\n").length,
                symbols: input.content.includes("function foo")
                    ? [{ name: "foo", kind: "function", line: 1, endLine: 1 }]
                    : [],
                references: input.content.includes("foo();")
                    ? [{ name: "foo", kind: "call", line: 2, column: 1, endLine: 2, endColumn: 4 }]
                    : [],
            }),
        });
        const ctx = makeSchemeCtx({
            db,
            workspaceId,
            workerId,
            mimetypes,
            defaultChannelFor: () => manifest.defaultChannel,
        });
        await SearchIndex.maintain(ctx);

        const result = await EntryFind.findWorkspaceEntries(
            findStmt(
                urlPath("multi", "/**", "contracts"),
                { dialect: "graph", raw: "&<foo" } as MatcherBody,
            ),
            ctx,
            manifest,
            { ownerId: await Owner.commonsId(db, workspaceId) },
        );

        assert.equal(result.status, 200);
        assert.deepEqual(resourcePaths(result), ["multi:///b.ts"]);
        assert.equal(result.matchLocationCount, 1);
    } finally { await db.close(); }
});

test("{§persistent-search-index}: changing one channel invalidates and re-derives only that channel", async () => {
    const { db, workspaceId, workerId } = await setup();
    try {
        const entryId = await seedExecEntry(
            db,
            workspaceId,
            workerId,
            "/run/abc",
            "stable stdout",
            "initial stderr",
        );
        const ctx = makeSchemeCtx({ db, workspaceId, workerId });
        await SearchIndex.maintain(ctx);
        const before = await db.test_channel_hashes_for_entry.all<{
            name: string;
            deep_hash: string | null;
            content_hash: string | null;
        }>({ entry_id: entryId });
        assert.ok(before.every(({ deep_hash }) => deep_hash !== null));

        const replaced = await new DbChannelCaps(ctx, "exec", "", workerId).replace(
            "/run/abc",
            "stderr",
            "changed stderr",
        );
        assert.equal(replaced.status, 200);
        const invalidated = await db.test_channel_hashes_for_entry.all<{
            name: string;
            deep_hash: string | null;
            content_hash: string | null;
        }>({ entry_id: entryId });
        assert.equal(
            invalidated.find(({ name }) => name === "stdout")?.deep_hash,
            before.find(({ name }) => name === "stdout")?.deep_hash,
        );
        assert.equal(invalidated.find(({ name }) => name === "stderr")?.deep_hash, null);
        assert.equal(invalidated.find(({ name }) => name === "stderr")?.content_hash, null);

        await SearchIndex.maintain(ctx);
        const after = await db.test_channel_hashes_for_entry.all<{
            name: string;
            deep_hash: string | null;
            content_hash: string | null;
        }>({ entry_id: entryId });
        assert.equal(
            after.find(({ name }) => name === "stdout")?.deep_hash,
            before.find(({ name }) => name === "stdout")?.deep_hash,
        );
        assert.notEqual(
            after.find(({ name }) => name === "stderr")?.deep_hash,
            before.find(({ name }) => name === "stderr")?.deep_hash,
        );
    } finally { await db.close(); }
});

test("{§persistent-search-index}: model EDIT invalidates its channel without making derivation attachment a catalog touch", async () => {
    const { db, workspaceId, workerId } = await setup();
    try {
        const ctx = makeSchemeCtx({ db, workspaceId, workerId });
        const worker = new Worker();
        const created = await worker.edit(
            editStmt(urlPath("worker", "/indexed-note"), "first representation"),
            ctx,
        );
        assert.equal(created.status, 201);
        if (created.entryId === null) throw new Error("Worker EDIT created no entry");

        const sentinel = "2000-01-01T00:00:00.000Z";
        await db.test_set_entry_updated_at.run({ entry_id: created.entryId, updated_at: sentinel });
        await SearchIndex.maintain(ctx);
        const attached = await db.test_channel_hashes_for_entry.all<{
            name: string;
            deep_hash: string | null;
        }>({ entry_id: created.entryId });
        assert.ok(attached[0]?.deep_hash);
        const afterAttachment = await db.test_entry_updated_at.get<{ updated_at: string }>({
            entry_id: created.entryId,
        });
        assert.equal(
            afterAttachment?.updated_at,
            sentinel,
            "private derivation attachment does not reorder the model-facing catalog",
        );

        const edited = await worker.edit(
            editStmt(urlPath("worker", "/indexed-note"), "second representation", null, fullReplace),
            ctx,
        );
        assert.equal(edited.status, 200);
        const invalidated = await db.test_channel_hashes_for_entry.all<{
            name: string;
            deep_hash: string | null;
        }>({ entry_id: created.entryId });
        assert.equal(invalidated[0]?.deep_hash, null, "the database rejects stale EDIT derivations");
        const afterEdit = await db.test_entry_updated_at.get<{ updated_at: string }>({
            entry_id: created.entryId,
        });
        assert.notEqual(afterEdit?.updated_at, sentinel, "the actual representation change remains a catalog touch");
    } finally { await db.close(); }
});

test("{§persistent-search-index}: a concurrent channel change cannot attach stale search evidence", async () => {
    const { db, workspaceId, workerId } = await setup();
    let releaseDerivation = (): void => {};
    try {
        const entryId = await seedEntryWithChannel(db, {
            workspaceId,
            scheme: "multi",
            pathname: "/racing.md",
            channel: "body",
            content: "representation before the race",
            mimetype: "text/markdown",
        });
        const baseMimetypes = makeSchemeCtx().mimetypes;
        if (baseMimetypes === undefined) throw new Error("test context omitted mimetypes");
        let announceDerivation = (): void => {};
        const derivationStarted = new Promise<void>((resolve) => { announceDerivation = resolve; });
        const derivationReleased = new Promise<void>((resolve) => { releaseDerivation = resolve; });
        let pause = true;
        const mimetypes = mimetypesFixture({
            process: async (...args: Parameters<typeof baseMimetypes.process>) => {
                if (pause) {
                    pause = false;
                    announceDerivation();
                    await derivationReleased;
                }
                return baseMimetypes.process(...args);
            },
        });
        const ctx = makeSchemeCtx({ db, workspaceId, workerId, mimetypes });
        const maintenance = SearchIndex.maintain(ctx);
        await derivationStarted;

        const ownerId = await Owner.commonsId(db, workspaceId);
        const replaced = await new DbChannelCaps(ctx, "multi", "", ownerId).replace(
            "/racing.md",
            "body",
            "representation after the race",
        );
        assert.equal(replaced.status, 200);
        releaseDerivation();
        await maintenance;

        const [stale] = await db.test_channel_hashes_for_entry.all<{
            name: string;
            deep_hash: string | null;
        }>({ entry_id: entryId });
        assert.equal(stale?.deep_hash, null, "the completed artifact cannot attach to changed channel content");

        await SearchIndex.maintain(ctx);
        const [current] = await db.test_channel_hashes_for_entry.all<{
            name: string;
            deep_hash: string | null;
        }>({ entry_id: entryId });
        assert.ok(current?.deep_hash, "the next pass attaches the current representation");
    } finally {
        releaseDerivation();
        await db.close();
    }
});

test("an unknown fragment 400s WITH the fact naming the declared universe", async () => {
    const { db, workspaceId, workerId } = await setup();
    try {
        await seedExecEntry(db, workspaceId, workerId, "/run/abc", "OUT-content", "ERR-content");
        // The sweep shape: a model probing a results-channel habit against a stdout/stderr
        // runtime. One miss must teach the topology — never a bare 400.
        const read = await lookThroughScheme(
            "exec",
            null,
            readStmt(urlPath("exec", "/run/abc", "results")),
            makeSchemeCtx({ db, workspaceId, workerId }),
        );
        assert.equal(read.status, 400);
        assert.equal(read.problem?.type, "https://problems.plurnk.xyz/scheme/exec/channel-not-found");
        assert.equal(read.problem?.requestedChannel, "results");
        assert.deepEqual(read.problem?.availableChannels, ["stdout", "stderr"]);
        assert.equal(read.problem?.recovery, "Use one of the available channels: #stdout, #stderr.");
        // EDIT side via Worker (exec streams are not model-editable): same fact shape.
        const k = new Worker();
        await k.edit(editStmt(urlPath("worker", "/note"), "seeded"), makeSchemeCtx({ db, workspaceId, workerId }));
        const edit = await k.edit(editStmt(urlPath("worker", "/note", "nope"), "x"), makeSchemeCtx({ db, workspaceId, workerId }));
        assert.equal(edit.status, 400);
        assert.equal(edit.problem?.type, "https://problems.plurnk.xyz/scheme/worker/channel-not-found");
        assert.equal(edit.problem?.requestedChannel, "nope");
        assert.deepEqual(edit.problem?.availableChannels, ["body"]);
        assert.equal(edit.problem?.recovery, "Use one of the available channels: #body.");
    } finally { await db.close(); }
});

test("fragment EDIT on absent entry → 404; default-channel (fragment-less) EDIT creates", async () => {
    const { db, workspaceId, workerId } = await setup();
    try {
        const k = new Worker();

        // Explicit fragment on a path with no existing entry → 404 (the
        // fragment-targeted write requires the entry to already exist), even
        // when the fragment names the default channel.
        const missing = await k.edit(editStmt(urlPath("worker", "/ghost", "body"), "x"), makeSchemeCtx({ db, workspaceId, workerId }));
        assert.equal(missing.status, 404);
        assert.equal(missing.entryId, null);
        assert.equal(missing.channel, "body");

        // Fragment-less EDIT to the same (still absent) path creates the entry.
        const created = await k.edit(editStmt(urlPath("worker", "/ghost"), "made"), makeSchemeCtx({ db, workspaceId, workerId }));
        assert.equal(created.status, 201);
        assert.equal(created.channel, "body");
        assert.notEqual(created.entryId, null);
    } finally { await db.close(); }
});

test("channels are keyed by (entry_id, name); same key collides, distinct names coexist", async () => {
    const { db, workspaceId, workerId } = await setup();
    try {
        // Two distinct channel names on one entry are two rows under the same key space.
        const entryId = await seedExecEntry(db, workspaceId, workerId, "run/keys", "first-out", "first-err");
        const channels = await db.test_list_channels_for_entry.all<{ name: string; content: string }>({ entry_id: entryId });
        assert.deepEqual(channels.map((c) => c.name), ["stderr", "stdout"], "distinct names coexist under one entry");

        // (entry_id, name) is the primary key — re-inserting the SAME (entry, name)
        // raw violates uniqueness. The append-only store keys on this tuple.
        await assert.rejects(
            () => db.test_seed_channel.run({
                entry_id: entryId, name: "stdout", content: "dup", mimetype: "text/stream", state: "static",
            }),
            /constraint/i,
            "duplicate (entry_id, name) is rejected by the PRIMARY KEY",
        );
    } finally { await db.close(); }
});

test("the exec scheme transitions channel state across the connection lifecycle", async () => {
    const { db, workspaceId, workerId } = await setup();
    try {
        const schemes = new SchemeRegistry();
        const engine = new Engine({ db, schemes });
        engine.setExecutors(await testExecutors());
        const exec = schemes.get("exec") as Exec;
        const ctx = makeSchemeCtx({ db, workspaceId, workerId, writer: "model", executors: await testExecutors() });
        const pathname = "r-statelife";

        // Drive the real applyResolution path: it seeds channels as "active",
        // spawns the subprocess, and the scheme OWNS the transition to "closed"
        // on clean exit (via the executor's setState callbacks).
        const started = await exec.applyResolution(
            { attrs: { runtime: "", cwd: null, target: null, body: "printf done", pathname, effect: "host" } },
            ctx,
        );
        assert.equal(started.status, 200);
        assert.equal(started.outcome, "started");

        // Wait for the spawned subprocess + queued state writes to drain.
        await exec.idle();

        const entryId = (await db.test_get_entry_id_by_scheme_pathname.get<{ id: number }>({ scheme: "sh", pathname }))?.id;
        assert.notEqual(entryId, undefined);
        const stdout = await db.test_get_channel.get<{ content: string; state: string }>({ entry_id: entryId, name: "stdout" });
        // Scheme-owned transition: a clean exit closes the stdout channel.
        assert.equal(stdout?.state, "closed", "exec scheme transitioned stdout active → closed on clean exit");
        assert.equal(stdout?.content, "done", "content accumulated through the lifecycle");
    } finally { await db.close(); }
});

test("channel state does not gate reads — errored/closed channels still return content", async () => {
    const { db, workspaceId, workerId } = await setup();
    try {
        // Seed an entry whose channel is in the 'errored' terminal state with
        // partial content still present.
        await seedEntryWithChannel(db, {
            workspaceId, scheme: "worker", pathname: "/partial", channel: "body",
            content: "partial-but-readable", mimetype: "text/markdown", state: "errored",
        });
        // READ returns the accumulated content regardless of the errored state —
        // state is metadata, not an engine gate.
        const r = await lookThroughScheme("worker", null, readStmt(urlPath("worker", "/partial")), makeSchemeCtx({ db, workspaceId, workerId }));
        assert.equal(r.status, 200, "errored state does not gate the read");
        assert.equal(r.content, "partial-but-readable");
        assert.equal(r.channel, "body");

        // Confirm the stored state really is 'errored' (the read ignored it).
        const stored = await db.test_get_channel.get<{ state: string }>({ entry_id: (await db.test_get_entry_id_by_scheme_pathname.get<{ id: number }>({ scheme: "worker", pathname: "/partial" }))?.id, name: "body" });
        assert.equal(stored?.state, "errored", "state persisted as errored — read succeeded anyway");
    } finally { await db.close(); }
});
