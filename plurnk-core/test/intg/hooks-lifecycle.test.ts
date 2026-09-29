import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { configuredModule } from "../../../plurnk-hooks/test/environment.ts";
import { Mock, ProviderError } from "@plurnk/plurnk-providers";
import Daemon from "../../src/server/Daemon.ts";
import { openMigrated } from "./_db.ts";
import { viableWindow } from "./_provider.ts";
import { makeMockResponse } from "./_mock.ts";

interface TerminalEvent {
    readonly workspaceId: number;
    readonly method: string;
    readonly params: {
        readonly workerId: number;
        readonly loopId: number;
        readonly result: { readonly status: number; readonly problem?: { readonly detail: string } };
    };
}

const captureHooks = async (t: TestContext, daemon: Daemon) => {
    const root = await mkdtemp(join(tmpdir(), "plurnk-hooks-lifecycle-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const script = join(root, "capture.mjs");
    const output = join(root, "events.jsonl");
    await writeFile(script, [
        'import { appendFile } from "node:fs/promises";',
        'let body = "";',
        'process.stdin.setEncoding("utf8");',
        'for await (const chunk of process.stdin) body += chunk;',
        'await appendFile(process.argv[2], body);',
    ].join("\n"));
    const failures: unknown[] = [];
    daemon.registerModule(configuredModule({
        PLURNK_HOOKS_COMMAND: process.execPath,
        PLURNK_HOOKS_ARGS: JSON.stringify([script, output]),
        PLURNK_HOOKS_EVENTS: "loop/terminated",
        PLURNK_HOOKS_TIMEOUT_MS: "5000",
    }, (_message, cause) => { failures.push(cause); }));
    return {
        failures,
        events: async (): Promise<TerminalEvent[]> => (await readFile(output, "utf8")).trim().split("\n").map((line) => JSON.parse(line)),
    };
};

test("{§module-shutdown-order} command hooks receive real loop cancellation before observer closure", { timeout: 15_000 }, async (t) => {
    const db = await openMigrated();
    const provider = new Mock({ contextWindow: viableWindow(), responses: [] });
    const entered = Promise.withResolvers<void>();
    provider.generate = async ({ signal }) => {
        assert.ok(signal);
        signal.throwIfAborted();
        entered.resolve();
        return new Promise((_resolve, reject) => {
            signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        });
    };
    const daemon = new Daemon({ db, provider });
    t.after(async () => {
        await daemon.stop();
        await db.close();
    });
    const hooks = await captureHooks(t, daemon);
    await daemon.start();
    const { workspaceId } = await daemon.createWorkspace({ name: "hooks-lifecycle" });
    const workerId = await daemon.ensureModelWorker(workspaceId);
    const { loopId } = await daemon.runLoop({ workspaceId, workerId, prompt: "Wait for cancellation." });
    await entered.promise;
    await daemon.stop();
    assert.deepEqual(hooks.failures, []);
    const events = await hooks.events();
    assert.equal(events.length, 1, "one cancellation, one command delivery");
    assert.equal(events[0].workspaceId, workspaceId);
    assert.equal(events[0].method, "loop/terminated");
    assert.equal(events[0].params.workerId, workerId);
    assert.equal(events[0].params.loopId, loopId);
    assert.equal(events[0].params.result.status, 499);
});

for (const outcome of ["success", "failure", "delegation"] as const) {
    test(`{§hooks-command-delivery} real ${outcome} events retain their full payload and owning coordinates`, { timeout: 20_000 }, async (t) => {
        const db = await openMigrated();
        const provider = new Mock({ contextWindow: viableWindow() * 4, responses: (outcome === "delegation" ? [
            "````WORK (worker://child)\nComplete the delegated work.\n````\n\n````WAIT\nAwait the child.\n````",
            "````KILL\nChild work completed.\n````",
            "````KILL\nParent work completed.\n````",
        ] : ["````KILL\nWork completed.\n````"]).map((response) => makeMockResponse(response)) });
        if (outcome === "failure") {
            provider.generate = async () => { throw new ProviderError("mock", "request_rejected", "Fixture request rejected."); };
        }
        const daemon = new Daemon({ db, provider });
        t.after(async () => { await daemon.stop(); await db.close(); });
        const hooks = await captureHooks(t, daemon);
        await daemon.start();
        const { workspaceId } = await daemon.createWorkspace({ name: `hooks-${outcome}` });
        const workerId = await daemon.ensureModelWorker(workspaceId);
        const done = Promise.withResolvers<void>();
        const published: TerminalEvent[] = [];
        daemon.subscribeToEvents((scope, method, params) => {
            if (method !== "loop/terminated") return;
            published.push(JSON.parse(JSON.stringify({ workspaceId: scope, method, params })));
            if ((params as { workerId: number }).workerId === workerId) done.resolve();
        });
        const { loopId } = await daemon.runLoop({ workspaceId, workerId, prompt: "Exercise lifecycle notifications.", policy: { proposals: "accept" } });
        await done.promise;
        await daemon.stop();
        const events = await hooks.events();
        assert.deepEqual(hooks.failures, []);
        assert.deepEqual(events, published, "the executable receives the same event evidence as an in-process subscriber");
        assert.equal(events.length, outcome === "delegation" ? 2 : 1);
        const parent = events.find((event) => event.params.workerId === workerId);
        assert.ok(parent);
        assert.equal(parent.workspaceId, workspaceId);
        assert.equal(parent.params.loopId, loopId);
        assert.equal(parent.params.result.status, outcome === "failure" ? 400 : 200);
        if (outcome === "failure") assert.equal(parent.params.result.problem?.detail, "Fixture request rejected.");
        if (outcome === "delegation") {
            const child = events.find((event) => event.params.workerId !== workerId);
            assert.ok(child);
            assert.equal(child.workspaceId, workspaceId);
            assert.notEqual(child.params.loopId, loopId);
            assert.equal(child.params.result.status, 200);
        }
    });
}
