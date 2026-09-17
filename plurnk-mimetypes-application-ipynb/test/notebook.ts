import { Validator } from "@plurnk/plurnk-contracts";
import schema from "./nbformat.v4.5.schema.json" with { type: "json" };

// Jupyter nbformat v5.10.4, nbformat/v4/nbformat.v4.5.schema.json; see NBFORMAT-LICENSE.
export function assertNotebook<T>(value: T): T {
    return Validator.assertJsonSchemaInstance("nbformat v4.5 fixture", schema, value);
}

export function notebook(value: unknown, space?: number): string {
    return JSON.stringify(assertNotebook(value), null, space);
}
