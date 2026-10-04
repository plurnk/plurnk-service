import { Knob } from "@plurnk/plurnk-meta";
const TOKENS_PLACEHOLDER = "{{tokens}}";
const MAX_WIDTH_PASSES = 64;

type MeasurePacket = (content: string) => number;

export interface LargestLogItem {
    readonly path: string;
    readonly tokens: number;
}

// {§context-gauge} — one JSON object the model reads every packet: `tokens`, `budget`, `largest`.
// State only: no mandate, no threshold, and never a response allowance ({§output-allowance-notice}).
export default class BudgetReadout {
    static draft(budget: number | null): string {
        if (budget === null) return `{"tokens":${TOKENS_PLACEHOLDER}}`;
        BudgetReadout.#assertBudget(budget);
        return `{"tokens":${TOKENS_PLACEHOLDER},"budget":${budget}}`;
    }

    // {§tokenomics-render-weight-budget} — the width only expands, so the final
    // numeric substitution cannot change the measured packet length or oscillate.
    // {§context-gauge} — the inventory is complete whatever the packet weighs: over budget it is the
    // curation handles the row asks the model to use ({§context-over-budget-row}).
    static resolve(
        template: string,
        measurePacket: MeasurePacket,
        largestLogItems: readonly LargestLogItem[] = [],
    ): string {
        BudgetReadout.#assertTemplate(template);
        const ranked = largestLogItems
            .map((item) => BudgetReadout.#assertLargestLogItem(item))
            .toSorted((a, b) => a.tokens === b.tokens
                ? a.path < b.path ? -1 : a.path > b.path ? 1 : 0
                : a.tokens > b.tokens ? -1 : 1)
            .slice(0, Knob.integer("PLURNK_SERVICE_BUDGET_LARGEST_ITEMS", 0));
        return BudgetReadout.#resolveTemplate(BudgetReadout.#withInventory(template, ranked), measurePacket).content;
    }

    static #resolveTemplate(
        template: string,
        measurePacket: MeasurePacket,
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
