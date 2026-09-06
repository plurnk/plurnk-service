import type { Db } from "./Db.ts";

export interface CalibrationSample {
    readonly weight: number;
    readonly reported: number;
}

const MIN_SAMPLES = 3;

// {§tokenomics-calibrated-readout} — provider capacity crosses into the stable
// curation ruler here. Content costs never cross in the opposite direction.
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

    static capacity(inputCapacity: number | null, factor = 1): number | null {
        if (!Number.isFinite(factor) || factor <= 0) throw new TypeError("calibration must be a positive finite number");
        if (inputCapacity === null) return null;
        if (!Number.isSafeInteger(inputCapacity) || inputCapacity <= 0) throw new TypeError("input capacity must be a positive safe integer");
        const capacity = Math.floor(inputCapacity / factor);
        if (!Number.isSafeInteger(capacity) || capacity < 0) throw new TypeError("curation capacity must be a non-negative safe integer");
        return capacity;
    }
}
