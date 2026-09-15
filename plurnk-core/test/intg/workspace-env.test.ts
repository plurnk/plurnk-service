import test from "node:test";
import assert from "node:assert/strict";
import type { FunctionalityListResult } from "@plurnk/plurnk-contracts";
import Daemon from "../../src/server/Daemon.ts";
import EnvFunctionality from "../../src/server/EnvFunctionality.ts";
import { insertWorker, insertWorkspace, openMigrated } from "./_helpers.ts";

test("{§workspace-env} workspace defaults, worker overrides and masks share the env verbs without copying workspace state", async () => {
    const db = await openMigrated();
    const daemon = new Daemon({ db, provider: null });
    await daemon.start();
    try {
        const workspaceId = await insertWorkspace(db, `env-${crypto.randomUUID()}`);
        const other = await insertWorkspace(db, `other-${crypto.randomUUID()}`);
        const alice = await insertWorker(db, workspaceId, null, "alice", "client");
        const bob = await insertWorker(db, workspaceId, null, "bob", "client");
        const shared = (verb: string, params: Record<string, unknown> = {}, workspace = workspaceId) =>
            daemon.invokeModuleAction(`workspace.env.${verb}`, params, { scope: "workspace", workspaceId: workspace });
        const local = (workerId: number, verb: string, params: Record<string, unknown> = {}) =>
            daemon.invokeModuleAction(`worker.env.${verb}`, params, { scope: "worker", workspaceId, workerId });
        const get = async (workerId: number) => ((await local(workerId, "list")) as FunctionalityListResult).definitions.find(({ alias }) => alias === "ENV_WITNESS");
        await shared("add", { alias: "ENV_WITNESS", definition: { value: "workspace" } });
        assert.deepEqual((await get(alice))?.definition, { value: "workspace" });
        assert.equal((await get(alice))?.origin, "workspace");
        assert.equal(((await shared("list", {}, other)) as FunctionalityListResult).definitions.some(({ alias }) => alias === "ENV_WITNESS"), false);
        await local(alice, "add", { alias: "ENV_WITNESS", definition: { value: "alice" } });
        assert.deepEqual((await get(alice))?.definition, { value: "alice" });
        assert.deepEqual((await get(bob))?.definition, { value: "workspace" });
        await local(alice, "remove", { alias: "ENV_WITNESS" });
        assert.equal((await get(alice))?.state, "disabled");
        assert.equal((await get(bob))?.state, "active");
        await local(alice, "enable", { alias: "ENV_WITNESS" });
        assert.deepEqual((await get(alice))?.definition, { value: "workspace" });
        await shared("disable", { alias: "ENV_WITNESS" });
        assert.equal((await get(alice))?.state, "disabled", "removing a worker mask cannot lift a workspace mask");
        assert.equal((await EnvFunctionality.resolve(db, workspaceId, alice)).env.ENV_WITNESS, undefined);
        await shared("enable", { alias: "ENV_WITNESS" });
        assert.equal((await get(alice))?.state, "active");
        assert.equal((await EnvFunctionality.resolve(db, workspaceId, alice)).env.ENV_WITNESS, "workspace");
        const child = await insertWorker(db, workspaceId, bob, "child", "client");
        await shared("remove", { alias: "ENV_WITNESS" });
        await shared("add", { alias: "ENV_WITNESS", definition: { value: "updated" } });
        assert.deepEqual((await get(child))?.definition, { value: "updated" }, "workspace values stay live through parentage");
        await assert.rejects(shared("add", { alias: "PLURNK_BAD", definition: { value: "x" } }), /plurnk's own/u);
        await assert.rejects(shared("list", { scope: "worker" }), /scope does not match/u);
        await assert.rejects(local(alice, "list", { scope: "workspace" }), /scope does not match/u);
    } finally {
        await daemon.stop();
        await db.close();
    }
});
