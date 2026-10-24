import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import type { AcpEvent } from "../../src/types.ts";
import { bindListener, openTestDatabase, SERVICE } from "./_helpers.ts";

test("{§acp-shutdown} daemon and listener settle with idle clients across workspaces", { timeout: 60_000 }, async (t) => {
    await import(join(SERVICE, "test/setup.ts"));
    const { default: Daemon } = await import(join(SERVICE, "src/server/Daemon.ts"));
    const db = await openTestDatabase();
    const http = await bindListener();
    const daemon = new Daemon({ db, provider: null, nodeModulesPath: join(SERVICE, "node_modules"), http });
    const clients = new AbortController();
    const activations: PromiseSettledResult<void>[] = [];
    const activate = daemon.activateWorkspace.bind(daemon);
    t.mock.method(daemon, "activateWorkspace", async (args: { workspaceId: number }) => {
        try {
            await activate(args);
            activations.push({ status: "fulfilled", value: undefined });
        } catch (reason) {
            activations.push({ status: "rejected", reason });
            throw reason;
        }
    });
    try {
        await daemon.start();
        const diagnostics = t.mock.method(console, "error");
        const { host, port } = http.httpAddress();
        // {§acp-action-binding} Each connection binds the worker its thread names, so each exists first.
        const workspaces = new Map<string, number>();
        for (const [index, workspace] of ["one", "one", "two"].entries()) {
            if (!workspaces.has(workspace)) workspaces.set(workspace, (await daemon.createWorkspace({ name: workspace })).workspaceId);
            await daemon.createWorker({ workspaceId: workspaces.get(workspace)!, name: `observer-${index}` });
        }
        const responses = await Promise.all(["one", "one", "two"].map(async (workspace, index) => {
            const response = await fetch(`http://${host}:${port}/acp/connect`, {
                method: "POST", headers: { "content-type": "application/json" },
                signal: AbortSignal.any([t.signal, clients.signal]),
                body: JSON.stringify({
                    threadId: `observer-${index}`, runId: `run-${index}`, state: {},
                    messages: [], tools: [], context: [], forwardedProps: { plurnk: { workspace, control: true } },
                }),
            });
            assert.equal(response.status, 200);
            return response;
        }));
        const bodies = Promise.all(responses.map((response) => response.text()));
        await daemon.stop();
        assert.equal(activations.length, 3, "shutdown joins every owner's background activation");
        for (const outcome of activations) {
            if (outcome.status === "rejected") {
                assert.ok(outcome.reason instanceof DOMException);
                assert.equal(outcome.reason.name, "AbortError", "unfinished activation is cancelled, not a closed module/database failure");
            }
        }
        await http.close();
        for (const body of await bodies) {
            const events = body.split("\n\n").filter((frame) => frame.startsWith("data: "))
                .map((frame) => JSON.parse(frame.slice(6)) as AcpEvent);
            assert.equal(events.filter(({ type }) => type === "RUN_STARTED").length, 1);
            const terminals = events.filter(({ type }) => type === "RUN_FINISHED" || type === "RUN_ERROR");
            assert.equal(terminals.length, 1);
            assert.equal(terminals[0]?.type, "RUN_ERROR");
            if (terminals[0]?.type === "RUN_ERROR") {
                assert.equal(terminals[0].code, "https://problems.plurnk.xyz/acp/http/service-stopping");
                // {§acp-plurnk-metadata} Shutdown ended the Run, not its loop: the end carries no terminal record.
                assert.equal((terminals[0].metadata as { plurnk?: { terminal?: unknown } } | undefined)?.plurnk?.terminal, undefined);
            }
        }
        await daemon.stop();
        assert.deepEqual(diagnostics.mock.calls.map(({ arguments: args }) => args), [], "clean shutdown has no background activation or database failures");
    } finally {
        clients.abort();
        await daemon.stop();
        await http.close();
        await db.close();
    }
});
