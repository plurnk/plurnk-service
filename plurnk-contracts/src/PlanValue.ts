import type { Plan } from "./types.ts";
import Validator from "./Validator.ts";

export const DEFAULT_PLAN_PRIORITY = "medium" as const;

// One source-admission normalization for the model-native Plan. Exact submitted
// text remains owned by turnOps evidence; standards projection happens later.
export default class PlanValue {
    static admit(raw: string): Plan {
        if (raw.length === 0) return { entries: [] };
        let parsed: unknown;
        try {
            parsed = JSON.parse(raw);
        } catch {
            return PlanValue.#fallback(raw);
        }
        const normalized = PlanValue.#supplyPriorities(parsed);
        return Validator.validatePlan(normalized).valid
            ? normalized as Plan
            : PlanValue.#fallback(raw);
    }

    static assertCanonical(value: unknown): Plan {
        if (!Validator.validatePlan(value).valid) {
            throw new TypeError("Expected a canonical Plurnk Plan.");
        }
        return value as Plan;
    }

    static stringify(value: unknown): string {
        return JSON.stringify(PlanValue.assertCanonical(value));
    }

    static #fallback(content: string): Plan {
        return {
            entries: [{ content, priority: DEFAULT_PLAN_PRIORITY, status: "in_progress" }],
        };
    }

    static #supplyPriorities(value: unknown): unknown {
        if (value === null || typeof value !== "object" || Array.isArray(value)) return value;
        const plan = value as Record<string, unknown>;
        if (!Array.isArray(plan.entries)) return value;
        const rest = Object.fromEntries(Object.entries(plan).filter(([key]) => key !== "entries"));
        return {
            entries: plan.entries.map((entry) => {
                if (entry === null || typeof entry !== "object" || Array.isArray(entry)) return entry;
                const record = entry as Record<string, unknown>;
                const extra = Object.fromEntries(Object.entries(record).filter(
                    ([key]) => key !== "content" && key !== "priority" && key !== "status",
                ));
                return {
                    ...(Object.hasOwn(record, "content") ? { content: record.content } : {}),
                    priority: Object.hasOwn(record, "priority") ? record.priority : DEFAULT_PLAN_PRIORITY,
                    ...(Object.hasOwn(record, "status") ? { status: record.status } : {}),
                    ...extra,
                };
            }),
            ...rest,
        };
    }
}
