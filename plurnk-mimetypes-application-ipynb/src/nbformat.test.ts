import assert from "node:assert/strict";
import { it } from "node:test";
import { InvalidJsonSchemaInstanceError } from "@plurnk/plurnk-contracts";
import { assertNotebook } from "../test/notebook.ts";

it("the nbformat v4.5 oracle rejects a missing cell ID, not merely invalid JSON", () => {
    const value = {
        nbformat: 4, nbformat_minor: 5, metadata: {},
        cells: [{ cell_type: "markdown", metadata: {}, source: "# Heading", id: "heading" }],
    };
    assert.doesNotThrow(() => assertNotebook(value));
    const { id: _id, ...withoutId } = value.cells[0];
    assert.throws(() => assertNotebook({ ...value, cells: [withoutId] }), (error: unknown) => {
        assert.ok(error instanceof InvalidJsonSchemaInstanceError);
        assert.ok(error.message.includes('required property \\"id\\"'));
        return true;
    });
});
