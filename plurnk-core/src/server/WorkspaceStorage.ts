import { mkdir } from "node:fs/promises";
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
        const state: unknown = JSON.parse(row.state);
        const key = state !== null && typeof state === "object" && "key" in state ? state.key : undefined;
        if (typeof key !== "string" || !/^[a-f0-9]{32}$/u.test(key)) throw new Error(`Workspace ${workspaceId} has an invalid storage key.`);
        const directory = join(this.#paths.stateDir, "workspaces", key, encodeURIComponent(namespaceOwner));
        await mkdir(directory, { recursive: true, mode: 0o700 });
        return directory;
    }
}
