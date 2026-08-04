import {
    DEFAULT_LOOP_FLAGS,
    Validator,
    type LoopFlags,
} from "@plurnk/plurnk-contracts";
import type { Db } from "./Db.ts";

// {§loop-flags-effective-read} — persistence may contain a partial object, but
// runtime policy is always the complete contracts-owned shape.
export default class LoopFlagsReader {
    static parse(raw: string, loopId: number): LoopFlags {
        let partial: unknown;
        try {
            partial = JSON.parse(raw);
        } catch (cause) {
            throw new Error(`Loop ${loopId} has invalid persisted flags JSON.`, { cause });
        }

        if (partial === null || typeof partial !== "object" || Array.isArray(partial)) {
            throw new Error(`Loop ${loopId} has invalid persisted flags.`, {
                cause: new TypeError("Persisted loop flags must be a JSON object."),
            });
        }

        try {
            return Validator.assertLoopFlags({ ...DEFAULT_LOOP_FLAGS, ...partial } as LoopFlags);
        } catch (cause) {
            throw new Error(`Loop ${loopId} has invalid persisted flags.`, { cause });
        }
    }

    static async read(db: Db, loopId: number): Promise<LoopFlags> {
        const row = await db.engine_get_loop_flags.get<{ flags: string }>({ loop_id: loopId });
        if (row === undefined) {
            throw new Error(`Loop ${loopId} does not exist while reading its persisted flags.`);
        }
        return LoopFlagsReader.parse(row.flags, loopId);
    }
}
