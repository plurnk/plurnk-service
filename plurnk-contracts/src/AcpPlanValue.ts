import type { AcpPlan, AcpPlanEntry } from "./types.ts";
import PlanValue from "./PlanValue.ts";
import Validator from "./Validator.ts";

export const ACP_MEMORY_PREFIX = "Memory: ";

// The standards boundary for Plurnk's model-native Plan. Internal state remains
// untouched; only an ACP consumer receives this deliberately lossy projection.
export default class AcpPlanValue {
    static project(value: unknown): AcpPlan {
        const plan = PlanValue.assertCanonical(value);
        const projected = {
            entries: plan.map((entry): AcpPlanEntry => {
                const { status, ...rest } = entry;
                if (status !== "memory") return { ...rest, status };
                return {
                    ...rest,
                    content: entry.content.startsWith(ACP_MEMORY_PREFIX)
                        ? entry.content
                        : `${ACP_MEMORY_PREFIX}${entry.content}`,
                    status: "completed",
                };
            }),
        } satisfies AcpPlan;
        return AcpPlanValue.assertCanonical(projected);
    }

    static assertCanonical(value: unknown): AcpPlan {
        if (!Validator.validateAcpPlan(value).valid) {
            throw new TypeError("Expected a canonical ACP Plan.");
        }
        return value as AcpPlan;
    }

}
