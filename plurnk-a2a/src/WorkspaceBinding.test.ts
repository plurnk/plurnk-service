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

test("{§a2a-lazy-workspace}: a name, a folder or both select one workspace; only admission creates, and an ambiguous folder refuses", async () => {
    const world = (id: number, name: string, root: string | null) => ({ id, name, project_root: root, created_at: "" });
    const fixture = (workspaces: ReturnType<typeof world>[], selects: { name: string; root: string | null } = { name: "~/project", root: "/home/u/project" }) => {
        const created: unknown[] = [];
        const port = {
            listWorkspaces: async () => workspaces,
            createWorkspace: async (args: { name?: string; projectRoot: string | null }) => {
                created.push(args);
                return { workspaceId: 50, workspaceName: args.name ?? selects.name, projectRoot: args.name === undefined ? selects.root : args.projectRoot, workerId: 1, workerName: "client" };
            },
        } as unknown as ApplicationPort;
        return { port, created };
    };
    const cases: Array<{ label: string; config: { name: string | null; projectRoot: string | null }; workspaces: ReturnType<typeof world>[]; selects?: { name: string; root: string | null }; found: number | null | RegExp; admitted: number | RegExp; creates: unknown[] }> = [
        { label: "a name adopts its workspace", config: { name: "agent", projectRoot: null }, workspaces: [world(9, "agent", "/srv/x")], found: 9, admitted: 9, creates: [] },
        { label: "an absent name is created headless", config: { name: "agent", projectRoot: null }, workspaces: [], found: null, admitted: 50, creates: [{ name: "agent", projectRoot: null }] },
        { label: "a name and its folder adopt", config: { name: "agent", projectRoot: "/srv/x" }, workspaces: [world(9, "agent", "/srv/x")], found: 9, admitted: 9, creates: [] },
        { label: "a name on another folder refuses", config: { name: "agent", projectRoot: "/srv/y" }, workspaces: [world(9, "agent", "/srv/x")], found: /has project root "\/srv\/x", not configured root "\/srv\/y"/, admitted: /not configured root/, creates: [] },
        { label: "an absent name is created on its folder", config: { name: "agent", projectRoot: "/srv/y" }, workspaces: [], found: null, admitted: 50, creates: [{ name: "agent", projectRoot: "/srv/y" }] },
        { label: "a folder adopts the one workspace on it, whatever its name", config: { name: null, projectRoot: "/home/u/project" }, workspaces: [world(4, "renamed", "/home/u/project"), world(5, "~/other", "/home/u/other")], found: 4, admitted: 4, creates: [] },
        { label: "a folder with no workspace is created as a client creates it", config: { name: null, projectRoot: "/home/u/project" }, workspaces: [world(5, "~/other", "/home/u/other")], found: null, admitted: 50, creates: [{ projectRoot: "/home/u/project" }] },
        { label: "a folder holding several workspaces refuses", config: { name: null, projectRoot: "/home/u/project" }, workspaces: [world(4, "~/project", "/home/u/project"), world(6, "a2a", "/home/u/project")], found: /holds 2 workspaces: '~\/project', 'a2a'\. PLURNK_A2A_WORKSPACE names the one to use\./, admitted: /holds 2 workspaces/, creates: [] },
        { label: "a default name held by another folder's workspace refuses", config: { name: null, projectRoot: "/home/u/project" }, workspaces: [], selects: { name: "~/project", root: "/mnt/elsewhere" }, found: null, admitted: /selected workspace '~\/project' on "\/mnt\/elsewhere"/, creates: [{ projectRoot: "/home/u/project" }] },
    ];
    for (const { label, config, workspaces, selects, found, admitted, creates } of cases) {
        const passive = fixture(workspaces, selects);
        const lookup = new WorkspaceBinding(passive.port, config).existingId();
        if (found instanceof RegExp) await assert.rejects(lookup, found, label);
        else assert.equal(await lookup, found, label);
        assert.deepEqual(passive.created, [], `${label}: a lookup creates nothing`);
        const admission = fixture(workspaces, selects);
        const id = new WorkspaceBinding(admission.port, config).id();
        if (admitted instanceof RegExp) await assert.rejects(id, admitted, label);
        else assert.equal(await id, admitted, label);
        assert.deepEqual(admission.created, creates, `${label}: what admission creates`);
    }
});
