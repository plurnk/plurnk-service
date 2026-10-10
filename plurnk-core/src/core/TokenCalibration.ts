import type { Db } from "./Db.ts";

export interface CalibrationSample {
    readonly weight: number;
    readonly reported: number;
}

// {§tokenomics-calibrated-readout} — provider capacity crosses into the stable
// curation ruler here. Content costs never cross in the opposite direction.
export default class TokenCalibration {
    // One sample fixes the factor; without one the conversion is 1:1.
    static factor(sample: CalibrationSample | undefined): number {
        if (sample === undefined) return 1;
        for (const [name, value] of Object.entries(sample)) {
            if (!Number.isSafeInteger(value) || value <= 0) throw new TypeError(`calibration sample ${name} must be a positive safe integer`);
        }
        return sample.reported / sample.weight;
    }

    // The factor a packet of this loop converts with: the loop's own first sample from the model, else the
    // model's most recently fixed one, else 1.
    static async forLoop(db: Db, model: string, loopId: number): Promise<number> {
        if (model.length === 0) throw new TypeError("calibration requires the model name the provider reports");
        const own = await db.engine_calibration_loop_sample.get<CalibrationSample>({ model, loop_id: loopId });
        return TokenCalibration.factor(own ?? await db.engine_calibration_model_sample.get<CalibrationSample>({ model }));
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
