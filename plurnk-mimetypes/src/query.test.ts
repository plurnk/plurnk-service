import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { globToRegex, outlineLineFor, queryGlob, queryJsonpathObject, queryRegex, queryXpathString } from "./query.ts";
import { projectJsonToXml } from "./projectJsonToXml.ts";
import { InvalidExpressionError, QueryParseFailureError, UnsupportedDialectError } from "./QueryError.ts";
import MimetypeInputError, { isMimetypeInputError } from "./MimetypeInputError.ts";
import { parseBodyMatcher } from "./parseBodyMatcher.ts";

// ─── query.test.ts ───
{
// Contracts: {§mimetype-query}, {§mimetype-query}.





it("{§mimetype-query} an explicit source mapper never borrows an ancestor for an unmapped value", () => {
    const tree = { line: 1, column: 1, endLine: 1, endColumn: 4, name: "synthetic" };
    const [match] = queryJsonpathObject(tree, "$.name", () => undefined, "abc");
    assert.equal(match.matching, "$['name']");
    assert.equal(match.regions, undefined);
    assert.equal(match.enclosingRegions, undefined);
});

it("{§mimetype-query} projected fields retain enclosing context without claiming the node's exact span", () => {
    const tree = { line: 1, column: 1, endLine: 1, endColumn: 4, name: "synthetic" };
    const [match] = queryJsonpathObject(tree, "$.name", undefined, "abc");
    assert.equal(match.regions, undefined);
    assert.deepEqual(match.enclosingRegions, [{ startLine: 1, startColumn: 1, endLine: 1, endColumn: 4 }]);
});

describe("{§mimetype-query} queryRegex: bare patterns", () => {
    it("{§mimetype-query} returns a string `matched` per global match", () => {
        const out = queryRegex("foo bar foo", "foo");
        assert.equal(out[0]?.text, "foo", "a regex match carries its own text");
        assert.equal(out.length, 2);
        assert.equal(out[0].matched, "foo");
        assert.equal(out[1].matched, "foo");
    });

    it("{§mimetype-query} computes exact text regions from the offset of each match", () => {
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

    it("{§mimetype-query} spans a multi-line match across its lines", () => {
        const out = queryRegex("a\nstart x\ny end\nb", "start[\\s\\S]*end");
        assert.equal(out.length, 1);
        assert.deepEqual(out[0].regions, [{
            startLine: 2, startColumn: 1, endLine: 3, endColumn: 6,
        }]);
    });

    it("{§mimetype-query} reports the smallest enclosing region when a match bisects CRLF", () => {
        const out = queryRegex("a\r\nb", "\\n");
        assert.equal(out.length, 1);
        assert.equal(out[0].regions, undefined, "a partial CRLF is not the whole separator");
        assert.deepEqual(out[0].enclosingRegions, [{
            startLine: 1, startColumn: 2, endLine: 2, endColumn: 1,
        }]);
    });

    it("{§mimetype-query} returns an empty array when nothing matches", () => {
        assert.deepEqual(queryRegex("foo", "bar"), []);
    });
});

describe("{§mimetype-query} queryRegex: anonymous captures", () => {
    it("returns an array of captures under {§mimetype-query}", () => {
        const out = queryRegex("name: alice", "(\\w+): (\\w+)");
        assert.equal(out.length, 1);
        assert.deepEqual(out[0].matched, ["name", "alice"]);
    });

    it("{§mimetype-query} handles multiple matches with anonymous captures", () => {
        const out = queryRegex("a=1 b=2", "(\\w)=(\\d)");
        assert.equal(out.length, 2);
        assert.deepEqual(out[0].matched, ["a", "1"]);
        assert.deepEqual(out[1].matched, ["b", "2"]);
    });
});

describe("{§mimetype-query} queryRegex: named captures", () => {
    it("{§mimetype-query} returns an object with named keys", () => {
        const out = queryRegex("key: value", "(?<key>\\w+): (?<val>\\w+)");
        assert.equal(out.length, 1);
        assert.deepEqual(out[0].matched, { key: "key", val: "value", "1": "key", "2": "value" });
    });

    it("{§mimetype-query} includes positional keys '1', '2' alongside named when mixed", () => {
        const out = queryRegex("foo bar", "(\\w+) (?<second>\\w+)");
        const matched = out[0].matched as Record<string, string>;
        assert.equal(matched["1"], "foo");
        assert.equal(matched["second"], "bar");
        assert.equal(matched["2"], "bar");
    });
});

describe("{§mimetype-query} queryRegex: flag handling", () => {
    it("{§mimetype-query} honors case-insensitive flag", () => {
        const out = queryRegex("Foo FOO foo", "foo", "i");
        assert.equal(out.length, 3);
    });

    it("{§mimetype-query} does not double-globalize already-global flags", () => {
        const out = queryRegex("foo foo", "foo", "g");
        assert.equal(out.length, 2);
    });

    it("{§mimetype-query} does not infinite-loop on zero-length matches", () => {
        const out = queryRegex("abc", "()");
        // 4 zero-width positions in "abc": before/between/after each char
        assert.equal(out.length, 4);
    });

    it("{§mimetype-query} advances zero-length Unicode matches by code point", () => {
        const out = queryRegex("😀", "()", "u");
        assert.equal(out.length, 2);
        assert.deepEqual(out.map(({ regions }) => regions), [
            [{ startLine: 1, startColumn: 1, endLine: 1, endColumn: 1 }],
            [{ startLine: 1, startColumn: 2, endLine: 1, endColumn: 2 }],
        ]);
    });

    it("{§mimetype-query} honestly encloses a non-Unicode match inside a surrogate pair", () => {
        const out = queryRegex("😀", "()");
        assert.equal(out.length, 3);
        assert.equal(out[1].regions, undefined, "an interior code-unit position is not an exact code-point span");
        assert.deepEqual(out[1].enclosingRegions, [{
            startLine: 1, startColumn: 1, endLine: 1, endColumn: 2,
        }]);
    });
});

describe("{§mimetype-query} queryRegex: error policy", () => {
    it("{§mimetype-query} throws InvalidExpressionError on malformed regex", () => {
        assert.throws(() => queryRegex("text", "(unclosed"), (err: unknown) => {
            return err instanceof InvalidExpressionError && err.dialect === "regex";
        });
    });
});

describe("{§mimetype-query} queryGlob", () => {
    it("{§mimetype-query} matches whole lines (line-anchored)", () => {
        const text = "error: foo\nwarn: bar\nerror: baz";
        const out = queryGlob(text, "error: *");
        assert.equal(out.length, 2);
        assert.equal(out[0].matched, "error: foo");
        assert.equal(out[1].matched, "error: baz");
    });

    it("{§mimetype-query} handles ? single-char wildcards", () => {
        const text = "cat\ncar\ndog";
        const out = queryGlob(text, "ca?");
        assert.equal(out.length, 2);
    });

    it("{§mimetype-query} handles character classes", () => {
        const text = "log1\nlog2\nlogA";
        const out = queryGlob(text, "log[12]");
        assert.equal(out.length, 2);
    });

    it("{§mimetype-query} supports conventional brace and extglob groups", () => {
        const text = "alpha\nbeta\nalphabeta\ngamma";
        assert.deepEqual(queryGlob(text, "@(alpha|beta)").map(({ matched }) => matched), ["alpha", "beta"]);
        assert.deepEqual(queryGlob(text, "{alpha,beta}").map(({ matched }) => matched), ["alpha", "beta"]);
        assert.deepEqual(queryGlob("item1\nitem2\nitem3\nitem4", "item{1..3}").map(({ matched }) => matched), ["item1", "item2", "item3"]);
        assert.deepEqual(queryGlob(text, "+(alpha|beta)").map(({ matched }) => matched), ["alpha", "beta", "alphabeta"]);
        assert.deepEqual(queryGlob(text, "?(alpha|beta)").map(({ matched }) => matched), ["alpha", "beta"]);
        assert.deepEqual(queryGlob(text, "*(alpha|beta)").map(({ matched }) => matched), ["alpha", "beta", "alphabeta"]);
        assert.deepEqual(queryGlob(text, "!(alpha|beta)").map(({ matched }) => matched), ["alphabeta", "gamma"]);
    });

    it("{§mimetype-query} treats bare at-sign text as a literal occurrence", () => {
        const text = "prefix @data/users.json suffix\ndata/users.json";
        assert.deepEqual(queryGlob(text, "@data/users.json").map(({ matched }) => matched), [
            "@data/users.json",
        ]);
    });

    it("{§mimetype-query} matches body globs across slashes within one line", () => {
        assert.equal(queryGlob("prefix data/users.json suffix", "*data/*.json*").length, 1);
    });

    it("{§mimetype-query} reports malformed glob groups as invalid expressions", () => {
        assert.throws(
            () => globToRegex("@(alpha|beta"),
            (error: unknown) => error instanceof InvalidExpressionError && error.dialect === "glob",
        );
    });

    it("{§mimetype-query} escapes regex metacharacters in non-glob positions", () => {
        const text = "a.b\nacb";
        const out = queryGlob(text, "a.b");
        assert.equal(out.length, 1);
        assert.equal(out[0].matched, "a.b");
    });

    it("{§mimetype-query} returns complete regions with 1-indexed columns", () => {
        const text = "first\nsecond\nthird";
        const out = queryGlob(text, "second");
        assert.equal(out.length, 1);
        assert.deepEqual(out[0].regions, [{
            startLine: 2, startColumn: 1, endLine: 2, endColumn: 7,
        }]);
    });

    it("{§mimetype-query} reports each literal occurrence at its exact source coordinates", () => {
        const text = "hello world hello again\ngoodbye";
        const out = queryGlob(text, "hello");
        assert.deepEqual(out.map(({ matched, regions }) => ({ matched, regions })), [
            { matched: "hello", regions: [{ startLine: 1, startColumn: 1, endLine: 1, endColumn: 6 }] },
            { matched: "hello", regions: [{ startLine: 1, startColumn: 13, endLine: 1, endColumn: 18 }] },
        ]);
        assert.deepEqual(queryGlob("😀hello", "hello")[0]?.regions, [
            { startLine: 1, startColumn: 2, endLine: 1, endColumn: 7 },
        ]);
    });

    it("{§mimetype-query} explicit wildcards keep structural meaning", () => {
        const text = "hello world\nworld hello";
        assert.equal(queryGlob(text, "hello*").length, 1);
        assert.equal(queryGlob(text, "hello*")[0].matched, "hello world");
        assert.equal(queryGlob(text, "*hello").length, 1);
        assert.equal(queryGlob(text, "*hello")[0].matched, "world hello");
        assert.equal(queryGlob(text, "*hello*").length, 2);
    });

    it("{§mimetype-query} does not invent a whole line for empty content", () => {
        assert.deepEqual(queryGlob("", "*"), []);
    });
});

describe("{§mimetype-query} queryJsonpathObject: bare-leaves outline (default)", () => {
    const outline = {
        Top: {
            Section: { Sub: 5 },
            Other: 7,
        },
        Trailer: 9,
    };

    it("{§mimetype-query} retains the locator when the outline has no readable-text mapping", () => {
        const out = queryJsonpathObject(outline, "$.Top.Section.Sub");
        assert.equal(out.length, 1);
        assert.equal(out[0].matched, 5);
        assert.equal(out[0].matching, "$['Top']['Section']['Sub']");
        assert.equal(out[0].regions, undefined);
    });

    it("{§mimetype-query} returns the nested subtree as `matched` for parent paths", () => {
        const out = queryJsonpathObject(outline, "$.Top.Section");
        assert.equal(out.length, 1);
        assert.deepEqual(out[0].matched, { Sub: 5 });
        assert.equal(out[0].regions, undefined);
    });

    it("{§mimetype-query} emits one match per wildcard result with the resolved matching path", () => {
        const out = queryJsonpathObject(outline, "$.Top.*");
        assert.equal(out.length, 2);
        const paths = new Set(out.map((m) => m.matching));
        assert.ok(paths.has("$['Top']['Section']"));
        assert.ok(paths.has("$['Top']['Other']"));
    });

    it("{§mimetype-query} returns [] when no matches", () => {
        assert.deepEqual(queryJsonpathObject(outline, "$.Nonexistent"), []);
    });

    it("{§mimetype-query} returns no values when a forward slice begins at or beyond the array end", () => {
        for (const values of [[], ["only"], ["first", "last"]]) {
            for (const offset of [0, 1]) {
                assert.deepEqual(queryJsonpathObject(values, `$[${values.length + offset}:]`), []);
            }
        }
        assert.deepEqual(queryJsonpathObject(["first", "last"], "$[1:]").map((match) => match.matched), ["last"]);
    });

    it("{§mimetype-query} throws InvalidExpressionError on malformed filter syntax", () => {
        assert.throws(() => queryJsonpathObject(outline, "$[?(@.x == "), (err: unknown) => {
            assert.ok(err instanceof InvalidExpressionError);
            assert.equal(err.dialect, "jsonpath");
            assert.equal(err.expression, "$[?(@.x == ");
            assert.ok(err.cause instanceof Error, "the upstream syntax failure remains available");
            return true;
        });
    });

    it("{§mimetype-query} preserves an evaluation failure for a valid expression", () => {
        const failure = new Error("fixture data accessor failed");
        const data = { get value() { throw failure; } };
        assert.throws(() => queryJsonpathObject(data, "$.value"), (error: unknown) => error === failure);
    });
});

describe("{§mimetype-query} queryJsonpathObject: custom region resolver", () => {
    it("{§mimetype-query} delegates readable-text region resolution by pointer", () => {
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

describe("{§mimetype-query} queryXpathString: line-less child elements walk to the enclosing span", () => {
    // A bare `name`/`params` field projects to a child element with no pk:line of
    // its own; xpath must report the SAME enclosing span jsonpath's ancestor walk
    // gives the corresponding JSON value — not an absent line.
    const xml = projectJsonToXml({
        type: "function_definition", line: 5, endLine: 10, name: "greet", params: ["x", "y"],
    });

    it("{§mimetype-query} a matched line-less <name> inherits the nearest annotated ancestor span", () => {
        const readable = Array.from({ length: 10 }, () => "x").join("\n");
        const out = queryXpathString(xml, "//name", "text/test", readable);
        assert.equal(out.length, 1);
        assert.equal(out[0].matched, "<name>greet</name>");
        assert.equal(out[0].regions, undefined);
        assert.deepEqual(out[0].enclosingRegions, [{
            startLine: 5, startColumn: 1, endLine: 10, endColumn: 2,
        }]);
    });

    it("{§mimetype-query} a node with NO annotated ancestor honestly reports no lines (never faked)", () => {
        const bare = projectJsonToXml({ name: "x" });
        const out = queryXpathString(bare, "//name", "text/test");
        assert.equal(out.length, 1);
        assert.equal(out[0].regions, undefined);
        assert.equal(out[0].matching, "//name");
    });
});

describe("{§mimetype-query} outlineLineFor: bare-number outline projection resolver", () => {
    const outline = { Top: { Section: { Sub: 5 }, Other: 7 }, Trailer: 9 };
    const lineFor = outlineLineFor(outline);

    it("{§mimetype-query} resolves a leaf pointer to its bare-number line", () => {
        assert.deepEqual(lineFor("/Top/Section/Sub"), { line: 5, endLine: 5 });
    });

    it("{§mimetype-query} resolves a subtree pointer to its min..max leaf span", () => {
        assert.deepEqual(lineFor("/Top"), { line: 5, endLine: 7 });
    });

    it("{§mimetype-query} resolves the root pointer to the whole-document span", () => {
        assert.deepEqual(lineFor(""), { line: 5, endLine: 9 });
    });

    it("{§mimetype-query} xpath over the projected outline maps the resolver into readable text", () => {
        const xml = projectJsonToXml(outline, "root", lineFor);
        const readable = Array.from({ length: 9 }, () => "x").join("\n");
        const out = queryXpathString(xml, "//Sub", "text/test", readable);
        assert.equal(out.length, 1);
        assert.equal(out[0].regions, undefined);
        assert.deepEqual(out[0].enclosingRegions, [{
            startLine: 5, startColumn: 1, endLine: 5, endColumn: 2,
        }]);
    });
});

describe("{§mimetype-query} jsonpath recursive descent over deep parse trees", () => {
    it("{§mimetype-query} $..* traverses a tree far past json-p3's default 50-node cap", () => {
        // A deepJson-shaped tree with ~200 nodes — mirrors an ANTLR/tree-sitter
        // handler's full parse tree. The default recursion cap threw here,
        // breaking recursive-descent jsonpath on every deep-tree handler.
        const child = (i: number): unknown => ({ type: `node_${i}`, line: i, endLine: i, text: String(i) });
        const tree = { type: "root", line: 1, endLine: 200, children: Array.from({ length: 200 }, (_, i) => child(i + 1)) };
        const matches = queryJsonpathObject(tree, "$..*");
        assert.ok(matches.length > 200, `expected >200 matches, got ${matches.length}`);
    });
});

describe("{§mimetype-query} queryXpathString: the reserved pk prefix is bound for provenance attributes", () => {
    const xml = projectJsonToXml({
        type: "document", line: 1, endLine: 3,
        children: [{ type: "heading", line: 2, endLine: 2, level: 2, text: "Testing" }],
    });

    it("{§mimetype-query} selects by pk:level and pk:line as written", () => {
        const byLevel = queryXpathString(xml, "//heading[@pk:level='2']", "text/test");
        assert.equal(byLevel.length, 1);
        assert.match(String(byLevel[0].matched), /^<heading /);
        assert.equal(queryXpathString(xml, "//*[@pk:line='2']", "text/test").length, 1);
        assert.equal(queryXpathString(xml, "//heading[@pk:level='3']", "text/test").length, 0);
    });

    it("{§mimetype-query} an unbound prefix is still an invalid expression", () => {
        assert.throws(() => queryXpathString(xml, "//heading[@zz:level='2']", "text/test"), InvalidExpressionError);
    });
});
}

// ─── QueryError.test.ts ───
{
describe("{§mimetype-query} UnsupportedDialectError", () => {
    it("{§mimetype-query} carries mimetype, dialect, and reason on the instance", () => {
        const err = new UnsupportedDialectError({
            mimetype: "text/plain",
            dialect: "xpath",
            reason: "no DOM projection",
        });
        assert.equal(err.mimetype, "text/plain");
        assert.equal(err.dialect, "xpath");
        assert.equal(err.reason, "no DOM projection");
        assert.equal(err.name, "UnsupportedDialectError");
        assert.ok(err.message.includes("xpath"));
    });
});

describe("{§mimetype-query} InvalidExpressionError", () => {
    it("{§mimetype-query} carries dialect and expression on the instance", () => {
        const err = new InvalidExpressionError({
            dialect: "regex",
            expression: "(unclosed",
        });
        assert.equal(err.dialect, "regex");
        assert.equal(err.expression, "(unclosed");
        assert.equal(err.name, "InvalidExpressionError");
    });

    it("{§mimetype-query} preserves the underlying error cause", () => {
        const cause = new SyntaxError("Invalid regular expression");
        const err = new InvalidExpressionError({
            dialect: "regex",
            expression: "(unclosed",
            cause,
        });
        assert.equal(err.cause, cause);
    });
});

describe("{§mimetype-query} QueryParseFailureError", () => {
    it("{§mimetype-query} carries mimetype and cause", () => {
        const cause = new SyntaxError("Unexpected token");
        const err = new QueryParseFailureError({
            mimetype: "application/json",
            cause,
        });
        assert.equal(err.mimetype, "application/json");
        assert.equal(err.cause, cause);
        assert.equal(err.name, "QueryParseFailureError");
        assert.ok(err instanceof MimetypeInputError);
    });

    it("{§mimetype-query} recognizes independently installed typed errors without trusting a name alone", () => {
        assert.equal(isMimetypeInputError({
            name: "MimetypeInputError",
            mimetype: "application/json",
        }), true);
        assert.equal(isMimetypeInputError({ name: "MimetypeInputError" }), false);
    });
});
}

// ─── parseBodyMatcher.test.ts ───
{
describe("{§mimetype-query} parseBodyMatcher", () => {
    it("{§mimetype-query} dispatches xpath via // prefix", () => {
        const p = parseBodyMatcher("//user[@role='admin']");
        assert.equal(p.dialect, "xpath");
        assert.equal(p.pattern, "//user[@role='admin']");
        assert.equal(p.flags, undefined);
    });

    it("{§mimetype-query} dispatches jsonpath via $ prefix", () => {
        const p = parseBodyMatcher("$.users[*].name");
        assert.equal(p.dialect, "jsonpath");
        assert.equal(p.pattern, "$.users[*].name");
    });

    it("{§mimetype-query} dispatches regex via /pattern/ form with flags", () => {
        const p = parseBodyMatcher("/error.*/gi");
        assert.equal(p.dialect, "regex");
        assert.equal(p.pattern, "error.*");
        assert.equal(p.flags, "gi");
    });

    it("{§mimetype-query} dispatches regex via /pattern/ form without flags", () => {
        const p = parseBodyMatcher("/error.*/");
        assert.equal(p.dialect, "regex");
        assert.equal(p.pattern, "error.*");
        assert.equal(p.flags, undefined);
    });

    it("{§mimetype-query} rejects a regex without its closing slash", () => {
        assert.throws(() => parseBodyMatcher("/error.*"), InvalidExpressionError);
    });

    it("{§mimetype-query} supports all flag characters per JS regex spec (gimsuy)", () => {
        const p = parseBodyMatcher("/foo/gimsuy");
        assert.equal(p.dialect, "regex");
        assert.equal(p.flags, "gimsuy");
    });

    it("{§mimetype-query} keeps escaped slashes and slashes inside character classes in the pattern", () => {
        assert.deepEqual(parseBodyMatcher("/a\\/b/i"), {
            dialect: "regex",
            pattern: "a\\/b",
            flags: "i",
        });
        assert.deepEqual(parseBodyMatcher("/[/]/"), {
            dialect: "regex",
            pattern: "[/]",
            flags: undefined,
        });
    });

    it("{§mimetype-query} rejects invalid patterns and flags at the classifier boundary", () => {
        assert.throws(() => parseBodyMatcher("/[abc/"), InvalidExpressionError);
        assert.throws(() => parseBodyMatcher("/foo/nope"), InvalidExpressionError);
    });

    it("{§mimetype-query} dispatches glob for anything not matching the other prefixes", () => {
        const p = parseBodyMatcher("*.log");
        assert.equal(p.dialect, "glob");
        assert.equal(p.pattern, "*.log");
    });

    it("{§mimetype-query} treats // as xpath even when followed by something xpath-looking-but-isn't", () => {
        const p = parseBodyMatcher("//foo");
        assert.equal(p.dialect, "xpath");
    });

    it("{§mimetype-query} treats single $ as jsonpath (handles edge of single-char roots)", () => {
        const p = parseBodyMatcher("$");
        assert.equal(p.dialect, "jsonpath");
    });
});
}

// ─── query.evidence.test.ts ───
{
// Contract: {§mimetype-query}.




// A synthesized deepJson document model (PDF-shaped): line-annotated nodes,
// metadata as document-level primitives.
const model = {
    type: "document",
    line: 1,
    endLine: 10,
    metadata: { title: "Quarterly Report", pageCount: 10 },
    children: [
        { type: "heading", name: "Introduction", line: 3, endLine: 5 },
        { type: "heading", name: "Method", line: 6, endLine: 9 },
    ],
};
const readable = Array.from({ length: 12 }, (_, index) => `line ${index + 1}`).join("\n");

describe("{§mimetype-query} structural matches report source-line spans", () => {
    it("{§mimetype-query} a node with explicit line/endLine reports that span", () => {
        const out = queryJsonpathObject(model, "$.children[0]", undefined, readable);
        assert.equal(out.length, 1);
        assert.deepEqual(out[0].enclosingRegions, [{
            startLine: 3, startColumn: 1, endLine: 5, endColumn: 7,
        }]);
    });

    it("{§mimetype-query} a primitive resolves to the nearest enclosing annotated node", () => {
        const heading = queryJsonpathObject(model, "$.children[1].name", undefined, readable);
        assert.equal(heading[0].matched, "Method");
        assert.deepEqual(heading[0].enclosingRegions, [{
            startLine: 6, startColumn: 1, endLine: 9, endColumn: 7,
        }], "walks up to children[1]");

        // metadata has no line of its own → walks up to the document span.
        const title = queryJsonpathObject(model, "$.metadata.title", undefined, readable);
        assert.equal(title[0].matched, "Quarterly Report");
        assert.deepEqual(title[0].enclosingRegions, [{
            startLine: 1, startColumn: 1, endLine: 10, endColumn: 8,
        }]);
    });

    it("{§mimetype-query} a handler-supplied lineFor (by pointer) wins for source fidelity", () => {
        const out = queryJsonpathObject(
            { host: "db.internal", pool: 5 },
            "$.host",
            (pointer) => (pointer === "/host"
                ? [{ startLine: 2, startColumn: 1, endLine: 2, endColumn: 5 }]
                : undefined),
        );
        assert.equal(out[0].matched, "db.internal");
        assert.deepEqual(out[0].regions, [{
            startLine: 2, startColumn: 1, endLine: 2, endColumn: 5,
        }]);
    });

    it("{§mimetype-query} xpath node match spans pk:line..pk:endLine", () => {
        const xml = '<root xmlns:pk="https://plurnk.xyz/deep-xml/1">'
            + '<function pk:line="5" pk:endLine="12">body</function></root>';
        const out = queryXpathString(xml, "//function", "application/x-test", readable);
        assert.equal(out.length, 1);
        assert.deepEqual(out[0].enclosingRegions, [{
            startLine: 5, startColumn: 1, endLine: 12, endColumn: 8,
        }]);
    });

    it("{§mimetype-query} xpath computed scalar carries no lines", () => {
        const xml = '<root xmlns:pk="https://plurnk.xyz/deep-xml/1">'
            + '<a pk:line="1"/><a pk:line="2"/></root>';
        const out = queryXpathString(xml, "count(//a)", "application/x-test");
        assert.equal(out.length, 1);
        assert.equal(out[0].matched, "2");
        assert.equal(out[0].regions, undefined);
        assert.equal(out[0].matching, "count(//a)");
    });

    it("{§mimetype-query} value is always present even when lines can't be resolved", () => {
        // Raw JSON, no annotations and no lineFor → lines absent, value intact.
        const out = queryJsonpathObject({ a: { b: "deep" } }, "$.a.b");
        assert.equal(out[0].matched, "deep");
        assert.equal(out[0].regions, undefined);
    });
});
}
