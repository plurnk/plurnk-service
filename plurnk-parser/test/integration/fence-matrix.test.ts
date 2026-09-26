// One of the {§pairing-witness} witnesses: every generated cell reads as the matrix expects.
import test from "node:test";
import assert from "node:assert/strict";
import PlurnkParser from "../../src/PlurnkParser.ts";
import { cells } from "./fence-matrix.ts";

const bodyOf = (body: unknown): string => typeof body === "string" ? body : (body as { raw?: string } | null)?.raw ?? "";

for (const cell of cells()) {
    test(`{§balanced-fences} {§fence-pairing}: ${cell.name}`, () => {
        const statements = PlurnkParser.parse(cell.text, { executors: ["sh"] }).items.flatMap((item) => item.kind === "statement" ? [item.statement] : []);
        assert.equal(statements[0]?.op, cell.op, cell.text);
        assert.equal(bodyOf(statements[0] !== undefined && "body" in statements[0] ? statements[0].body : null), cell.body, cell.text);
        assert.deepEqual(statements.slice(1).map((statement) => statement.op), cell.following, cell.text);
    });
}
