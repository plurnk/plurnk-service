import type { Notice } from "@plurnk/plurnk-contracts";
import { Knob } from "@plurnk/plurnk-meta";
const TOKENS_PLACEHOLDER = "{{tokens}}";
const MAX_WIDTH_PASSES = 64;

type MeasurePacket = (gauge: string, notice: Notice | null) => number;

export interface LargestLogItem {
    readonly path: string;
    readonly tokens: number;
}

export interface Readout {
    readonly gauge: string;
    readonly notice: Notice | null;
}

// {§context-pressure-notice} — the share and the constraint it nears; the gauge keeps the counts.
const pressureNotice = (share: number): Notice => ({
    source: "engine:context",
    kind: "budget_pressure",
    level: "warn",
    message: `Context is at ${share}% of budget. YOU MUST NOT exceed budget.`,
});

// {§context-gauge} — one measured JSON object; the curation inventory and the pressure notice
// ({§context-pressure-notice}) appear only under pressure.
// Never a response allowance ({§output-allowance-notice}).
export default class BudgetReadout {
    static draft(budget: number | null): string {
        if (budget === null) return `{"tokens":${TOKENS_PLACEHOLDER}}`;
        BudgetReadout.#assertBudget(budget);
        return `{"tokens":${TOKENS_PLACEHOLDER},"budget":${budget}}`;
    }

    // The budget a stored gauge showed the model; null when it shows none.
    static budgetOf(content: string): number | null {
        let gauge: unknown;
        try {
            gauge = JSON.parse(content.split("\n")[0] ?? "");
        } catch {
            return null;
        }
        const budget = typeof gauge === "object" && gauge !== null ? (gauge as { budget?: unknown }).budget : undefined;
        return typeof budget === "number" ? budget : null;
    }

    // {§tokenomics-render-weight-budget} — the width only expands, so the final
    // numeric substitution cannot change the measured packet length or oscillate.
    static resolve(
        template: string,
        measurePacket: MeasurePacket,
        largestLogItems: readonly LargestLogItem[] = [],
    ): Readout {
        BudgetReadout.#assertTemplate(template);
        const ranked = largestLogItems
            .map((item) => BudgetReadout.#assertLargestLogItem(item))
            .toSorted((a, b) => a.tokens === b.tokens
                ? a.path < b.path ? -1 : a.path > b.path ? 1 : 0
                : a.tokens > b.tokens ? -1 : 1)
            .slice(0, Knob.integer("PLURNK_SERVICE_BUDGET_LARGEST_ITEMS", 0));
        const neutral = BudgetReadout.#resolveTemplate(template, (gauge) => measurePacket(gauge, null));
        const budget = BudgetReadout.budgetOf(neutral.content);
        const pressure = Knob.percent("PLURNK_SERVICE_BUDGET_PRESSURE");
        // Neither the inventory nor the notice can trigger its own appearance; their weight is included only after admission.
        if (budget === null || neutral.usage <= budget * pressure) return { gauge: neutral.content, notice: null };
        const pressured = BudgetReadout.#withInventory(template, ranked);
        const noticed = neutral.usage > budget ? null : BudgetReadout.#withNotice(pressured, budget, neutral.usage, measurePacket);
        return noticed ?? { gauge: BudgetReadout.#resolveTemplate(pressured, (gauge) => measurePacket(gauge, null)).content, notice: null };
    }

    // {§context-pressure-notice} — the share is the gauge's own final tokens over its budget, the notice
    // included; a packet the notice would carry over its budget carries none.
    static #withNotice(template: string, budget: number, usage: number, measurePacket: MeasurePacket): Readout | null {
        let share = Math.floor(usage * 100 / budget);
        for (let pass = 0; pass < MAX_WIDTH_PASSES; pass += 1) {
            const notice = pressureNotice(share);
            const resolved = BudgetReadout.#resolveTemplate(template, (gauge) => measurePacket(gauge, notice));
            if (resolved.usage > budget) return null;
            const measured = Math.floor(resolved.usage * 100 / budget);
            if (measured === share) return { gauge: resolved.content, notice };
            share = measured;
        }
        throw new Error(`Budget pressure share did not converge after ${MAX_WIDTH_PASSES} passes`);
    }

    static #resolveTemplate(
        template: string,
        measurePacket: (gauge: string) => number,
    ): { content: string; usage: number } {
        let width = 1;

        for (let pass = 0; pass < MAX_WIDTH_PASSES; pass += 1) {
            const probe = BudgetReadout.#render(template, width, "0".repeat(width));
            const usage = BudgetReadout.#assertWeight(measurePacket(probe));
            const value = String(usage);
            const expanded = Math.max(width, value.length);
            if (expanded !== width) {
                width = expanded;
                continue;
            }

            const content = BudgetReadout.#render(template, width, value);
            const finalWeight = BudgetReadout.#assertWeight(measurePacket(content));
            if (finalWeight !== usage) {
                throw new Error(`Budget readout measurement changed after fixed-width substitution: ${usage} -> ${finalWeight}`);
            }
            return { content, usage };
        }

        throw new Error(`Budget readout field width did not converge after ${MAX_WIDTH_PASSES} passes`);
    }

    static #render(template: string, width: number, value: string): string {
        return template.replace(TOKENS_PLACEHOLDER, value.padStart(width));
    }

    // The inventory rides inside the same JSON object as its `largest` field, so the
    // section is one JSON payload.
    static #withInventory(template: string, items: readonly LargestLogItem[]): string {
        const largest = items
            .map(({ path, tokens }) => JSON.stringify({ path, tokens }))
            .join(",");
        return template.replace(/\}\s*$/u, () => `,"largest":[${largest}]}`);
    }

    static #assertLargestLogItem(item: LargestLogItem): LargestLogItem {
        if (!item.path.startsWith("log:///") || /[\r\n]/u.test(item.path)) {
            throw new TypeError(`Largest log item path must be one log:/// URI, got ${JSON.stringify(item.path)}`);
        }
        if (!Number.isSafeInteger(item.tokens) || item.tokens <= 0) {
            throw new TypeError("Largest log item tokens must be a positive safe integer");
        }
        return item;
    }

    static #assertBudget(budget: number): void {
        if (!Number.isSafeInteger(budget) || budget < 0) {
            throw new TypeError("Budget readout budget must be a non-negative safe integer");
        }
    }

    static #assertWeight(weight: number): number {
        if (!Number.isSafeInteger(weight) || weight < 0) {
            throw new TypeError("Budget readout packet weight must be a non-negative safe integer");
        }
        return weight;
    }

    static #assertTemplate(template: string): void {
        if (template.split(TOKENS_PLACEHOLDER).length !== 2) {
            throw new TypeError(`Budget readout template must contain ${TOKENS_PLACEHOLDER} exactly once`);
        }
    }
}
