const TOKENS_ACTIVE_TOTAL_PLACEHOLDER = "{{tokensActiveTotal}}";
const MAX_WIDTH_PASSES = 64;

type MeasurePacket = (content: string) => number;

interface LargestLogItem {
    readonly path: string;
    readonly tokensBody: number;
    readonly tokensActive: number;
}

const PRESSURE_FRACTION = 0.8;
const LARGEST_LOG_ITEMS_MAX = 5;
const PRESSURE_MANDATE = "YOU MUST KILL superseded, stale, or irrelevant log items and ranges.";

export default class BudgetReadout {
    static draft(ceiling: number | null, responseMax: number | null = null): string {
        if (ceiling === null) return "";
        BudgetReadout.#assertCeiling(ceiling);
        // {§output-allowance-notice} (#478): the per-turn response allowance is a
        // capacity fact like the ceiling — disclosed, never discovered by truncation.
        // {§provider-flexed-allowance} (#482): the disclosed number stays the
        // configured floor; wire-level overflow tolerance is never advertised.
        const responseField = responseMax === null ? "" : `,"tokensResponseMax":${responseMax}`;
        return `{"tokensActiveTotal":${TOKENS_ACTIVE_TOTAL_PLACEHOLDER},"tokensActiveMax":${ceiling}${responseField}}`;
    }

    // {§tokenomics-render-weight-budget} — the width only expands, so the final
    // numeric substitution cannot change the measured packet length or oscillate.
    static resolve(
        template: string,
        ceiling: number,
        measurePacket: MeasurePacket,
        largestLogItems: readonly LargestLogItem[] = [],
        calibration = 1,
    ): string {
        BudgetReadout.#assertCeiling(ceiling);
        BudgetReadout.#assertTemplate(template);
        BudgetReadout.#assertCalibration(calibration);
        // {§tokenomics-calibrated-readout} — pressure and the displayed figures judge the calibrated
        // weight; the raw measure still guards the fixed-width substitution.
        const neutral = BudgetReadout.#resolveTemplate(template, measurePacket, calibration);
        if (neutral.calibrated / ceiling < PRESSURE_FRACTION || largestLogItems.length === 0) {
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
            const pressured = BudgetReadout.#withInventory(template, ranked.slice(0, count));
            const resolved = BudgetReadout.#resolveTemplate(pressured, measurePacket, calibration);
            if (neutral.calibrated > ceiling || resolved.calibrated <= ceiling) return resolved.content;
        }
        return neutral.content;
    }

    static #resolveTemplate(
        template: string,
        measurePacket: MeasurePacket,
        calibration: number,
    ): { content: string; usage: number; calibrated: number } {
        let width = 1;

        for (let pass = 0; pass < MAX_WIDTH_PASSES; pass += 1) {
            const probe = BudgetReadout.#render(template, width, "0".repeat(width));
            const usage = BudgetReadout.#assertWeight(measurePacket(probe));
            const calibrated = Math.round(usage * calibration);
            const value = String(calibrated);
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
            return { content, usage, calibrated };
        }

        throw new Error(`Budget readout field width did not converge after ${MAX_WIDTH_PASSES} passes`);
    }

    static #render(template: string, width: number, value: string): string {
        return template.replace(TOKENS_ACTIVE_TOTAL_PLACEHOLDER, value.padStart(width));
    }

    // The inventory rides inside the same JSON object as a `tokensActiveLargest`
    // field, so the block opens as one JSON payload; the recovery mandate follows it.
    static #withInventory(template: string, items: readonly LargestLogItem[]): string {
        const largest = items
            .map(({ path, tokensBody, tokensActive }) => JSON.stringify({ path, tokensBody, tokensActive }))
            .join(",");
        const object = template.replace(/\}\s*$/u, () => `,"tokensActiveLargest":[${largest}]}`);
        return `${object}\n\n${PRESSURE_MANDATE}`;
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

    static #assertCalibration(calibration: number): void {
        if (!Number.isFinite(calibration) || calibration <= 0) {
            throw new TypeError("Budget readout calibration must be a positive finite number");
        }
    }

    static #assertWeight(weight: number): number {
        if (!Number.isSafeInteger(weight) || weight < 0) {
            throw new TypeError("Budget readout packet weight must be a non-negative safe integer");
        }
        return weight;
    }

    static #assertTemplate(template: string): void {
        if (template.split(TOKENS_ACTIVE_TOTAL_PLACEHOLDER).length !== 2) {
            throw new TypeError(`Budget readout template must contain ${TOKENS_ACTIVE_TOTAL_PLACEHOLDER} exactly once`);
        }
    }
}
