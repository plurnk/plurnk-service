import { Validator, type LoopPolicy } from "@plurnk/plurnk-contracts";
import type { Db } from "./Db.ts";

// {§loop-policy-effective-read} — persistence contains one complete immutable
// contracts-owned policy snapshot.
export default class LoopPolicyReader {
    static parse(raw: string, loopId: number): LoopPolicy {
        let partial: unknown;
        try {
            partial = JSON.parse(raw);
        } catch (cause) {
            throw new Error(`Loop ${loopId} has invalid persisted policy JSON.`, { cause });
        }

        if (partial === null || typeof partial !== "object" || Array.isArray(partial)) {
            throw new Error(`Loop ${loopId} has invalid persisted policy.`, {
                cause: new TypeError("Persisted loop policy must be a JSON object."),
            });
        }

        try {
            return Validator.assertLoopPolicy(partial as LoopPolicy);
        } catch (cause) {
            throw new Error(`Loop ${loopId} has invalid persisted policy.`, { cause });
        }
    }

    static async read(db: Db, loopId: number): Promise<LoopPolicy> {
        const row = await db.engine_get_loop_policy.get<{ policy: string }>({ loop_id: loopId });
        if (row === undefined) {
            throw new Error(`Loop ${loopId} does not exist while reading its persisted policy.`);
        }
        return LoopPolicyReader.parse(row.policy, loopId);
    }
}
