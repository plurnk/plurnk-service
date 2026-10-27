import type { SchemeResult } from "@plurnk/plurnk-schemes";
import Results from "../core/results.ts";

// {§edit} — current-state failure, without inferring earlier validity,
// another writer, or fault from a failed precondition.
export default class EditCollision {
    static result(target: string): SchemeResult;
    static result<F extends Readonly<Record<string, unknown>>>(
        target: string,
        fields: F,
        extensions?: Readonly<Record<string, unknown>>,
    ): SchemeResult & F;
    static result(
        target: string,
        fields: Readonly<Record<string, unknown>> = {},
        extensions: Readonly<Record<string, unknown>> = {},
    ): SchemeResult {
        return Results.failure(
            "engine:edit",
            "edit-collision",
            409,
            "EDIT collided with the current resource state.",
            fields,
            {
                target,
                recovery: "READ the target again before selecting current coordinates.",
                retryable: false,
                ...extensions,
            },
        );
    }
}
