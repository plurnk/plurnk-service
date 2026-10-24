// {§acp-status-model} {§notifications-worker-policy} — a worker's model route through the official client. A client attached
// to the worker holds the route its snapshot read; another view's management Runs set the effort, then the model, and the
// attached client is told each change without reconnecting; a client attaching afterward reads the same route. Real core,
// a stock HttpAgent, fixture providers behind two declared aliases.
import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";
import { HttpAgent } from "../../src/client.ts";
import type { RunAgentInput } from "../../src/types.ts";
import type { ModelRoute } from "@plurnk/plurnk-contracts";
import { Mock } from "@plurnk/plurnk-providers";
import { bindListener, openTestDatabase, SERVICE } from "./_helpers.ts";

class Observer extends HttpAgent {
    override connect(input: RunAgentInput) { return super.run(input); }
}

const until = async (what: string, predicate: () => boolean, timeoutMs = 15_000): Promise<void> => {
    const deadline = Date.now() + timeoutMs;
    while (!predicate()) {
        if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
        await new Promise((resolve) => setTimeout(resolve, 10));
    }
};

// The route as the official client's state carries it: undefined until its snapshot arrives.
const watch = () => {
    let model: ModelRoute | null | undefined;
    const route = (state: unknown): ModelRoute | null | undefined =>
        (state as { plurnk?: { status?: { model?: ModelRoute | null } } }).plurnk?.status?.model;
    return {
        model: () => model,
        subscriber: {
            onStateSnapshotEvent: ({ event }: { event: { snapshot: unknown } }) => { model = route(event.snapshot); },
            onStateDeltaEvent: ({ event }: { event: { delta: unknown } }) => {
                for (const op of event.delta as Array<{ path: string; value?: unknown }>) {
                    if (op.path === "/plurnk/status") model = (op.value as { model?: ModelRoute | null }).model;
                    if (op.path === "/plurnk/status/model") model = op.value as ModelRoute | null;
                }
            },
        },
    };
};

test("{§acp-status-model} {§notifications-worker-policy}: another view's effort change, then its model change, reach an attached client live; a fresh client reads the same route", { timeout: 60_000 }, async (t) => {
    await import(join(SERVICE, "test/setup.ts"));
    const [{ default: Daemon }, { default: ProviderInstantiate }] = await Promise.all([
        import(join(SERVICE, "src/server/Daemon.ts")), import(join(SERVICE, "src/core/ProviderInstantiate.ts")),
    ]);
    // Two declared aliases, each a fixture provider with its configured effort and `low` to choose.
    const aliases = ["first", "second"].map((name) => ({ alias: `${name}-${crypto.randomUUID()}`, provider: "openai", model: `${name}-model` }));
    for (const spec of aliases) {
        const key = `PLURNK_MODEL_${spec.alias}`;
        const prior = process.env[key];
        process.env[key] = `${spec.provider}/${spec.model}`;
        t.after(() => { if (prior === undefined) delete process.env[key]; else process.env[key] = prior; });
        const fixture = new Mock({ contextWindow: 16_384, responses: [] });
        ProviderInstantiate.registerInstance(fixture, spec);
        ProviderInstantiate.registerInstance(fixture, spec, process.env, "low");
    }
    const db = await openTestDatabase();
    const http = await bindListener();
    const daemon = new Daemon({ db, http, nodeModulesPath: join(SERVICE, "node_modules"), provider: null });
    const agents: HttpAgent[] = [];
    t.after(async () => {
        for (const agent of agents) agent.abortRun();
        await daemon.stop();
        await http.close();
        await db.close();
    });
    await daemon.start();
    const { workspaceId } = await daemon.createWorkspace({ name: "policy" });
    const { workerId } = await daemon.createWorker({ workspaceId, name: "main" });
    await daemon.setWorkerModel({ workspaceId, workerId, selector: aliases[0].alias });
    const { host, port } = http.httpAddress();
    const url = `http://${host}:${port}/acp`;
    const forwardedProps = { plurnk: { workspace: "policy" } };
    const observe = async () => {
        const agent = new Observer({ url: `${url}/connect`, threadId: "main" });
        agents.push(agent);
        const watched = watch();
        void agent.connectAgent({ forwardedProps }, watched.subscriber);
        await until("the snapshot", () => watched.model() !== undefined);
        return watched;
    };
    // A management Run of another view on the same thread: its last frame.
    const act = async (action: Record<string, unknown>): Promise<{ type: string }> => {
        const response = await fetch(url, {
            method: "POST", headers: { "content-type": "application/json" },
            body: JSON.stringify({ threadId: "main", runId: crypto.randomUUID(), state: {}, messages: [], tools: [], context: [],
                forwardedProps: { plurnk: { ...forwardedProps.plurnk, action } } }),
        });
        const frames = (await response.text()).split("\n\n").filter((frame) => frame.startsWith("data: "))
            .map((frame) => JSON.parse(frame.slice(6)) as { type: string });
        const last = frames.at(-1);
        assert.ok(last !== undefined, "the management Run answers");
        return last;
    };
    const read = async (): Promise<ModelRoute | null> => (await daemon.readWorkerModel({ workspaceId, workerId })).model;

    const attached = await observe();
    assert.deepEqual(attached.model(), await read(), "the snapshot carries the worker's route");
    assert.equal(attached.model()?.effortSource, "default");

    assert.equal((await act({ kind: "worker.effort.set", effort: "low" })).type, "RUN_FINISHED", "the effort is set");
    await until("the attached client to hold the new effort", () => attached.model()?.effort === "low");
    assert.deepEqual(attached.model(), await read(), "it holds the route as the daemon reads it, the effort now explicit");
    assert.equal(attached.model()?.effortSource, "explicit");

    assert.equal((await act({ kind: "worker.model.set", selector: aliases[1].alias })).type, "RUN_FINISHED", "the model is set");
    await until("the attached client to hold the new model", () => attached.model()?.alias === aliases[1].alias);
    assert.deepEqual(attached.model(), await read(), "and the new model, the chosen effort carried with it");

    const fresh = await observe();
    assert.deepEqual(fresh.model(), attached.model(), "a client attaching afterward reads the same route");
});
