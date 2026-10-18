// {§agui-thread-binding} {§connection-lifecycle} TWO THREADS OVER ONE WORKSPACE:
// two threads name the same workspace and act in it. Their operations are the workspace's, journaled in its
// runtime worker under each thread's owner address, and the workspace — the workspace filesystem — is SHARED: an
// EDIT made through thread A is READable through thread B (the environment door). No model needed: client ops
// (op.parse) exercise the routing and the shared workspace against the real daemon in the canonical core workspace.

import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import type { ApplicationLoopProjection } from "@plurnk/plurnk-contracts";
import type { AguiEvent } from "../../src/types.ts";
import { bindListener, openTestDatabase, SERVICE } from "./_helpers.ts";

const action = async (port: number, threadId: string, workspace: string, kind: string, params: Record<string, unknown> = {}): Promise<{ ok: boolean; result?: Record<string, unknown>; problem?: Record<string, unknown> }> => {
    const res = await fetch(`http://127.0.0.1:${port}/agui`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ threadId, runId: crypto.randomUUID(), state: {}, messages: [], tools: [], context: [], forwardedProps: { plurnk: { workspace, action: { kind, ...params } } } }),
    });
    assert.equal(res.status, 200);
    const events = (await res.text()).split("\n\n").filter((f) => f.startsWith("data: ")).map((f) => JSON.parse(f.slice(6)) as AguiEvent);
    // {§agui-plurnk-metadata} The action's outcome is its Run's result.
    const outcome = (events.find((e) => e.type === "RUN_FINISHED") as { result?: { ok: boolean; result?: Record<string, unknown>; problem?: Record<string, unknown> } } | undefined)?.result;
    assert.ok(outcome !== undefined, `no action result for ${kind}`);
    return outcome;
};

test("two threads, one workspace: each thread's operations under its own address, one shared filesystem (the environment door)", { timeout: 60_000 }, async () => {
    await import(join(SERVICE, "test/setup.ts"));
    const { default: Daemon } = await import(join(SERVICE, "src/server/Daemon.ts"));

    const db = await openTestDatabase();
    const http = await bindListener();
    const daemon = new Daemon({ db, provider: null, nodeModulesPath: join(SERVICE, "node_modules"), http });
    await daemon.start();
    const port = http.httpAddress().port;

    try {
        // Thread A dispatches one ordered multi-statement action against a shared entry.
        // {§agui-op-parse} {§whitespace-contract}
        const edit = await action(port, "first-thread", "shared-workspace", "op.parse", {
            text: "Prelude.\n````EDIT (worker:///notes.md)\nfirst\n````\n3\n````EDIT (worker:///notes.md) <1,-1>\nthe workspace is one\n````\nPostscript.",
        });
        assert.equal(edit.ok, true, JSON.stringify(edit.problem));
        const editResults = (edit.result as { results: Array<{ status: number }> }).results;
        assert.deepEqual(editResults.map(({ status }) => status), [201, 200]);

        // {§agui-op-parse} {§unparsed-tail-boundary} — one real daemon action keeps the
        // valid prefix, surfaces the boundary loss once, and never mutates from recovered tail AST.
        const tailed = await action(port, "first-thread", "shared-workspace", "op.parse", {
            text: "````EDIT (worker:///tail-trusted.md)\nkept\n````\n\n````EDIT (worker:///tail-untrusted.md",
        });
        assert.equal(tailed.ok, true, JSON.stringify(tailed.problem));
        const tailResults = (tailed.result as {
            results: Array<{ status: number; problem?: Record<string, unknown> }>;
        }).results;
        assert.deepEqual(tailResults.map(({ status }) => status), [201, 400]);
        assert.deepEqual(tailResults[1]?.problem, {
            type: "https://problems.plurnk.xyz/agui/action/parse-failed",
            title: "Parse failed",
            status: 400,
            detail: "target slot of `EDIT` opened at line 5 but never closed - add `)`",
            line: 5,
            column: 0,
            source: "grammar",
            severity: "error",
            stage: "parsing",
            retryable: false,
        });
        const untrusted = await action(port, "first-thread", "shared-workspace", "op.parse", {
            text: "````READ (worker:///tail-untrusted.md)````",
        });
        const untrustedResults = (untrusted.result as { results: Array<{ status: number }> }).results;
        assert.equal(untrustedResults[0]?.status, 404, "the statement recovered from the undefined tail never dispatched");

        // Thread B acts in the SAME workspace.
        const read = await action(port, "second-thread", "shared-workspace", "op.parse", { text: "````READ (worker:///notes.md)````" });
        assert.equal(read.ok, true, JSON.stringify(read.problem));
        const readResults = (read.result as { results: Array<{ status: number; [k: string]: unknown }> }).results;
        assert.equal(readResults[0]?.status, 200, `thread B READs what thread A wrote: ${JSON.stringify(readResults)}`);
        assert.equal(readResults[0]?.content, "the workspace is one", "the action dispatched both EDITs in source order");

        // {§agui-action-binding} Workspace-level actions and operations bind no worker, so neither thread's name was
        // minted; {§connection-lifecycle} both threads' operations journal in the runtime worker, each loop naming its
        // thread's owner ({§actor-boundary-client-operations}).
        const workers = await action(port, "second-thread", "shared-workspace", "workspace.workers");
        assert.equal(workers.ok, true);
        const workerList = (workers.result as { workers: Array<{ id: number; name: string; origin: string }> }).workers;
        const names = workerList.map((worker) => worker.name);
        assert.deepEqual(names.filter((name) => name === "first-thread" || name === "second-thread"), [],
            `no worker was minted for a thread whose Runs bind none: ${names.join(", ")}`);
        const runtime = workerList.find((worker) => worker.origin === "_plurnk");
        assert.ok(runtime !== undefined, `the runtime worker journals the operations: ${names.join(", ")}`);
        const journal = await action(port, "second-thread", "shared-workspace", "log.read", { workerId: runtime.id });
        assert.equal(journal.ok, true, JSON.stringify(journal.problem));
        const rows = (journal.result as { entries: Array<{ origin: string; source: string | null }> }).entries;
        assert.ok(rows.some(({ origin }) => origin === "client"), "the operations journal in the runtime worker");
        assert.ok(rows.every(({ source }) => source === null), "an operation's rows are acts, not arrivals");
        const [workspace] = await daemon.listWorkspaces();
        const loops: readonly ApplicationLoopProjection[] = await daemon.listWorkerLoops({ workspaceId: workspace!.id, workerId: runtime.id });
        assert.deepEqual([...new Set(loops.flatMap(({ promptSource }) => promptSource === null ? [] : [promptSource]))].toSorted(), [
            "agui://anonymous/threads/first-thread",
            "agui://anonymous/threads/second-thread",
        ], "every operation's loop names the person who acted");
    } finally {
        await daemon.stop();
        await http.close();
        await db.close();
    }
});
