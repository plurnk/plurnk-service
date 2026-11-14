import test, { describe } from "node:test";
import assert from "node:assert/strict";
import { PlurnkParseError } from "@plurnk/plurnk-contracts";
import { parseMatcher } from "./MatcherSyntax.ts";
import { parseLineMarker, parseRangeMarker, parseTextLineMarker } from "./ScopeSyntax.ts";

describe("MatcherSyntax and ScopeSyntax", () => {
    test("{§matcher-prefix-claims} {§parse-recovery}: parseMatcher handles ECMAScript pipe escaping, PCRE anchors, inline modifiers, glob-regex recovery, comma regex lists, and unbalanced delimiter repair", () => {
        // PCRE `\A`, `\b<wordChar>\Z`, leading `~` inside slashes, `(?im)` inline modifier lifting, and ECMAScript `\|` literal pipe
        const pcre = parseMatcher("/(?im)\\Afoo|bar\\bs\\Z/");
        assert.deepEqual(pcre, {
            dialect: "regex",
            raw: "/(?im)\\Afoo|bar\\bs\\Z/",
            pattern: "^foo|bars$",
            flags: "im",
        });

        const literalOr = parseMatcher("/\\[\\$\\{id \\|\\| 'fallback'\\}\\]/");
        assert.deepEqual(literalOr, {
            dialect: "regex",
            raw: "/\\[\\$\\{id \\|\\| 'fallback'\\}\\]/",
            pattern: "\\[\\$\\{id \\|\\| 'fallback'\\}\\]",
            flags: "",
        });
        assert.equal(new RegExp(literalOr.pattern, literalOr.flags).test(""), false);
        assert.equal(new RegExp(literalOr.pattern, literalOr.flags).test("[${id || 'fallback'}]"), true);

        const tildeRegex = parseMatcher("/~needle/ -i");
        assert.deepEqual(tildeRegex, {
            dialect: "regex",
            raw: "/~needle/ -i",
            pattern: "needle",
            flags: "i",
        });

        // Unclosed slash `/pattern` without closing `/` compiles as regex; unclosed `[` before `/i` repairs
        assert.equal(parseMatcher("/unclosed_ok").dialect, "regex");
        const repairedClass = parseMatcher("/foo[bar/i");
        assert.equal(repairedClass.dialect, "regex");
        if (repairedClass.dialect === "regex") {
            assert.equal(repairedClass.pattern, "foo\\[bar");
            assert.equal(repairedClass.flags, "i");
        }

        // Unbalanced `(` and `)` repair in slash regex and `^`-anchored regex
        const repairedParens = parseMatcher("/fn(a, b/");
        assert.equal(repairedParens.dialect, "regex");
        if (repairedParens.dialect === "regex") {
            assert.equal(repairedParens.pattern, "fn\\(a, b");
        }
        const caretRepaired = parseMatcher("^def foo(x:");
        assert.equal(caretRepaired.dialect, "regex");
        const dollarAnchor = parseMatcher("export default$");
        assert.equal(dollarAnchor.dialect, "regex");

        // Glob-shaped `/pattern/` with leading `*` or `?` recovers to line glob regex
        const globRegex = parseMatcher("/*test?.ts/i");
        assert.deepEqual(globRegex, {
            dialect: "regex",
            raw: "/*test?.ts/i",
            pattern: ".*test.\\.ts",
            flags: "i",
        });

        // Comma-separated regex list folds into alternation on `find` and `read`
        const regexList = parseMatcher("/alpha/i, /beta/m", "find");
        assert.deepEqual(regexList, {
            dialect: "regex",
            raw: "/alpha/i, /beta/m",
            pattern: "(?:alpha)|(?:beta)",
            flags: "im",
        });

        // Multiline `/pattern/s` vs multiline glob
        assert.equal(parseMatcher("/line1\nline2/s").dialect, "regex");
        assert.equal(parseMatcher("line1\nline2").dialect, "glob");
    });

    test("{§matcher-prefix-claims} {§parse-recovery}: parseMatcher handles XPath (//, escaped-slash, single-slash recovery, @attr repair), JSONPath, FTS, Graph, and soft unreadability", () => {
        // XPath normalization (`///.../` slash-wrapped XPath) and `item@id` -> `item/@id` repair
        assert.deepEqual(parseMatcher("///project/dependencies/@name/text()/"), {
            dialect: "xpath",
            raw: "//project/dependencies/@name",
        });
        assert.deepEqual(parseMatcher("//item@id"), {
            dialect: "xpath",
            raw: "//item/@id",
        });
        // Escaped-slash XPath `/\/root\/@id/` and single-slash XPath `/root/item/@id`
        assert.deepEqual(parseMatcher("/\\/root\\/@id/"), {
            dialect: "xpath",
            raw: "//root/@id",
        });
        assert.deepEqual(parseMatcher("/root/item/@id"), {
            dialect: "xpath",
            raw: "/root/item/@id",
        });

        // JSONPath, FTS, Graph, Glob
        assert.deepEqual(parseMatcher("$.store.book[0].title"), { dialect: "jsonpath", raw: "$.store.book[0].title" });
        assert.deepEqual(parseMatcher("~BM25 search query"), { dialect: "fts", raw: "~BM25 search query" });
        assert.deepEqual(parseMatcher("&<parseMatcher"), { dialect: "graph", raw: "&<parseMatcher" });
        assert.deepEqual(parseMatcher("&>parsePath"), { dialect: "graph", raw: "&>parsePath" });
        assert.deepEqual(parseMatcher("*.config.ts"), { dialect: "glob", raw: "*.config.ts" });

        // Soft unreadable diagnostics across every prefix claim (never throws)
        const unreadableCases: Array<[string, RegExp]> = [
            ["/", /opens a regex matcher but no pattern follows/u],
            ["/start/,/end/", /range suffix after its closing/u],
            ["/foo/i trailing", /trailing text after `\/pattern\/flags`/u],
            [`/${"a".repeat(90)}/9`, /Invalid flags supplied.*…`/u],
            ["^[", /leads with `\^` but is not a valid regex/u],
            ["///[invalid", /leads with `\/\/` but is not a valid xpath/u],
            ["$[invalid", /leads with `\$` but is not a valid jsonpath/u],
            ["& invalid spaces", /Malformed graph matcher/u],
        ];
        for (const [raw, msgRe] of unreadableCases) {
            const m = parseMatcher(raw, "edit");
            assert.equal(m.dialect, "unreadable", raw);
            if (m.dialect === "unreadable") {
                assert.match(m.message, msgRe, raw);
                assert.ok(m.recovery.length > 0);
            }
        }
    });

    test("{§matcher-prefix-claims} {§fence-pairing} {§parse-recovery}: ScopeSyntax parses numeric markers, count/insert/relative recoveries, and @hash anchor tuples", () => {
        // Numeric line markers (signed, decimal, hyphen/comma separators, boundary commas)
        assert.deepEqual(parseLineMarker("<-5, 10.5-20>"), { marks: [-5, 10.5, 20] });
        assert.deepEqual(parseLineMarker(",1,5,"), { marks: [1, 5] });
        assert.deepEqual(parseLineMarker("15 lines"), { marks: [1, 15] });
        assert.deepEqual(parseLineMarker("L8, L8"), { marks: [8, 1, 8, 1] });

        // parseRangeMarker normalizations: col-0 insert (`<10,0>` / `<10,0,10,0>`), relative `<10, +5>`, and count `<20, 5>` (`end < start`)
        assert.deepEqual(parseRangeMarker("10,0"), { marks: [10, 1, 10, 1] });
        assert.deepEqual(parseRangeMarker("10,0,10,0"), { marks: [10, 1, 10, 1] });
        assert.deepEqual(parseRangeMarker("10, +5"), { marks: [10, 15] });
        assert.deepEqual(parseRangeMarker("20, 5"), { marks: [20, 24] });

        // parseTextLineMarker: row prefix `42<@abcde>`, `@210` line-number sigil, anchor `+N` offset folding, col-0 insert, single-line count `,1`, and tuple reordering
        assert.deepEqual(parseTextLineMarker("42<@abcde>"), { marks: ["@abcde"] });
        assert.deepEqual(parseTextLineMarker("<@abcde>-<@fghij>"), { marks: ["@abcde", "@fghij"] });
        assert.deepEqual(parseTextLineMarker("@210,@220"), { marks: [210, 220] });
        assert.deepEqual(parseTextLineMarker("@abcde,+4"), { marks: ["@abcde", "@abcde+4"] });
        assert.deepEqual(parseTextLineMarker("@abcde-3,+3"), { marks: ["@abcde-3", "@abcde"] });
        assert.deepEqual(parseTextLineMarker("@abcde,0"), { marks: ["@abcde", 1, "@abcde", 1] });
        assert.deepEqual(parseTextLineMarker("@abcde,0,@abcde,0"), { marks: ["@abcde", 1, "@abcde", 1] });
        assert.deepEqual(parseTextLineMarker("@abcde,1"), { marks: ["@abcde"] });
        assert.deepEqual(parseTextLineMarker("@abcde,@fghij,5"), { marks: ["@abcde", 5, "@fghij"] });
        assert.deepEqual(parseTextLineMarker("@abcde,@fghij,2,8"), { marks: ["@abcde", 2, "@fghij", 8] });

        // Refusal diagnostics on invalid ranges
        const badScopes: Array<[() => unknown, RegExp]> = [
            [() => parseLineMarker("abc"), /expected numeric coordinates/u],
            [() => parseRangeMarker("1,+2,+3"), /use numeric coordinates or `@hash` line anchors/u],
            [() => parseRangeMarker("0, +5"), /requires a positive start/u],
            [() => parseTextLineMarker("not-a-range"), /use numeric coordinates or `@hash` line anchors/u],
            [() => parseTextLineMarker("+5,@abcde"), /use numeric coordinates or `@hash` line anchors/u],
        ];
        for (const [fn, re] of badScopes) {
            assert.throws(fn, (err: unknown) => err instanceof PlurnkParseError && re.test(err.message));
        }
    });
});
