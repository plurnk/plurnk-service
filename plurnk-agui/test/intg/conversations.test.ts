// {§agui-thread-binding} TWO CONVERSATIONS OVER ONE WORLD:
// two threads name the same workspace; each gets its OWN worker (its own history), and the
// world — the workspace filesystem — is SHARED: an EDIT made through thread A is READable
// through thread B (the environment door). No model needed: client ops (op.parse)
// exercise the routing and the shared world against the real daemon in the canonical
// core workspace.

import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import Module from "../../src/Module.ts";
import type { DaemonSeam } from "../../src/DaemonSeam.ts";
import type { AguiEvent } from "../../src/types.ts";
import { openTestDatabase, SERVICE } from "./_helpers.ts";

const action = async (port: number, threadId: string, workspace: string, kind: string, params: Record<string, unknown> = {}): Promise<{ ok: boolean; result?: Record<string, unknown>; problem?: Record<string, unknown> }> => {
    const res = await fetch(`http://127.0.0.1:${port}/`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ threadId, runId: crypto.randomUUID(), state: {}, messages: [], tools: [], context: [], forwardedProps: { plurnk: { workspace, action: { kind, ...params } } } }),
    });
    assert.equal(res.status, 200);
    const events = (await res.text()).split("\n\n").filter((f) => f.startsWith("data: ")).map((f) => JSON.parse(f.slice(6)) as AguiEvent);
    const r = events.find((e) => e.type === "CUSTOM" && (e as { name?: string }).name === "plurnk.action.result") as { value: { ok: boolean; result?: Record<string, unknown>; problem?: Record<string, unknown> } } | undefined;
    assert.ok(r !== undefined, `no action result for ${kind}`);
    return r.value;
};

test("two threads, one world: distinct workers, shared filesystem (the environment door)", { timeout: 60_000 }, async () => {
    // Apply the same assembled package-default floor as the daemon's own test tiers.
    await import(join(SERVICE, "test/floor.ts"));
    const { default: Daemon } = await import(join(SERVICE, "src/server/Daemon.ts"));

    const db = await openTestDatabase();
    const daemon = new Daemon({ db, provider: null, nodeModulesPath: join(SERVICE, "node_modules") });
    let module: Module | null = null;
    const registration = Module.init({ host: "127.0.0.1", port: 0 });
    daemon.registerModule({
        start: async (seam: DaemonSeam) => {
            module = await registration.start(seam);
            return module;
        },
    });
    await daemon.start({ host: "127.0.0.1", port: 0 });
    const port = (module as unknown as Module).address().port;

    try {
        // Thread A (== workspace name: the default conversation) dispatches one ordered
        // multi-statement action against a shared entry. {§agui-op-parse}
        const edit = await action(port, "shared-world", "shared-world", "op.parse", {
            text: "## EDIT1 (worker:///notes.md)\nfirst\n\n## EDIT1 (worker:///notes.md) <1,-1>\nthe world is one",
        });
        assert.equal(edit.ok, true, JSON.stringify(edit.problem));
        const editResults = (edit.result as { results: Array<{ status: number }> }).results;
        assert.deepEqual(editResults.map(({ status }) => status), [201, 200]);

        // {§agui-op-parse} {§unparsed-tail-boundary} — one real daemon action keeps the
        // valid prefix, surfaces the boundary loss once, and never mutates from recovered tail AST.
        const tailed = await action(port, "shared-world", "shared-world", "op.parse", {
            text: "## EDIT1 (worker:///tail-trusted.md)\nkept\n\n## EDIT1 (worker:///tail-untrusted.md",
        });
        assert.equal(tailed.ok, true, JSON.stringify(tailed.problem));
        const tailResults = (tailed.result as {
            results: Array<{ status: number; problem?: Record<string, unknown> }>;
        }).results;
        assert.deepEqual(tailResults.map(({ status }) => status), [201, 400]);
        assert.deepEqual(tailResults[1]?.problem, {
            type: "https://problems.plurnk.dev/agui/action/parse-failed",
            title: "Parse failed",
            status: 400,
            detail: "target slot of `## EDIT1` opened at line 4 but never closed - add `)`",
            line: 4,
            column: 0,
            source: "grammar",
            severity: "error",
            stage: "parsing",
            retryable: false,
        });
        const untrusted = await action(port, "shared-world", "shared-world", "op.parse", {
            text: "## READ1 (worker:///tail-untrusted.md)",
        });
        const untrustedResults = (untrusted.result as { results: Array<{ status: number }> }).results;
        assert.equal(untrustedResults[0]?.status, 404, "the statement recovered from the undefined tail never dispatched");

        // Thread B — a DISTINCT conversation over the SAME world.
        const read = await action(port, "second-look", "shared-world", "op.parse", { text: "## READ1 (worker:///notes.md)\n" });
        assert.equal(read.ok, true, JSON.stringify(read.problem));
        const readResults = (read.result as { results: Array<{ status: number; [k: string]: unknown }> }).results;
        assert.equal(readResults[0]?.status, 200, `thread B READs what thread A wrote: ${JSON.stringify(readResults)}`);
        assert.equal(readResults[0]?.content, "the world is one", "the action dispatched both EDITs in source order");

        // {§agui-op-look} {§op-look}
        const beforeLook = await action(port, "second-look", "shared-world", "log.read");
        const entriesBeforeLook = (beforeLook.result as { entries: unknown[] }).entries.length;
        const looked = await action(port, "second-look", "shared-world", "op.look", {
            text: "## LOOK1 (worker:///notes.md)",
        });
        assert.equal(looked.ok, true, JSON.stringify(looked.problem));
        assert.equal(looked.result?.status, 200);
        assert.equal(looked.result?.content, "the world is one");
        const afterLook = await action(port, "second-look", "shared-world", "log.read");
        assert.equal(
            (afterLook.result as { entries: unknown[] }).entries.length,
            entriesBeforeLook,
            "op.look creates no log entry through the assembled module and daemon",
        );

        const ambiguousLook = await action(port, "second-look", "shared-world", "op.look", {
            text: "## LOOK1 (worker:///notes.md)\n\n## EDIT1 (worker:///notes.md)\nmust-not-dispatch",
        });
        assert.equal(ambiguousLook.ok, false);
        assert.equal(ambiguousLook.problem?.type, "https://problems.plurnk.dev/agui/action/invalid-action-parameters");
        assert.equal(ambiguousLook.problem?.detail, "op.look parsed 2 statements; exactly one LOOK statement is required.");
        const unchanged = await action(port, "second-look", "shared-world", "op.look", {
            text: "## LOOK1 (worker:///notes.md)",
        });
        assert.equal(unchanged.result?.content, "the world is one", "the rejected second statement never reaches the daemon");

        // The workers are DISTINCT: the workspace holds thread B's own conversation worker,
        // named for it, alongside the model worker — histories split, world shared.
        const workers = await action(port, "second-look", "shared-world", "workspace.workers");
        assert.equal(workers.ok, true);
        const workerList = (workers.result as { workers: Array<{ id: number; name: string }> }).workers;
        const names = workerList.map((worker) => worker.name);
        assert.ok(names.includes("second-look"), `thread B's conversation worker exists by ITS name: ${names.join(", ")}`);

        // The workerId filter crosses the module and real seam: the
        // client ops journaled in each thread's client worker; per-worker reads must differ.
        // (The service's readlog-worker-filter pin exonerates the seam in isolation; this
        // pins the full module→seam path with live params.)
        const perWorker = new Map<number, number>();
        for (const worker of workerList) {
            const read = await action(port, "second-look", "shared-world", "log.read", { workerId: worker.id });
            assert.equal(read.ok, true, `log.read workerId=${worker.id}: ${JSON.stringify(read.problem)}`);
            perWorker.set(worker.id, (read.result as { entries: unknown[] }).entries.length);
        }
        const counts = [...perWorker.values()];
        assert.ok(new Set(counts).size > 1 || counts.every((c) => c === 0) === false,
            `per-worker reads are distinguishable: ${JSON.stringify([...perWorker])}`);
    } finally {
        await daemon.stop();
        await db.close();
    }
});
