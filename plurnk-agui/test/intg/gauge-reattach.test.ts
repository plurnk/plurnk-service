// {§agui-state-patches} {§methods-worker-gauge} — the budget moves with each of the bound Worker's packets, and a Run's
// snapshot carries the one its latest packet reported, so a live, a late and a reattached observer of the same Worker
// agree: before its first packet, after a loop concludes, midway through a working loop, and after the loop that follows.
import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";
import { Mock } from "@plurnk/plurnk-providers";
import type { AguiEvent } from "../../src/types.ts";
import { NO_GAUGE } from "../accounting-fixture.ts";
import { replayState } from "../state-replay.ts";
import { bindListener, openTestDatabase, SERVICE } from "./_helpers.ts";

type Budget = { curationWeight: number | null; curationBudget: number | null; contextTokens: number | null; contextCapacity: number | null };

test("{§agui-state-patches}: live, late and reattached observers hold the budget the latest packet reported", { timeout: 60_000 }, async (t) => {
    await import(join(SERVICE, "test/setup.ts"));
    const [{ default: Daemon }, { makeMockResponse }] = await Promise.all([
        import(join(SERVICE, "src/server/Daemon.ts")), import(join(SERVICE, "test/intg/_mock.ts")),
    ]);
    const provider = new Mock({ contextWindow: 32768, responses: [
        makeMockResponse("````SEND [200]\nThe first answer.\n````"),
        makeMockResponse("````NOTE\nWorking on the second.\n````"),
        makeMockResponse("````SEND [200]\nThe second answer.\n````"),
    ] });
    // The second loop's second call is held while an observer attaches.
    const generate = provider.generate.bind(provider);
    let calls = 0;
    const held = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    t.mock.method(provider, "generate", async (...args: Parameters<Mock["generate"]>) => {
        if (++calls === 3) {
            held.resolve();
            await release.promise;
        }
        return generate(...args);
    });
    const db = await openTestDatabase();
    const http = await bindListener();
    const daemon = new Daemon({ db, http, provider, nodeModulesPath: join(SERVICE, "node_modules") });
    const cancellation = new AbortController();
    t.after(async () => {
        cancellation.abort();
        release.resolve();
        await daemon.stop();
        await http.close();
        await db.close();
    });
    await daemon.start();
    const url = `http://127.0.0.1:${http.httpAddress().port}/agui`;
    // One Run of the thread: the events received so far, and all of them once it finishes, or once `enough` holds,
    // when this observer disconnects.
    const start = (input: Record<string, unknown>, enough?: (events: AguiEvent[]) => boolean): { events: AguiEvent[]; done: Promise<AguiEvent[]> } => {
        const events: AguiEvent[] = [];
        const done = (async (): Promise<AguiEvent[]> => {
            const observer = new AbortController();
            const response = await fetch(url, {
                method: "POST", headers: { "content-type": "application/json" }, signal: AbortSignal.any([observer.signal, cancellation.signal]),
                body: JSON.stringify({ threadId: "gauge", runId: crypto.randomUUID(), state: {}, messages: [], tools: [], context: [],
                    forwardedProps: { plurnk: { workspace: "gauge-reattach", control: true } }, ...input }),
            });
            assert.equal(response.status, 200);
            const reader = response.body!.getReader();
            const decoder = new TextDecoder();
            let buffer = "";
            try {
                for (;;) {
                    const { done: ended, value } = await reader.read();
                    if (ended) return events;
                    buffer += decoder.decode(value, { stream: true });
                    const frames = buffer.split("\n\n");
                    buffer = frames.pop() ?? "";
                    for (const frame of frames) if (frame.startsWith("data: ")) events.push(JSON.parse(frame.slice(6)) as AguiEvent);
                    if (enough?.(events) === true) {
                        observer.abort();
                        return events;
                    }
                }
            } catch (cause) {
                if (observer.signal.aborted) return events;
                throw cause;
            }
        })();
        return { events, done };
    };
    const run = (input: Record<string, unknown>, enough?: (events: AguiEvent[]) => boolean): Promise<AguiEvent[]> => start(input, enough).done;
    const budget = (events: AguiEvent[]): Budget => (replayState(events) as { budget: Budget }).budget;
    const snapshotted = (events: AguiEvent[]): boolean => events.some(({ type }) => type === "STATE_SNAPSHOT");
    const ask = (content: string) => ({ messages: [{ id: crypto.randomUUID(), role: "user", content }] });

    assert.deepEqual(budget(await run({})), NO_GAUGE, "a Worker without a packet reports no gauge");

    const first = await run(ask("Answer once."));
    assert.equal(first.at(-1)?.type, "RUN_FINISHED");
    const reported = budget(first);
    assert.ok(reported.curationWeight !== null && reported.curationWeight > 0, "the first loop's packet reported its weight");
    assert.deepEqual(budget(await run({})), reported, "a late observer holds the gauge the live Run received");

    const second = start(ask("Work on it, then answer."));
    await held.promise;
    const midway = budget(await run({}, snapshotted));
    assert.notDeepEqual(midway, reported, "the working loop's first turn moved the gauge before the loop ends");
    assert.deepEqual(budget(second.events), midway, "a live and a reattached observer agree midway through the loop");
    release.resolve();
    const live = await second.done;
    assert.equal(live.at(-1)?.type, "RUN_FINISHED");
    assert.deepEqual(budget(live.slice(0, live.findIndex(({ type }) => type === "STATE_SNAPSHOT") + 1)), reported,
        "the next Run starts from the gauge its client already held");
    const next = budget(live);
    assert.notDeepEqual(next, midway, "its last turn reported a gauge of its own");
    assert.deepEqual(budget(await run({})), next, "a reattached observer holds the gauge of the latest packet");
});
