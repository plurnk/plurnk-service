// {§operator-config-workspace-settings} — a workspace's non-knob metadata bag (`workspaces.settings`).
// Configuration overrides live in `workspace_config` under their canonical `PLURNK_*` names;
// this bag retains only workspace-stable client identification and standing approval permissions.

import { isRecord } from "@plurnk/plurnk-contracts";
import type { Db } from "./Db.ts";

export type StandingPermission = "allow_always" | "reject_always";

const isStandingPermission = (value: unknown): value is StandingPermission =>
    value === "allow_always" || value === "reject_always";

export type WorkspaceOpenContext = {
    client: string | null; // {§emission-admission} — workspace-stable frontend id; null = unset
    permissions: Readonly<Record<string, StandingPermission>>;
};

export default class WorkspaceSettings {
    static parse(raw: string, workspaceId: number): WorkspaceOpenContext {
        let bag: Record<string, unknown>;
        try {
            const parsed: unknown = JSON.parse(raw);
            if (!isRecord(parsed)) throw new TypeError("Workspace settings must be a JSON object.");
            bag = parsed;
        } catch (cause) {
            throw new Error(`Workspace ${workspaceId} has invalid persisted settings.`, { cause });
        }
        const client = typeof bag.client === "string" ? bag.client : null;
        const permissions: Record<string, StandingPermission> = {};
        if (bag.permissions !== undefined) {
            if (!isRecord(bag.permissions)) {
                throw new Error(`Workspace ${workspaceId} has invalid persisted permissions.`);
            }
            for (const [key, value] of Object.entries(bag.permissions)) {
                if (key.length === 0 || !isStandingPermission(value)) {
                    throw new Error(`Workspace ${workspaceId} has invalid persisted permissions.`);
                }
                permissions[key] = value;
            }
        }
        return {
            client,
            permissions: Object.freeze(permissions),
        };
    }

    static async read(db: Db, workspaceId: number): Promise<WorkspaceOpenContext> {
        const row = await db.workspace_get_settings.get<{ settings: string }>({ workspace_id: workspaceId });
        if (row === undefined) throw new Error(`Workspace ${workspaceId} does not exist while reading its settings.`);
        return WorkspaceSettings.parse(row.settings, workspaceId);
    }
}
