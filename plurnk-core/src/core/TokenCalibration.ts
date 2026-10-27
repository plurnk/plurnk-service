import type { Db } from "./Db.ts";

export interface CalibrationSample {
    readonly weight: number;
    readonly reported: number;
}

// {§tokenomics} — provider capacity crosses into the stable
// curation ruler here by the additive offset observed on the latest settled emission.
// Content costs never cross in the opposite direction.
export default class TokenCalibration {
    // One sample fixes the additive offset (weight - reported); without one the offset is 0 (1:1).
    static offset(sample: CalibrationSample | undefined): number {
        if (sample === undefined) return 0;
        for (const [name, value] of Object.entries(sample)) {
            if (!Number.isSafeInteger(value) || value <= 0) throw new TypeError(`calibration sample ${name} must be a positive safe integer`);
        }
        return sample.weight - sample.reported;
    }

    // The offset a packet of this loop converts with: the loop's own latest sample from the model, else the
    // model's most recent sample across any loop or session, else 0.
    static async forLoop(db: Db, model: string, loopId: number): Promise<number> {
        if (model.length === 0) throw new TypeError("calibration requires the model name the provider reports");
        const own = await db.engine_calibration_loop_sample.get<CalibrationSample>({ model, loop_id: loopId });
        return TokenCalibration.offset(own ?? await db.engine_calibration_model_sample.get<CalibrationSample>({ model }));
    }

    // The model's most recent offset across any loop or session, else 0.
    static async forModel(db: Db, model: string): Promise<number> {
        if (model.length === 0) throw new TypeError("calibration requires the model name the provider reports");
        return TokenCalibration.offset(await db.engine_calibration_model_sample.get<CalibrationSample>({ model }));
    }

    static capacity(inputCapacity: number | null, offset = 0): number | null {
        if (!Number.isSafeInteger(offset)) throw new TypeError("calibration offset must be a safe integer");
        if (inputCapacity === null) return null;
        if (!Number.isSafeInteger(inputCapacity) || inputCapacity <= 0) throw new TypeError("input capacity must be a positive safe integer");
        const capacity = Math.max(0, inputCapacity + offset);
        if (!Number.isSafeInteger(capacity)) throw new TypeError("curation capacity must be a non-negative safe integer");
        return capacity;
    }

    static estimatedTokens(weight: number, offset = 0): number {
        if (!Number.isSafeInteger(weight) || weight < 0) throw new TypeError("packet weight must be a non-negative safe integer");
        if (!Number.isSafeInteger(offset)) throw new TypeError("calibration offset must be a safe integer");
        const tokens = Math.max(0, weight - offset);
        if (!Number.isSafeInteger(tokens)) throw new TypeError("estimated tokens must be a non-negative safe integer");
        return tokens;
    }
}
