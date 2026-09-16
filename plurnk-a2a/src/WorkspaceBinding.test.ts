import assert from "node:assert/strict";
import test from "node:test";
import type { ApplicationPort } from "@plurnk/plurnk-contracts";
import WorkspaceBinding from "./WorkspaceBinding.ts";

test("{§a2a-lazy-workspace}: passive misses do not create or conceal a subsequently existing workspace", async () => {
    let available = false;
    const port = {
        listWorkspaces: async () => available
            ? [{ id: 9, name: "agent", project_root: null, created_at: "" }]
            : [],
        createWorkspace: async () => { throw new Error("A passive lookup must not create a workspace."); },
    } as unknown as ApplicationPort;
    const workspace = new WorkspaceBinding(port, { name: "agent", projectRoot: null });
    assert.equal(await workspace.existingId(), null);
    available = true;
    assert.equal(await workspace.existingId(), 9);
    assert.equal(await workspace.id(), 9, "admission adopts the same existing workspace");
});

test("{§a2a-lazy-workspace}: concurrent admission and observation share one workspace creation", async () => {
    const created = Promise.withResolvers<{ workspaceId: number }>();
    const admitted = Promise.withResolvers<void>();
    let creations = 0;
    const port = {
        listWorkspaces: async () => [],
        createWorkspace: async () => {
            creations += 1;
            admitted.resolve();
            return created.promise;
        },
    } as unknown as ApplicationPort;
    const workspace = new WorkspaceBinding(port, { name: "agent", projectRoot: null });
    const first = workspace.id();
    await admitted.promise;
    const observed = workspace.existingId();
    const second = workspace.id();
    created.resolve({ workspaceId: 19 });
    assert.deepEqual(await Promise.all([first, observed, second]), [19, 19, 19]);
    assert.equal(creations, 1);
});
