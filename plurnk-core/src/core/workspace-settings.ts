// {§operator-config} — a workspace's client-chosen open context: the per-workspace overrides a client
// user legitimately sets at workspace.create, read at turn-0 with precedence over env.
// filesItems REPLACES the env value; the other knobs compose per their own tags.
// Storage is a JSON bag on workspaces.settings.

import type { Db } from "./Db.ts";
import FileCreationPolicy, { type FileCreateScope } from "./file-creation-policy.ts";

export type WorkspaceOpenContext = {
    filesItems: number | null; // {§operator-config-workspace-files-items} — replace env; null = unset
    maxCommands: number | null; // {§operator-config-workspace-max-commands} — min() with env; null = unset
    git: boolean | null;       // {§operator-config-workspace-git} — env AND workspace; null = unset
    fileCreateScope: FileCreateScope | null; // {§operator-config-workspace-file-create-scope}
    membersModelScope: FileCreateScope | null; // {§operator-config-workspace-members-model-scope}
    client: string | null;     // {§client-metadata} — workspace-stable frontend id; null = unset
    execs: Record<string, string> | null; // {§operator-config-workspace-execs}
};

export default class WorkspaceSettings {
    // The workspace's open-context bag. Absent/unset fields read as null / []. A malformed
    // bag never reaches here — workspace.create validates before persisting.
    static async read(db: Db, workspaceId: number): Promise<WorkspaceOpenContext> {
        const row = await db.workspace_get_settings.get<{ settings: string }>({ workspace_id: workspaceId });
        const bag = row?.settings !== undefined ? (JSON.parse(row.settings) as { filesItems?: unknown; maxCommands?: unknown; git?: unknown; fileCreateScope?: unknown; membersModelScope?: unknown; client?: unknown; execs?: unknown }) : {};
        const filesItems = typeof bag.filesItems === "number" ? bag.filesItems : null;
        const maxCommands = typeof bag.maxCommands === "number" ? bag.maxCommands : null;
        const git = typeof bag.git === "boolean" ? bag.git : null;
        const fileCreateScope = bag.fileCreateScope === undefined
            ? null
            : FileCreationPolicy.parse(bag.fileCreateScope, "settings.fileCreateScope");
        const membersModelScope = bag.membersModelScope === undefined
            ? null
            : FileCreationPolicy.parse(bag.membersModelScope, "settings.membersModelScope");
        const client = typeof bag.client === "string" ? bag.client : null;
        const execs = (typeof bag.execs === "object" && bag.execs !== null && !Array.isArray(bag.execs)) ? (bag.execs as Record<string, string>) : null;
        return { filesItems, maxCommands, git, fileCreateScope, membersModelScope, client, execs };
    }

}
