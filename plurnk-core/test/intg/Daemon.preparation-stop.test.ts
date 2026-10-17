import assert from "node:assert/strict";
import test from "node:test";
import Daemon from "../../src/server/Daemon.ts";
import { openMigrated } from "./_db.ts";

test("{§module-shutdown-order} daemon cancels admitted preparation, joins cleanup, then closes observers", async (t) => {
    const db = await openMigrated();
    const daemon = new Daemon({ db, provider: null });
    const entered = Promise.withResolvers<void>();
    const cancelled = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const events: string[] = [];
    let stopping: Promise<void> | undefined;
    daemon.registerModule({
        setup(seam) {
            for (const family of ["held", "later"]) {
                seam.registerFunctionalityAdapter({
                    family, namespaceOwner: family, summary: "Fixture capability",
                    definitionSchema: { type: "object" },
                    available: async () => [],
                    admit: async () => ({ alias: "fixture", definition: {} }),
                    prepare: async ({ signal }) => {
                        events.push(`prepare:${family}`);
                        if (family === "held") {
                            entered.resolve();
                            await new Promise<void>((resolve) => signal.addEventListener("abort", () => {
                                events.push("cancel"); cancelled.resolve(); resolve();
                            }, { once: true }));
                            await release.promise;
                            events.push("candidate-cleanup");
                            signal.throwIfAborted();
                        }
                        return { documents: [], outcomes: new Map(), snapshot: null, commit: async () => {}, abort: async () => {} };
                    },
                    teardown: async () => { events.push(`teardown:${family}`); },
                });
            }
        },
        stop() { events.push("module-stop"); },
        close() { events.push("module-close"); },
    }, "test-preparation");
    t.after(async () => { release.resolve(); await (stopping ?? daemon.stop()); await db.close(); });
    await daemon.start();
    const { workspaceId } = await daemon.createWorkspace({ name: "stop-preparation" });
    const demand = assert.rejects(daemon.activateWorkspace({ workspaceId }), { name: "AbortError" });
    await entered.promise;
    stopping = daemon.stop();
    await cancelled.promise;
    await assert.rejects(daemon.activateWorkspace({ workspaceId }), { name: "AbortError" });
    assert.equal(events.includes("module-close"), false, "observers remain open while cancelled preparation cleans up");
    release.resolve();
    await Promise.all([demand, stopping]);
    assert.equal(events.includes("prepare:later"), false, "shutdown never advances activation into another family");
    assert.ok(events.indexOf("candidate-cleanup") < events.indexOf("module-close"), JSON.stringify(events));
    assert.equal(events.filter((event) => event === "module-close").length, 1);
    assert.ok(await db.envelope_get_workspace.get({ id: workspaceId }), "durable state remains usable after shutdown settlement");
});
