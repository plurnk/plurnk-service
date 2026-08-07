import assert from "node:assert/strict";
import { Validator, type TextRegion } from "@plurnk/plurnk-contracts";
import type { HandlerContent } from "./BaseHandler.ts";
import { UnsupportedDialectError } from "./QueryError.ts";
import type { MimeRef, MimeSymbol } from "./types.ts";

// The public conformance harness implements {§mimetype-references} under
// {§mimetype-public-api}. Framework suites and external handler authors run the
// same invariants through one implementation, exposed via
// the `@plurnk/plurnk-mimetypes/conformance` subpath so node:assert stays out
// of the runtime bundle.
//
// A handler whose `references()` returns rows is conformant — and may
// participate in plurnk-service's code graph — only when a real-world-shaped
// fixture passes every invariant in {§mimetype-references}. References-free
// handlers (data formats, symbols-only hand-rolls) do not need this: references
// are a code-graph concept and an empty channel is honest, not a failure.

// Minimal duck surface the harness drives — any handler instance satisfies it
// (BaseHandler and its subclasses do structurally). Typed locally so an author
// passes their handler regardless of how it is declared.
export interface ConformanceHandler {
    extractRaw(content: string): MimeSymbol[] | Promise<MimeSymbol[]>;
    references(content: string): MimeRef[] | Promise<MimeRef[]>;
}

export interface ConformanceFixture {
    // Real-world-shaped source for the handler's mimetype. Not a synthetic
    // minimal snippet — the invariants only mean something against code that
    // exercises strings, comments, nesting, and cross-references.
    source: string;
    // Substrings that appear in `source` ONLY inside string literals or
    // comments. The harness asserts none surface as a ref name — the
    // leaf-harvest noise class the references channel exists to exclude.
    decoyNames: readonly string[];
    // At least one expected (container, name) join: a ref that resolves to a
    // local def by plurnk-service's join rule (ref.name === a def's name AND
    // ref.container === that def's emitted path). Proves the join works on
    // real output, not just that rows exist.
    expectJoins: ReadonlyArray<{ refName: string; container: string }>;
    // Spot-check expectations: every entry must appear among the refs. `line`
    // and `container` are matched when present.
    expectRefs: ReadonlyArray<Partial<MimeRef> & { name: string; kind: MimeRef["kind"] }>;
}

export interface ConformanceResult {
    symbols: MimeSymbol[];
    references: MimeRef[];
}

// Run the {§mimetype-references} invariants against a handler + fixture. Throws an
// AssertionError (node:assert) on the first violation — wire it into a
// `node:test` `it(...)` per fixture. Returns the materialized symbols + refs
// for any additional handler-specific assertions the author wants to add.
export async function assertHandlerConformance(
    handler: ConformanceHandler,
    fixture: ConformanceFixture,
): Promise<ConformanceResult> {
    const symbols = await handler.extractRaw(fixture.source);
    const references = await handler.references(fixture.source);

    // ——— Shared invariants ({§mimetype-references}) ———

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

// Structural-query evidence conformance.
//
// A query result has exactly one honest verdict:
// - "exact": an exact region in the text the model can READ.
// - "enclosing": the nearest honest enclosing region in that text.
// - "locator-only": a canonical structural locator without a text region.
// - "unsupported": the handler rejects the dialect explicitly.
//
// "defect" is deliberately not a passing verdict. A missing, fabricated, or
// incorrectly classified result fails the gate.

export interface QueryEvidenceCase {
    source: HandlerContent;
    dialect: "jsonpath" | "xpath" | "regex" | "glob";
    pattern: string;
    verdict: "exact" | "enclosing" | "locator-only" | "unsupported";
    expectRegions?: ReadonlyArray<ReadonlyArray<TextRegion>>;
}

export interface QueryEvidenceConformanceHandler {
    query(
        content: HandlerContent,
        dialect: string,
        pattern: string,
        flags?: string,
    ): Promise<ReadonlyArray<{
        matched: unknown;
        matching?: string;
        regions?: ReadonlyArray<TextRegion>;
    }>>;
}

export async function assertQueryEvidenceConformance(
    handler: QueryEvidenceConformanceHandler,
    cases: readonly QueryEvidenceCase[],
): Promise<void> {
    for (const c of cases) {
        const label = `${c.dialect} \`${c.pattern}\``;
        if (c.verdict === "unsupported") {
            await assert.rejects(
                () => handler.query(c.source, c.dialect, c.pattern),
                (cause: unknown) => cause instanceof UnsupportedDialectError,
                `${label}: unsupported verdict must throw UnsupportedDialectError`,
            );
            continue;
        }

        const matches = await handler.query(c.source, c.dialect, c.pattern);
        assert.ok(matches.length > 0, `${label}: produced no matches; not a conformance signal`);

        if (c.verdict === "locator-only") {
            for (const m of matches) {
                assert.equal(
                    m.regions,
                    undefined,
                    `${label}: locator-only match fabricated text regions: ${JSON.stringify(m.regions)}`,
                );
                assert.ok(
                    typeof m.matching === "string" && m.matching.length > 0,
                    `${label}: locator-only match omitted its canonical locator`,
                );
            }
            continue;
        }

        assert.ok(
            c.expectRegions !== undefined,
            `${label}: ${c.verdict} verdict must declare complete expected regions`,
        );
        for (const m of matches) {
            assert.ok(
                Array.isArray(m.regions) && m.regions.length > 0,
                `${label}: ${c.verdict} match has no region: ${JSON.stringify(m.matched)}`,
            );
            for (const region of m.regions!) {
                assertTextRegion(region, label);
            }
        }
        assert.deepEqual(
            matches.map((match) => match.regions),
            c.expectRegions,
            `${label}: ${c.verdict} regions mismatch`,
        );
    }
}

/** @deprecated Use QueryEvidenceCase with complete TextRegion expectations. */
export interface QueryLineCase {
    source: string;
    dialect: "jsonpath" | "xpath" | "regex" | "glob";
    pattern: string;
    expectStartLines?: readonly number[];
    scalar?: boolean;
}

/** @deprecated Use QueryEvidenceConformanceHandler. */
export interface QueryConformanceHandler {
    query(
        content: string,
        dialect: string,
        pattern: string,
        flags?: string,
    ): Promise<ReadonlyArray<{
        matched: unknown;
        matching?: string;
        regions?: ReadonlyArray<TextRegion>;
        lines?: ReadonlyArray<{ line: number; endLine: number }>;
    }>>;
}

/** @deprecated Use assertQueryEvidenceConformance with complete TextRegion expectations. */
export async function assertQueryLineConformance(
    handler: QueryConformanceHandler,
    cases: readonly QueryLineCase[],
): Promise<void> {
    for (const c of cases) {
        const matches = await handler.query(c.source, c.dialect, c.pattern);
        const normalized = matches.map((match) => ({
            matched: match.matched,
            ...(match.matching !== undefined || c.scalar === true
                ? { matching: match.matching ?? c.pattern }
                : {}),
            ...(match.regions !== undefined
                ? { regions: match.regions }
                : match.lines !== undefined
                    ? { regions: match.lines.map(({ line, endLine }) => ({
                        startLine: line,
                        startColumn: 1,
                        endLine,
                        endColumn: 1,
                    })) }
                    : {}),
        }));
        const expectedRegions = normalized.map((match) => match.regions ?? []);
        await assertQueryEvidenceConformance(
            { query: async () => normalized },
            [{
                source: c.source,
                dialect: c.dialect,
                pattern: c.pattern,
                verdict: c.scalar === true ? "locator-only" : "exact",
                ...(c.scalar === true ? {} : { expectRegions: expectedRegions }),
            }],
        );
        if (c.expectStartLines !== undefined) {
            assert.deepEqual(
                normalized.map((match) => match.regions?.[0]?.startLine),
                [...c.expectStartLines],
                `${c.dialect} \`${c.pattern}\`: match start lines mismatch`,
            );
        }
    }
}

function assertTextRegion(region: TextRegion, label: string): void {
    try {
        Validator.assertTextRegion(region);
    } catch (cause) {
        assert.fail(`${label}: invalid TextRegion ${JSON.stringify(region)}: ${String(cause)}`);
    }
}
