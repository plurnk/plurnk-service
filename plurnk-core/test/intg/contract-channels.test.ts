// Integration coverage for SPEC {§channels} channel-topology contract tags that
// previously had no test. Each test name carries its §-anchor and exercises
// the real path for one tagged sentence in SPEC.md {§channels}.

import test from "node:test";
import assert from "node:assert/strict";
import Worker from "../../src/schemes/Worker.ts";
import Exec from "../../src/schemes/Exec.ts";
import type { Db } from "../../src/core/Db.ts";
import Engine from "../../src/core/Engine.ts";
import SchemeRegistry from "../../src/core/SchemeRegistry.ts";
import { lookThroughScheme, openMigrated, insertWorkspace, insertWorker, makeSchemeCtx, seedEntryWithChannel, testExecutors } from "./_helpers.ts";
import { urlPath, editStmt, readStmt } from "./_dsl.ts";

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
        assert.equal(read.problem?.type, "https://problems.plurnk.dev/scheme/exec/channel-not-found");
        assert.equal(read.problem?.requestedChannel, "results");
        assert.deepEqual(read.problem?.availableChannels, ["stdout", "stderr"]);
        assert.equal(read.problem?.recovery, "Use one of the available channels: #stdout, #stderr.");
        // EDIT side via Worker (exec streams are not model-editable): same fact shape.
        const k = new Worker();
        await k.edit(editStmt(urlPath("worker", "/note"), "seeded"), makeSchemeCtx({ db, workspaceId, workerId }));
        const edit = await k.edit(editStmt(urlPath("worker", "/note", "nope"), "x"), makeSchemeCtx({ db, workspaceId, workerId }));
        assert.equal(edit.status, 400);
        assert.equal(edit.problem?.type, "https://problems.plurnk.dev/scheme/worker/channel-not-found");
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
