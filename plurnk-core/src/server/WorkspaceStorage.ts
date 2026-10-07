import { lstat, mkdir, rename } from "node:fs/promises";
import { join } from "node:path";
import type { Db } from "../core/Db.ts";
import type HostPaths from "../core/HostPaths.ts";

// {§module-workspace-directory}
export default class WorkspaceStorage {
    readonly #db: Db;
    readonly #paths: HostPaths;

    constructor(db: Db, paths: HostPaths) {
        this.#db = db;
        this.#paths = paths;
    }

    async directory(workspaceId: number, namespaceOwner: string): Promise<string> {
        if (["", ".", ".."].includes(namespaceOwner)) throw new Error("A module storage directory requires a namespace owner.");
        const row = await this.#db.workspace_storage_key.get<{ state: string }>({ workspace_id: workspaceId });
        if (row === undefined) throw new Error(`Workspace ${workspaceId} does not exist.`);
        const directory = join(this.#workspaceRoot(workspaceId, row.state), encodeURIComponent(namespaceOwner));
        await mkdir(directory, { recursive: true, mode: 0o700 });
        return directory;
    }

    #workspaceRoot(workspaceId: number, encoded: string): string {
        const state: unknown = JSON.parse(encoded);
        const key = state !== null && typeof state === "object" && "key" in state ? state.key : undefined;
        if (typeof key !== "string" || !/^[a-f0-9]{32}$/u.test(key)) throw new Error(`Workspace ${workspaceId} has an invalid storage key.`);
        return join(this.#paths.stateDir, "workspaces", key);
    }

    // {§skills-storage-upgrade} — the host that placed these bytes upgrades them
    // before modules acquire state; the module knows only its current identity.
    async upgrade(): Promise<void> {
        const roots = await this.#db.workspace_storage_roots.all<{ workspace_id: number; state: string }>({});
        const inspect = (path: string) => lstat(path).catch((cause: unknown) => {
            if ((cause as NodeJS.ErrnoException)?.code === "ENOENT") return null;
            throw cause;
        });
        for (const { workspace_id: workspaceId, state } of roots) {
            const root = this.#workspaceRoot(workspaceId, state);
            const previous = join(root, encodeURIComponent("@plurnk/plurnk-core/skills"));
            const current = join(root, encodeURIComponent("@plurnk/plurnk-skills"));
            const source = await inspect(previous);
            if (source === null) continue;
            if (!source.isDirectory()) throw new Error(`Skills state upgrade requires a directory at ${previous}.`);
            if (await inspect(current) !== null) throw new Error(`Skills state upgrade cannot replace existing ${current}; original state remains at ${previous}.`);
            await rename(previous, current);
        }
    }
}
