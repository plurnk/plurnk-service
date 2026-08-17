// Streaming verification: a countdown script emits one line every 0.5s
// for ~3 seconds. The exec scheme's job is to land each chunk in
// entry_channels.content as it arrives — not all at once at close.
//
// This test exercises the time dimension that every other exec test
// glosses over by using `echo` (instant output) or `sleep 30` (no
// output until aborted). Here we verify:
//   1. Channel content grows monotonically over the spawn's lifetime.
//   2. Channel state is "active" during emission, "closed" after exit.
//   3. stream/event notifications fire per chunk (not just at close)
//      with increasing contentLength values, so a daemon client could
//      render a live waterfall.
//   4. The final byte count matches the script's complete output.

import test from "node:test";
import assert from "node:assert/strict";
import type { ExecStatement } from "@plurnk/plurnk-contracts";
import Engine from "../../src/core/Engine.ts";
import SchemeRegistry from "../../src/core/SchemeRegistry.ts";
import Exec from "../../src/schemes/Exec.ts";
import { openMigrated, insertWorkspace, insertWorker, insertLoop, insertTurn, testExecutors, rootWorkspace } from "./_helpers.ts";
import { mkdtemp, writeFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const execStmt = (runtime: string, body: string): ExecStatement => ({
    op: "EXEC", annotation: null, delimiter: "", signal: runtime,
    target: null, lineMarker: null, body, position: { line: 1, column: 1 },
});

const deferred = <T>(): { promise: Promise<T>; resolve: (v: T) => void } => {
    let resolve!: (v: T) => void;
    const promise = new Promise<T>((res) => { resolve = res; });
    return { promise, resolve };
};

test("streaming exec: chunks land in the channel as they arrive (not buffered until close)", async () => {
    // 5 lines, 0.5s apart — ~2.5s total. Each line is 2 bytes ("N\n").
    // We sample mid-stream and assert content has GROWN but isn't yet
    // complete, then sample again after idle to assert final state.
    type Event = { entryId: number; channel: string; state: string; contentLength: number };
    const events: Event[] = [];
    const db = await openMigrated();
    try {
        const schemes = new SchemeRegistry();
        const exec = schemes.get("exec") as Exec;
        const engine = new Engine({
            db, schemes,
            streamEventNotify: (_workspaceId, event) => events.push(event),
        });
        engine.setExecutors(await testExecutors());
        const workspaceId = await insertWorkspace(db, `exec-stream-${crypto.randomUUID()}`);
        const workerId = await insertWorker(db, workspaceId);
        const loopId = await insertLoop(db, workerId, 1, "streaming test");
        const turnId = await insertTurn(db, loopId, 1, 102);

        const idDeferred = deferred<number>();
        const dispatchPromise = engine.dispatch({
            statement: execStmt("sh", "for i in 5 4 3 2 1; do echo $i; sleep 0.5; done"),
            workspaceId, workerId, loopId, turnId, sequence: 1, origin: "model",
            onDispatch: (id) => idDeferred.resolve(id),
        });
        const logEntryId = await idDeferred.promise;
        engine.resolveProposal(logEntryId, { decision: "accept" });
        const result = await dispatchPromise;
        assert.equal(result.status, 200, "applyResolution returns 200/started fast — does not block");

        // Find the auto-generated entry id from the log entry's attrs.
        const log = await db.test_get_log_entry_by_id.get<{ attrs: string }>({ id: logEntryId });
        const { pathname } = JSON.parse(log?.attrs ?? "{}") as { pathname: string };
        const entryRow = await db.test_get_entry_by_pathname_scheme.get<{ id: number }>({
            scheme: "sh", pathname,
        });
        assert.ok(entryRow, "exec entry was created at proposal-time, before any output");

        const sampleStdout = async (): Promise<{ content: string; state: string }> => {
            const row = await db.test_get_channel.get<{ content: string; state: string }>({
                entry_id: entryRow!.id, name: "stdout",
            });
            return { content: row?.content ?? "", state: row?.state ?? "?" };
        };

        // Sample at T+0 (just after dispatch returned) — channel may be
        // empty or partially populated depending on whether spawn has had
        // a tick yet. The invariant is state=active.
        const t0 = await sampleStdout();
        assert.equal(t0.state, "active", "channel starts in 'active' state during spawn");

        // T+~1.1s: expect 2-3 lines have landed (5, 4 — possibly 3 if
        // we got lucky with timing). We assert lower bound only — at
        // least one line — to keep the test robust against scheduler jitter.
        await new Promise((r) => setTimeout(r, 1100));
        const t1 = await sampleStdout();
        assert.ok(t1.content.length > 0, `at T+~1s, stdout should have some content; got ${JSON.stringify(t1.content)}`);
        assert.ok(t1.content.length < 10, `at T+~1s, stdout should NOT yet have the full 10 bytes ("5\\n4\\n3\\n2\\n1\\n"); got ${t1.content.length} bytes`);
        assert.equal(t1.state, "active", "still streaming at T+~1s");

        // T+~2.2s: more lines should have landed.
        await new Promise((r) => setTimeout(r, 1100));
        const t2 = await sampleStdout();
        assert.ok(t2.content.length > t1.content.length,
            `content grew monotonically: t1=${t1.content.length} bytes → t2=${t2.content.length} bytes`);

        // Wait for completion.
        await exec.idle();
        const tEnd = await sampleStdout();
        assert.equal(tEnd.content, "5\n4\n3\n2\n1\n", "final stdout is all 5 lines");
        assert.equal(tEnd.state, "closed", "channel transitions active → closed at exit");

        // Stream events: per-chunk while active + state transition at end.
        const chunkEvents = events.filter((e) => e.state === "active" && e.channel === "stdout");
        const closeEvents = events.filter((e) => e.state === "closed" && e.channel === "stdout");
        assert.ok(chunkEvents.length >= 3,
            `expected ≥3 stdout chunk events (one per line, modulo buffering); got ${chunkEvents.length}`);
        // ContentLength must be monotonically non-decreasing across chunk events.
        const lengths = chunkEvents.map((e) => e.contentLength);
        for (let i = 1; i < lengths.length; i++) {
            assert.ok(lengths[i] >= lengths[i - 1],
                `contentLength should be monotonically non-decreasing across chunk events; got ${lengths.join(", ")}`);
        }
        assert.equal(closeEvents.length, 1, "exactly one state=closed event for stdout");
        assert.equal(closeEvents[0].contentLength, 10, "close event reports final byte count (5 lines × 2 bytes)");
    } finally { await db.close(); }
});

test("streaming exec: subscription stays open during emission, closes after exit", async () => {
    const db = await openMigrated();
    try {
        const schemes = new SchemeRegistry();
        const exec = schemes.get("exec") as Exec;
        const engine = new Engine({ db, schemes });
        engine.setExecutors(await testExecutors());
        const workspaceId = await insertWorkspace(db, `exec-stream-sub-${crypto.randomUUID()}`);
        const workerId = await insertWorker(db, workspaceId);
        const loopId = await insertLoop(db, workerId, 1, "subscription lifecycle");
        const turnId = await insertTurn(db, loopId, 1, 102);

        const idDeferred = deferred<number>();
        const dispatchPromise = engine.dispatch({
            statement: execStmt("sh", "for i in 3 2 1; do echo $i; sleep 0.4; done"),
            workspaceId, workerId, loopId, turnId, sequence: 1, origin: "model",
            onDispatch: (id) => idDeferred.resolve(id),
        });
        const logEntryId = await idDeferred.promise;
        engine.resolveProposal(logEntryId, { decision: "accept" });
        await dispatchPromise;

        const log = await db.test_get_log_entry_by_id.get<{ attrs: string }>({ id: logEntryId });
        const { pathname } = JSON.parse(log?.attrs ?? "{}") as { pathname: string };
        const entryRow = await db.test_get_entry_by_pathname_scheme.get<{ id: number }>({
            scheme: "sh", pathname,
        });

        // Mid-stream: subscription is still open (closed_at IS NULL).
        await new Promise((r) => setTimeout(r, 600));
        const midSub = await db.test_get_subscription_by_entry.get<{
            closed_at: string | null; close_status: number | null;
        }>({ worker_id: workerId, entry_id: entryRow!.id });
        assert.equal(midSub?.closed_at, null, "subscription is alive during emission");
        assert.equal(midSub?.close_status, null);

        // After completion: subscription closes at 200.
        await exec.idle();
        const endSub = await db.test_get_subscription_by_entry.get<{
            closed_at: string | null; close_status: number | null; close_result: string | null;
        }>({ worker_id: workerId, entry_id: entryRow!.id });
        assert.ok(endSub?.closed_at, "subscription closed after spawn exit");
        assert.equal(endSub?.close_status, 200, "clean exit closes subscription at 200");
        assert.deepEqual(JSON.parse(endSub?.close_result ?? "null"), { status: 200, exitCode: 0 });
    } finally { await db.close(); }
});

test("streaming exec: the workspace catalog picks up partial channel content between samples", async () => {
    // The workspace catalog (engine_list_workspace_entries, its
    // source) reads channels.content LIVE — so each turn build sees
    // whatever bytes have landed by that moment. This proves the model
    // would observe partial output across turn boundaries (rather than
    // seeing nothing until close).
    const db = await openMigrated();
    try {
        const schemes = new SchemeRegistry();
        const exec = schemes.get("exec") as Exec;
        const engine = new Engine({ db, schemes });
        engine.setExecutors(await testExecutors());
        const workspaceId = await insertWorkspace(db, `exec-stream-idx-${crypto.randomUUID()}`);
        const workerId = await insertWorker(db, workspaceId);
        const loopId = await insertLoop(db, workerId, 1, "catalog mid-stream");
        const turnId = await insertTurn(db, loopId, 1, 102);

        const idDeferred = deferred<number>();
        const dispatchPromise = engine.dispatch({
            statement: execStmt("sh", "for i in 4 3 2 1; do echo $i; sleep 0.4; done"),
            workspaceId, workerId, loopId, turnId, sequence: 1, origin: "model",
            onDispatch: (id) => idDeferred.resolve(id),
        });
        engine.resolveProposal(await idDeferred.promise, { decision: "accept" });
        await dispatchPromise;

        const execStdout = async (): Promise<Array<{ scheme: string; pathname: string; content: string }>> => {
            // Read the exec entry's stdout channel from the workspace catalog
            // (engine_list_workspace_entries, the source behind the catalog):
            // one row per (entry, channel) with the channel's LIVE content.
            // Streaming is a channel property — partial bytes must be observable
            // mid-stream regardless of how they're later rendered.
            const rows = await db.engine_list_workspace_entries.all<{
                scheme: string; pathname: string;
                channel: string; content: string;
            }>({ workspace_id: workspaceId });
            return rows
                .filter((r) => r.scheme === "sh" && r.channel === "stdout")
                .map((r) => ({ scheme: r.scheme, pathname: r.pathname, content: r.content }));
        };

        // Mid-stream snapshot of the catalog.
        await new Promise((r) => setTimeout(r, 700));
        const mid = await execStdout();
        assert.equal(mid.length, 1, "exec stdout visible in the catalog mid-stream");
        assert.ok(mid[0].content.length > 0, `catalog reflects partial content; got "${mid[0].content}"`);
        assert.ok(mid[0].content.length < 8, "partial content < full 8 bytes (4\\n3\\n2\\n1\\n)");

        // After completion.
        await exec.idle();
        const end = await execStdout();
        assert.equal(end[0].content, "4\n3\n2\n1\n");
    } finally { await db.close(); }
});

// {§exec-target-routing}: accepting an empty-body file target runs the file
// without changing its authored mode.
test("an empty-body 0o644 script target survives acceptance and runs", async () => {
    const dir = await mkdtemp(join(tmpdir(), "exec-file-target-"));
    const db = await openMigrated();
    try {
        await writeFile(join(dir, "demo_greet.sh"), "echo greetings-from-file-target\n", { mode: 0o644 });
        const schemes = new SchemeRegistry();
        const engine = new Engine({ db, schemes });
        engine.setExecutors(await testExecutors());
        const workspaceId = await insertWorkspace(db, `exec-file-target-${crypto.randomUUID()}`);
        await rootWorkspace(db, workspaceId, dir);
        const workerId = await insertWorker(db, workspaceId);
        const loopId = await insertLoop(db, workerId, 1, "run the script");
        const turnId = await insertTurn(db, loopId, 1, 102);

        const idDeferred = deferred<number>();
        const dispatchPromise = engine.dispatch({
            statement: { op: "EXEC", annotation: null, delimiter: "", signal: "sh", target: { kind: "local", raw: "demo_greet.sh" }, lineMarker: null, body: "", position: { line: 1, column: 1 } },
            workspaceId, workerId, loopId, turnId, sequence: 1, origin: "model",
            onDispatch: (id) => idDeferred.resolve(id),
        });
        engine.resolveProposal(await idDeferred.promise, { decision: "accept" });
        const result = await dispatchPromise;
        assert.ok(result.status < 400, `the empty-body file target survives accept (got ${result.status} ${JSON.stringify(result)})`);

        const exec = schemes.get("exec") as Exec;
        await exec.idle();
        // the exec entry lives at the l/t/s coordinate (/1/1/1) under the runtime scheme — fail-hard
        const entryRow = await db.test_get_entry_by_pathname_scheme.get<{ id: number }>({ scheme: "sh", pathname: "/1/1/1" });
        assert.ok(entryRow, "the sh exec entry exists at /1/1/1");
        const ch = await db.test_get_channel.get<{ content: string }>({ entry_id: entryRow!.id, name: "stdout" });
        assert.match(ch?.content ?? "", /greetings-from-file-target/, "the script ran and its stdout arrived");
        const mode = (await stat(join(dir, "demo_greet.sh"))).mode & 0o777;
        assert.equal(mode, 0o644, "transient exec: the mode is untouched — no chmod magic");
    } finally { await db.close(); await rm(dir, { recursive: true, force: true }); }
});
