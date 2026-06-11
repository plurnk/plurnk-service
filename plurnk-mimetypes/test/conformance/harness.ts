import assert from "node:assert/strict";
import TreeSitterLanguageHandler from "../../src/treesitter/handler.ts";
import { lookupTreeSitterLanguage } from "../../src/treesitter/registry.ts";
import type { MimeRef, MimeSymbol } from "../../src/types.ts";

// Cross-language conformance harness for the defs + refs channels
// (issue #20; invariants from SPEC §16). Each language's conformance test
// supplies a fixture and its expectations; this harness runs the shared
// invariants every language must satisfy. A language participates in the
// service's graph only when its suite is green.

export interface ConformanceFixture {
    mimetype: string;
    source: string;
    // Substrings that appear in the fixture ONLY inside string literals or
    // comments — the harness asserts none of them surface as a ref name
    // (the leaf-harvest noise class the channel exists to prevent).
    decoyNames: readonly string[];
    // At least one expected (container, name) join: a ref that resolves to a
    // local def by the service's join rule — proves the schema's join works
    // on real output.
    expectJoins: ReadonlyArray<{ refName: string; container: string }>;
    // Spot-check expectations: every entry must appear among the refs.
    expectRefs: ReadonlyArray<Partial<MimeRef> & { name: string; kind: MimeRef["kind"] }>;
}

export interface ConformanceResult {
    symbols: MimeSymbol[];
    references: MimeRef[];
}

export async function runConformance(fixture: ConformanceFixture): Promise<ConformanceResult> {
    const entry = lookupTreeSitterLanguage(fixture.mimetype);
    assert.ok(entry, `no registry entry for ${fixture.mimetype}`);
    const handler = new TreeSitterLanguageHandler(
        { mimetype: entry.mimetype, glyph: entry.glyph, extensions: entry.extensions },
        entry,
    );
    const symbols = await handler.extractRaw(fixture.source);
    const references = await handler.references(fixture.source);

    // ——— Shared invariants (SPEC §16) ———

    assert.ok(references.length > 0, "fixture must produce at least one ref");

    const defPaths = new Set(
        symbols.map((s) => (s.container !== undefined ? `${s.container}.${s.name}` : s.name)),
    );
    const defNames = new Set(symbols.map((s) => s.name));

    for (const ref of references) {
        const label = `${ref.kind} ${ref.name} @${ref.line}:${ref.column}`;
        // 1-indexed positions, sane ranges, columns always present.
        assert.ok(ref.line >= 1, `1-indexed line: ${label}`);
        assert.ok(ref.column >= 1, `1-indexed column: ${label}`);
        assert.ok(ref.endLine >= ref.line, `endLine >= line: ${label}`);
        assert.equal(typeof ref.endColumn, "number", `endColumn present: ${label}`);
        // Every container names an enclosing def emitted by the same entry.
        if (ref.container !== undefined) {
            assert.ok(
                defPaths.has(ref.container),
                `container "${ref.container}" must be an emitted def path: ${label}`,
            );
        }
        // No definitions in the refs stream: a ref at the exact position of
        // a same-named def would be the def's own name node.
        const collidingDef = symbols.find(
            (s) => s.name === ref.name && s.line === ref.line && s.column === ref.column,
        );
        assert.equal(collidingDef, undefined, `ref must not be a def's own name node: ${label}`);
    }

    // Deterministic document order.
    for (let i = 1; i < references.length; i += 1) {
        const prev = references[i - 1];
        const cur = references[i];
        assert.ok(
            cur.line > prev.line || (cur.line === prev.line && cur.column >= prev.column),
            `document order violated at index ${i}`,
        );
    }

    // String/comment decoys never surface.
    for (const decoy of fixture.decoyNames) {
        assert.ok(
            !references.some((r) => r.name === decoy),
            `decoy "${decoy}" (string/comment content) surfaced as a ref`,
        );
    }

    // The service's join works: ref.name matches a local def name AND
    // ref.container equals an emitted def path.
    for (const join of fixture.expectJoins) {
        const ref = references.find(
            (r) => r.name === join.refName && r.container === join.container,
        );
        assert.ok(
            ref,
            `expected join ref "${join.refName}" with container "${join.container}"; `
            + `got: ${JSON.stringify(references.map((r) => ({ n: r.name, c: r.container })))}`,
        );
        assert.ok(defNames.has(join.refName), `join target "${join.refName}" must be a local def`);
    }

    // Spot-check expected refs.
    for (const expected of fixture.expectRefs) {
        const found = references.find((r) =>
            r.name === expected.name
            && r.kind === expected.kind
            && (expected.line === undefined || r.line === expected.line)
            && (expected.container === undefined || r.container === expected.container));
        assert.ok(
            found,
            `expected ref ${JSON.stringify(expected)}; `
            + `got: ${JSON.stringify(references.map((r) => ({ n: r.name, k: r.kind, l: r.line, c: r.container })))}`,
        );
    }

    return { symbols, references };
}
