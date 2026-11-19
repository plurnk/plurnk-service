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

        // Comma- or pipe-separated regex lists (including `/branch1|/branch2/` and `$`-closed final branch) fold into alternation on `find` and `read`
        const regexList = parseMatcher("/alpha/i, /beta/m", "find");
        assert.deepEqual(regexList, {
            dialect: "regex",
            raw: "/alpha/i, /beta/m",
            pattern: "(?:alpha)|(?:beta)",
            flags: "im",
        });
        assert.deepEqual(parseMatcher("/alpha/i | /beta/m", "read"), {
            dialect: "regex",
            raw: "/alpha/i | /beta/m",
            pattern: "(?:alpha)|(?:beta)",
            flags: "im",
        });
        assert.deepEqual(parseMatcher("/def test.*merge|/def test.*conflict|/class /", "find"), {
            dialect: "regex",
            raw: "/def test.*merge|/def test.*conflict|/class /",
            pattern: "(?:def test.*merge)|(?:def test.*conflict)|(?:class )",
            flags: "",
        });
        assert.deepEqual(parseMatcher("/def ignore|/def set_active|/def clear$", "find"), {
            dialect: "regex",
            raw: "/def ignore|/def set_active|/def clear$",
            pattern: "(?:def ignore)|(?:def set_active)|(?:def clear$)",
            flags: "",
        });

        // Closed `/.../flags` matcher with unescaped interior `/` (e.g. Fortran `/=`) escapes interior `/` on `find`/`read`
        const interiorSlash = parseMatcher("/= =|/=|Eq\\(|Ne\\(/", "find");
        assert.deepEqual(interiorSlash, {
            dialect: "regex",
            raw: "/= =|/=|Eq\\(|Ne\\(/",
            pattern: "= =|\\/=|Eq\\(|Ne\\(",
            flags: "",
        });
        assert.equal(new RegExp(interiorSlash.pattern, interiorSlash.flags).test("if (a /= b)"), true);

        // Multiline `/pattern/s` vs multiline glob
        assert.equal(parseMatcher("/line1\nline2/s").dialect, "regex");
        assert.equal(parseMatcher("line1\nline2").dialect, "glob");

        // Python `(?P<name>...)` and `(?P=name)` translation plus empty code brackets `[]` (#1530)
        const pyNamed = parseMatcher("/(?P<tag>[A-Za-z]+)=(?P=tag)/u");
        assert.deepEqual(pyNamed, {
            dialect: "regex",
            raw: "/(?P<tag>[A-Za-z]+)=(?P=tag)/u",
            pattern: "(?<tag>[A-Za-z]+)=\\k<tag>",
            flags: "u",
        });
        assert.equal(new RegExp(pyNamed.pattern, pyNamed.flags).test("foo=foo"), true);
        assert.equal(new RegExp(pyNamed.pattern, pyNamed.flags).test("foo=bar"), false);

        const emptyCodeBrackets = parseMatcher("/Array\\(([]|\\[\\]|empty)\\)/u");
        assert.equal(emptyCodeBrackets.dialect, "regex");
        if (emptyCodeBrackets.dialect === "regex") {
            assert.equal(new RegExp(emptyCodeBrackets.pattern, emptyCodeBrackets.flags).test("Array([])"), true);
        }

        // Unslashed pipe-alternation regex recovery on `find`/`read` while keeping `||`, extglobs, and `edit` as `glob` (#1530)
        const pipeAlt = parseMatcher("def zeros|def ones|Array([]|\\[\\]|empty", "find");
        assert.equal(pipeAlt.dialect, "regex");
        if (pipeAlt.dialect === "regex") {
            assert.equal(new RegExp(pipeAlt.pattern, "u").test("def zeros(shape):"), true);
            assert.equal(new RegExp(pipeAlt.pattern, "u").test("x = Array([]"), true);
        }
        assert.equal(parseMatcher("a || b", "find").dialect, "glob");
        assert.equal(parseMatcher("@(alpha|beta)", "find").dialect, "glob");
        assert.equal(parseMatcher("def zeros|def ones", "edit").dialect, "glob");
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
        assert.deepEqual(parseMatcher("~^class (Max|Min)", "find"), {
            dialect: "regex",
            raw: "~^class (Max|Min)",
            pattern: "^class (Max|Min)",
            flags: "",
        });
        assert.deepEqual(parseMatcher("~/def foo/i", "read"), {
            dialect: "regex",
            raw: "~/def foo/i",
            pattern: "def foo",
            flags: "i",
        });
        assert.deepEqual(parseMatcher("~//not-regex", "find"), { dialect: "fts", raw: "~//not-regex" });
        assert.deepEqual(parseMatcher("&<parseMatcher"), { dialect: "graph", raw: "&<parseMatcher" });
        assert.deepEqual(parseMatcher("&>parsePath"), { dialect: "graph", raw: "&>parsePath" });
        assert.deepEqual(parseMatcher("&def _coeff_isneg"), { dialect: "graph", raw: "&_coeff_isneg" });
        assert.deepEqual(parseMatcher("&async def run_loop"), { dialect: "graph", raw: "&run_loop" });
        assert.deepEqual(parseMatcher("&<class MyModel"), { dialect: "graph", raw: "&<MyModel" });
        assert.deepEqual(parseMatcher("*.config.ts"), { dialect: "glob", raw: "*.config.ts" });

        // Non-XPath `//<ident>...` with regex operators recovers as regex on `find`/`read` (#1530)
        assert.deepEqual(parseMatcher("//def _scan_iterable_shape|//def _scan", "find"), {
            dialect: "regex",
            raw: "//def _scan_iterable_shape|//def _scan",
            pattern: "def _scan_iterable_shape|def _scan",
            flags: "",
        });

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

    test("{§matcher-prefix-claims} {§expression-boundaries} {§parse-recovery}: ScopeSyntax parses numeric markers, count/insert/relative recoveries, and @hash anchor tuples", () => {
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
        assert.deepEqual(parseTextLineMarker("L2"), { marks: [2] });
        assert.deepEqual(parseTextLineMarker("L10-L20"), { marks: [10, 20] });
        assert.deepEqual(parseTextLineMarker("#1741,1754"), { marks: [1741, 1754] });
        assert.deepEqual(parseTextLineMarker("1240,1242@"), { marks: [1240, 1242] });
        assert.deepEqual(parseTextLineMarker("@qAVg2,qAVg2"), { marks: ["@qAVg2", "@qAVg2"] });
        assert.deepEqual(parseTextLineMarker("@abcde,12345"), { marks: ["@abcde", 12345] });

        // Unambiguous open-ended Python slice markers recover (`-K:` -> `-K,-1`, `:M` -> `1,M`) (#1530)
        assert.deepEqual(parseLineMarker("-30:"), { marks: [-30, -1] });
        assert.deepEqual(parseLineMarker("[-30:]"), { marks: [-30, -1] });
        assert.deepEqual(parseTextLineMarker("-45:"), { marks: [-45, -1] });
        assert.deepEqual(parseLineMarker(":50"), { marks: [1, 50] });
        assert.deepEqual(parseTextLineMarker("[:50]"), { marks: [1, 50] });

        // Ambiguous positive/two-sided colon slices are refused with generic working-form recovery (#1530)
        for (const ambiguousSlice of ["100:", "-30:-1", ":-10", "10:50"]) {
            assert.throws(
                () => parseTextLineMarker(ambiguousSlice),
                (err: unknown) => err instanceof PlurnkParseError
                    && typeof err.recovery === "string"
                    && err.recovery.includes('range: "-K,-1"')
                    && err.recovery.includes("startLine,startCol,endLine,endCol"),
                ambiguousSlice,
            );
        }

        // Refusal diagnostics on invalid ranges (including explicit 4-coordinate column recovery on `line:col`)
        assert.throws(
            () => parseTextLineMarker("1:1-2"),
            (err: unknown) => err instanceof PlurnkParseError
                && /use numeric coordinates or `@hash` line anchors/u.test(err.message)
                && err.recovery?.includes("startLine,startCol,endLine,endCol") === true,
        );
        assert.throws(
            () => parseTextLineMarker("1:1,1:2"),
            (err: unknown) => err instanceof PlurnkParseError
                && err.recovery?.includes("endCol` exclusive") === true,
        );
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
