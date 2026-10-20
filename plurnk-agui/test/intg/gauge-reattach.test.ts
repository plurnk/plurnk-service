// {§agui-state-patches} {§methods-worker-gauge} — the budget a Run's snapshot carries is the one the bound Worker's
// latest concluded loop reported, so a live, a late and a reattached observer of the same Worker agree: before its first
// conclusion, after each of two consecutive loops, and while a later loop's call is under way.
import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";
import { Mock } from "@plurnk/plurnk-providers";
import type { AguiEvent } from "../../src/types.ts";
import { NO_GAUGE } from "../accounting-fixture.ts";
import { replayState } from "../state-replay.ts";
import { bindListener, openTestDatabase, SERVICE } from "./_helpers.ts";

type Budget = { curationWeight: number | null; curationBudget: number | null; contextTokens: number | null; contextCapacity: number | null };

test("{§agui-state-patches}: live, late and reattached observers hold the budget the latest conclusion reported", { timeout: 60_000 }, async (t) => {
    await import(join(SERVICE, "test/setup.ts"));
    const [{ default: Daemon }, { makeMockResponse }] = await Promise.all([
        import(join(SERVICE, "src/server/Daemon.ts")), import(join(SERVICE, "test/intg/_mock.ts")),
    ]);
    const provider = new Mock({ contextWindow: 32768, responses: [
        makeMockResponse("````SEND [200]\nThe first answer.\n````"), makeMockResponse("````SEND [200]\nThe second answer.\n````"),
    ] });
    // The second loop's call is held while an observer attaches.
    const generate = provider.generate.bind(provider);
    let holdNext = false;
    const held = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    t.mock.method(provider, "generate", async (...args: Parameters<Mock["generate"]>) => {
        if (holdNext) {
            holdNext = false;
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
    // One Run of the thread, read until it finishes, or until `enough` holds, when this observer disconnects.
    const run = async (input: Record<string, unknown>, enough?: (events: AguiEvent[]) => boolean): Promise<AguiEvent[]> => {
        const observer = new AbortController();
        const response = await fetch(url, {
            method: "POST", headers: { "content-type": "application/json" }, signal: AbortSignal.any([observer.signal, cancellation.signal]),
            body: JSON.stringify({ threadId: "gauge", runId: crypto.randomUUID(), state: {}, messages: [], tools: [], context: [],
                forwardedProps: { plurnk: { workspace: "gauge-reattach", control: true } }, ...input }),
        });
        assert.equal(response.status, 200);
        const reader = response.body!.getReader();
        const decoder = new TextDecoder();
        const events: AguiEvent[] = [];
        let buffer = "";
        try {
            for (;;) {
                const { done, value } = await reader.read();
                if (done) return events;
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
    };
    const budget = (events: AguiEvent[]): Budget => (replayState(events) as { budget: Budget }).budget;
    const snapshotted = (events: AguiEvent[]): boolean => events.some(({ type }) => type === "STATE_SNAPSHOT");
    const ask = (content: string) => ({ messages: [{ id: crypto.randomUUID(), role: "user", content }] });

    assert.deepEqual(budget(await run({})), NO_GAUGE, "a Worker that has not concluded a loop reports no gauge");

    const first = await run(ask("Answer once."));
    assert.equal(first.at(-1)?.type, "RUN_FINISHED");
    const reported = budget(first);
    assert.ok(reported.curationWeight !== null && reported.curationWeight > 0, "the first conclusion reported its packet's weight");
    assert.deepEqual(budget(await run({})), reported, "a late observer holds the gauge the live Run received");

    holdNext = true;
    const second = run(ask("Answer again."));
    await held.promise;
    assert.deepEqual(budget(await run({}, snapshotted)), reported, "an observer attaching mid-call holds the latest conclusion's gauge");
    release.resolve();
    const live = await second;
    assert.equal(live.at(-1)?.type, "RUN_FINISHED");
    assert.deepEqual(budget(live.slice(0, live.findIndex(({ type }) => type === "STATE_SNAPSHOT") + 1)), reported,
        "the next Run starts from the gauge its client already held");
    const next = budget(live);
    assert.notDeepEqual(next, reported, "the second conclusion reported a gauge of its own");
    assert.deepEqual(budget(await run({})), next, "a reattached observer holds the gauge of the conclusion that followed");
});
