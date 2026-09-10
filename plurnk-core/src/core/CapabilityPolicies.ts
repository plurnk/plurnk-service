import {
    Validator,
    type CapabilityPolicy,
} from "@plurnk/plurnk-contracts";
import type { Db } from "./Db.ts";
import WorkspaceSettings from "./workspace-settings.ts";

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
    ): Promise<readonly { scope: "service" | "workspace"; policy: CapabilityPolicy }[]> {
        const workspace = await WorkspaceSettings.read(db, workspaceId);
        return [
            { scope: "service", policy: CapabilityPolicies.service() },
            { scope: "workspace", policy: workspace.capabilities },
        ];
    }
}
