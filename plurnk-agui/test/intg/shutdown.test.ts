import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import type { AguiEvent } from "../../src/types.ts";
import { bindListener, openTestDatabase, SERVICE } from "./_helpers.ts";

test("{§agui-shutdown} daemon and listener settle with idle clients across workspaces", { timeout: 60_000 }, async (t) => {
    await import(join(SERVICE, "test/setup.ts"));
    const { default: Daemon } = await import(join(SERVICE, "src/server/Daemon.ts"));
    const db = await openTestDatabase();
    const http = await bindListener();
    const daemon = new Daemon({ db, provider: null, nodeModulesPath: join(SERVICE, "node_modules"), http });
    const clients = new AbortController();
    try {
        await daemon.start();
        const { host, port } = http.httpAddress();
        // {§agui-action-binding} Each connection binds the worker its thread names, so each exists first.
        const worlds = new Map<string, number>();
        for (const [index, workspace] of ["one", "one", "two"].entries()) {
            if (!worlds.has(workspace)) worlds.set(workspace, (await daemon.createWorkspace({ name: workspace })).workspaceId);
            await daemon.createWorker({ workspaceId: worlds.get(workspace)!, name: `observer-${index}` });
        }
        const responses = await Promise.all(["one", "one", "two"].map(async (workspace, index) => {
            const response = await fetch(`http://${host}:${port}/agui/connect`, {
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
        await http.close();
        for (const body of await bodies) {
            const events = body.split("\n\n").filter((frame) => frame.startsWith("data: "))
                .map((frame) => JSON.parse(frame.slice(6)) as AguiEvent);
            assert.equal(events.filter(({ type }) => type === "RUN_STARTED").length, 1);
            const terminals = events.filter(({ type }) => type === "RUN_FINISHED" || type === "RUN_ERROR");
            assert.equal(terminals.length, 1);
            assert.equal(terminals[0]?.type, "RUN_ERROR");
            if (terminals[0]?.type === "RUN_ERROR") {
                assert.equal(terminals[0].code, "https://problems.plurnk.xyz/agui/http/service-stopping");
            }
            assert.ok(!events.some((event) => event.type === "CUSTOM" && event.name === "plurnk.terminated"));
        }
        await daemon.stop();
    } finally {
        clients.abort();
        await daemon.stop();
        await http.close();
        await db.close();
    }
});
