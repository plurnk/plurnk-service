import assert from "node:assert/strict";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import type { WorkspaceCapabilityGate } from "@plurnk/plurnk-contracts";
import Functionality from "./Functionality.ts";
import WorkspaceGate from "../core/WorkspaceGate.ts";
import type { WorkspaceCapabilityProvider } from "./DaemonModule.ts";

test("{§module-workspace-quiescence} a queued catalog refresh cannot block the current turn's admission refresh", { timeout: 5000 }, async () => {
    const gate = new WorkspaceGate(async () => false);
    const queued = Promise.withResolvers<void>();
    const publications: string[] = [];
    let provider!: WorkspaceCapabilityProvider;
    let state: unknown = null;
    const exclusively = async <T>(mode: WorkspaceCapabilityGate, run: () => Promise<T>): Promise<T> => {
        const hold = mode === "none" ? undefined
            : mode === "wait" ? gate.requestExclusive(1) : gate.tryExclusive(1);
        assert.notEqual(hold, null, "the fixture never requests a busy immediate mutation");
        if (mode === "wait") queued.resolve();
        try {
            await hold?.acquired;
            return await run();
        } finally { hold?.release(); }
    };
    const coordinator = new Functionality({
        registerModuleAction: () => {},
        registerWorkspaceCapabilityProvider: (_owner, value) => { provider = value; },
        readWorkspaceModuleState: async () => state,
        replaceWorkspaceCapabilities: async (replacement, options) => exclusively(options?.gate ?? "try", async () => {
            state = replacement.state;
            options?.publish?.();
            publications.push("published");
        }),
        readWorkerModuleState: async () => null,
        replaceWorkerModuleState: async () => {},
        withWorkspaceGate: (_workspaceId, _owner, mode, run) => exclusively(mode, run),
        retainWorkspace: () => () => {},
        preparationChanged: () => {},
    });
    const handle = coordinator.register({
        family: "fixture",
        namespaceOwner: "fixture",
        summary: "Fixture capability",
        definitionSchema: { type: "object" },
        available: async () => [],
        discover: async () => [],
        admit: async () => ({ alias: "fixture", definition: {} }),
        prepare: async () => ({
            documents: [], outcomes: new Map(), snapshot: {},
            commit: async () => {}, abort: async () => {},
        }),
        teardown: async () => {},
    });
    await provider.activate({ workspaceId: 1, retain: () => () => {} });
    assert.deepEqual(publications, ["published"]);
    const releaseTurn = await gate.acquireTurn(1, 1);
    const catalog = handle.refresh({ workspaceId: 1 });
    await queued.promise;
    const admission = handle.refresh({ workspaceId: 1 }, { gate: "none", ifChanged: true });
    let finished = false;
    try {
        finished = await Promise.race([admission.then(() => true), delay(300).then(() => false)]);
        assert.deepEqual(publications, ["published"], "the queued refresh does not replace the current turn's snapshot");
    } finally {
        releaseTurn();
        await Promise.all([catalog, admission]);
    }
    assert.equal(finished, true, "turn admission must finish while it owns the turn gate, not wait on a refresh that needs that gate");
    assert.deepEqual(publications, ["published", "published"], "the queued refresh publishes after the turn releases");
});
