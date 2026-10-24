// {§acp-status-descendants} — the bound Worker's tree rides its status gauge as the daemon states it: empty in the
// Run's opening snapshot, the child once the model's WORK spawned it, the gate it waits on in the snapshot of the Run
// that answers it, the gate settled while that Run watches, and the child concluded for the next observer; each change
// published once, replaced whole.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Mock } from "@plurnk/plurnk-providers";
import type { AcpDescendant } from "../../src/AcpPlus.ts";
import type { AcpEvent } from "../../src/types.ts";
import { bindListener, openTestDatabase, SERVICE } from "./_helpers.ts";

type Delta = { readonly op: string; readonly path: string; readonly value: unknown };
type Gauge = { readonly snapshot?: { readonly plurnk?: { readonly status?: { readonly descendants?: unknown } } } };

// The tree a Run's snapshot states, each tree it republished in order, and the tree each whole-gauge replacement carried.
const trees = (events: readonly AcpEvent[]): { snapshot: unknown; published: unknown[]; replacements: unknown[] } => {
    const deltas = events.filter(({ type }) => type === "STATE_DELTA").flatMap((event) => (event as { delta: Delta[] }).delta);
    return {
        snapshot: (events.find(({ type }) => type === "STATE_SNAPSHOT") as Gauge | undefined)?.snapshot?.plurnk?.status?.descendants,
        published: deltas.filter(({ path }) => path === "/plurnk/status/descendants").map(({ value }) => value),
        replacements: deltas.filter(({ path }) => path === "/plurnk/status").map(({ value }) => (value as { descendants?: unknown }).descendants),
    };
};

test("{§acp-status-descendants} the gauge states the tree: empty, the spawned child, its gate, the gate settled, the child concluded", { timeout: 60_000 }, async (t) => {
    await import(join(SERVICE, "test/setup.ts"));
    const [{ default: Daemon }, { makeMockResponse }] = await Promise.all([
        import(join(SERVICE, "src/server/Daemon.ts")), import(join(SERVICE, "test/intg/_mock.ts")),
    ]);
    const provider = new Mock({ contextWindow: 32768, responses: [
        makeMockResponse("````WORK (worker://counter)\nCreate count.txt, then reply with the number 3.\n````\n````WAIT\nWaiting for counter.\n````", 10),
        makeMockResponse("````EDIT (count.txt)\n3\n````\n````NOTE\nConfirming the write.\n````", 10),
        makeMockResponse("````SEND [200]\n3\n````", 10),
        makeMockResponse("````SEND [200]\nThe child answered 3.\n````", 10),
    ] });
    // The child's two calls are held until the tree the test is about has reached the watching Run.
    const generate = provider.generate.bind(provider);
    const holds = new Map([2, 3].map((call) => [call, Promise.withResolvers<void>()]));
    let calls = 0;
    t.mock.method(provider, "generate", async (...args: Parameters<Mock["generate"]>) => {
        await holds.get(++calls)?.promise;
        return generate(...args);
    });
    const db = await openTestDatabase();
    const root = await mkdtemp(join(tmpdir(), "plurnk-status-descendants-"));
    const http = await bindListener();
    const daemon = new Daemon({ db, provider, http, nodeModulesPath: join(SERVICE, "node_modules") });
    const cancellation = new AbortController();
    t.after(async () => {
        cancellation.abort();
        for (const hold of holds.values()) hold.resolve();
        await daemon.stop();
        await http.close();
        await db.close();
        await rm(root, { recursive: true, force: true });
    });
    await daemon.start();
    const url = `http://127.0.0.1:${http.httpAddress().port}/acp`;
    // One Run of the thread: the events received so far, a wait for those that satisfy a condition, and all of them.
    const start = (input: Record<string, unknown>) => {
        const events: AcpEvent[] = [];
        const waits: Array<{ condition: (events: AcpEvent[]) => boolean; resolve: () => void }> = [];
        const check = (): void => {
            for (const wait of waits.splice(0)) {
                if (wait.condition(events)) wait.resolve();
                else waits.push(wait);
            }
        };
        const done = (async (): Promise<AcpEvent[]> => {
            const response = await fetch(url, {
                method: "POST", headers: { "content-type": "application/json" }, signal: cancellation.signal,
                body: JSON.stringify({ threadId: "tree", runId: crypto.randomUUID(), state: {}, messages: [], tools: [], context: [],
                    forwardedProps: { plurnk: { workspace: "tree" } }, ...input }),
            });
            assert.equal(response.status, 200);
            const reader = response.body!.getReader();
            const decoder = new TextDecoder();
            let buffer = "";
            for (;;) {
                const { done: ended, value } = await reader.read();
                if (ended) return events;
                buffer += decoder.decode(value, { stream: true });
                const frames = buffer.split("\n\n");
                buffer = frames.pop() ?? "";
                for (const frame of frames) if (frame.startsWith("data: ")) events.push(JSON.parse(frame.slice(6)) as AcpEvent);
                check();
            }
        })();
        const until = (condition: (events: AcpEvent[]) => boolean): Promise<void> => {
            const reached = Promise.withResolvers<void>();
            waits.push({ condition, resolve: reached.resolve });
            check();
            return reached.promise;
        };
        return { events, until, done };
    };
    const publishes = (tree: readonly AcpDescendant[]) => (events: AcpEvent[]): boolean =>
        trees(events).published.some((published) => JSON.stringify(published) === JSON.stringify(tree));

    const { workspaceId } = await daemon.createWorkspace({ name: "tree", projectRoot: root });
    const first = start({ messages: [{ id: "message-1", role: "user", content: "Delegate the count." }] });
    await first.until((events) => trees(events).published.length > 0);
    const [main, child] = await Promise.all(["tree", "counter"].map((name) => daemon.readWorker({ workspaceId, identity: { name } })));
    assert.ok(main && child, "the WORK spawned the child the tree states");
    const node = (lifecycle: AcpDescendant["lifecycle"], gates: number): AcpDescendant =>
        ({ id: child.id, name: "counter", parentWorkerId: main.id, kind: "work", lifecycle, gates });
    await first.until(publishes([node("running", 0)]));
    holds.get(2)!.resolve();
    const interrupted = await first.done;
    const terminal = interrupted.at(-1) as { type?: string; outcome?: { type?: string; interrupts?: Array<{ id: string }> } } | undefined;
    assert.equal(terminal?.type, "RUN_FINISHED");
    assert.equal(terminal?.outcome?.type, "interrupt", "the child's gate reaches the owning thread");
    assert.deepEqual(trees(interrupted).snapshot, [], "the opening snapshot states an empty tree");

    const answering = start({ resume: [{ interruptId: terminal.outcome.interrupts![0].id, status: "resolved", payload: { decision: "accept" } }] });
    await answering.until((events) => events.some(({ type }) => type === "STATE_SNAPSHOT"));
    assert.deepEqual(trees(answering.events).snapshot, [node("running", 1)], "the Run that answers the gate opens on the child waiting on it");
    await answering.until(publishes([node("running", 0)]));
    holds.get(3)!.resolve();
    const answered = await answering.done;
    assert.equal(answered.at(-1)?.type, "RUN_FINISHED");
    assert.equal((answered.at(-1) as { outcome?: { type?: string } }).outcome?.type, "success");
    assert.deepEqual(trees(await start({}).done).snapshot, [node("completed", 0)], "the next observer finds the child concluded");

    for (const events of [interrupted, answered]) {
        const run = trees(events);
        const sequence = [run.snapshot, ...run.published].map((tree) => JSON.stringify(tree));
        assert.ok(sequence.every((tree, index) => index === 0 || tree !== sequence[index - 1]), `each change published once: ${sequence.join(" → ")}`);
        assert.ok(run.replacements.every((tree) => Array.isArray(tree)), "a whole-gauge replacement carries the tree too");
    }
});
