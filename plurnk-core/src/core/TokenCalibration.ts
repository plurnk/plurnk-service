import type { Db } from "./Db.ts";

export interface CalibrationSample {
    readonly weight: number;
    readonly reported: number;
}

export interface WeighedItem {
    readonly path: string;
    readonly tokensBody: number;
    readonly tokensActive: number;
}

const MIN_SAMPLES = 3;

// {§tokenomics-calibrated-readout} — the model-independent ruler ({§tokenomics-agnostic-ruler}) overstates
// what a tokenizer charges by a model-specific ratio. The readout scales by what
// this model actually reported for its recent packets; nothing stored is rewritten.
export default class TokenCalibration {
    static factor(samples: readonly CalibrationSample[]): number {
        if (samples.length < MIN_SAMPLES) return 1;
        let weight = 0;
        let reported = 0;
        for (const sample of samples) {
            for (const [name, value] of Object.entries(sample)) {
                if (!Number.isSafeInteger(value) || value <= 0) throw new TypeError(`calibration sample ${name} must be a positive safe integer`);
            }
            weight += sample.weight;
            reported += sample.reported;
        }
        return reported / weight;
    }

    static async forModel(db: Db, model: string): Promise<number> {
        if (model.length === 0) throw new TypeError("calibration requires the model name the provider reports");
        const samples = await db.engine_calibration_samples.all<{ weight: number; reported: number }>({ model });
        return TokenCalibration.factor(samples);
    }

    static scale(item: WeighedItem, factor: number): WeighedItem {
        return {
            ...item,
            tokensBody: Math.max(1, Math.round(item.tokensBody * factor)),
            tokensActive: Math.max(1, Math.round(item.tokensActive * factor)),
        };
    }
}
