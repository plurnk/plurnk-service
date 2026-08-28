const TOKENS_ACTIVE_TOTAL_PLACEHOLDER = "{{tokensActiveTotal}}";
const TOKEN_PERCENT_PLACEHOLDER = "{{tokenPercent}}";
const MAX_WIDTH_PASSES = 64;

interface FieldWidths {
    readonly activeTotal: number;
    readonly percent: number;
}

type MeasurePacket = (content: string) => number;

interface LargestLogItem {
    readonly path: string;
    readonly tokensBody: number;
    readonly tokensActive: number;
}

const PRESSURE_FRACTION = 0.8;
const LARGEST_LOG_ITEMS_MAX = 5;
const PRESSURE_MANDATE = "YOU MUST FOLD, KILL, or trim superseded, stale, or irrelevant log content.";

export default class BudgetReadout {
    static draft(ceiling: number | null): string {
        if (ceiling === null) return "";
        BudgetReadout.#assertCeiling(ceiling);
        return `tokensActiveTotal: ${TOKENS_ACTIVE_TOTAL_PLACEHOLDER} (${TOKEN_PERCENT_PLACEHOLDER}%)\ntokensActiveMax: ${ceiling}`;
    }

    // {§tokenomics-render-weight-budget} — widths only expand, so final numeric
    // substitution cannot change the measured packet length or oscillate.
    static resolve(
        template: string,
        ceiling: number,
        measurePacket: MeasurePacket,
        largestLogItems: readonly LargestLogItem[] = [],
    ): string {
        BudgetReadout.#assertCeiling(ceiling);
        BudgetReadout.#assertTemplate(template);
        const neutral = BudgetReadout.#resolveTemplate(template, ceiling, measurePacket);
        if (neutral.usage / ceiling < PRESSURE_FRACTION || largestLogItems.length === 0) {
            return neutral.content;
        }

        // {§tokenomics-pressure-inventory} — take the largest useful prefix that
        // fits, so recovery advice cannot manufacture the overflow it describes.
        const ranked = largestLogItems
            .map((item) => BudgetReadout.#assertLargestLogItem(item))
            .toSorted((a, b) => a.tokensActive === b.tokensActive
                ? a.path < b.path ? -1 : a.path > b.path ? 1 : 0
                : a.tokensActive > b.tokensActive ? -1 : 1)
            .slice(0, LARGEST_LOG_ITEMS_MAX);
        for (let count = ranked.length; count > 0; count -= 1) {
            const inventory = BudgetReadout.#renderPressureInventory(ranked.slice(0, count));
            const resolved = BudgetReadout.#resolveTemplate(`${template.replace(/\n+$/u, "")}\n\n${inventory}`, ceiling, measurePacket);
            if (neutral.usage > ceiling || resolved.usage <= ceiling) return resolved.content;
        }
        return neutral.content;
    }

    static #resolveTemplate(
        template: string,
        ceiling: number,
        measurePacket: MeasurePacket,
    ): { content: string; usage: number } {
        let widths: FieldWidths = { activeTotal: 1, percent: 1 };

        for (let pass = 0; pass < MAX_WIDTH_PASSES; pass += 1) {
            const probe = BudgetReadout.#render(template, widths, {
                activeTotal: "0".repeat(widths.activeTotal),
                percent: "0".repeat(widths.percent),
            });
            const usage = BudgetReadout.#assertWeight(measurePacket(probe));
            const values = {
                activeTotal: String(usage),
                percent: BudgetReadout.#percent(usage, ceiling),
            };
            const expanded = {
                activeTotal: Math.max(widths.activeTotal, values.activeTotal.length),
                percent: Math.max(widths.percent, values.percent.length),
            };
            if (
                expanded.activeTotal !== widths.activeTotal
                || expanded.percent !== widths.percent
            ) {
                widths = expanded;
                continue;
            }

            const content = BudgetReadout.#render(template, widths, values);
            const finalWeight = BudgetReadout.#assertWeight(measurePacket(content));
            if (finalWeight !== usage) {
                throw new Error(`Budget readout measurement changed after fixed-width substitution: ${usage} -> ${finalWeight}`);
            }
            return { content, usage };
        }

        throw new Error(`Budget readout field widths did not converge after ${MAX_WIDTH_PASSES} passes`);
    }

    static #render(
        template: string,
        widths: FieldWidths,
        values: { readonly activeTotal: string; readonly percent: string },
    ): string {
        return template
            .replace(TOKENS_ACTIVE_TOTAL_PLACEHOLDER, values.activeTotal.padStart(widths.activeTotal))
            .replace(TOKEN_PERCENT_PLACEHOLDER, values.percent.padStart(widths.percent));
    }

    static #percent(usage: number, ceiling: number): string {
        const percent = (usage / ceiling) * 100;
        return usage > 0 && percent < 1 ? "<1" : String(Math.round(percent));
    }

    static #renderPressureInventory(items: readonly LargestLogItem[]): string {
        const rows = items.map(({ path, tokensBody, tokensActive }) =>
            `* ${path} - ${JSON.stringify({ tokensBody, tokensActive })}`);
        return `${PRESSURE_MANDATE}\n\n### Largest Log Items:\n\n${rows.join("\n")}`;
    }

    static #assertLargestLogItem(item: LargestLogItem): LargestLogItem {
        if (!item.path.startsWith("log:///") || /[\r\n]/u.test(item.path)) {
            throw new TypeError(`Largest log item path must be one log:/// URI, got ${JSON.stringify(item.path)}`);
        }
        for (const [name, value] of Object.entries({ tokensBody: item.tokensBody, tokensActive: item.tokensActive })) {
            if (!Number.isSafeInteger(value) || value <= 0) {
                throw new TypeError(`Largest log item ${name} must be a positive safe integer`);
            }
        }
        return item;
    }

    static #assertCeiling(ceiling: number): void {
        if (!Number.isSafeInteger(ceiling) || ceiling <= 0) {
            throw new TypeError("Budget readout ceiling must be a positive safe integer");
        }
    }

    static #assertWeight(weight: number): number {
        if (!Number.isSafeInteger(weight) || weight < 0) {
            throw new TypeError("Budget readout packet weight must be a non-negative safe integer");
        }
        return weight;
    }

    static #assertTemplate(template: string): void {
        for (const placeholder of [TOKENS_ACTIVE_TOTAL_PLACEHOLDER, TOKEN_PERCENT_PLACEHOLDER]) {
            if (template.split(placeholder).length !== 2) {
                throw new TypeError(`Budget readout template must contain ${placeholder} exactly once`);
            }
        }
    }
}
