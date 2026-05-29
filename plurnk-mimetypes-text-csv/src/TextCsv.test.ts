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
        const result = h.extractRaw("name,age,role\nalice,30,admin\nbob,25,user\n");
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
        const result = h.extractRaw('"name, formal","desc"\nalice,nope\n');
        assert.deepEqual(result.map((s) => s.name), ["name, formal", "desc"]);
    });

    it("unescapes double-quote-inside-quoted-field", () => {
        const result = h.extractRaw('"she said ""hi""",x\nfoo,bar\n');
        assert.deepEqual(result.map((s) => s.name), ['she said "hi"', "x"]);
    });

    it("handles CRLF line endings", () => {
        const result = h.extractRaw("a,b,c\r\n1,2,3\r\n");
        assert.deepEqual(result.map((s) => s.name), ["a", "b", "c"]);
    });

    it("handles file without trailing newline", () => {
        const result = h.extractRaw("a,b,c");
        assert.deepEqual(result.map((s) => s.name), ["a", "b", "c"]);
    });

    it("returns empty array for empty input", () => {
        assert.deepEqual(h.extractRaw(""), []);
    });

    it("emits empty-named symbols for blank headers (column count preserved)", () => {
        const result = h.extractRaw("a,,c\n1,2,3\n");
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

describe("TextCsv — query (jsonpath against row objects)", () => {
    const src = [
        "name,role,score",
        "alice,admin,99",
        "bob,user,72",
        "carol,admin,84",
    ].join("\n");

    it("returns the actual cell value as matched", async () => {
        const out = await h.query(src, "jsonpath", "$[0].name");
        assert.equal(out.length, 1);
        assert.equal(out[0].matched, "alice");
    });

    it("returns all values in a column with $[*]", async () => {
        const out = await h.query(src, "jsonpath", "$[*].role");
        assert.equal(out.length, 3);
        assert.deepEqual(out.map((m) => m.matched), ["admin", "user", "admin"]);
    });

    it("supports filter expressions over row objects", async () => {
        const out = await h.query(src, "jsonpath", "$[?(@.role=='admin')].name");
        assert.equal(out.length, 2);
        assert.deepEqual(out.map((m) => m.matched), ["alice", "carol"]);
    });

    it("returns line numbers (header=1, first data row=2, ...)", async () => {
        const out = await h.query(src, "jsonpath", "$[1].name");
        assert.equal(out.length, 1);
        assert.equal(out[0].matched, "bob");
        // bob is on line 3 (header line 1, alice line 2, bob line 3)
        assert.equal(out[0].line, 3);
    });

    it("throws QueryParseFailureError on malformed CSV", async () => {
        await assert.rejects(
            async () => { await h.query('"unterminated', "jsonpath", "$[0]"); },
            (err: unknown) => err instanceof Error && err.name === "QueryParseFailureError",
        );
    });

    it("inherits regex against the raw CSV source", async () => {
        // Need the multiline flag for ^ to anchor at line starts.
        const out = await h.query(src, "regex", "^(\\w+),admin,", "m");
        assert.equal(out.length, 2);
        assert.deepEqual(out[0].matched, ["alice"]);
        assert.deepEqual(out[1].matched, ["carol"]);
    });
});
