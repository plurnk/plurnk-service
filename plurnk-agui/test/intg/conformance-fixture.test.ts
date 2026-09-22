import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { HttpAgent } from "@ag-ui/client";
import { EventType, type RunErrorEvent } from "@ag-ui/core";
import type { AguiEvent } from "../../src/types.ts";
import { replayState } from "../state-replay.ts";
import type { ApplicationPort } from "@plurnk/plurnk-contracts";
import Module from "../../src/Module.ts";
import { openTestDatabase, SERVICE } from "./_helpers.ts";

test("{§agui-official-client-conformance} the official client accepts a real daemon run without paid inference", { timeout: 60_000 }, async (t) => {
    await import(join(SERVICE, "test/setup.ts"));
    const { startClientJourneyModel } = await import(join(SERVICE, "../scripts/fixtures/client-journey-model.mjs"));
    const { default: ProviderInstantiate } = await import(join(SERVICE, "src/core/ProviderInstantiate.ts"));
    const { default: Daemon } = await import(join(SERVICE, "src/server/Daemon.ts"));
    const fixture = await startClientJourneyModel();
    t.after(() => fixture.close());
    const previous = { ...process.env };
    Object.assign(process.env, fixture.env);
    t.after(() => {
        for (const name of Object.keys(fixture.env)) {
            if (previous[name] === undefined) delete process.env[name];
            else process.env[name] = previous[name];
        }
    });
    const db = await openTestDatabase();
    const sandbox = await mkdtemp(join(tmpdir(), "agui-official-fixture-"));
    const provider = await ProviderInstantiate.loadActiveProvider();
    assert.ok(provider);
    const daemon = new Daemon({ db, provider, nodeModulesPath: join(SERVICE, "node_modules") });
    const started = Promise.withResolvers<Module>();
    const registration = Module.init({ host: "127.0.0.1", port: 0 });
    daemon.registerModule({
        start: async (seam: ApplicationPort) => {
            const module = await registration.start(seam);
            started.resolve(module);
            return module;
        },
    });
    try {
        await daemon.start();
        const { host, port } = (await started.promise).address();
        const agent = new HttpAgent({ url: `http://${host}:${port}/`, threadId: "official-client" });
        agent.messages = [{ id: "m1", role: "user", content: "Exercise the installed one-shot interface." }];
        const events: AguiEvent[] = [];
        const errors: Error[] = [];
        const reasoning: string[] = [];
        let outcome: string | undefined;
        await agent.runAgent({
            forwardedProps: { plurnk: { workspace: "official-client", projectRoot: sandbox, maxTurns: 3 } },
        }, {
            onEvent: ({ event }) => { events.push(event as AguiEvent); },
            onRunFailed: ({ error }) => { errors.push(error); },
            onReasoningMessageContentEvent: ({ event }) => { reasoning.push(event.delta); },
            onRunFinishedEvent: (event) => { outcome = event.outcome; },
        });
        assert.equal(errors.length, 0, "the official verifier and transport report no errors");
        const types = events.map(({ type }) => type);
        assert.equal(types[0], "RUN_STARTED");
        assert.equal(types.at(-1), "RUN_FINISHED");
        assert.equal(outcome, "success");
        assert.deepEqual(replayState(events), agent.state, "RFC 6902 replay agrees with the official client's reducer");
        assert.equal(reasoning.join(""), "I will complete the installed one-shot request through the shared protocol.");
        assert.equal(types.includes(EventType.RUN_ERROR), false);
        for (const type of [EventType.STATE_SNAPSHOT, EventType.TEXT_MESSAGE_START, EventType.TEXT_MESSAGE_CONTENT, EventType.TEXT_MESSAGE_END, EventType.REASONING_MESSAGE_CONTENT]) {
            assert.ok(types.includes(type), `${type} traverses the official client's validator`);
        }
        const reply = agent.messages.findLast(({ role }) => role === "assistant");
        assert.ok(reply);
        assert.equal(reply.content, "The installed one-shot journey is complete.");
        assert.equal(agent.messages.some(({ role }) => role === "activity"), false, "lifecycle verbs do not invent an ACP Plan");
        const rows = events.filter((event) => event.type === EventType.CUSTOM && (event as { name?: string }).name === "plurnk.row")
            .map((event) => (event as unknown as { value: { op: string; origin: string } }).value);
        assert.ok(rows.some(({ op, origin }) => op === "NOTE" && origin === "_plurnk"), "the initialization note remains an ordinary operation");
        assert.deepEqual(rows.filter(({ origin }) => origin === "model").map(({ op }) => op), ["KILL"], "the authored completion carries the answer without a synthetic operation");
        assert.equal(fixture.requests.length, 1, "one actual inference request completes the run");
        assert.equal(fixture.requests[0].journey, "cli");

        const rejected = new HttpAgent({ url: `http://${host}:${port}/`, threadId: "official-rejected" });
        rejected.messages = [{ id: "rejected", role: "user", content: "Exercise the rejected provider request." }];
        const problems: RunErrorEvent[] = [];
        const failedTypes: EventType[] = [];
        await rejected.runAgent({
            forwardedProps: { plurnk: { workspace: "official-rejected", projectRoot: sandbox, maxTurns: 3 } },
        }, {
            onEvent: ({ event }) => { failedTypes.push(event.type); },
            onRunErrorEvent: ({ event }) => { problems.push(event); },
            onRunFailed: ({ error }) => { errors.push(error); },
        });
        assert.equal(errors.length, 0, "a provider refusal is a valid protocol outcome, not a verifier failure");
        assert.equal(failedTypes[0], EventType.RUN_STARTED);
        assert.equal(failedTypes.at(-1), EventType.RUN_ERROR);
        assert.equal(failedTypes.includes(EventType.RUN_FINISHED), false);
        assert.equal(problems.length, 1);
        assert.match(problems[0].message, /The requested model is unavailable; select an available model\./u);
        assert.deepEqual(fixture.requests.map(({ journey }: { journey: string }) => journey), ["cli", "rejected"], "the provider refusal is not retried");
    } finally {
        await daemon.stop();
        await db.close();
        await rm(sandbox, { recursive: true, force: true });
    }
});
