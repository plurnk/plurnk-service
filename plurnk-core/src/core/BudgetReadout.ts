import { Knob } from "@plurnk/plurnk-meta";
const TOKENS_PLACEHOLDER = "{{tokens}}";
const PERCENT_PLACEHOLDER = "{{percent}}";
const MAX_WIDTH_PASSES = 64;

type MeasurePacket = (gauge: string) => number;

export interface LargestLogItem {
    readonly path: string;
    readonly tokens: number;
}

export interface Readout {
    readonly gauge: string;
}

// {§context-gauge} — one measured JSON object: the packet's weight, the room, and the share of the room
// that weight is, on every packet with a budget; the curation inventory joins only above the threshold.
// Never a response allowance ({§output-allowance-notice}) and never a mandate.
export default class BudgetReadout {
    static draft(budget: number | null): string {
        if (budget === null) return `{"tokens":${TOKENS_PLACEHOLDER}}`;
        BudgetReadout.#assertBudget(budget);
        // A zero room has no share to state: every weight exceeds it ({§context-over-budget-row}).
        if (budget === 0) return `{"tokens":${TOKENS_PLACEHOLDER},"budget":0}`;
        return `{"tokens":${TOKENS_PLACEHOLDER},"budget":${budget},"percent":${PERCENT_PLACEHOLDER}}`;
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

    // {§tokenomics-render-weight-budget} — the widths only expand, so the final numeric substitutions
    // cannot change the measured packet length or oscillate.
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
        const neutral = BudgetReadout.#resolveTemplate(template, measurePacket);
        const budget = BudgetReadout.budgetOf(neutral.content);
        const pressure = Knob.percent("PLURNK_SERVICE_BUDGET_PRESSURE");
        // The inventory cannot trigger its own appearance; its weight is included only after admission.
        if (budget === null || neutral.usage <= budget * pressure) return { gauge: neutral.content };
        return { gauge: BudgetReadout.#resolveTemplate(BudgetReadout.#withInventory(template, ranked), measurePacket).content };
    }

    static #resolveTemplate(
        template: string,
        measurePacket: MeasurePacket,
    ): { content: string; usage: number } {
        const budget = BudgetReadout.#templateBudget(template);
        let tokensWidth = 1;
        let percentWidth = 1;

        for (let pass = 0; pass < MAX_WIDTH_PASSES; pass += 1) {
            const probe = BudgetReadout.#render(template, "0".repeat(tokensWidth), "0".repeat(percentWidth));
            const usage = BudgetReadout.#assertWeight(measurePacket(probe));
            const tokens = String(usage);
            // {§context-gauge} — the share is the gauge's own final tokens over its budget, so it never
            // disagrees with the figures beside it.
            const percent = budget === null ? "" : String(Math.floor(usage * 100 / budget));
            const expandedTokens = Math.max(tokensWidth, tokens.length);
            const expandedPercent = Math.max(percentWidth, percent.length);
            if (expandedTokens !== tokensWidth || expandedPercent !== percentWidth) {
                tokensWidth = expandedTokens;
                percentWidth = expandedPercent;
                continue;
            }

            const content = BudgetReadout.#render(template, tokens.padStart(tokensWidth), percent.padStart(percentWidth));
            const finalWeight = BudgetReadout.#assertWeight(measurePacket(content));
            if (finalWeight !== usage) {
                throw new Error(`Budget readout measurement changed after fixed-width substitution: ${usage} -> ${finalWeight}`);
            }
            return { content, usage };
        }

        throw new Error(`Budget readout field width did not converge after ${MAX_WIDTH_PASSES} passes`);
    }

    static #render(template: string, tokens: string, percent: string): string {
        return template.replace(TOKENS_PLACEHOLDER, tokens).replace(PERCENT_PLACEHOLDER, percent);
    }

    // The budget the template states, read before any substitution; null when it states none.
    static #templateBudget(template: string): number | null {
        const match = /"budget":(\d+)/u.exec(template);
        if (match === null) return null;
        const budget = Number(match[1]);
        return budget > 0 ? budget : null;
    }

    // The inventory rides inside the same JSON object as its `largest` field, after the share, so the
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
        const percents = template.split(PERCENT_PLACEHOLDER).length - 1;
        if (percents > 1 || (percents === 1 && BudgetReadout.#templateBudget(template) === null)) {
            throw new TypeError(`Budget readout template may contain ${PERCENT_PLACEHOLDER} once, after a positive budget`);
        }
    }
}
