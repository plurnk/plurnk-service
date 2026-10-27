import { describe, it } from "node:test";
import assert from "node:assert/strict";
import TextCsv, { parseAll } from "./TextCsv.ts";
import { assertQueryEvidenceConformance } from "@plurnk/plurnk-mimetypes/conformance";
import { readFile } from "node:fs/promises";

// ─── TextCsv.test.ts ───
{
const metadata = {
    mimetype: "text/csv",
    glyph: "📊",
    extensions: [".csv"] as const,
};

const h = new TextCsv(metadata);

describe("{§csv-records} TextCsv extract: header names as field symbols", () => {
    it("{§csv-records} extracts header columns as field symbols at line 1", () => {
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

    it("{§csv-records} respects quoted fields containing commas", () => {
        const result = h.extractRaw('"name, formal","desc"\nalice,nope\n');
        assert.deepEqual(result.map((s) => s.name), ["name, formal", "desc"]);
    });

    it("{§csv-records} a multiline header has the full header record's span", () => {
        assert.deepEqual(h.extractRaw('"first\nname",other\na,1'), [
            { name: "first\nname", kind: "field", line: 1, endLine: 2 },
            { name: "other", kind: "field", line: 1, endLine: 2 },
        ]);
    });

    it("{§csv-records} unescapes double-quote-inside-quoted-field", () => {
        const result = h.extractRaw('"she said ""hi""",x\nfoo,bar\n');
        assert.deepEqual(result.map((s) => s.name), ['she said "hi"', "x"]);
    });

    it("{§csv-records} handles CRLF line endings", () => {
        const result = h.extractRaw("a,b,c\r\n1,2,3\r\n");
        assert.deepEqual(result.map((s) => s.name), ["a", "b", "c"]);
    });

    it("{§csv-records} handles file without trailing newline", () => {
        const result = h.extractRaw("a,b,c");
        assert.deepEqual(result.map((s) => s.name), ["a", "b", "c"]);
    });

    it("{§csv-records} returns empty array for empty input", () => {
        assert.deepEqual(h.extractRaw(""), []);
    });

    it("{§csv-records} emits empty-named symbols for blank headers (column count preserved)", () => {
        const result = h.extractRaw("a,,c\n1,2,3\n");
        assert.deepEqual(result.map((s) => s.name), ["a", "", "c"]);
    });
});

describe("{§mimetype-channel-selection} TextCsv validate", () => {
    it("{§csv-records} accepts uniform column-count CSV", () => {
        assert.doesNotThrow(() => h.validate("a,b,c\n1,2,3\n4,5,6\n"));
        assert.doesNotThrow(() => h.validate("a,b\n1,2"));
    });

    it("{§csv-records} throws on row with different column count", () => {
        assert.throws(
            () => h.validate("a,b,c\n1,2,3\n4,5\n"),
            /has 2 columns/,
        );
    });

    it("{§csv-records} throws on unbalanced quote", () => {
        assert.throws(() => h.validate('a,b\n"unterminated,2\n'));
    });

    it("{§csv-records} accepts empty input", () => {
        assert.doesNotThrow(() => h.validate(""));
    });
});

describe("{§csv-records} parseAll (RFC 4180 tokenizer)", () => {
    it("{§csv-records} retains an empty quoted field at EOF as a record", () => {
        assert.deepEqual(parseAll('""'), [[""]]);
        assert.deepEqual(parseAll('name\n""'), [["name"], [""]]);
    });

    it("{§csv-records} keeps __proto__ as a data column", () => {
        const rows = h.deepJson("__proto__,value\nhello,world");
        assert.deepEqual(rows, [JSON.parse('{"__proto__":"hello","value":"world"}')]);
    });

    it("{§csv-records} parses a multi-row CSV", () => {
        const rows = parseAll("a,b\n1,2\n3,4\n");
        assert.deepEqual(rows, [
            ["a", "b"],
            ["1", "2"],
            ["3", "4"],
        ]);
    });

    it("{§csv-records} handles newlines inside quoted fields", () => {
        const rows = parseAll('"line1\nline2","plain"\nrow,2\n');
        assert.deepEqual(rows, [
            ["line1\nline2", "plain"],
            ["row", "2"],
        ]);
    });

    it("{§csv-records} preserves leading/trailing whitespace in unquoted fields", () => {
        // RFC 4180 doesn't mandate trimming; we preserve verbatim.
        const rows = parseAll(" a , b \n");
        assert.deepEqual(rows, [[" a ", " b "]]);
    });

    it("{§csv-records} throws on unbalanced quote", () => {
        assert.throws(() => parseAll('"unterminated,2\n'));
    });
});

describe("{§mimetype-query} TextCsv query: jsonpath against row objects", () => {
    const src = [
        "name,role,score",
        "alice,admin,99",
        "bob,user,72",
        "carol,admin,84",
    ].join("\n");

    it("{§csv-records} returns the actual cell value as matched", async () => {
        const out = await h.query(src, "jsonpath", "$[0].name");
        assert.equal(out.length, 1);
        assert.equal(out[0].matched, "alice");
    });

    it("{§csv-records} returns all values in a column with $[*]", async () => {
        const out = await h.query(src, "jsonpath", "$[*].role");
        assert.equal(out.length, 3);
        assert.deepEqual(out.map((m) => m.matched), ["admin", "user", "admin"]);
    });

    it("{§csv-records} supports filter expressions over row objects", async () => {
        const out = await h.query(src, "jsonpath", "$[?(@.role=='admin')].name");
        assert.equal(out.length, 2);
        assert.deepEqual(out.map((m) => m.matched), ["alice", "carol"]);
    });

    it("{§csv-records} returns the selected field's exact source region", async () => {
        const out = await h.query(src, "jsonpath", "$[1].name");
        assert.equal(out.length, 1);
        assert.equal(out[0].matched, "bob");
        // bob is on line 3 (header line 1, alice line 2, bob line 3)
        assert.deepEqual(out[0].regions, [{
            startLine: 3, startColumn: 1, endLine: 3, endColumn: 4,
        }]);
    });

    it("{§csv-records} throws QueryParseFailureError on malformed CSV", async () => {
        await assert.rejects(
            async () => { await h.query('"unterminated', "jsonpath", "$[0]"); },
            (err: unknown) => err instanceof Error && err.name === "QueryParseFailureError",
        );
    });

    it("{§csv-records} inherits regex against the raw CSV source", async () => {
        // Need the multiline flag for ^ to anchor at line starts.
        const out = await h.query(src, "regex", "^(\\w+),admin,", "m");
        assert.equal(out.length, 2);
        assert.deepEqual(out[0].matched, ["alice"]);
        assert.deepEqual(out[1].matched, ["carol"]);
    });
});
}

// ─── queryEvidence.conformance.test.ts ───
{
// {§mimetype-query}: records and fields retain actual physical source spans.
const h = new TextCsv({"mimetype":"text/csv","glyph":"📊","extensions":[".csv"]});
const src = "name,age\nalice,30\nbob,25\n";

describe("{§mimetype-query} query-evidence conformance (both dialects)", () => {
    for (const eol of ["\n", "\r\n", "\r"]) for (const dialect of ["jsonpath", "xpath"] as const) {
        it(`{§csv-records} ${dialect} locates a multiline record and the record after it, ${JSON.stringify(eol)}`, async () => {
            const source = ['name,note', 'alice,"first', 'second"', 'bob,ok'].join(eol);
            await assertQueryEvidenceConformance(h, [
                {
                    source, dialect,
                    pattern: dialect === "jsonpath" ? "$[0].note" : "//item[1]/note",
                    verdict: "exact",
                    expectRegions: [[{ startLine: 2, startColumn: 7, endLine: 3, endColumn: 8 }]],
                },
                {
                    source, dialect,
                    pattern: dialect === "jsonpath" ? "$[1].name" : "//item[2]/name",
                    verdict: "exact",
                    expectRegions: [[{ startLine: 4, startColumn: 1, endLine: 4, endColumn: 4 }]],
                },
            ]);
        });
    }

    it("{§csv-records} jsonpath distinguishes exact rows from exact field evidence", async () => {
        await assertQueryEvidenceConformance(h, [
            {
                source: src,
                dialect: "jsonpath",
                pattern: "$[0]",
                verdict: "exact",
                expectRegions: [[{
                    startLine: 2, startColumn: 1, endLine: 2, endColumn: 9,
                }]],
            },
            {
                source: src,
                dialect: "jsonpath",
                pattern: "$[0].name",
                verdict: "exact",
                expectRegions: [[{
                    startLine: 2, startColumn: 1, endLine: 2, endColumn: 6,
                }]],
            },
        ]);
    });
    it("{§csv-records} xpath distinguishes exact rows from exact field evidence", async () => {
        await assertQueryEvidenceConformance(h, [
            {
                source: src,
                dialect: "xpath",
                pattern: "//item[1]",
                verdict: "exact",
                expectRegions: [[{
                    startLine: 2, startColumn: 1, endLine: 2, endColumn: 9,
                }]],
            },
            {
                source: src,
                dialect: "xpath",
                pattern: "//item[1]/name",
                verdict: "exact",
                expectRegions: [[{
                    startLine: 2, startColumn: 1, endLine: 2, endColumn: 6,
                }]],
            },
        ]);
    });
});
}

// ─── spectrum.test.ts ───
{
const { fixtures } = JSON.parse(await readFile(new URL("../test/fixtures/csv-spectrum.json", import.meta.url), "utf8")) as {
    fixtures: Array<{ name: string; csvBase64: string; expectedJson: string }>;
};
const handler = new TextCsv({ mimetype: "text/csv", glyph: "📊", extensions: [".csv"] });

describe("{§csv-records} csv-spectrum 2.0.0", () => {
    for (const { name, csvBase64, expectedJson } of fixtures) {
        const source = Buffer.from(csvBase64, "base64").toString("utf8");
        const csv = name.endsWith("_crlf") ? source.replaceAll("\n", "\r\n") : source;
        const expected = JSON.parse(expectedJson);
        if (name === "location_coordinates") {
            it("{§csv-records} identifies the upstream inconsistent oracle, not a passing parser case", () => {
                assert.equal(Array.isArray(expected), false, "the other corpus expectations are arrays");
                assert.equal(expected["Contact Phone Number"], "1234567890");
                assert.equal(csv.split("\n")[1].split(",")[0], "2095257564");
                assert.notEqual(parseAll(csv)[1][0], expected["Contact Phone Number"]);
            });
            continue;
        }
        it(name, () => {
            assert.doesNotThrow(() => handler.validate(csv));
            assert.deepEqual(handler.deepJson(csv), expected);
            assert.deepEqual(parseAll(csv).slice(1), expected.map((row: Record<string, string>) => Object.values(row)));
        });
    }
});
}
