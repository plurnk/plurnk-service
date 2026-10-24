// {§acp-action-binding} The env family's writes on a thread whose worker does not exist yet create that worker, as
// the other durable-policy setters do; its readers and its edits of existing entries require one. The real daemon
// answers every verb; nothing is simulated.
import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { Mock } from "@plurnk/plurnk-providers";
import type { AcpEvent } from "../../src/types.ts";
import { bindListener, openTestDatabase, SERVICE } from "./_helpers.ts";

type Problem = { status?: number; type?: string };

// A Run's finishing result, or the problem that refused the request before any Run opened.
const act = async (port: number, action: Readonly<Record<string, unknown>>, signal: AbortSignal): Promise<{ ok?: boolean; result?: unknown } | Problem> => {
    const response = await fetch(`http://127.0.0.1:${port}/acp`, {
        method: "POST",
        signal,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ threadId: "fresh", runId: crypto.randomUUID(), state: {}, messages: [], tools: [], context: [],
            forwardedProps: { plurnk: { workspace: "env-binding", action } } }),
    });
    if (response.status !== 200) return await response.json() as Problem;
    const events = (await response.text()).split("\n\n").filter((frame) => frame.startsWith("data: "))
        .map((frame) => JSON.parse(frame.slice(6)) as AcpEvent);
    const finished = (events.find(({ type }) => type === "RUN_FINISHED") as { result?: { ok?: boolean; result?: unknown } } | undefined)?.result;
    assert.ok(finished !== undefined, "the action's Run finishes with its result");
    return finished;
};

// Every verb of the worker-scoped env family, and whether it creates the thread's absent worker.
const VERBS: ReadonlyArray<{ readonly kind: string; readonly params: Readonly<Record<string, unknown>>; readonly creates: boolean }> = [
    { kind: "worker.env.add", params: { alias: "GREETING", definition: { value: "Hello" } }, creates: true },
    { kind: "worker.env.replace", params: { alias: "GREETING", definition: { value: "Hello" } }, creates: true },
    { kind: "worker.env.list", params: {}, creates: false },
    { kind: "worker.env.discover", params: {}, creates: false },
    { kind: "worker.env.enable", params: { alias: "GREETING" }, creates: false },
    { kind: "worker.env.disable", params: { alias: "GREETING" }, creates: false },
    { kind: "worker.env.remove", params: { alias: "GREETING" }, creates: false },
];

for (const verb of VERBS) {
    test(`{§acp-action-binding} ${verb.kind} on a thread with no worker ${verb.creates ? "creates the worker and holds the entry" : "is 404 worker-not-found and creates nothing"}`, { timeout: 30_000 }, async (t) => {
        await import(join(SERVICE, "test/setup.ts"));
        const { default: Daemon } = await import(join(SERVICE, "src/server/Daemon.ts"));
        const db = await openTestDatabase();
        const http = await bindListener();
        const daemon = new Daemon({ db, provider: new Mock({ contextWindow: 32768, responses: [] }), nodeModulesPath: join(SERVICE, "node_modules"), http });
        t.after(async () => {
            await daemon.stop();
            await http.close();
            await db.close();
        });
        await daemon.start();
        const { workspaceId } = await daemon.createWorkspace({ name: "env-binding" });
        const { port } = http.httpAddress();
        const answer = await act(port, { kind: verb.kind, ...verb.params }, t.signal);
        const created = (await daemon.listWorkers(workspaceId)).some((worker: { readonly name: string | null }) => worker.name === "fresh");
        if (!verb.creates) {
            assert.ok("status" in answer, `refused before any Run: ${JSON.stringify(answer)}`);
            assert.equal(answer.status, 404);
            assert.match(answer.type ?? "", /worker-not-found$/u);
            assert.equal(created, false, "a verb that requires the worker creates nothing");
            return;
        }
        assert.ok("ok" in answer && answer.ok === true, JSON.stringify(answer));
        assert.equal(created, true, "the thread's worker exists");
        const listed = await act(port, { kind: "worker.env.list" }, t.signal);
        const definitions = ("result" in listed ? listed.result as { definitions?: ReadonlyArray<{ alias: string; origin: string; definition?: { value?: string } }> } : undefined)?.definitions;
        assert.deepEqual(definitions?.filter(({ origin }) => origin === "worker").map(({ alias, definition }) => ({ alias, value: definition?.value })),
            [{ alias: "GREETING", value: "Hello" }], "the created worker holds the entry the action wrote");
    });
}
