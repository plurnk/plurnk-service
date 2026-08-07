// Contracts: {§mimetype-query}, {§mimetype-query-conformance}.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { outlineLineFor, queryGlob, queryJsonpathObject, queryRegex, queryXpathString } from "./query.ts";
import { projectJsonToXml } from "./projectJsonToXml.ts";
import { InvalidExpressionError } from "./QueryError.ts";

describe("queryRegex — bare patterns", () => {
    it("returns a string `matched` per global match", () => {
        const out = queryRegex("foo bar foo", "foo");
        assert.equal(out.length, 2);
        assert.equal(out[0].matched, "foo");
        assert.equal(out[1].matched, "foo");
    });

    it("computes exact text regions from the offset of each match", () => {
        const text = "alpha\nbeta\ngamma\nbeta";
        const out = queryRegex(text, "beta");
        assert.equal(out.length, 2);
        assert.deepEqual(out[0].regions, [{
            startLine: 2, startColumn: 1, endLine: 2, endColumn: 5,
        }]);
        assert.deepEqual(out[1].regions, [{
            startLine: 4, startColumn: 1, endLine: 4, endColumn: 5,
        }]);
    });

    it("spans a multi-line match across its lines", () => {
        const out = queryRegex("a\nstart x\ny end\nb", "start[\\s\\S]*end");
        assert.equal(out.length, 1);
        assert.deepEqual(out[0].regions, [{
            startLine: 2, startColumn: 1, endLine: 3, endColumn: 6,
        }]);
    });

    it("reports the smallest enclosing region when a match bisects CRLF", () => {
        const out = queryRegex("a\r\nb", "\\n");
        assert.equal(out.length, 1);
        assert.deepEqual(out[0].regions, [{
            startLine: 1, startColumn: 2, endLine: 2, endColumn: 1,
        }]);
    });

    it("returns an empty array when nothing matches", () => {
        assert.deepEqual(queryRegex("foo", "bar"), []);
    });
});

describe("queryRegex — anonymous captures", () => {
    it("returns an array of captures under {§mimetype-query}", () => {
        const out = queryRegex("name: alice", "(\\w+): (\\w+)");
        assert.equal(out.length, 1);
        assert.deepEqual(out[0].matched, ["name", "alice"]);
    });

    it("handles multiple matches with anonymous captures", () => {
        const out = queryRegex("a=1 b=2", "(\\w)=(\\d)");
        assert.equal(out.length, 2);
        assert.deepEqual(out[0].matched, ["a", "1"]);
        assert.deepEqual(out[1].matched, ["b", "2"]);
    });
});

describe("queryRegex — named captures", () => {
    it("returns an object with named keys", () => {
        const out = queryRegex("key: value", "(?<key>\\w+): (?<val>\\w+)");
        assert.equal(out.length, 1);
        assert.deepEqual(out[0].matched, { key: "key", val: "value", "1": "key", "2": "value" });
    });

    it("includes positional keys '1', '2' alongside named when mixed", () => {
        const out = queryRegex("foo bar", "(\\w+) (?<second>\\w+)");
        const matched = out[0].matched as Record<string, string>;
        assert.equal(matched["1"], "foo");
        assert.equal(matched["second"], "bar");
        assert.equal(matched["2"], "bar");
    });
});

describe("queryRegex — flag handling", () => {
    it("honors case-insensitive flag", () => {
        const out = queryRegex("Foo FOO foo", "foo", "i");
        assert.equal(out.length, 3);
    });

    it("does not double-globalize already-global flags", () => {
        const out = queryRegex("foo foo", "foo", "g");
        assert.equal(out.length, 2);
    });

    it("does not infinite-loop on zero-length matches", () => {
        const out = queryRegex("abc", "()");
        // 4 zero-width positions in "abc": before/between/after each char
        assert.equal(out.length, 4);
    });

    it("advances zero-length Unicode matches by code point", () => {
        const out = queryRegex("😀", "()", "u");
        assert.equal(out.length, 2);
        assert.deepEqual(out.map(({ regions }) => regions), [
            [{ startLine: 1, startColumn: 1, endLine: 1, endColumn: 1 }],
            [{ startLine: 1, startColumn: 2, endLine: 1, endColumn: 2 }],
        ]);
    });

    it("honestly encloses a non-Unicode match inside a surrogate pair", () => {
        const out = queryRegex("😀", "()");
        assert.equal(out.length, 3);
        assert.deepEqual(out[1].regions, [{
            startLine: 1, startColumn: 1, endLine: 1, endColumn: 2,
        }]);
    });
});

describe("queryRegex — error policy", () => {
    it("throws InvalidExpressionError on malformed regex", () => {
        assert.throws(() => queryRegex("text", "(unclosed"), (err: unknown) => {
            return err instanceof InvalidExpressionError && err.dialect === "regex";
        });
    });
});

describe("queryGlob", () => {
    it("matches whole lines (line-anchored)", () => {
        const text = "error: foo\nwarn: bar\nerror: baz";
        const out = queryGlob(text, "error: *");
        assert.equal(out.length, 2);
        assert.equal(out[0].matched, "error: foo");
        assert.equal(out[1].matched, "error: baz");
    });

    it("handles ? single-char wildcards", () => {
        const text = "cat\ncar\ndog";
        const out = queryGlob(text, "ca?");
        assert.equal(out.length, 2);
    });

    it("handles character classes", () => {
        const text = "log1\nlog2\nlogA";
        const out = queryGlob(text, "log[12]");
        assert.equal(out.length, 2);
    });

    it("escapes regex metacharacters in non-glob positions", () => {
        const text = "a.b\nacb";
        const out = queryGlob(text, "a.b");
        assert.equal(out.length, 1);
        assert.equal(out[0].matched, "a.b");
    });

    it("returns complete regions with 1-indexed columns", () => {
        const text = "first\nsecond\nthird";
        const out = queryGlob(text, "second");
        assert.equal(out.length, 1);
        assert.deepEqual(out[0].regions, [{
            startLine: 2, startColumn: 1, endLine: 2, endColumn: 7,
        }]);
    });

    it("treats a bare word as a fuzzy content search", () => {
        const text = "hello world hello again\ngoodbye";
        const out = queryGlob(text, "hello");
        assert.equal(out.length, 1);
        assert.equal(out[0].matched, "hello world hello again");
    });

    it("explicit wildcards keep structural meaning", () => {
        const text = "hello world\nworld hello";
        assert.equal(queryGlob(text, "hello*").length, 1);
        assert.equal(queryGlob(text, "hello*")[0].matched, "hello world");
        assert.equal(queryGlob(text, "*hello").length, 1);
        assert.equal(queryGlob(text, "*hello")[0].matched, "world hello");
        assert.equal(queryGlob(text, "*hello*").length, 2);
    });

    it("does not invent a whole line for empty content", () => {
        assert.deepEqual(queryGlob("", "*"), []);
    });
});

describe("queryJsonpathObject — bare-leaves outline (default)", () => {
    const outline = {
        Top: {
            Section: { Sub: 5 },
            Other: 7,
        },
        Trailer: 9,
    };

    it("retains the locator when the outline has no readable-text mapping", () => {
        const out = queryJsonpathObject(outline, "$.Top.Section.Sub");
        assert.equal(out.length, 1);
        assert.equal(out[0].matched, 5);
        assert.equal(out[0].matching, "$['Top']['Section']['Sub']");
        assert.equal(out[0].regions, undefined);
    });

    it("returns the nested subtree as `matched` for parent paths", () => {
        const out = queryJsonpathObject(outline, "$.Top.Section");
        assert.equal(out.length, 1);
        assert.deepEqual(out[0].matched, { Sub: 5 });
        assert.equal(out[0].regions, undefined);
    });

    it("emits one match per wildcard result with the resolved matching path", () => {
        const out = queryJsonpathObject(outline, "$.Top.*");
        assert.equal(out.length, 2);
        const paths = out.map((m) => m.matching);
        assert.ok(paths.includes("$['Top']['Section']"));
        assert.ok(paths.includes("$['Top']['Other']"));
    });

    it("returns [] when no matches", () => {
        assert.deepEqual(queryJsonpathObject(outline, "$.Nonexistent"), []);
    });

    it("throws InvalidExpressionError on malformed filter syntax", () => {
        // jsonpath-plus is lenient about structural typos in paths (returns []
        // for nonsense path syntax), but throws on broken filter expressions —
        // which is the kind of error model-authored matchers usually make.
        assert.throws(() => queryJsonpathObject(outline, "$[?(@.x == "), (err: unknown) => {
            return err instanceof InvalidExpressionError && err.dialect === "jsonpath";
        });
    });
});

describe("queryJsonpathObject - custom region resolver", () => {
    it("delegates readable-text region resolution by pointer", () => {
        const data = { users: [{ name: "alice" }, { name: "bob" }] };
        const out = queryJsonpathObject(data, "$.users[*].name", (pointer) => {
            if (pointer === "/users/0/name") {
                return [{ startLine: 3, startColumn: 2, endLine: 3, endColumn: 7 }];
            }
            if (pointer === "/users/1/name") {
                return [{ startLine: 7, startColumn: 2, endLine: 7, endColumn: 5 }];
            }
            return undefined;
        });
        assert.equal(out.length, 2);
        assert.equal(out[0].matched, "alice");
        assert.deepEqual(out[0].regions, [{
            startLine: 3, startColumn: 2, endLine: 3, endColumn: 7,
        }]);
        assert.equal(out[1].matched, "bob");
        assert.deepEqual(out[1].regions, [{
            startLine: 7, startColumn: 2, endLine: 7, endColumn: 5,
        }]);
    });
});

describe("queryXpathString — line-less child elements walk to the enclosing span ({§mimetype-query-conformance} symmetry)", () => {
    // A bare `name`/`params` field projects to a child element with no pk:line of
    // its own; xpath must report the SAME enclosing span jsonpath's ancestor walk
    // gives the corresponding JSON value — not an absent line.
    const xml = projectJsonToXml({
        type: "function_definition", line: 5, endLine: 10, name: "greet", params: ["x", "y"],
    });

    it("a matched line-less <name> inherits the nearest annotated ancestor span", () => {
        const readable = Array.from({ length: 10 }, () => "x").join("\n");
        const out = queryXpathString(xml, "//name", "text/test", readable);
        assert.equal(out.length, 1);
        assert.equal(out[0].matched, "<name>greet</name>");
        assert.deepEqual(out[0].regions, [{
            startLine: 5, startColumn: 1, endLine: 10, endColumn: 2,
        }]);
    });

    it("a node with NO annotated ancestor honestly reports no lines (never faked)", () => {
        const bare = projectJsonToXml({ name: "x" });
        const out = queryXpathString(bare, "//name", "text/test");
        assert.equal(out.length, 1);
        assert.equal(out[0].regions, undefined);
        assert.equal(out[0].matching, "//name");
    });
});

describe("outlineLineFor — bare-number outline projection resolver ({§mimetype-query-conformance} symmetry)", () => {
    const outline = { Top: { Section: { Sub: 5 }, Other: 7 }, Trailer: 9 };
    const lineFor = outlineLineFor(outline);

    it("resolves a leaf pointer to its bare-number line", () => {
        assert.deepEqual(lineFor("/Top/Section/Sub"), { line: 5, endLine: 5 });
    });

    it("resolves a subtree pointer to its min..max leaf span", () => {
        assert.deepEqual(lineFor("/Top"), { line: 5, endLine: 7 });
    });

    it("resolves the root pointer to the whole-document span", () => {
        assert.deepEqual(lineFor(""), { line: 5, endLine: 9 });
    });

    it("xpath over the projected outline maps the resolver into readable text", () => {
        const xml = projectJsonToXml(outline, "root", lineFor);
        const readable = Array.from({ length: 9 }, () => "x").join("\n");
        const out = queryXpathString(xml, "//Sub", "text/test", readable);
        assert.equal(out.length, 1);
        assert.deepEqual(out[0].regions, [{
            startLine: 5, startColumn: 1, endLine: 5, endColumn: 2,
        }]);
    });
});

describe("jsonpath recursive descent over deep parse trees", () => {
    it("$..* traverses a tree far past json-p3's default 50-node cap", () => {
        // A deepJson-shaped tree with ~200 nodes — mirrors an ANTLR/tree-sitter
        // handler's full parse tree. The default recursion cap threw here,
        // breaking recursive-descent jsonpath on every deep-tree handler.
        const child = (i: number): unknown => ({ type: `node_${i}`, line: i, endLine: i, text: String(i) });
        const tree = { type: "root", line: 1, endLine: 200, children: Array.from({ length: 200 }, (_, i) => child(i + 1)) };
        const matches = queryJsonpathObject(tree, "$..*");
        assert.ok(matches.length > 200, `expected >200 matches, got ${matches.length}`);
    });
});
