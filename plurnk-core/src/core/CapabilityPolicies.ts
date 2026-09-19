import {
    isAttended,
    Validator,
    type CapabilityPolicy,
} from "@plurnk/plurnk-contracts";
import type { Db } from "./Db.ts";
import WorkspaceSettings from "./workspace-settings.ts";
import LoopPolicyReader from "./LoopPolicyReader.ts";

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

    // {§loop-attendance} — the loop is the cascade's innermost ring. An unattended run has nobody
    // to answer, so it denies the `interact` access class outright: the reserved tool tree's FIND
    // and READ faces drop every interaction runtime and turn 0 never surveys one, rather than the
    // model being taught a tool and spending a turn discovering it cannot work (#770).
    static readonly UNATTENDED: CapabilityPolicy = Object.freeze({
        deny: Object.freeze([Object.freeze({ access: "interact" as const })]) as CapabilityPolicy["deny"],
    });

    // `loopId` is omitted where the question is genuinely about the workspace and not one run —
    // the operator's capability projection, and the shared reserved-document materialization, which
    // is one tree per workspace. Admission for a particular loop is decided at dispatch, which has
    // the loop coordinate, so a document a loop may not use is one it may not READ.
    static async layers(
        db: Db,
        workspaceId: number,
        loopId?: number,
    ): Promise<readonly { scope: "service" | "workspace" | "loop"; policy: CapabilityPolicy }[]> {
        const workspace = await WorkspaceSettings.read(db, workspaceId);
        const base = [
            { scope: "service" as const, policy: CapabilityPolicies.service() },
            { scope: "workspace" as const, policy: workspace.capabilities },
        ];
        if (loopId === undefined) return base;
        const attended = isAttended(await LoopPolicyReader.read(db, loopId));
        return attended ? base : [...base, { scope: "loop" as const, policy: CapabilityPolicies.UNATTENDED }];
    }
}
