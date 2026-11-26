// {§operator-config-workspace-settings} — per-workspace configuration rows (`workspace_config`)
// composing strictly inward over the daemon's effective environment (`host -> service -> workspace`).

import type { Db } from "./Db.ts";
import ConfigPolicy from "./ConfigPolicy.ts";
import OperatorConfig from "./OperatorConfig.ts";

export default class WorkspaceConfig {
    static async readRaw(db: Db, workspaceId: number): Promise<Map<string, string>> {
        if (db.workspace_config_list === undefined) return new Map();
        const rows = await db.workspace_config_list.all<{ key: string; value: string }>({
            workspace_id: workspaceId,
        });
        return new Map(rows.map(({ key, value }) => [key, value]));
    }

    static async readRawKey(db: Db, workspaceId: number, key: string): Promise<string | undefined> {
        if (db.workspace_config_get === undefined) return undefined;
        const row = await db.workspace_config_get.get<{ value: string }>({
            workspace_id: workspaceId,
            key,
        });
        return row?.value;
    }

    // Effective value for one workspace-overridable key, applying monotonic ceiling composition
    // against the enclosing environment (`host -> service`).
    static async readEffectiveKey(
        db: Db,
        workspaceId: number,
        key: string,
        baseEnv: NodeJS.ProcessEnv = process.env,
    ): Promise<string | undefined> {
        const outer = baseEnv[key];
        if (!ConfigPolicy.isWorkspaceKey(key) || ConfigPolicy.isHostOnly(key)) return outer;
        const inner = await WorkspaceConfig.readRawKey(db, workspaceId, key);
        if (inner === undefined) return outer;
        return ConfigPolicy.composeCeiling(key, outer, inner);
    }

    // Complete workspace-resolved environment projection (`baseEnv` overlaid with `workspace_config`).
    static async resolve(
        db: Db,
        workspaceId: number,
        baseEnv: NodeJS.ProcessEnv = process.env,
    ): Promise<NodeJS.ProcessEnv> {
        const raw = await WorkspaceConfig.readRaw(db, workspaceId);
        if (raw.size === 0) return baseEnv;
        const resolved: NodeJS.ProcessEnv = { ...baseEnv };
        for (const [key, value] of raw) {
            if (!ConfigPolicy.isWorkspaceKey(key) || ConfigPolicy.isHostOnly(key)) continue;
            if (OperatorConfig.isSecretKey(key, baseEnv)) continue;
            resolved[key] = ConfigPolicy.composeCeiling(key, baseEnv[key], value);
        }
        return resolved;
    }

    static async put(db: Db, workspaceId: number, key: string, value: string): Promise<void> {
        await db.workspace_config_put.run({ workspace_id: workspaceId, key, value });
    }

    static async remove(db: Db, workspaceId: number, key: string): Promise<boolean> {
        const existing = await WorkspaceConfig.readRawKey(db, workspaceId, key);
        if (existing === undefined) return false;
        await db.workspace_config_delete.run({ workspace_id: workspaceId, key });
        return true;
    }
}
