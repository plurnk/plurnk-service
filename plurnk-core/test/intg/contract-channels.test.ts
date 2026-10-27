import test, { describe } from "node:test";
import assert from "node:assert/strict";
import Workspace from "../../src/schemes/Workspace.ts";
import Exec from "../../src/schemes/Exec.ts";
import EntryFind from "../../src/schemes/_entry-find.ts";
import SearchIndex from "../../src/schemes/_search-index.ts";
import DbChannelCaps from "../../src/core/caps/DbChannelCaps.ts";
import Engine from "../../src/core/Engine.ts";
import SchemeRegistry from "../../src/core/SchemeRegistry.ts";
import EntryCrud from "../../src/schemes/_entry-crud.ts";
import Http from "@plurnk/plurnk-schemes-http";
import GitMembership from "../../src/core/git-membership.ts";
import { TextCoordinates } from "@plurnk/plurnk-mimetypes";
import { contentHash } from "../../src/core/content-hash.ts";
import { type Db } from "../../src/core/Db.ts";
import { readThroughScheme, mimetypesFixture, makeSchemeCtx, schemeManifest, DEFAULT_MIMETYPES } from "./_scheme.ts";
import { openMigrated, insertWorkspace, insertSession, seedEntryWithChannel, insertLoop, insertTurn, seedEnvelope, rootWorkspace } from "./_db.ts";
import { testExecutors, quiesceExecs } from "./_execs.ts";
import { urlPath, editStmt, findStmt, fullReplace, readStmt, regex, copyStmt, moveStmt } from "./_dsl.ts";
import { resourcePaths } from "./_find.ts";
import { Mock } from "@plurnk/plurnk-providers";
import { type ReadStatement, type CopyStatement, type EditStatement, type FindStatement, type MatcherBody, type MoveStatement } from "@plurnk/plurnk-contracts";
import { PlurnkParser } from "@plurnk/plurnk-parser";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { hermeticGitEnv } from "../../src/core/git-env.ts";

describe("contract-channels", () => {
// Integration coverage for the SPEC {§channels} channel-topology contract tags.
// Each test name carries its §-anchor and exercises
// the real path for one tagged sentence in SPEC.md {§channels}.


















const setup = async () => {
    const db = await openMigrated();
    const workspaceId = await insertWorkspace(db, `ws-${crypto.randomUUID()}`);
    const sessionId = await insertSession(db, workspaceId);
    return { db, workspaceId, sessionId };
};

// Seed a multi-channel exec entry (stdout + stderr) directly, bypassing the
// subprocess. exec is the production multi-channel vehicle (Session is single-
// channel); fragment routing in _entry-ops.ts is exercised through Exec's
// manifest (defaultChannel="stdout").
const seedExecEntry = async (
    db: Db,
    workspaceId: number,
    _sessionId: number,
    pathname: string,
    stdout: string,
    stderr: string,
): Promise<number> => {
    const entryId = await seedEntryWithChannel(db, {
        workspaceId, scheme: "exec", pathname, channel: "stdout", content: stdout, mimetype: "text/stream",
    });
    // Second channel on the SAME entry — the (entry_id, name) keying means a
    // distinct name is a distinct row under the same entry.
    await db.test_seed_channel.run({
        entry_id: entryId, name: "stderr", content: stderr, mimetype: "text/stream", state: "static",
    });
    return entryId;
};

test("{§channels} fragment targets the named channel; fragment-less targets default", async () => {
    const { db, workspaceId, sessionId } = await setup();
    try {
        await seedExecEntry(db, workspaceId, sessionId, "/run/abc", "OUT-content", "ERR-content");
        const readExec = (statement: ReturnType<typeof readStmt>) => readThroughScheme(
            "exec",
            null,
            statement,
            makeSchemeCtx({ db, workspaceId, sessionId }),
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
    const { db, workspaceId, sessionId } = await setup();
    try {
        await seedExecEntry(
            db,
            workspaceId,
            sessionId,
            "/run/abc",
            "ordinary output",
            "stderr-only diagnostic",
        );
        const exec = new Exec(undefined, () => { throw new Error("this test materializes nothing"); });
        const core = makeSchemeCtx({
            db,
            workspaceId,
            sessionId,
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
    const { db, workspaceId, sessionId } = await setup();
    try {
        await seedExecEntry(db, workspaceId, sessionId, "/run/complete", "out", "err");
        await seedEntryWithChannel(db, {
            workspaceId,
            scheme: "exec",
            pathname: "/run/stdout-only",
            channel: "stdout",
            content: "out only",
            mimetype: "text/stream",
        });
        const exec = new Exec(undefined, () => { throw new Error("this test materializes nothing"); });
        const core = makeSchemeCtx({
            db,
            workspaceId,
            sessionId,
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
                { path: "exec:///run/complete", mimetype: "text/stream", weight: 2, lines: 1 },
                { path: "exec:///run/complete#stderr", mimetype: "text/stream", weight: 2, lines: 1 },
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

test("{§channel-selection}: FIND reports an undeclared channel with the declared universe", async () => {
    const { db, workspaceId, sessionId } = await setup();
    try {
        await seedExecEntry(db, workspaceId, sessionId, "/run/abc", "out", "err");
        const result = await new Exec(undefined, () => { throw new Error("this test materializes nothing"); }).find(
            findStmt(urlPath("exec", "/run/abc", "results"), regex("anything")),
            makeSchemeCtx({
                db,
                workspaceId,
                sessionId,
                defaultChannelFor: () => Exec.manifest.defaultChannel,
            }),
        );

        assert.equal(result.status, 404);
        assert.equal(result.problem?.type, "https://problems.plurnk.xyz/scheme/exec/channel-not-found");
        assert.equal(result.problem?.requestedChannel, "results");
        assert.deepEqual(result.problem?.availableChannels, ["stdout", "stderr"]);
        assert.equal(result.problem?.recovery, "Use one of the available channels: #stdout, #stderr."); // {§problems-content}
    } finally { await db.close(); }
});

test("{§find-fulltext-selection}: full-text FIND ranks the addressed channel's derivation", async () => {
    const { db, workspaceId, sessionId } = await setup();
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
            sessionId,
            defaultChannelFor: () => manifest.defaultChannel,
        });
        await SearchIndex.maintain(ctx);

        const result = await EntryFind.findWorkspaceEntries(
            findStmt(
                urlPath("multi", "/**", "contracts"),
                { dialect: "fts", raw: "~exclusivecontractneedle" },
            ),
            ctx,
            manifest,
            {  },
        );

        assert.equal(result.status, 200);
        assert.deepEqual(resourcePaths(result), ["multi:///tool.md"]);
    } finally { await db.close(); }
});

test("{§relation-indexed-dialects}: graph FIND resolves evidence in the addressed channel", async () => {
    const { db, workspaceId, sessionId } = await setup();
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
                totalLines: TextCoordinates.lineCount(input.content),
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
            sessionId,
            mimetypes,
            defaultChannelFor: () => manifest.defaultChannel,
        });
        await SearchIndex.maintain(ctx);

        const result = await EntryFind.findWorkspaceEntries(
            findStmt(
                urlPath("multi", "/**", "contracts"),
                { dialect: "graph", raw: "&<foo" },
            ),
            ctx,
            manifest,
            {  },
        );

        assert.equal(result.status, 200);
        assert.deepEqual(resourcePaths(result), ["multi:///b.ts"]);
        assert.equal(result.matchLocationCount, 1);
    } finally { await db.close(); }
});

test("{§persistent-search-index}: changing one channel invalidates and re-derives only that channel", async () => {
    const { db, workspaceId, sessionId } = await setup();
    try {
        const entryId = await seedExecEntry(
            db,
            workspaceId,
            sessionId,
            "/run/abc",
            "stable stdout",
            "initial stderr",
        );
        const ctx = makeSchemeCtx({ db, workspaceId, sessionId });
        await SearchIndex.maintain(ctx);
        const before = await db.test_channel_hashes_for_entry.all<{
            name: string;
            deep_hash: string | null;
            content_hash: string | null;
        }>({ entry_id: entryId });
        assert.ok(before.every(({ deep_hash }) => deep_hash !== null));

        const replaced = await new DbChannelCaps(ctx, "exec", "").replace(
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
        assert.equal(invalidated.find(({ name }) => name === "stderr")?.content_hash, contentHash("changed stderr"), "a settled body carries its stored identity ({§content-store})");

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
    const { db, workspaceId, sessionId } = await setup();
    try {
        const ctx = makeSchemeCtx({ db, workspaceId, sessionId });
        const session = new Workspace();
        const created = await session.edit(
            editStmt(urlPath("workspace", "/indexed-note"), "first representation"),
            ctx,
        );
        assert.equal(created.status, 201);
        if (created.entryId === null) throw new Error("Session EDIT created no entry");

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

        const edited = await session.edit(
            editStmt(urlPath("workspace", "/indexed-note"), "second representation", fullReplace),
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
    const { db, workspaceId, sessionId } = await setup();
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
        const ctx = makeSchemeCtx({ db, workspaceId, sessionId, mimetypes });
        const maintenance = SearchIndex.maintain(ctx);
        await derivationStarted;

        const replaced = await new DbChannelCaps(ctx, "multi", "").replace(
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

test("{§channel-selection} READ and EDIT retain topology facts on channel misses", async () => {
    const { db, workspaceId, sessionId } = await setup();
    try {
        await seedExecEntry(db, workspaceId, sessionId, "/run/abc", "OUT-content", "ERR-content");
        const read = await readThroughScheme(
            "exec",
            null,
            readStmt(urlPath("exec", "/run/abc", "results")),
            makeSchemeCtx({ db, workspaceId, sessionId }),
        );
        assert.equal(read.status, 404);
        assert.equal(read.problem?.type, "https://problems.plurnk.xyz/scheme/exec/channel-not-found");
        assert.equal(read.problem?.requestedChannel, "results");
        assert.deepEqual(read.problem?.availableChannels, ["stdout", "stderr"]);
        assert.equal(read.problem?.recovery, "Use one of the available channels: #stdout, #stderr."); // {§problems-content}
        // EDIT side via Session (exec streams are not model-editable): same fact shape.
        const k = new Workspace();
        await k.edit(editStmt(urlPath("workspace", "/note"), "seeded"), makeSchemeCtx({ db, workspaceId, sessionId }));
        const edit = await k.edit(editStmt(urlPath("workspace", "/note", "nope"), "x"), makeSchemeCtx({ db, workspaceId, sessionId }));
        assert.equal(edit.status, 404);
        assert.equal(edit.problem?.type, "https://problems.plurnk.xyz/scheme/workspace/channel-not-found");
        assert.equal(edit.problem?.requestedChannel, "nope");
        assert.deepEqual(edit.problem?.availableChannels, ["body", "readable"]);
        assert.equal(edit.problem?.recovery, "Use one of the available channels: #body, #readable."); // {§problems-content}
    } finally { await db.close(); }
});

test("{§channels} fragment EDIT on absent entry → 404; default-channel (fragment-less) EDIT creates", async () => {
    const { db, workspaceId, sessionId } = await setup();
    try {
        const k = new Workspace();

        // Explicit fragment on a path with no existing entry → 404 (the
        // fragment-targeted write requires the entry to already exist), even
        // when the fragment names the default channel.
        const missing = await k.edit(editStmt(urlPath("workspace", "/ghost", "body"), "x"), makeSchemeCtx({ db, workspaceId, sessionId }));
        assert.equal(missing.status, 404);
        assert.equal(missing.entryId, null);
        assert.equal(missing.channel, "body");

        // Fragment-less EDIT to the same (still absent) path creates the entry.
        const created = await k.edit(editStmt(urlPath("workspace", "/ghost"), "made"), makeSchemeCtx({ db, workspaceId, sessionId }));
        assert.equal(created.status, 201);
        assert.equal(created.channel, "body");
        assert.notEqual(created.entryId, null);
    } finally { await db.close(); }
});

test("{§channels} channels are keyed by (entry_id, name); same key collides, distinct names coexist", async () => {
    const { db, workspaceId, sessionId } = await setup();
    try {
        // Two distinct channel names on one entry are two rows under the same key space.
        const entryId = await seedExecEntry(db, workspaceId, sessionId, "run/keys", "first-out", "first-err");
        const channels = await db.test_list_channels_for_entry.all<{ name: string; content: string }>({ entry_id: entryId });
        assert.deepEqual(channels.map((c) => c.name), ["stderr", "stdout"], "distinct names coexist under one entry");

        // (entry_id, name) is the primary key — re-inserting the SAME (entry, name)
        // raw violates uniqueness. The store keys on this tuple.
        await assert.rejects(
            () => db.test_seed_channel.run({
                entry_id: entryId, name: "stdout", content: "dup", mimetype: "text/stream", state: "static",
            }),
            /constraint/i,
            "duplicate (entry_id, name) is rejected by the PRIMARY KEY",
        );
    } finally { await db.close(); }
});

test("{§channels} the exec scheme transitions channel state across the connection lifecycle", async () => {
    const { db, workspaceId, sessionId } = await setup();
    try {
        const schemes = new SchemeRegistry();
        const engine = new Engine({ db, schemes });
        engine.setExecutors(await testExecutors());
        const exec = schemes.get("exec") as Exec;
        const ctx = makeSchemeCtx({ db, workspaceId, sessionId, writer: "model", executors: await testExecutors() });
        const pathname = "r-statelife";

        // Drive the real applyResolution path: it seeds channels as "active",
        // spawns the subprocess, and the scheme OWNS the transition to "closed"
        // on clean exit (via the executor's setState callbacks).
        const started = await exec.applyResolution(
            { attrs: { runtime: "", cwd: null, target: null, body: "printf done", pathname, effect: "host" }, metadata: null },
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

test("{§channels} channel state does not gate reads — errored/closed channels still return content", async () => {
    const { db, workspaceId, sessionId } = await setup();
    try {
        // Seed an entry whose channel is in the 'errored' terminal state with
        // partial content still present.
        await seedEntryWithChannel(db, {
            workspaceId, scheme: "workspace", pathname: "/partial", channel: "body",
            content: "partial-but-readable", mimetype: "text/markdown", state: "errored",
        });
        // READ returns the accumulated content regardless of the errored state —
        // state is metadata, not an engine gate.
        const r = await readThroughScheme("session", null, readStmt(urlPath("workspace", "/partial")), makeSchemeCtx({ db, workspaceId, sessionId }));
        assert.equal(r.status, 200, "errored state does not gate the read");
        assert.equal(r.content, "partial-but-readable");
        assert.equal(r.channel, "body");

        // Confirm the stored state really is 'errored' (the read ignored it).
        const stored = await db.test_get_channel.get<{ state: string }>({ entry_id: (await db.test_get_entry_id_by_scheme_pathname.get<{ id: number }>({ scheme: "workspace", pathname: "/partial" }))?.id, name: "body" });
        assert.equal(stored?.state, "errored", "state persisted as errored — read succeeded anyway");
    } finally { await db.close(); }
});
});

describe("Engine.channel-recovery", () => {
const response = (operation: string, op = "NOTE") => ({
    assistant: { content: `${operation}
\`\`\`\`${op}
\`\`\`\``, reasoning: null },
    usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
});

test("{§channel-selection} channel exploration across operation owners permits recovery without strikes", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `channel-recovery-${crypto.randomUUID()}`);
        const sessionId = await insertSession(db, workspaceId);
        const loopId = await insertLoop(db, sessionId, 1, "Retrieve the retained text.");
        const engine = new Engine({ db, schemes: new SchemeRegistry() });
        const misses = [
            "````READ (workspace:///note#stdout)````",
            "````FIND (workspace:///note#stderr)````",
            "````COPY (workspace:///note#results) (workspace:///copy)````",
            "````COPY (workspace:///note) (workspace:///copy#results)````",
            "````MOVE (workspace:///note#stdout) (workspace:///moved)````",
            "````MOVE (workspace:///note) (workspace:///moved#stdout)````",
            "````EDIT (workspace:///note#extra) <1>\nreplacement\n````",
            "````EDIT (workspace:///note#constructor) <1>\nreplacement\n````",
        ];
        const provider = new Mock({ contextWindow: 100000, responses: [
            response("````EDIT (workspace:///note)\nretained text\n````"),
            ...misses.map((operation) => response(operation)),
            response("````READ (workspace:///note)````"),
            { assistant: { content: "````SEND [200]\nRetrieved the retained text.\n````", reasoning: null } },
        ] });
        const result = await engine.runLoop({ provider, workspaceId, sessionId, loopId, messages: [], maxTurns: 15 });
        assert.equal(result.result.status, 200, JSON.stringify(result.result));
        const rows = await db.test_log_entries_by_loop.all<{ op: string; pathname: string; status_rx: number; rx: string }>({ loop_id: loopId });
        const failures = rows.filter(({ status_rx }) => status_rx >= 400);
        assert.deepEqual(failures.map(({ op, status_rx }) => ({ op, status_rx })),
            ["READ", "FIND", "COPY", "COPY", "MOVE", "MOVE", "EDIT", "EDIT"].map((op) => ({ op, status_rx: 404 })));
        for (const { op, rx } of failures) {
            const problem = JSON.parse(rx).problem;
            assert.match(problem.type, /\/channel-not-found$/);
            // A READ miss names the channels the entry holds; the other owners name the scheme's
            // declared channels, which include the derived `readable` ({§channel-selection}).
            assert.deepEqual(problem.availableChannels, op === "READ" ? ["body"] : ["body", "readable"]);
        }
        const recovered = rows.find(({ op, pathname, status_rx }) => op === "READ" && pathname === "/note" && status_rx === 200);
        assert.ok(recovered);
        assert.match(JSON.parse(recovered.rx).content, /retained text/);
        assert.equal(await db.test_get_entry_by_path.get({ workspace_id: workspaceId, scheme: "workspace", pathname: "/copy" }), undefined);
        assert.equal(await db.test_get_entry_by_path.get({ workspace_id: workspaceId, scheme: "workspace", pathname: "/moved" }), undefined);
    } finally { await db.close(); }
});
});

describe("Session.channels", () => {
// Tests for SPEC {§scheme-manifest} channel manifest + {§channel-selection} fragment-as-channel-selector.








const setup = async () => {
    const db = await openMigrated();
    const workspaceId = await insertWorkspace(db, `ws-${crypto.randomUUID()}`);
    const sessionId = await insertSession(db, workspaceId);
    return { db, workspaceId, sessionId };
};

test("{§scheme-manifest}: channel removal preserves siblings and removes only an empty entry", async () => {
    const { db, workspaceId, sessionId } = await setup();
    try {
        const ctx = makeSchemeCtx({ db, workspaceId, sessionId });
        const coordinate = { authority: "", pathname: "/channels" };
        const written = await EntryCrud.writeEntry(coordinate, {
            channels: {
                body: { content: "body", mimetype: "text/plain" },
                notes: { content: "retained", mimetype: "text/plain" },
            },
        }, ctx, "session");
        assert.equal(written.status, 201);
        assert.equal((await EntryCrud.deleteChannel(coordinate, "body", ctx, "session")).status, 200);
        const remaining = await EntryCrud.readEntry(coordinate, ctx, "session");
        assert.equal(remaining.status, 200);
        assert.deepEqual(Object.keys(remaining.entry!.channels), ["notes"]);
        assert.equal(remaining.entry!.channels.notes.content, "retained");
        const missing = await EntryCrud.deleteChannel(coordinate, "body", ctx, "session");
        assert.equal(missing.status, 404);
        assert.equal(missing.problem?.type, "https://problems.plurnk.xyz/scheme/session/channel-not-found");
        assert.equal((await EntryCrud.deleteChannel(coordinate, "notes", ctx, "session")).status, 200);
        assert.equal((await EntryCrud.readEntry(coordinate, ctx, "session")).status, 404);
    } finally { await db.close(); }
});

test("{§scheme-manifest}: empty-entry pruning preserves a channel published after an empty observation", async () => {
    const { db, workspaceId, sessionId } = await setup();
    try {
        const ctx = makeSchemeCtx({ db, workspaceId, sessionId });
        const coordinate = { authority: "", pathname: "/concurrent" };
        const written = await EntryCrud.writeEntry(coordinate, {
            channels: { body: { content: "original", mimetype: "text/plain" } },
        }, ctx, "session");
        assert.equal(written.status, 201);
        await db.crud_delete_channel.get({ entry_id: written.entryId!, name: "body" });
        assert.deepEqual((await EntryCrud.readEntry(coordinate, ctx, "session")).entry!.channels, {});
        await db.test_seed_channel.run({
            entry_id: written.entryId!, name: "body", content: "new publication",
            mimetype: "text/plain", state: "static",
        });
        await db.crud_delete_empty_entry.run({ entry_id: written.entryId! });
        const retained = await EntryCrud.readEntry(coordinate, ctx, "session");
        assert.equal(retained.status, 200);
        assert.equal(retained.entry!.channels.body.content, "new publication");
    } finally { await db.close(); }
});

test("{§manifest} Session declares a dynamic body beside its typed readable projection", () => {
    assert.deepEqual(Workspace.manifest.channels, { readable: "text/markdown" });
    assert.equal(Workspace.manifest.defaultChannel, "body");
});

test("{§scheme-manifest} Session.edit writes only the body channel; preview is render-time", async () => {
    const { db, workspaceId, sessionId } = await setup();
    try {
        const r = await new Workspace().edit(editStmt(urlPath("workspace", "/x"), "hello"), makeSchemeCtx({ db, workspaceId, sessionId }));
        assert.equal(r.status, 201);
        assert.equal(r.channel, "body");

        const channels = await db.test_list_channels_for_entry.all<{ name: string; content: string; mimetype: string }>({ entry_id: r.entryId });
        assert.equal(channels.length, 1);
        assert.equal(channels[0].name, "body");
        assert.equal(channels[0].content, "hello");
        assert.equal(channels[0].mimetype, "text/markdown");
    } finally { await db.close(); }
});

test("{§channel-selection} Session.edit with unknown channel returns 404", async () => {
    const { db, workspaceId, sessionId } = await setup();
    try {
        const r = await new Workspace().edit(editStmt(urlPath("workspace", "/x", "not-a-channel"), "x"), makeSchemeCtx({ db, workspaceId, sessionId }));
        assert.equal(r.status, 404);
        assert.equal(r.problem?.type, "https://problems.plurnk.xyz/scheme/workspace/channel-not-found");
        assert.equal(r.entryId, null);
    } finally { await db.close(); }
});

test("{§scheme-manifest} Session.read with no fragment returns body channel (default)", async () => {
    const { db, workspaceId, sessionId } = await setup();
    try {
        const k = new Workspace();
        await k.edit(editStmt(urlPath("workspace", "/x"), "body content"), makeSchemeCtx({ db, workspaceId, sessionId }));
        const r = await readThroughScheme("workspace", null, readStmt(urlPath("workspace", "/x")), makeSchemeCtx({ db, workspaceId, sessionId }));
        assert.equal(r.status, 200);
        assert.equal(r.content, "body content");
        assert.equal(r.channel, "body");
    } finally { await db.close(); }
});

test("{§channel-selection} Session.read with unknown channel returns 404", async () => {
    const { db, workspaceId, sessionId } = await setup();
    try {
        const k = new Workspace();
        await k.edit(editStmt(urlPath("workspace", "/x"), "body content"), makeSchemeCtx({ db, workspaceId, sessionId }));
        const r = await readThroughScheme("workspace", null, readStmt(urlPath("workspace", "/x", "not-a-channel")), makeSchemeCtx({ db, workspaceId, sessionId }));
        assert.equal(r.status, 404);
        assert.equal(r.problem?.type, "https://problems.plurnk.xyz/scheme/workspace/channel-not-found");
    } finally { await db.close(); }
});
});

describe("entry-html-projection", () => {
// Web-page projection is scoped to the WEB-FETCH entry point (the exec sink), NOT generic writes.
// A fetched html page stores the handler's readable projection as the decisive `body`
// (text/markdown — what READ serves and every price reports) with the raw page under `html`
// (xpath + archive). An AUTHORED/workspace html file is DATA — written verbatim, attributes intact,
// so a default READ still sees a `<user email=…>` roster.












const ROSTER = "<html><body><h1>Team Roster</h1><user email=\"alice@x.com\">Alice</user></body></html>";

const workspaceReadStmt = (pathname: string, body: ReadStatement["body"] = null): ReadStatement => ({
    metadata: null,
    op: "READ", aside: null,
    target: { kind: "url", raw: `workspace:///${pathname}`, scheme: "workspace", username: null, password: null, hostname: null, port: null, pathname: `/${pathname}`, query: null, fragment: null },
    lineMarker: null, body, matcher: null, position: { line: 1, column: 1 },
});

test("{§channel-selection} an AUTHORED html write is verbatim — attribute data survives a default READ", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `authored-${crypto.randomUUID()}`);
        const sessionId = await insertSession(db, workspaceId);
        const ctx = makeSchemeCtx({ db, workspaceId, sessionId, mimetypes: DEFAULT_MIMETYPES, weigh: (t: string) => Math.ceil(t.length / 4) });

        const written = await EntryCrud.writeEntry({ authority: "", pathname: "/roster.html" }, { channels: { body: { content: ROSTER, mimetype: "text/html" } } }, ctx, "workspace");
        assert.equal(written.status, 201);
        const rows = await db.entry_read_channels.all<{ name: string; content: string; mimetype: string }>({ entry_id: written.entryId });
        // {§channel-selection} — the source is verbatim; its projection rides beside it, never over it.
        assert.deepEqual(rows.map((r) => r.name).toSorted(), ["body", "readable"], "the verbatim source and its readable sibling; no #html archive of an authored file");
        const body = rows.find((r) => r.name === "body")!;
        assert.equal(body.mimetype, "text/html", "the authored mimetype is preserved");
        assert.equal(body.content, ROSTER, "the source channel is exactly what was authored");
        assert.equal(rows.find((r) => r.name === "readable")?.mimetype, "text/markdown");

        const read = await readThroughScheme("workspace", null, workspaceReadStmt("roster.html"), ctx);
        assert.match(read.content ?? "", /alice@x\.com/, "a default READ sees the email — attributes intact");
    } finally { await db.close(); }
});

test("{§naked-pattern} {§channel-selection}: `READ (page.html) #readable`, the channel written after the parenthesis, reads the readable projection", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `trailing-channel-${crypto.randomUUID()}`);
        const sessionId = await insertSession(db, workspaceId);
        const ctx = makeSchemeCtx({ db, workspaceId, sessionId, mimetypes: DEFAULT_MIMETYPES, weigh: (t: string) => Math.ceil(t.length / 4) });
        const written = await EntryCrud.writeEntry({ authority: "", pathname: "/roster.html" }, { channels: { body: { content: ROSTER, mimetype: "text/html" } } }, ctx, "workspace");
        assert.equal(written.status, 201);
        const parsed = PlurnkParser.parseStatements("```READ (workspace:///roster.html) #readable\n```\n").items.flatMap((item) => item.kind === "statement" ? [item.statement] : [])[0] as ReadStatement;
        assert.equal(parsed.matcher, null, "the token is the channel, not a pattern");
        const read = await readThroughScheme("workspace", null, parsed, ctx);
        assert.equal(read.status, 200);
        assert.equal((read as { channel?: string }).channel, "readable", "the readable projection was selected");
        assert.equal(read.mimetype, "text/markdown");
        assert.match(read.content ?? "", /Team Roster/u, "and it is the page as prose");
        assert.doesNotMatch(read.content ?? "", /<user /u, "not the markup");
    } finally { await db.close(); }
});

test("{§exec-entry-sink} a FETCHED html page (via the exec sink) keeps its source as body and its Markdown as #readable", async () => {
    const rawHtml = `<html><head><script>ads()</script></head><body><h1>Headline</h1><p>${"the body text remains readable ".repeat(20)}</p></body></html>`;
    const db = await openMigrated();
    const schemes = new SchemeRegistry();
    await schemes.discoverExternal(process.cwd());
    const engine = new Engine({ db, schemes, mimetypes: DEFAULT_MIMETYPES });
    engine.setExecutors(await testExecutors());
    schemes.registerRuntimeSchemes(await testExecutors());
    engine.registerRuntime("fetchstub", {
        executor: {
            runtime: "fetchstub", glyph: "?",
            get manifest() { return { name: "fetchstub", channels: { results: "text/html" }, defaultChannel: "results", category: "data", writableBy: [], volatile: true, modelVisible: true } as never; },
            get defaultChannel() { return "results"; },
            get channels() { return { results: { mimetype: "text/html" } }; },
            effect: () => "pure" as const,
            probe: async () => ({ available: true as const, detail: undefined }),
            run: async (args: { entry?: (p: string, c: string, o: object) => Promise<void>; write: (c: string, x: string, m: string) => void; setState: (c: string, s: string) => void }) => {
                await args.entry?.("https://news.example/a", rawHtml, { tags: ["q"], mimetype: "text/html" });
                args.write("results", "[]", "application/json");
                args.setState("results", "closed");
                return { status: 200, exitCode: 0 };
            },
        },
        namespaceOwner: { kind: "module", name: "fetchstub fixture" },
        glyph: "?", summary: "HTML projection fixture.", invocation: { body: { role: "fixture input", required: true }, example: { body: "fixture" } }, details: "", available: true, detail: undefined,
    } as never);
    try {
        const workspaceId = await insertWorkspace(db, `fetched-${crypto.randomUUID()}`);
        const sessionId = await insertSession(db, workspaceId);
        const loopId = await insertLoop(db, sessionId, 1, "fetch test");
        const turnId = await insertTurn(db, loopId, 1, 102);
        await engine.dispatch({ statement: { runtime: "fetchstub", aside: null, target: null, metadata: null, lineMarker: null, body: "go", position: { line: 1, column: 1 } }, workspaceId, sessionId, loopId, turnId, sequence: 1, origin: "model" });
        await quiesceExecs(schemes); // {§exec-entry-sink}: settle materialization before db.close().

        const entry = await db.test_get_entry_by_coordinate.get<{ id: number }>({
            scheme: "https",
            authority: "news.example",
            pathname: "/a",
        });
        assert.ok(entry !== undefined, "the fetched page materialized");
        const rows = await db.entry_read_channels.all<{ name: string; content: string; mimetype: string; weight: number }>({ entry_id: entry.id });
        const byName = new Map(rows.map((r) => [r.name, r]));
        // {§channel-selection} — one rule for pages and files: the source is the body, the projection rides beside it.
        assert.equal(byName.get("body")?.content, rawHtml, "the body is the server source, byte-for-byte");
        assert.equal(byName.get("readable")?.mimetype, "text/markdown", "the projection is #readable");
        assert.match(byName.get("readable")!.content, /Headline/, "the readable text survives");
        assert.ok(!byName.get("readable")!.content.includes("<script>"), "the markup does not");
        assert.ok(
            byName.get("readable")!.content.split("\n").every((line) => line.length <= 100),
            "the Markdown projection has bounded prose lines",
        );
        assert.ok(byName.get("readable")!.weight < byName.get("body")!.weight, "the projection weighs less than the scaffolding");
    } finally { await quiesceExecs(schemes); await db.close(); }
});

test("{§scheme-surface} a scoped HTTP READ slices the materialized readable body instead of starting another fetch", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `http-scope-${crypto.randomUUID()}`);
        const sessionId = await insertSession(db, workspaceId);
        const ctx = makeSchemeCtx({ db, workspaceId, sessionId });
        await EntryCrud.writeEntry({ authority: "example.org", pathname: "/page" }, {
            channels: {
                body: { content: "one\ntwo\nthree\nfour", mimetype: "text/markdown" },
                header: { content: "HTTP 200 OK", mimetype: "text/plain" },
                html: { content: "<p>one</p><p>two</p><p>three</p><p>four</p>", mimetype: "text/html" },
            },
        }, ctx, "https");
        const statement: ReadStatement = {
            metadata: null,
            op: "READ", aside: null,
            target: {
                kind: "url", raw: "https://example.org/page", scheme: "https",
                username: null, password: null, hostname: "example.org", port: null,
                pathname: "/page", query: null, fragment: null,
            },
            lineMarker: { marks: [2, 3] }, matcher: null, body: null, position: { line: 1, column: 1 },
        };
        const result = await readThroughScheme("https", new Http(), statement, ctx);
        assert.equal(result.status, 200);
        assert.equal(result.content, "two\nthree");
        assert.equal(result.startLine, 2);
    } finally { await db.close(); }
});

test("{§scheme-surface} a scoped HTTP READ slices the selected auxiliary channel when body is empty", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `http-header-scope-${crypto.randomUUID()}`);
        const sessionId = await insertSession(db, workspaceId);
        const ctx = makeSchemeCtx({ db, workspaceId, sessionId });
        await EntryCrud.writeEntry({ authority: "example.org", pathname: "/empty" }, {
            channels: {
                body: { content: "", mimetype: "text/plain" },
                header: {
                    content: "HTTP 204 No Content\ncontent-type: text/plain\nx-request-id: 42",
                    mimetype: "text/plain",
                },
            },
        }, ctx, "https");
        const statement: ReadStatement = {
            metadata: null,
            op: "READ", aside: null,
            target: {
                kind: "url", raw: "https://example.org/empty#header", scheme: "https",
                username: null, password: null, hostname: "example.org", port: null,
                pathname: "/empty", query: null, fragment: "header",
            },
            lineMarker: { marks: [2, 3] }, matcher: null, body: null, position: { line: 1, column: 1 },
        };
        const result = await readThroughScheme("https", new Http(), statement, ctx);
        assert.equal(result.status, 200);
        assert.equal(result.content, "content-type: text/plain\nx-request-id: 42");
        assert.equal(result.channel, "header");
        assert.equal(result.startLine, 2);
    } finally { await db.close(); }
});
});

describe("readable-channel", () => {
// {§channel-selection} — a readable projection is a channel, never a hidden matching surface.















const execFileP = promisify(execFile);

const HTML = "<html>\n  <body>\n    <h1>Team Roster</h1>\n    <p>Alice is an admin.</p>\n  </body>\n</html>";

const setup = async () => {
    const db = await openMigrated();
    const env = await seedEnvelope(db, `ws-${crypto.randomUUID()}`, { producer: "client" });
    const engine = new Engine({ db, schemes: new SchemeRegistry(), mimetypes: DEFAULT_MIMETYPES });
    let sequence = 0;
    const dispatch = (statement: EditStatement | ReadStatement | FindStatement | CopyStatement | MoveStatement) => {
        sequence += 1;
        return engine.dispatch({ statement, workspaceId: env.workspaceId, sessionId: env.sessionId, loopId: env.loopId, turnId: env.turnId, sequence, origin: "client" });
    };
    const channel = async (pathname: string, name: string) => (await db.test_get_channel_by_pathname.get<{ content: string; mimetype: string }>({ pathname, name }));
    return { db, env, dispatch, channel };
};

const page = urlPath("workspace", "/users.html");
const readable = urlPath("workspace", "/users.html", "readable");

test("{§channel-selection} an HTML source lands with its readable projection beside it, and the projection follows every source write", async () => {
    const { db, dispatch, channel } = await setup();
    try {
        assert.equal((await dispatch(editStmt(page, HTML))).status, 201);
        const derived = await channel("/users.html", "readable");
        assert.equal(derived?.mimetype, "text/markdown");
        assert.match(derived.content, /Team Roster/);
        assert.doesNotMatch(derived.content, /<h1>/, "the projection is the Markdown, not the markup");
        assert.equal((await dispatch(editStmt(page, "    <h1>Crew Roster</h1>", { marks: [3] }))).status, 200);
        assert.match(String((await channel("/users.html", "readable"))?.content), /Crew Roster/, "a source write refreshes the projection");
        assert.equal((await dispatch(editStmt(page, "<html><body><!-- nothing readable --></body></html>", { marks: [1, -1] }))).status, 200);
        assert.equal(await channel("/users.html", "readable"), undefined, "a source without a projection keeps no sibling");
    } finally { await db.close(); }
});

test("{§channel-selection} a Markdown source has no projection and no sibling", async () => {
    const { db, dispatch, channel } = await setup();
    try {
        assert.equal((await dispatch(editStmt(urlPath("workspace", "/notes.md"), "# Notes\n\nplain"))).status, 201);
        assert.equal(await channel("/notes.md", "readable"), undefined);
    } finally { await db.close(); }
});

test("{§channel-selection} each channel matches in its own text and reports its own coordinates", async () => {
    const { db, dispatch } = await setup();
    try {
        await dispatch(editStmt(page, HTML));
        const markup = await dispatch(readStmt(page, null, regex("<h[1-6]", "i")));
        assert.equal(markup.status, 200, JSON.stringify(markup));
        assert.deepEqual(markup.lineOrdinals, [3], "the sweep's case: the heading tag is on source line 3");
        const body = await dispatch(readStmt(page, null, regex("admin")));
        assert.deepEqual(body.lineOrdinals, [4], "the source's own line");
        const projection = await dispatch(readStmt(readable, null, regex("admin")));
        assert.equal(projection.status, 200, JSON.stringify(projection));
        assert.equal(projection.mimetype, "text/markdown");
        assert.match(String(projection.content), /Alice is an admin\./);
        assert.doesNotMatch(String(projection.content), /<p>/, "the projection's line, in the projection's coordinates");
        // A broad FIND matches the addressed (default) channel in its own coordinates and lists the
        // sibling beside it ({§channel-selection}); `#readable` addresses the projection.
        const broad = await dispatch(findStmt(urlPath("workspace", "/*"), regex("admin")));
        assert.equal(broad.status, 200, JSON.stringify(broad));
        const rows = (broad.results as Array<Array<{ path?: string; mimetype?: string; region?: { startLine: number } }>>).flat();
        assert.deepEqual(rows.map(({ path, mimetype }) => `${path} ${mimetype}`), ["workspace:///users.html text/html", "workspace:///users.html#readable text/markdown"]);
        assert.equal(rows[0]?.region?.startLine, 4, "the match is reported in the source's coordinates");
        const projected = await dispatch(findStmt(readable, regex("admin")));
        assert.equal(projected.status, 200, JSON.stringify(projected));
        assert.deepEqual((projected.results as Array<{ channel?: string; region?: { startLine: number } }>).map(({ channel, region }) => `${channel}:${region?.startLine}`), ["readable:3"], "the projection matches in the projection's coordinates");
    } finally { await db.close(); }
});

test("{§channel-selection} full-text search reaches HTML through its readable channel", async () => {
    const { db, env, dispatch } = await setup();
    try {
        await dispatch(editStmt(page, HTML));
        await SearchIndex.maintain(makeSchemeCtx({ db, workspaceId: env.workspaceId, sessionId: env.sessionId }));
        const hit = await dispatch(findStmt(urlPath("workspace", "/*"), { dialect: "fts", raw: "~roster" }));
        assert.equal(hit.status, 200, JSON.stringify(hit));
        const paths = (hit.results as Array<Array<{ path?: string }>>).flat().map((row) => row.path);
        assert.ok(paths.some((path) => String(path).includes("users.html")), JSON.stringify(paths));
    } finally { await db.close(); }
});

test("{§channel-selection} nothing writes the derived channel: EDIT, a transfer landing, and a MOVE out are refused; COPY from it reads", async () => {
    const { db, dispatch, channel } = await setup();
    try {
        await dispatch(editStmt(page, HTML));
        const edit = await dispatch(editStmt(readable, "hand-written", { marks: [1] }));
        assert.equal(edit.status, 400, JSON.stringify(edit));
        assert.match(String(edit.problem?.type), /\/channel-derived$/);
        const landing = await dispatch(copyStmt(urlPath("workspace", "/notes.md"), readable));
        assert.equal(landing.status, 400, JSON.stringify(landing));
        assert.match(String(landing.problem?.type), /\/channel-derived$/);
        const move = await dispatch(moveStmt(readable, urlPath("workspace", "/copy.md")));
        assert.equal(move.status, 400, JSON.stringify(move));
        assert.match(String(move.problem?.type), /\/channel-derived$/);
        const copy = await dispatch(copyStmt(readable, urlPath("workspace", "/copy.md")));
        assert.equal(copy.status, 201, JSON.stringify(copy));
        assert.match(String((await channel("/copy.md", "body"))?.content), /Team Roster/);
    } finally { await db.close(); }
});

test("{§channel-selection} a tracked .html member materializes with its readable projection beside the source", async () => {
    const root = await mkdtemp(join(tmpdir(), "plurnk-readable-member-"));
    const db = await openMigrated();
    try {
        await execFileP("git", ["init", "-q"], { cwd: root, env: hermeticGitEnv() });
        await writeFile(join(root, "page.html"), HTML);
        await execFileP("git", ["add", "page.html"], { cwd: root, env: hermeticGitEnv() });
        const workspaceId = await insertWorkspace(db, `readable-member-${crypto.randomUUID()}`);
        await rootWorkspace(db, workspaceId, root);
        const sessionId = await insertSession(db, workspaceId);
        assert.deepEqual(await GitMembership.indexGitMembership(makeSchemeCtx({ db, workspaceId, sessionId })), []);
        const entry = await db.test_get_entry_by_path.get<{ id: number }>({ workspace_id: workspaceId, scheme: "file", pathname: "page.html" });
        assert.ok(entry);
        const source = await db.test_get_channel.get<{ content: string; mimetype: string }>({ entry_id: entry.id, name: "body" });
        assert.equal(source?.mimetype, "text/html");
        assert.equal(source?.content, HTML, "the source channel is the file verbatim");
        const projection = await db.test_get_channel.get<{ content: string; mimetype: string }>({ entry_id: entry.id, name: "readable" });
        assert.equal(projection?.mimetype, "text/markdown");
        assert.match(projection.content, /Team Roster/);
    } finally { await db.close(); await rm(root, { recursive: true, force: true }); }
});

// {§channel-selection} — first contact carries the choice: a READ names the resource's
// other channels with their tokens, so the model reaches for `#readable` from the receipt itself.
test("{§channel-selection} a READ names the resource's other channels with their tokens; a single-channel entry names none", async () => {
    const { db, dispatch } = await setup();
    try {
        await dispatch(editStmt(page, HTML));
        const source = await dispatch(readStmt(page, { marks: [1, -1] }));
        assert.equal(source.status, 200, JSON.stringify(source));
        const channels = source.channels as Record<string, number>;
        assert.deepEqual(Object.keys(channels), ["#readable"], "the sibling is named as the fragment the model appends");
        assert.ok(Number.isSafeInteger(channels["#readable"]) && channels["#readable"] > 0, "with its tokens");
        const projection = await dispatch(readStmt(readable, { marks: [1, -1] }));
        assert.deepEqual(Object.keys(projection.channels as Record<string, number>), ["#body"], "and the source is named from the projection");
        await dispatch(editStmt(urlPath("workspace", "/notes.md"), "plain"));
        const plain = await dispatch(readStmt(urlPath("workspace", "/notes.md"), { marks: [1, -1] }));
        assert.equal(plain.channels, undefined, "a single-channel entry names no siblings");
    } finally { await db.close(); }
});
});
