import type { Plan } from "./types.ts";
import Validator from "./Validator.ts";

export const DEFAULT_PLAN_PRIORITY = "medium" as const;

// One source-admission normalization for the model-native Plan. Exact submitted
// text remains owned by turnOps evidence; standards projection happens later.
export default class PlanValue {
    static admit(raw: string): Plan {
        if (raw.length === 0) return [];
        const submitted = PlanValue.#submittedValue(raw);
        if (submitted === undefined) return PlanValue.#fallback(raw);
        const normalized = PlanValue.#supplyPriorities(submitted);
        return Validator.validatePlan(normalized).valid
            ? normalized as Plan
            : PlanValue.#fallback(raw);
    }

    // The two admitted layouts: one JSON array document (any whitespace
    // layout), or the JSONL dialect the log projects — every nonblank line
    // one JSON entry object. Any unparsable or non-object line rejects the
    // whole body; no partial salvage.
    static #submittedValue(raw: string): unknown[] | undefined {
        try {
            const value = JSON.parse(raw);
            if (Array.isArray(value)) return value;
        } catch { /* not one JSON document — try the JSONL dialect */ }
        const lines = raw.split("\n").map((line) => line.trim()).filter((line) => line.length > 0);
        if (lines.length === 0) return undefined;
        const records: unknown[] = [];
        for (const line of lines) {
            let record: unknown;
            try {
                record = JSON.parse(line);
            } catch {
                return undefined;
            }
            if (record === null || typeof record !== "object" || Array.isArray(record)) return undefined;
            records.push(record);
        }
        return records;
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

    // Log-projection layout (#335): one canonical entry per line
    // (application/jsonl). Line-trimmable working memory — FOLDing lines
    // yields smaller valid JSONL, which a bracketed array cannot do. A
    // planless [] projects as zero lines.
    static stringifyJsonl(value: unknown): string {
        return PlanValue.assertCanonical(value).map((entry) => JSON.stringify(entry)).join("\n");
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
