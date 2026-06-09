// Integration coverage for SPEC §5 channel-topology contract tags that
// previously had no test. Each test name carries its §-anchor and exercises
// the real path for one tagged sentence in SPEC.md §5.

import test from "node:test";
import assert from "node:assert/strict";
import Known from "../../src/schemes/Known.ts";
import Exec from "../../src/schemes/Exec.ts";
import type { Db, PrepMethod } from "../../src/core/Db.ts";
import PacketWire from "../../src/core/packet-wire.ts";
import { openMigrated, insertSession, insertRun, makeSchemeCtx, seedEntryWithChannel, testExecutors } from "./_helpers.ts";
import { urlPath, editStmt, readStmt, hideStmt } from "./_dsl.ts";

const setup = async () => {
    const db = await openMigrated();
    const sessionId = await insertSession(db, `ws-${crypto.randomUUID()}`);
    const runId = await insertRun(db, sessionId);
    return { db, sessionId, runId };
};

// Seed a multi-channel exec entry (stdout + stderr) directly, bypassing the
// subprocess. exec is the production multi-channel vehicle (Known is single-
// channel); fragment routing in _entry-ops.ts is exercised through Exec's
// manifest (defaultChannel="stdout").
const seedExecEntry = async (
    db: Db,
    sessionId: number,
    runId: number,
    pathname: string,
    stdout: string,
    stderr: string,
): Promise<number> => {
    const entryId = await seedEntryWithChannel(db, {
        sessionId, runId, scheme: "exec", pathname, channel: "stdout", content: stdout, mimetype: "text/stream",
    });
    // Second channel on the SAME entry — the (entry_id, name) keying means a
    // distinct name is a distinct row under the same entry.
    await (db.test_seed_channel as PrepMethod).run({
        entry_id: entryId, name: "stderr", content: stderr, mimetype: "text/stream", state: "static",
    });
    await (db.test_seed_visibility as PrepMethod).run({
        run_id: runId, entry_id: entryId, channel: "stderr", indexed: 1,
    });
    return entryId;
};

test("[§5.5-fragment-selects-named-channel] fragment targets the named channel; fragment-less targets default", async () => {
    const { db, sessionId, runId } = await setup();
    try {
        await seedExecEntry(db, sessionId, runId, "run/abc", "OUT-content", "ERR-content");
        const exec = new Exec();

        // Fragment `#stderr` selects the named (non-default) channel.
        const frag = await exec.read(readStmt(urlPath("exec", "run/abc", "stderr")), makeSchemeCtx({ db, sessionId }));
        assert.equal(frag.status, 200);
        assert.equal(frag.channel, "stderr");
        assert.equal(frag.content, "ERR-content");

        // Fragment-less resolves to the scheme's defaultChannel (stdout).
        const dflt = await exec.read(readStmt(urlPath("exec", "run/abc")), makeSchemeCtx({ db, sessionId }));
        assert.equal(dflt.status, 200);
        assert.equal(dflt.channel, "stdout");
        assert.equal(dflt.content, "OUT-content");
    } finally { await db.close(); }
});

test("[§5.5-fragment-on-nonexistent-404] fragment EDIT on absent entry → 404; default-channel (fragment-less) EDIT creates", async () => {
    const { db, sessionId, runId } = await setup();
    try {
        const k = new Known();

        // Explicit fragment on a path with no existing entry → 404 (the
        // fragment-targeted write requires the entry to already exist), even
        // when the fragment names the default channel.
        const missing = await k.edit(editStmt(urlPath("known", "ghost", "body"), "x"), makeSchemeCtx({ db, sessionId, runId }));
        assert.equal(missing.status, 404);
        assert.equal(missing.entryId, null);
        assert.equal(missing.channel, "body");

        // Fragment-less EDIT to the same (still absent) path creates the entry.
        const created = await k.edit(editStmt(urlPath("known", "ghost"), "made"), makeSchemeCtx({ db, sessionId, runId }));
        assert.equal(created.status, 201);
        assert.equal(created.channel, "body");
        assert.notEqual(created.entryId, null);
    } finally { await db.close(); }
});

test("[§5.5-fragment-targeted-show-hide] fragment-targeted HIDE flips only the named channel; fragment-less flips all", async () => {
    const { db, sessionId, runId } = await setup();
    try {
        const entryId = await seedExecEntry(db, sessionId, runId, "run/xyz", "out", "err");
        const exec = new Exec();

        const visOf = async (channel: string): Promise<number | undefined> =>
            (await (db.test_get_visibility as PrepMethod).get<{ indexed: number }>({ run_id: runId, entry_id: entryId, channel }))?.indexed;

        assert.equal(await visOf("stdout"), 1);
        assert.equal(await visOf("stderr"), 1);

        // Fragment-targeted HIDE on #stderr flips ONLY stderr.
        const h = await exec.hide(hideStmt(urlPath("exec", "run/xyz", "stderr")), makeSchemeCtx({ db, sessionId, runId }));
        assert.equal(h.status, 200);
        assert.equal(await visOf("stdout"), 1, "stdout untouched by fragment-targeted hide");
        assert.equal(await visOf("stderr"), 0, "stderr flipped to hidden");

        // Fragment-less HIDE flips ALL channels of the entry (§5.2).
        const hAll = await exec.hide(hideStmt(urlPath("exec", "run/xyz")), makeSchemeCtx({ db, sessionId, runId }));
        assert.equal(hAll.status, 200);
        assert.equal(await visOf("stdout"), 0, "fragment-less hide flips stdout too");
        assert.equal(await visOf("stderr"), 0);
    } finally { await db.close(); }
});

test("[§5.5-wire-omits-suffix-on-default-channel] default channel renders path-only; non-default carries #name", () => {
    // Single-channel entry → path-only fence (no #channel suffix at all).
    const single = PacketWire.renderSystemContent({
        system_definition: "SD",
        persona: "",
        index: [{
            scheme: "known",
            pathname: "france/capital",
            defaultChannel: "body",
            channels: { body: { content: "Paris", mimetype: "text/markdown", tokens: 1 } },
        }],
        log: [],
    });
    assert.match(single, /<<:::known:\/\/france\/capital\nParis\n:::known:\/\/france\/capital/, "single-channel default is path-only");
    assert.doesNotMatch(single, /#body/, "default channel never carries its #name suffix");

    // Multi-channel entry → default (stdout) path-only, non-default (stderr) keeps #stderr.
    const multi = PacketWire.renderSystemContent({
        system_definition: "SD",
        persona: "",
        index: [{
            scheme: "exec",
            pathname: "run/abc",
            defaultChannel: "stdout",
            channels: {
                stdout: { content: "ok", mimetype: "text/stream", tokens: 1 },
                stderr: { content: "warn", mimetype: "text/stream", tokens: 1 },
            },
        }],
        log: [],
    });
    assert.match(multi, /<<:::exec:\/\/run\/abc\nok\n:::exec:\/\/run\/abc/, "multi-channel default (stdout) is path-only");
    assert.match(multi, /<<:::exec:\/\/run\/abc#stderr\nwarn\n:::exec:\/\/run\/abc#stderr/, "non-default (stderr) keeps #stderr");
    assert.doesNotMatch(multi, /#stdout/, "default channel name is never suffixed");
});

test("[§5-channels-append-only] channels are keyed by (entry_id, name); same key collides, distinct names coexist", async () => {
    const { db, sessionId, runId } = await setup();
    try {
        // Two distinct channel names on one entry are two rows under the same key space.
        const entryId = await seedExecEntry(db, sessionId, runId, "run/keys", "first-out", "first-err");
        const channels = await (db.test_list_channels_for_entry as PrepMethod).all<{ name: string; content: string }>({ entry_id: entryId });
        assert.deepEqual(channels.map((c) => c.name), ["stderr", "stdout"], "distinct names coexist under one entry");

        // (entry_id, name) is the primary key — re-inserting the SAME (entry, name)
        // raw violates uniqueness. The append-only store keys on this tuple.
        await assert.rejects(
            () => (db.test_seed_channel as PrepMethod).run({
                entry_id: entryId, name: "stdout", content: "dup", mimetype: "text/stream", state: "static",
            }),
            /constraint/i,
            "duplicate (entry_id, name) is rejected by the PRIMARY KEY",
        );
    } finally { await db.close(); }
});

test("[§5.6-schemes-own-state-transitions] the exec scheme transitions channel state across the connection lifecycle", async () => {
    const { db, sessionId, runId } = await setup();
    try {
        const exec = new Exec();
        const ctx = makeSchemeCtx({ db, sessionId, runId, writer: "model", executors: await testExecutors() });
        const pathname = "r-statelife";

        // Drive the real applyResolution path: it seeds channels as "active",
        // spawns the subprocess, and the scheme OWNS the transition to "closed"
        // on clean exit (via the executor's setState callbacks).
        const started = await exec.applyResolution(
            { attrs: { runtime: "", cwd: null, command: "printf done", pathname } },
            ctx,
        );
        assert.equal(started.status, 200);
        assert.equal(started.outcome, "started");

        // Wait for the spawned subprocess + queued state writes to drain.
        await exec.idle();

        const entryId = (await (db.test_get_entry_id_by_scheme_pathname as PrepMethod).get<{ id: number }>({ scheme: "exec", pathname }))?.id;
        assert.notEqual(entryId, undefined);
        const stdout = await (db.test_get_channel as PrepMethod).get<{ content: string; state: string }>({ entry_id: entryId, name: "stdout" });
        // Scheme-owned transition: a clean exit closes the stdout channel.
        assert.equal(stdout?.state, "closed", "exec scheme transitioned stdout active → closed on clean exit");
        assert.equal(stdout?.content, "done", "content accumulated through the lifecycle");
    } finally { await db.close(); }
});

test("[§5.6-state-is-metadata] channel state does not gate reads — errored/closed channels still return content", async () => {
    const { db, sessionId, runId } = await setup();
    try {
        // Seed an entry whose channel is in the 'errored' terminal state with
        // partial content still present.
        await seedEntryWithChannel(db, {
            sessionId, runId, scheme: "known", pathname: "partial", channel: "body",
            content: "partial-but-readable", mimetype: "text/markdown", state: "errored",
        });
        const k = new Known();

        // READ returns the accumulated content regardless of the errored state —
        // state is metadata, not an engine gate.
        const r = await k.read(readStmt(urlPath("known", "partial")), makeSchemeCtx({ db, sessionId }));
        assert.equal(r.status, 200, "errored state does not gate the read");
        assert.equal(r.content, "partial-but-readable");
        assert.equal(r.channel, "body");

        // Confirm the stored state really is 'errored' (the read ignored it).
        const stored = await (db.test_get_channel as PrepMethod).get<{ state: string }>({ entry_id: (await (db.test_get_entry_id_by_scheme_pathname as PrepMethod).get<{ id: number }>({ scheme: "known", pathname: "partial" }))?.id, name: "body" });
        assert.equal(stored?.state, "errored", "state persisted as errored — read succeeded anyway");
    } finally { await db.close(); }
});
