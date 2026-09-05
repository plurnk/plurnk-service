import type { AcpPlan } from "./types.ts";
import PlanValue from "./PlanValue.ts";
import Validator from "./Validator.ts";

// {§plan-acp-projection}
export default class AcpPlanValue {
    static project(value: unknown): AcpPlan {
        const plan = PlanValue.assertCanonical(value);
        const projected = {
            entries: plan.map((entry) => ({ ...entry, priority: "medium" as const })),
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
