import {
    CapabilityAdmission,
    Validator,
    type CapabilityPolicy,
    type LoopPolicy,
} from "@plurnk/plurnk-contracts";
import type { Db } from "./Db.ts";
import WorkspaceSettings from "./workspace-settings.ts";
import WorkerSettingsReader from "./worker-settings.ts";

export default class CapabilityPolicies {
    static service(env: NodeJS.ProcessEnv = process.env): CapabilityPolicy {
        const raw = env.PLURNK_SERVICE_CAPABILITIES;
        if (raw === undefined) {
            throw new Error("PLURNK_SERVICE_CAPABILITIES is missing from the assembled environment floor.");
        }
        if (raw.trim().length === 0) {
            throw new Error("PLURNK_SERVICE_CAPABILITIES must be a CapabilityPolicy JSON object.");
        }
        let parsed: unknown;
        try {
            parsed = JSON.parse(raw) as unknown;
        } catch (cause) {
            throw new Error("PLURNK_SERVICE_CAPABILITIES is not valid JSON.", { cause });
        }
        try {
            return Validator.assertCapabilityPolicy(parsed as CapabilityPolicy);
        } catch (cause) {
            throw new Error("PLURNK_SERVICE_CAPABILITIES is not a valid capability policy.", { cause });
        }
    }

    static async layers(
        db: Db,
        workspaceId: number,
        workerId: number,
        loopPolicy: LoopPolicy,
    ): Promise<readonly { scope: "service" | "workspace" | "worker-bound" | "worker" | "loop"; policy: CapabilityPolicy }[]> {
        const workspace = await WorkspaceSettings.read(db, workspaceId);
        const worker = await WorkerSettingsReader.read(db, workerId);
        const bound = await WorkerSettingsReader.bound(db, workerId);
        return [
            { scope: "service", policy: CapabilityPolicies.service() },
            { scope: "workspace", policy: workspace.capabilities },
            { scope: "worker-bound", policy: bound },
            { scope: "worker", policy: worker.capabilities },
            { scope: "loop", policy: loopPolicy.capabilities },
        ];
    }

    static async workerLayers(
        db: Db,
        workspaceId: number,
        workerId: number,
    ): Promise<readonly { scope: "service" | "workspace" | "worker-bound" | "worker"; policy: CapabilityPolicy }[]> {
        const workspace = await WorkspaceSettings.read(db, workspaceId);
        const worker = await WorkerSettingsReader.read(db, workerId);
        return [
            { scope: "service", policy: CapabilityPolicies.service() },
            { scope: "workspace", policy: workspace.capabilities },
            { scope: "worker-bound", policy: await WorkerSettingsReader.bound(db, workerId) },
            { scope: "worker", policy: worker.capabilities },
        ];
    }

    // A child receives the parent's effective capability authority by value.
    // Service/workspace restrictions are included in the snapshot as well as
    // remaining live layers, so no later widening can retroactively enlarge a
    // delegation.
    static async delegationBound(
        db: Db,
        workspaceId: number,
        workerId: number,
        loopPolicy?: LoopPolicy,
    ): Promise<CapabilityPolicy> {
        const layers = loopPolicy === undefined
            ? await CapabilityPolicies.workerLayers(db, workspaceId, workerId)
            : await CapabilityPolicies.layers(db, workspaceId, workerId, loopPolicy);
        return CapabilityAdmission.intersect(layers.map((layer) => layer.policy));
    }
}
