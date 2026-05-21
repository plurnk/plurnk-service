import { describe, it } from "node:test";
import assert from "node:assert/strict";
import TextCsv, { parseAll } from "./TextCsv.ts";

const metadata = {
    mimetype: "text/csv",
    glyph: "📊",
    extensions: [".csv"] as const,
};

const h = new TextCsv(metadata);

describe("TextCsv — extract", () => {
    it("extracts header columns as field symbols at line 1", () => {
        const result = h.extract("name,age,role\nalice,30,admin\nbob,25,user\n");
        assert.deepEqual(
            result.map((s) => ({ name: s.name, kind: s.kind, line: s.line })),
            [
                { name: "name", kind: "field", line: 1 },
                { name: "age", kind: "field", line: 1 },
                { name: "role", kind: "field", line: 1 },
            ],
        );
    });

    it("respects quoted fields containing commas", () => {
        const result = h.extract('"name, formal","desc"\nalice,nope\n');
        assert.deepEqual(result.map((s) => s.name), ["name, formal", "desc"]);
    });

    it("unescapes double-quote-inside-quoted-field", () => {
        const result = h.extract('"she said ""hi""",x\nfoo,bar\n');
        assert.deepEqual(result.map((s) => s.name), ['she said "hi"', "x"]);
    });

    it("handles CRLF line endings", () => {
        const result = h.extract("a,b,c\r\n1,2,3\r\n");
        assert.deepEqual(result.map((s) => s.name), ["a", "b", "c"]);
    });

    it("handles file without trailing newline", () => {
        const result = h.extract("a,b,c");
        assert.deepEqual(result.map((s) => s.name), ["a", "b", "c"]);
    });

    it("returns empty array for empty input", () => {
        assert.deepEqual(h.extract(""), []);
    });

    it("emits empty-named symbols for blank headers (column count preserved)", () => {
        const result = h.extract("a,,c\n1,2,3\n");
        assert.deepEqual(result.map((s) => s.name), ["a", "", "c"]);
    });
});

describe("TextCsv — validate", () => {
    it("accepts uniform column-count CSV", () => {
        assert.doesNotThrow(() => h.validate("a,b,c\n1,2,3\n4,5,6\n"));
        assert.doesNotThrow(() => h.validate("a,b\n1,2"));
    });

    it("throws on row with different column count", () => {
        assert.throws(
            () => h.validate("a,b,c\n1,2,3\n4,5\n"),
            /has 2 columns/,
        );
    });

    it("throws on unbalanced quote", () => {
        assert.throws(() => h.validate('a,b\n"unterminated,2\n'));
    });

    it("accepts empty input", () => {
        assert.doesNotThrow(() => h.validate(""));
    });
});

describe("parseAll (RFC 4180 tokenizer)", () => {
    it("parses a multi-row CSV", () => {
        const rows = parseAll("a,b\n1,2\n3,4\n");
        assert.deepEqual(rows, [
            ["a", "b"],
            ["1", "2"],
            ["3", "4"],
        ]);
    });

    it("handles newlines inside quoted fields", () => {
        const rows = parseAll('"line1\nline2","plain"\nrow,2\n');
        assert.deepEqual(rows, [
            ["line1\nline2", "plain"],
            ["row", "2"],
        ]);
    });

    it("preserves leading/trailing whitespace in unquoted fields", () => {
        // RFC 4180 doesn't mandate trimming; we preserve verbatim.
        const rows = parseAll(" a , b \n");
        assert.deepEqual(rows, [[" a ", " b "]]);
    });

    it("throws on unbalanced quote", () => {
        assert.throws(() => parseAll('"unterminated,2\n'));
    });
});
