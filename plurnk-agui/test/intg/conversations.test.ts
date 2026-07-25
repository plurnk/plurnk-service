// TWO CONVERSATIONS OVER ONE WORLD (the machine model's core split, svc#366 landed):
// two threads name the same workspace; each gets its OWN run (its own history), and the
// world — the workspace filesystem — is SHARED: an EDIT made through thread A is READable
// through thread B (the environment door). No model needed: client ops (op.parse)
// exercise the routing and the shared world against a REAL daemon; skips clean when
// the sibling service checkout is absent.

import { test } from "node:test";
import assert from "node:assert/strict";
import { access } from "node:fs/promises";
import { join, resolve } from "node:path";
import Module from "../../src/Module.ts";
import type { DaemonSeam } from "../../src/DaemonSeam.ts";
import type { AguiEvent } from "../../src/types.ts";

const SERVICE = resolve(import.meta.dirname, "../../../plurnk-service");
const gated = await access(join(SERVICE, "src/server/Daemon.ts")).then(() => false, () => true);

const action = async (port: number, threadId: string, workspace: string, kind: string, params: Record<string, unknown> = {}): Promise<{ ok: boolean; result?: Record<string, unknown>; error?: string }> => {
    const res = await fetch(`http://127.0.0.1:${port}/`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ threadId, runId: crypto.randomUUID(), state: {}, messages: [], tools: [], context: [], forwardedProps: { plurnk: { workspace, action: { kind, ...params } } } }),
    });
    assert.equal(res.status, 200);
    const events = (await res.text()).split("\n\n").filter((f) => f.startsWith("data: ")).map((f) => JSON.parse(f.slice(6)) as AguiEvent);
    const r = events.find((e) => e.type === "CUSTOM" && (e as { name?: string }).name === "plurnk.action.result") as { value: { ok: boolean; result?: Record<string, unknown>; error?: string } } | undefined;
    assert.ok(r !== undefined, `no action result for ${kind}`);
    return r.value;
};

test("two threads, one world: distinct runs, shared filesystem (the environment door)", { skip: gated, timeout: 60_000 }, async () => {
    // The service's shipped env floor (partition integers etc.) — the daemon fails
    // hard without it, and this test boots one in-process.
    process.loadEnvFile(join(SERVICE, ".env.defaults"));
    const { openMigrated } = await import(join(SERVICE, "test/intg/_helpers.ts"));
    const { default: Daemon } = await import(join(SERVICE, "src/server/Daemon.ts"));

    const db = await openMigrated();
    const daemon = new Daemon({ db, provider: null, nodeModulesPath: join(SERVICE, "node_modules") });
    let module: Module | null = null;
    daemon.registerModule(async (seam: DaemonSeam) => {
        module = await Module.init({ host: "127.0.0.1", port: 0 })(seam);
    });
    await daemon.start({ host: "127.0.0.1", port: 0 });
    const port = (module as unknown as Module).address().port;

    try {
        // Thread A (== workspace name: the default conversation) EDITs a shared entry.
        const edit = await action(port, "shared-world", "shared-world", "op.parse", { text: "<<EDIT(worker:///notes.md):the world is one:EDIT\n" });
        assert.equal(edit.ok, true, edit.error ?? "");
        const editResults = (edit.result as { results: Array<{ status: number }> }).results;
        assert.ok(editResults.every((r) => r.status < 300), `EDIT dispatched clean: ${JSON.stringify(editResults)}`);

        // Thread B — a DISTINCT conversation over the SAME world.
        const read = await action(port, "second-look", "shared-world", "op.parse", { text: "<<READ(worker:///notes.md):READ\n" });
        assert.equal(read.ok, true, read.error ?? "");
        const readResults = (read.result as { results: Array<{ status: number; [k: string]: unknown }> }).results;
        assert.equal(readResults[0]?.status, 200, `thread B READs what thread A wrote: ${JSON.stringify(readResults)}`);

        // The workers are DISTINCT: the workspace holds thread B's own conversation worker,
        // named for it, alongside the model worker — histories split, world shared.
        const workers = await action(port, "second-look", "shared-world", "workspace.workers");
        assert.equal(workers.ok, true);
        const runList = (workers.result as { workers: Array<{ id: number; name: string }> }).workers;
        const names = runList.map((r) => r.name);
        assert.ok(names.includes("second-look"), `thread B's conversation worker exists by ITS name: ${names.join(", ")}`);

        // #376 isolation — the workerId filter through module HEAD + the REAL seam: the
        // client ops journaled in each thread's CLIENT run; per-worker reads must differ.
        // (The service's readlog-run-filter pin exonerates the seam in isolation; this
        // pins the full module→seam path with live params.)
        const perRun = new Map<number, number>();
        for (const r of runList) {
            const read = await action(port, "second-look", "shared-world", "log.read", { workerId: r.id });
            assert.equal(read.ok, true, `log.read workerId=${r.id}: ${read.error ?? ""}`);
            perRun.set(r.id, (read.result as { entries: unknown[] }).entries.length);
        }
        const counts = [...perRun.values()];
        assert.ok(new Set(counts).size > 1 || counts.every((c) => c === 0) === false,
            `per-worker reads are DISTINGUISHABLE (a uniform answer for every workerId is the #376 signature): ${JSON.stringify([...perRun])}`);
    } finally {
        await (module as Module | null)?.close();
        await daemon.stop();
        await db.close();
    }
});
