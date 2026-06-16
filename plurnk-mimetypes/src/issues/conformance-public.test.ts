// #32: the references-conformance harness is public — a third-party handler
// author imports assertHandlerConformance from @plurnk/plurnk-mimetypes/
// conformance and runs the SPEC §16 invariants against their OWN handler
// instance, with no registry involvement. This proves the decoupled entry
// (src/conformance.ts) drives a bare duck handler, the same invariants the
// in-registry suites run through the wrapper.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { assertHandlerConformance } from "../conformance.ts";
import type { ConformanceHandler, ConformanceFixture } from "../conformance.ts";
import type { MimeRef, MimeSymbol } from "../types.ts";

// A minimal synthetic handler: class `Helper` with method `run`, and inside
// run an instantiation of Helper. No tree-sitter, no registry — just the duck
// surface, exactly what a Tier 4 hand-roll author would pass.
const SYMBOLS: MimeSymbol[] = [
    { name: "Helper", kind: "class", line: 1, endLine: 5, column: 7, endColumn: 13 },
    { name: "run", kind: "method", line: 2, endLine: 4, column: 5, endColumn: 8, container: "Helper" },
];
const REFS: MimeRef[] = [
    { name: "Helper", kind: "instantiate", line: 3, column: 9, endLine: 3, endColumn: 15, container: "Helper.run" },
];

const SOURCE = "class Helper {\n  run() {\n    new Helper() // SECRET note\n  }\n}\n";

function handlerWith(refs: MimeRef[]): ConformanceHandler {
    return { extractRaw: () => SYMBOLS, references: () => refs };
}

const FIXTURE: ConformanceFixture = {
    source: SOURCE,
    decoyNames: ["SECRET", "note"],
    expectJoins: [{ refName: "Helper", container: "Helper.run" }],
    expectRefs: [{ name: "Helper", kind: "instantiate" }],
};

describe("#32 — public conformance harness", () => {
    it("a conformant handler passes and returns its symbols + references", async () => {
        const { symbols, references } = await assertHandlerConformance(handlerWith(REFS), FIXTURE);
        assert.equal(symbols.length, 2);
        assert.equal(references.length, 1);
    });

    it("a decoy surfacing as a ref fails the invariant", async () => {
        const leaky = handlerWith([
            ...REFS,
            { name: "SECRET", kind: "call", line: 3, column: 18, endLine: 3, endColumn: 24, container: "Helper.run" },
        ]);
        await assert.rejects(
            () => assertHandlerConformance(leaky, FIXTURE),
            /decoy "SECRET" .* surfaced as a ref/,
        );
    });

    it("a ref whose container is not an emitted def fails", async () => {
        const orphan = handlerWith([
            { name: "Helper", kind: "instantiate", line: 3, column: 9, endLine: 3, endColumn: 15, container: "Nope.gone" },
        ]);
        await assert.rejects(
            () => assertHandlerConformance(orphan, FIXTURE),
            /container "Nope.gone" must be an emitted def path/,
        );
    });

    it("a refs-free handler is rejected — this harness is for refs-emitting handlers", async () => {
        await assert.rejects(
            () => assertHandlerConformance(handlerWith([]), FIXTURE),
            /at least one ref/,
        );
    });
});
