import type { SchemeResult } from "@plurnk/plurnk-schemes";
import Results from "../core/results.ts";

// One neutral public outcome for an otherwise-valid EDIT that loses a resource
// claim or whose observed representation changes before landing. The detection
// layer is absent from the diagnosis: concurrent correct workers are ordinary.
export default class EditCollision {
    static result(
        target: string,
        fields: Readonly<Record<string, unknown>> = {},
        extensions: Readonly<Record<string, unknown>> = {},
    ): SchemeResult {
        return Results.failure(
            "engine:edit",
            "edit-collision",
            409,
            "EDIT coordinates collided with another change.",
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
