import type { Plan } from "./types.ts";
import Validator from "./Validator.ts";
import { renderJsonResult } from "./JsonResult.ts";

export const DEFAULT_PLAN_PRIORITY = "medium" as const;

// One source-admission normalization for the model-native Plan. Exact submitted
// text remains owned by turnOps evidence; standards projection happens later.
export default class PlanValue {
    static admit(raw: string): Plan {
        if (raw.length === 0) return [];
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

    // Log-projection layout (#335, reworked #339): the shared
    // {§json-result-rendering} spread — one valid JSON array, one entry per
    // line, brackets riding the first and last lines. FOLD line scopes reach
    // individual entries; the projected form re-admits as plain JSON.
    static render(value: unknown): string {
        return renderJsonResult(PlanValue.assertCanonical(value));
    }

    static #fallback(content: string): Plan {
        return [{ content, priority: DEFAULT_PLAN_PRIORITY, status: "in_progress" }];
    }

    static #supplyPriorities(value: unknown): unknown {
        if (!Array.isArray(value)) return value;
        return value.map((entry) => {
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
        });
    }
}
