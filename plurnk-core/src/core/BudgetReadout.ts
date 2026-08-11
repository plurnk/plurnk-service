const TOKENS_FREE_PLACEHOLDER = "{{tokensFree}}";
const TOKEN_USAGE_PLACEHOLDER = "{{tokenUsage}}";
const TOKEN_PERCENT_PLACEHOLDER = "{{tokenPercent}}";
const MAX_WIDTH_PASSES = 64;
const PANIC = "Context Token Budget Panic: YOU MUST FOLD or KILL enough less-relevant log items to restore free tokens.";

interface FieldWidths {
    readonly usage: number;
    readonly percent: number;
    readonly free: number;
}

type MeasurePacket = (content: string) => number;

export default class BudgetReadout {
    static draft(ceiling: number | null): string {
        if (ceiling === null) return "";
        BudgetReadout.#assertCeiling(ceiling);
        return `Token Ceiling ${ceiling} · Token Usage ${TOKEN_USAGE_PLACEHOLDER} (${TOKEN_PERCENT_PLACEHOLDER}%) · Tokens Free ${TOKENS_FREE_PLACEHOLDER}`;
    }

    // {§tokenomics-render-weight-budget} — widths only expand, so final numeric
    // substitution cannot change the measured packet length or oscillate.
    static resolve(template: string, ceiling: number, measurePacket: MeasurePacket): string {
        BudgetReadout.#assertCeiling(ceiling);
        BudgetReadout.#assertTemplate(template);
        const ordinary = BudgetReadout.#resolveTemplate(template, ceiling, measurePacket);
        if (ordinary.usage <= ceiling) return ordinary.content;
        return BudgetReadout.#resolveTemplate(`${template}\n${PANIC}`, ceiling, measurePacket).content;
    }

    static #resolveTemplate(
        template: string,
        ceiling: number,
        measurePacket: MeasurePacket,
    ): { content: string; usage: number } {
        let widths: FieldWidths = { usage: 1, percent: 1, free: 1 };

        for (let pass = 0; pass < MAX_WIDTH_PASSES; pass += 1) {
            const probe = BudgetReadout.#render(template, widths, {
                usage: "0".repeat(widths.usage),
                percent: "0".repeat(widths.percent),
                free: "0".repeat(widths.free),
            });
            const usage = BudgetReadout.#assertWeight(measurePacket(probe));
            const values = {
                usage: String(usage),
                percent: BudgetReadout.#percent(usage, ceiling),
                free: String(ceiling - usage),
            };
            const expanded = {
                usage: Math.max(widths.usage, values.usage.length),
                percent: Math.max(widths.percent, values.percent.length),
                free: Math.max(widths.free, values.free.length),
            };
            if (
                expanded.usage !== widths.usage
                || expanded.percent !== widths.percent
                || expanded.free !== widths.free
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
        values: { readonly usage: string; readonly percent: string; readonly free: string },
    ): string {
        return template
            .replace(TOKEN_USAGE_PLACEHOLDER, values.usage.padStart(widths.usage))
            .replace(TOKEN_PERCENT_PLACEHOLDER, values.percent.padStart(widths.percent))
            .replace(TOKENS_FREE_PLACEHOLDER, values.free.padStart(widths.free));
    }

    static #percent(usage: number, ceiling: number): string {
        const percent = (usage / ceiling) * 100;
        return usage > 0 && percent < 1 ? "<1" : String(Math.round(percent));
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
        for (const placeholder of [TOKEN_USAGE_PLACEHOLDER, TOKEN_PERCENT_PLACEHOLDER, TOKENS_FREE_PLACEHOLDER]) {
            if (template.split(placeholder).length !== 2) {
                throw new TypeError(`Budget readout template must contain ${placeholder} exactly once`);
            }
        }
    }
}
