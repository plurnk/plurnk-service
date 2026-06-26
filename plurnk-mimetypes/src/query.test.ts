import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { queryGlob, queryJsonpathObject, queryRegex } from "./query.ts";
import { InvalidExpressionError } from "./QueryError.ts";

describe("queryRegex — bare patterns", () => {
    it("returns a string `matched` per global match", () => {
        const out = queryRegex("foo bar foo", "foo");
        assert.equal(out.length, 2);
        assert.equal(out[0].matched, "foo");
        assert.equal(out[1].matched, "foo");
    });

    it("computes line spans from the offset of each match", () => {
        const text = "alpha\nbeta\ngamma\nbeta";
        const out = queryRegex(text, "beta");
        assert.equal(out.length, 2);
        assert.deepEqual(out[0].lines, [{ line: 2, endLine: 2 }]);
        assert.deepEqual(out[1].lines, [{ line: 4, endLine: 4 }]);
    });

    it("spans a multi-line match across its lines", () => {
        const out = queryRegex("a\nstart x\ny end\nb", "start[\\s\\S]*end");
        assert.equal(out.length, 1);
        assert.deepEqual(out[0].lines, [{ line: 2, endLine: 3 }]);
    });

    it("returns an empty array when nothing matches", () => {
        assert.deepEqual(queryRegex("foo", "bar"), []);
    });
});

describe("queryRegex — anonymous captures", () => {
    it("returns an array of captures per grammar #17", () => {
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

    it("returns line numbers (1-indexed)", () => {
        const text = "first\nsecond\nthird";
        const out = queryGlob(text, "second");
        assert.equal(out.length, 1);
        assert.deepEqual(out[0].lines, [{ line: 2, endLine: 2 }]);
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

    it("returns the bare leaf number as `matched` and the line", () => {
        const out = queryJsonpathObject(outline, "$.Top.Section.Sub");
        assert.equal(out.length, 1);
        assert.equal(out[0].matched, 5);
        assert.deepEqual(out[0].lines, [{ line: 5, endLine: 5 }]);
    });

    it("returns the nested subtree as `matched` for parent paths", () => {
        const out = queryJsonpathObject(outline, "$.Top.Section");
        assert.equal(out.length, 1);
        assert.deepEqual(out[0].matched, { Sub: 5 });
        // span derives from the subtree's leaf numbers (a single leaf here, 5)
        assert.deepEqual(out[0].lines, [{ line: 5, endLine: 5 }]);
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

describe("queryJsonpathObject — custom lineFor (used by JSON/YAML/TOML handlers)", () => {
    it("delegates line resolution to the provided callback by pointer", () => {
        const data = { users: [{ name: "alice" }, { name: "bob" }] };
        const out = queryJsonpathObject(data, "$.users[*].name", (pointer) => {
            // Fake source-position map: alice on line 3, bob on line 7
            if (pointer === "/users/0/name") return [{ line: 3, endLine: 3 }];
            if (pointer === "/users/1/name") return [{ line: 7, endLine: 7 }];
            return undefined;
        });
        assert.equal(out.length, 2);
        assert.equal(out[0].matched, "alice");
        assert.deepEqual(out[0].lines, [{ line: 3, endLine: 3 }]);
        assert.equal(out[1].matched, "bob");
        assert.deepEqual(out[1].lines, [{ line: 7, endLine: 7 }]);
    });
});
