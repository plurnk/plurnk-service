// Issue #42: Mimetypes.query accepts a parsed-form matcher, not only a raw
// string — consume the grammar's already-parsed { dialect, pattern, flags } so
// there's no second parser for the matcher syntax (no drift).
// https://github.com/plurnk/plurnk-mimetypes/issues/42
//
// Load-bearing claims, restated as tests of the contract (not the impl):
//
//   C1. Mimetypes.query accepts a parsed body `{ dialect, pattern, flags? }`
//       (the shape @plurnk/plurnk-grammar produces) in addition to a raw string.
//   C2. The parsed form and the equivalent raw string produce identical results
//       across every dialect, and both carry m.lines (#41) uniformly.
//   C3. The parsed form dispatches by its EXPLICIT dialect — it does NOT re-parse
//       the pattern by leading prefix. A pattern that the prefix-parser would
//       classify as another dialect (e.g. "//foo" → xpath) still runs under the
//       dialect the caller declared (regex). This is the anti-drift guarantee.
//
// These enforce the promise, not the wiring: a future change that re-derives the
// dialect from the parsed pattern, or drops the parsed-form overload, fails here.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import Mimetypes from "../Mimetypes.ts";
import BaseHandler from "../BaseHandler.ts";
import type { Discovery, HandlerInfo, MimeSymbol, Registry } from "../types.ts";

function makeDiscovery(handlers: HandlerInfo[]): Discovery {
    const byExtension = new Map<string, string>();
    const byFilename = new Map<string, string>();
    const handlerMap = new Map<string, HandlerInfo>();
    for (const info of handlers) {
        handlerMap.set(info.mimetype, info);
        for (const ext of info.extensions) byExtension.set(ext.toLowerCase(), info.mimetype);
    }
    const registry: Registry = { byExtension, byFilename };
    return { registry, handlers: handlerMap };
}

// A handler that supports all four dialects: regex/glob over text, jsonpath over
// deepJson, xpath over the projected deep-xml.
class FakeQueryHandler extends BaseHandler {
    override extractRaw(_content: string | Uint8Array): MimeSymbol[] {
        return [{ name: "module", kind: "module", line: 1, endLine: 3 }];
    }
    override deepJson(_content: string | Uint8Array): unknown {
        return {
            type: "module", line: 1, endLine: 3,
            children: [{ type: "method", line: 2, endLine: 2, name: "greet" }],
        };
    }
}

const info: HandlerInfo = {
    mimetype: "text/x-fake",
    glyph: "🧪",
    packageName: "@plurnk/plurnk-mimetypes-text-fake",
    extensions: [".fake"],
    binary: false,
    source: "package",
};

function makeMimetypes(): Mimetypes {
    return new Mimetypes({
        discovery: makeDiscovery([info]),
        loader: async () => ({ default: FakeQueryHandler }),
    });
}

// Two source lines, with the literal "//foo" on line 2 so a regex hit is
// line-locatable and distinct from an xpath interpretation of the same pattern.
const SOURCE = "alpha\n//foo bar\n";
const INPUT = { path: "f.fake", content: SOURCE };

describe("Issue #42 — C1: parsed-form matcher is accepted alongside the raw string", () => {
    it("dispatches a parsed { dialect, pattern } object", async () => {
        const m = makeMimetypes();
        const out = await m.query(INPUT, { dialect: "jsonpath", pattern: "$..children[*]" });
        assert.equal(out.length, 1);
        assert.deepEqual(out[0].lines, [{ line: 2, endLine: 2 }]);
    });
});

describe("Issue #42 — C2: parsed and raw forms agree, with m.lines, on every dialect", () => {
    const cases: ReadonlyArray<{ raw: string; parsed: { dialect: "regex" | "glob" | "jsonpath" | "xpath"; pattern: string; flags?: string } }> = [
        { raw: "/foo/", parsed: { dialect: "regex", pattern: "foo" } },
        { raw: "*foo*", parsed: { dialect: "glob", pattern: "*foo*" } },
        { raw: "$..children[*]", parsed: { dialect: "jsonpath", pattern: "$..children[*]" } },
        { raw: "//method", parsed: { dialect: "xpath", pattern: "//method" } },
    ];
    for (const { raw, parsed } of cases) {
        it(`${parsed.dialect}: raw "${raw}" === parsed, both carry lines`, async () => {
            const rawOut = await makeMimetypes().query(INPUT, raw);
            const parsedOut = await makeMimetypes().query(INPUT, parsed);
            assert.deepEqual(parsedOut, rawOut, "parsed form must match raw-string dispatch exactly");
            assert.ok(parsedOut.length > 0, "expected at least one match");
            for (const m of parsedOut) {
                assert.ok(m.lines && m.lines.length > 0 && m.lines[0].line >= 1, "every match carries a source-line span");
            }
        });
    }
});

describe("Issue #42 — C3: parsed dialect is authoritative; no re-parse by prefix (anti-drift)", () => {
    it("a parsed { regex, '//foo' } runs as regex even though '//foo' string-classifies as xpath", async () => {
        const m = makeMimetypes();
        // As a regex over the source text, "//foo" matches the literal on line 2.
        const asRegex = await m.query(INPUT, { dialect: "regex", pattern: "//foo" });
        assert.equal(asRegex.length, 1);
        assert.equal(asRegex[0].matched, "//foo");
        assert.deepEqual(asRegex[0].lines, [{ line: 2, endLine: 2 }]);

        // The same text passed as the raw string "//foo" classifies as xpath and
        // selects <foo> elements — of which there are none. Different dialect,
        // different result: proof the parsed form did NOT re-derive the dialect.
        const asString = await makeMimetypes().query(INPUT, "//foo");
        assert.deepEqual(asString, []);
    });
});
