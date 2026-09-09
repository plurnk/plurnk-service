import type { AcpPlan } from "./types.ts";
import PlanValue from "./PlanValue.ts";
import Validator from "./Validator.ts";

// {§plan-acp-projection}
export default class AcpPlanValue {
    static project(value: unknown): AcpPlan {
        const plan = PlanValue.assertCanonical(value);
        const projected = {
            entries: plan.map((entry) => {
                const metadata = Object.fromEntries(Object.entries(entry._meta ?? {}).filter(([key]) => key !== "plurnk.xyz/status"));
                const { _meta: _ignored, ...fields } = entry;
                if (entry.status !== "waiting" && entry.status !== "failed") return {
                    ...fields,
                    status: entry.status,
                    priority: "medium" as const,
                    ...(Object.keys(metadata).length === 0 ? {} : { _meta: metadata }),
                };
                return {
                    ...entry,
                    content: `${entry.status === "waiting" ? "Waiting" : "Failed"}: ${entry.content}`,
                    status: entry.status === "waiting" ? "in_progress" as const : "completed" as const,
                    priority: "medium" as const,
                    _meta: { ...metadata, "plurnk.xyz/status": entry.status },
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
