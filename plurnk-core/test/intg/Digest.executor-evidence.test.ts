// {§digest-executor-evidence} — engine-materialized completion rows for a failed
// command are evidence, never errors: a loop that concluded green over red test
// runs is CLEAN, not DEGENERATE-WIN.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import Digest from "../../src/digest/Digest.ts";
import { openMigrated, insertWorkspace, insertWorker, insertLoop, insertTurn } from "./_helpers.ts";

test("{§digest-executor-evidence}: executor completion rows never count toward health or errs", async () => {
    const dir = await mkdtemp(join(tmpdir(), "plurnk-digest-executor-"));
    const dbPath = join(dir, "plurnk.db");
    const digestDir = join(dir, "digest");
    const db = await openMigrated(dbPath);
    try {
        const workspaceId = await insertWorkspace(db, "digest-executor");
        const workerId = await insertWorker(db, workspaceId);
        const loopId = await insertLoop(db, workerId, 1, "fix");
        await db.test_set_loop_status.run({ id: loopId, status: 200, terminal_result: JSON.stringify({ status: 200, content: "done" }) });
        const turnId = await insertTurn(db, loopId, 1, 200);
        const insert = async (sequence: number, origin: "model" | "_plurnk", rx: object, status: number): Promise<void> => {
            const row = await db.engine_insert_log_entry.get<{ id: number }>({
                worker_id: workerId, loop_id: loopId, turn_id: turnId, sequence,
                origin, source: origin === "_plurnk" ? "worker://runner" : null, model_call_id: null,
                op: "READ", delimiter: "", signal: null,
                scheme: "sh", username: null, password: null, hostname: null, port: null,
                pathname: "/1/1/2", query: null, fragment: "stderr", lineMarker: null,
                tx: "{}", mimetype_tx: "application/json",
                rx: JSON.stringify(rx), mimetype_rx: "application/json",
                status_rx: status, weight: 1, state: "resolved", outcome: null,
                attrs: "{}",
            });
            if (row === undefined) throw new Error("fixture insert returned no row");
        };
        // The engine-materialized completion pair for a red `go test ./...` run.
        await insert(1, "_plurnk", { status: 500, problem: { type: "https://problems.plurnk.xyz/executor/sh/nonzero-exit", title: "Command failed", status: 500, detail: "exit 1" } }, 500);
        await insert(2, "_plurnk", { status: 500, problem: { type: "https://problems.plurnk.xyz/executor/sh/nonzero-exit", title: "Command failed", status: 500, detail: "exit 1" } }, 500);
        // A genuine model-fault row for contrast.
        await insert(3, "model", { status: 416, problem: { type: "https://problems.plurnk.xyz/scheme/file/range", title: "Range past end", status: 416, detail: "past the end" } }, 416);
    } finally { await db.close(); }

    Digest.run({ dbPath, digestDir });
    const markdown = await readFile(join(digestDir, "digest.md"), "utf8");
    assert.match(markdown, /errs=1\b/, "only the genuine fault counts in the errs badge");
    assert.doesNotMatch(markdown, /errs=[23]\b/, "executor evidence never inflates the badge");
    assert.match(markdown, /\(1 errors, 0 error-items\)|status=\d+ \(1 errors/, "health counts one error");
});

test("{§digest-executor-evidence}: a green conclusion over only red commands is CLEAN", async () => {
    const dir = await mkdtemp(join(tmpdir(), "plurnk-digest-executor-clean-"));
    const dbPath = join(dir, "plurnk.db");
    const digestDir = join(dir, "digest");
    const db = await openMigrated(dbPath);
    try {
        const workspaceId = await insertWorkspace(db, "digest-executor-clean");
        const workerId = await insertWorker(db, workspaceId);
        const loopId = await insertLoop(db, workerId, 1, "fix");
        await db.test_set_loop_status.run({ id: loopId, status: 200, terminal_result: JSON.stringify({ status: 200, content: "done" }) });
        const turnId = await insertTurn(db, loopId, 1, 200);
        const row = await db.engine_insert_log_entry.get<{ id: number }>({
            worker_id: workerId, loop_id: loopId, turn_id: turnId, sequence: 1,
            origin: "_plurnk", source: "worker://runner", model_call_id: null,
            op: "READ", delimiter: "", signal: null,
            scheme: "sh", username: null, password: null, hostname: null, port: null,
            pathname: "/1/1/2", query: null, fragment: "stderr", lineMarker: null,
            tx: "{}", mimetype_tx: "application/json",
            rx: JSON.stringify({ status: 500, problem: { type: "https://problems.plurnk.xyz/executor/sh/nonzero-exit", title: "Command failed", status: 500, detail: "exit 1" } }),
            mimetype_rx: "application/json",
            status_rx: 500, weight: 1, state: "resolved", outcome: null,
            attrs: "{}",
        });
        if (row === undefined) throw new Error("fixture insert returned no row");
    } finally { await db.close(); }

    Digest.run({ dbPath, digestDir });
    const markdown = await readFile(join(digestDir, "digest.md"), "utf8");
    assert.match(markdown, /CLEAN/, "red commands under a green conclusion stay CLEAN");
    assert.doesNotMatch(markdown, /DEGENERATE-WIN/);
});
