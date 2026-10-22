// {§agui-overview} — through the official HttpAgent against the real daemon: the overview of the daemon's places is one
// snapshot, a connected observer follows what a finished reply, a running loop and a rename change, and observing creates,
// binds and claims nothing.
import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";
import { HttpAgent } from "@ag-ui/client";
import type { RunAgentInput } from "@ag-ui/core";
import { bindListener, openTestDatabase, SERVICE } from "./_helpers.ts";

// HttpAgent leaves AbstractAgent's connect() to its subclasses: a standing observer is the official client's own run
// pipeline pointed at /agui/connect.
class Observer extends HttpAgent {
    override connect(input: RunAgentInput) { return super.run(input); }
}

interface Reply { id: number; coordinate: string; completion: number; at: number; excerpt: string; continued: boolean; body: { url: string; mimeType: string } }
interface Place { workspaceId: number; id: number; name: string; parentWorkerId: number | null; kind: string; lifecycle: string; gates: number; reply: Reply | null }
interface OverviewState {
    scope: { workspaceId: number | null };
    workspaces: Record<string, { id: number; name: string; projectRoot: string | null; projectLabel: string | null }>;
    workers: Record<string, Place>;
    recent: number[];
    omitted: number;
}
const overviewOf = (agent: HttpAgent): OverviewState | undefined => (agent.state as { plurnk?: { overview?: OverviewState } }).plurnk?.overview;

// A provider whose calls answer in order; a call that holds waits for its release before it answers.
const scripted = async (script: ReadonlyArray<{ readonly dsl: string; readonly hold?: Promise<void> }>) => {
    const { AiSdkProvider } = await import("@plurnk/plurnk-providers");
    let calls = 0;
    const provider = new AiSdkProvider({
        model: "overview-witness", url: "https://example.test/v1/chat/completions",
        contextWindow: 1_000_000, streaming: true, fetchTimeoutMs: 30_000, operationTimeoutMs: 30_000,
        temperature: null, repeatPenalty: null, effort: { mode: "adaptive", budget: null }, retryAttempts: 0,
        fetch: async () => {
            const step = script[calls] ?? { dsl: "````SEND [200]\nDone.\n````" };
            calls++;
            const frame = (delta: object, finish: string | null = null) => `data: ${JSON.stringify({ id: `overview-${calls}`, model: "overview-witness",
                choices: [{ index: 0, delta, finish_reason: finish }], ...(finish === null ? {} : { usage: { prompt_tokens: 50, completion_tokens: 10, total_tokens: 60 } }) })}\n\n`;
            return new Response(new ReadableStream<Uint8Array>({
                async start(controller) {
                    await step.hold;
                    controller.enqueue(new TextEncoder().encode(frame({ content: step.dsl }, "stop")));
                    controller.enqueue(new TextEncoder().encode("data: [DONE]\n\n"));
                    controller.close();
                },
            }), { headers: { "content-type": "text/event-stream" } });
        },
    });
    return { provider, calls: () => calls };
};

const boot = async (t: { after(fn: () => Promise<void> | void): void }, provider: unknown) => {
    await import(join(SERVICE, "test/setup.ts"));
    const { default: Daemon } = await import(join(SERVICE, "src/server/Daemon.ts"));
    const db = await openTestDatabase();
    const http = await bindListener();
    const daemon = new Daemon({ db, http, provider, nodeModulesPath: join(SERVICE, "node_modules") });
    let stopped = false;
    const stop = async () => {
        if (stopped) return;
        stopped = true;
        await daemon.stop();
        await http.close();
        await db.close();
    };
    t.after(stop);
    await daemon.start();
    const { host, port } = http.httpAddress();
    return { daemon, url: `http://${host}:${port}/agui`, stop };
};

const until = async (what: string, ready: () => boolean): Promise<void> => {
    for (const deadline = Date.now() + 20_000; !ready();) {
        if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
        await new Promise((resolve) => setTimeout(resolve, 20));
    }
};

test("{§agui-overview-run} {§agui-overview-state} {§agui-overview-updates} the official client reads the overview's snapshot and follows a finished reply, a running loop and a rename", { timeout: 120_000 }, async (t) => {
    const second = Promise.withResolvers<void>();
    const { provider, calls } = await scripted([
        { dsl: "````SEND [200]\nFirst answer.\nWith more.\n````" },
        { dsl: "````SEND [200]\nSecond answer.\n````", hold: second.promise },
    ]);
    t.after(() => second.resolve());
    const { daemon, url } = await boot(t, provider);
    const submitter = new HttpAgent({ url, threadId: "main" });
    t.after(() => submitter.abortRun());
    submitter.messages = [{ id: "q1", role: "user", content: "Question one." }];
    await submitter.runAgent({ forwardedProps: { plurnk: { workspace: "overview", control: true } } });

    const directory = async () => ({ workspaces: (await daemon.listWorkspaces()).length,
        workers: (await Promise.all((await daemon.listWorkspaces()).map(({ id }: { id: number }) => daemon.listWorkers(id)))).flat().length });
    const before = await directory();

    // A Run on /agui is the snapshot, then RUN_FINISHED.
    const reader = new HttpAgent({ url, threadId: "overview-reader" });
    const types: string[] = [];
    await reader.runAgent({ forwardedProps: { plurnk: { overview: {} } } }, { onEvent: ({ event }) => { types.push(event.type); } });
    assert.deepEqual(types, ["RUN_STARTED", "STATE_SNAPSHOT", "RUN_FINISHED"], "one snapshot, nothing else");
    const snapshot = overviewOf(reader);
    assert.ok(snapshot !== undefined, "the state carries the overview");
    const main = Object.values(snapshot.workers).find(({ name }) => name === "main");
    assert.ok(main !== undefined, "the worker is a place");
    assert.deepEqual([main.lifecycle, main.gates, main.parentWorkerId, main.kind], ["completed", 0, null, "root"]);
    assert.deepEqual([main.reply?.completion, main.reply?.excerpt, main.reply?.continued], [200, "First answer.", true], "its latest finished reply, by excerpt");
    assert.deepEqual([snapshot.scope, snapshot.recent, snapshot.omitted], [{ workspaceId: null }, [main.id], 0]);
    assert.equal(snapshot.workspaces[String(main.workspaceId)]?.name, "overview", "with the workspace it belongs to");
    const body = await fetch(main.reply?.body.url ?? "");
    assert.equal(body.status, 200);
    assert.equal(await body.text(), "First answer.\nWith more.", "the whole reply is one read away");
    assert.match(body.headers.get("content-type") ?? "", new RegExp(`^${main.reply?.body.mimeType ?? "?"}`, "u"), "of the type the reference names");
    assert.deepEqual(await directory(), before, "reading the overview created no workspace and no worker");

    // A connected observer: the snapshot, then what changes.
    const observer = new Observer({ url: `${url}/connect`, threadId: "overview-observer" });
    t.after(() => observer.abortRun());
    const seen: OverviewState[] = [];
    let started = false;
    void observer.connectAgent({ forwardedProps: { plurnk: { overview: { workspaceId: main.workspaceId } } } }, {
        onRunStartedEvent: () => { started = true; },
        onStateChanged: () => { const state = overviewOf(observer); if (state !== undefined) seen.push(structuredClone(state)); },
    }).catch(() => undefined);
    await until("the observer's snapshot", () => started && overviewOf(observer) !== undefined);
    assert.deepEqual(overviewOf(observer)?.scope, { workspaceId: main.workspaceId }, "scoped to the workspace");

    submitter.messages = [...submitter.messages, { id: "q2", role: "user", content: "Question two." }];
    const answering = submitter.runAgent({ forwardedProps: { plurnk: { workspace: "overview", control: true } } });
    await until("the running loop", () => overviewOf(observer)?.workers[String(main.id)]?.lifecycle === "running");
    assert.equal(overviewOf(observer)?.workers[String(main.id)]?.reply?.excerpt, "First answer.", "a running loop leaves the latest finished reply as it was");
    second.resolve();
    await answering;
    await until("the second reply", () => overviewOf(observer)?.workers[String(main.id)]?.reply?.excerpt === "Second answer.");
    const answered = overviewOf(observer)?.workers[String(main.id)];
    assert.ok((answered?.reply?.id ?? 0) > (main.reply?.id ?? 0), "a newer finished reply replaces it");
    assert.equal(calls(), 2, "observing ran no inference");

    await daemon.renameWorkspace(main.workspaceId, "overview-renamed");
    await until("the rename", () => overviewOf(observer)?.workspaces[String(main.workspaceId)]?.name === "overview-renamed");
    assert.ok(seen.length >= 3, "the observer received deltas, not only its snapshot");
    assert.deepEqual(await directory(), before, "observing created no workspace and no worker");
});

test("{§agui-overview-run} an overview beside another request, a malformed scope and an unknown workspace are refused", { timeout: 60_000 }, async (t) => {
    const { provider } = await scripted([]);
    const { url } = await boot(t, provider);
    const post = async (plurnk: Record<string, unknown>, endpoint = url) => {
        const response = await fetch(endpoint, { method: "POST", headers: { "content-type": "application/json", accept: "text/event-stream" },
            body: JSON.stringify({ threadId: "refused", runId: "refused", state: {}, messages: [], tools: [], context: [], forwardedProps: { plurnk } }) });
        return { status: response.status, type: response.status === 200 ? "" : (await response.json() as { type: string }).type };
    };
    for (const overview of [{ workspaceId: 0 }, { workspaceId: "1" }, { other: 1 }, [], "all"]) {
        const refused = await post({ overview });
        assert.equal(refused.status, 400, JSON.stringify(overview));
        assert.match(refused.type, /\/overview-invalid$/u, JSON.stringify(overview));
    }
    const both = await post({ overview: {}, action: { kind: "workspace.list" } });
    assert.deepEqual([both.status, both.type.split("/").at(-1)], [400, "ambiguous-run-input"], "a Run does one thing");
    const unknown = await post({ overview: { workspaceId: 9_999 } }, `${url}/connect`);
    assert.deepEqual([unknown.status, unknown.type.split("/").at(-1)], [404, "workspace-not-found"], "the daemon's refusal, before anything is streamed");
});

test("{§agui-overview-run} {§agui-shutdown} the daemon stopping ends a connected observation with service-stopping", { timeout: 60_000 }, async (t) => {
    const { provider } = await scripted([]);
    const { url, stop } = await boot(t, provider);
    const response = await fetch(`${url}/connect`, { method: "POST", headers: { "content-type": "application/json", accept: "text/event-stream" },
        body: JSON.stringify({ threadId: "stopping", runId: "stopping", state: {}, messages: [], tools: [], context: [], forwardedProps: { plurnk: { overview: {} } } }) });
    assert.equal(response.status, 200);
    const reader = response.body!.getReader();
    let text = "";
    const read = async (pattern: RegExp) => {
        while (!pattern.test(text)) {
            const { value, done } = await reader.read();
            if (done) break;
            text += new TextDecoder().decode(value);
        }
    };
    await read(/STATE_SNAPSHOT/u);
    const stopping = stop();
    await read(/RUN_ERROR/u);
    await stopping;
    assert.match(text, /"type":"RUN_ERROR"[^\n]*service-stopping/u, "the observation ends as every Run does at shutdown");
});
