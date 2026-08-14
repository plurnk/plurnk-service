// {§attribution}

import test from "node:test";
import assert from "node:assert/strict";
import Engine from "../../src/core/Engine.ts";
import ExecutorRegistry from "../../src/core/ExecutorRegistry.ts";
import SchemeRegistry from "../../src/core/SchemeRegistry.ts";
import { Mimetypes, emptyRegistry } from "@plurnk/plurnk-mimetypes";
import { Mock } from "@plurnk/plurnk-providers";
import type { MockResponse } from "@plurnk/plurnk-providers";
import type { PluginAttributionContext } from "@plurnk/plurnk-meta";
import { openMigrated, insertWorkspace, insertWorker, insertLoop } from "./_helpers.ts";

const response = (content: string): MockResponse => ({
    assistant: {
        content,
        reasoning: null,
    },
    assistantRaw: null,
});

const invalid = response("unframed prose");
const valid = response("# PLAN0\nfinish\n\n## SEND0 [200]\ndone");
const canonical = (...tags: string[]): string[] => [...new Set(tags)].toSorted();

test("each emission attempt composes opaque family hooks and records exactly what was forwarded", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `attr-${crypto.randomUUID()}`);
        const workerId = await insertWorker(db, workspaceId);
        const workerIdentity = await db.test_workers_get_provider_identity.get<{ provider_identity: string }>({ id: workerId });
        const loopId = await insertLoop(db, workerId, 1, "go");
        const contexts: PluginAttributionContext[] = [];

        const schemes = new SchemeRegistry();
        schemes.attributions = ({ attempt }) => ["shared", `scheme:${attempt}`];
        const executors = new ExecutorRegistry(new Map());
        executors.attributions = ({ attempt }) => ["shared", `executor:${attempt}`];
        const mimetypes = new Mimetypes({
            discovery: { registry: emptyRegistry(), handlers: new Map(), skipped: [] },
        });
        mimetypes.attributions = async ({ attempt }) => ["shared", `mimetype:${attempt}`];

        const provider = new Mock({ contextWindow: 100_000, responses: [invalid, valid] });
        const providerWithAttribution = provider as Mock & {
            attributions?: (context: PluginAttributionContext) => readonly string[];
        };
        providerWithAttribution.attributions = (context) => {
            contexts.push(context);
            return ["shared", `provider:${context.attempt}`];
        };
        const forwarded: Array<readonly string[] | undefined> = [];
        const generate = provider.generate.bind(provider);
        provider.generate = (args) => {
            forwarded.push((args as { attributions?: readonly string[] }).attributions);
            return generate(args);
        };

        const engine = new Engine({ db, schemes, mimetypes });
        engine.setExecutors(executors);
        const result = await engine.runTurn({ provider, workspaceId, workerId, loopId, messages: [] });

        const first = canonical("shared", "scheme:1", "executor:1", "mimetype:1", "provider:1");
        const second = canonical("shared", "scheme:2", "executor:2", "mimetype:2", "provider:2");
        assert.deepEqual(forwarded, [first, second], "each call receives that attempt's canonical union");
        assert.deepEqual(contexts, [
            {
                workspaceId: String(workspaceId),
                workerId: workerIdentity?.provider_identity,
                primaryWorkerId: workerIdentity?.provider_identity,
                loop: 1,
                turn: 1,
                attempt: 1,
            },
            {
                workspaceId: String(workspaceId),
                workerId: workerIdentity?.provider_identity,
                primaryWorkerId: workerIdentity?.provider_identity,
                loop: 1,
                turn: 1,
                attempt: 2,
            },
        ], "plugins receive only the exact provider-attempt coordinates");

        const attempts = await db.test_turn_attempts.all<{ sequence: number; attributions: string }>({
            turn_id: result.turnId,
        });
        assert.deepEqual(
            attempts.map(({ sequence, attributions }) => ({ sequence, attributions: JSON.parse(attributions) })),
            [
                { sequence: 1, attributions: first },
                { sequence: 2, attributions: second },
            ],
            "attempt evidence retains each exact forwarded set",
        );

        const row = await db.test_get_turn.get<{ packet: string }>({ id: result.turnId });
        const packet = JSON.parse(row!.packet) as { attributions: string[] };
        assert.deepEqual(packet.attributions, second, "the turn request retains the latest attempted set");
        assert.deepEqual(
            await engine.loopAttributions(loopId),
            canonical(...first, ...second),
            "loop reporting derives its union from exact request evidence",
        );
    } finally {
        await db.close();
    }
});

test("an empty folksonomy omits the provider field but persists the exact empty request set", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `attr-empty-${crypto.randomUUID()}`);
        const workerId = await insertWorker(db, workspaceId);
        const loopId = await insertLoop(db, workerId, 1, "go");
        const engine = new Engine({ db, schemes: new SchemeRegistry() });
        const provider = new Mock({ contextWindow: 100_000, responses: [valid] });
        let forwarded: readonly string[] | undefined;
        const generate = provider.generate.bind(provider);
        provider.generate = (args) => {
            forwarded = (args as { attributions?: readonly string[] }).attributions;
            return generate(args);
        };

        const result = await engine.runTurn({ provider, workspaceId, workerId, loopId, messages: [] });

        assert.equal(forwarded, undefined);
        const row = await db.test_get_turn.get<{ packet: string }>({ id: result.turnId });
        assert.deepEqual((JSON.parse(row!.packet) as { attributions: string[] }).attributions, []);
        assert.deepEqual(await engine.loopAttributions(loopId), []);
    } finally {
        await db.close();
    }
});
