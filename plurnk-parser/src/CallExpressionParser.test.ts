import test, { describe } from "node:test";
import assert from "node:assert/strict";
import { PlurnkParseError } from "@plurnk/plurnk-contracts";
import { parseCallStatements } from "./CallExpressionParser.ts";
import { hasHeredocKey } from "./HeredocSyntax.ts";

const POS = { line: 1, column: 0 };

describe("CallExpressionParser", () => {
    test("{§parser-build} {§op-shapes}: parseCallStatements decodes string escapes, numeric literals, regexes, array.join, string concatenation, Python literals, and TS placeholders", () => {
        const calls = parseCallStatements(
            [
                'await plurnk.note({ text: "a\\n\\r\\t\\b\\f\\v\\0\\\\\\\'\\"\\`\\$\\\n\\\r\n\\x41\\u0042\\u{1F680}\\q" + "!" });',
                'await plurnk["find"]({ range: [0x10, 0b1010, 0o17, 1_000.5e2, .5], pattern: /a\\/[b/c]/gi });',
                'await plurnk.edit({ path: ["src", "index.ts"].join("/"), text: [1, true].join() });',
                "await gitea.issue_read({ a: True, b: False, c: None, d: undefined, e: NaN, f: Infinity, s: string | null, arr: Array<Record<string, any>>[] });",
            ].join("\n"),
            POS,
        );

        assert.equal(calls.length, 4);
        assert.deepEqual(calls[0]?.args[0], {
            text: "a\n\r\t\b\f\v\0\\'\"`$AB🚀q!",
        });
        assert.deepEqual(calls[1]?.chain, ["plurnk", "find"]);
        assert.deepEqual(calls[1]?.args[0], {
            range: [16, 10, 15, 100050, 0.5],
            pattern: "/a\\/[b/c]/gi",
        });
        assert.deepEqual(calls[2]?.args[0], {
            path: "src/index.ts",
            text: "1,true",
        });
        const fourth = calls[3]?.args[0] as Record<string, unknown>;
        assert.equal(fourth.a, true);
        assert.equal(fourth.b, false);
        assert.equal(fourth.c, null);
        assert.equal(fourth.d, undefined);
        assert.ok(Number.isNaN(fourth.e));
        assert.equal(fourth.f, Number.POSITIVE_INFINITY);
        assert.equal(fourth.s, "");
        assert.deepEqual(fourth.arr, []);
    });

    test("{§fence-pairing} {§parse-recovery}: parseCallStatements supports keyword args with heredocs, parenthesized calls, extra braces, premature closes, and transposed closers", () => {
        const calls = parseCallStatements(
            [
                '((await (plurnk.edit(path="src/a.ts", pattern=<<<EOF\n/raw/\nEOF, text=<<<EOF2\nbody\nEOF2))));',
                'await plurnk.read({{ path?: "src/b.ts"; range: "1,5" }});',
                'await plurnk.edit({ path: "src/c.ts" }, { text: "merged?" });',
                'await plurnk.edit({ path: "src/d.ts" }, text: "premature-close" });',
                'await plurnk.read({ path: "src/e.ts" )};',
                'await plurnk.todo({ items: ["one", "two"}) ]);',
                'await plurnk.note({ text: \'unquoted "inner\' + " end" }/>);',
                'await plurnk.note(<<EOF1, <<EOF2);\nfirst\nEOF1\nsecond\nEOF2',
            ].join("\n"),
            POS,
        );

        assert.equal(calls.length, 8);
        const kwObj = calls[0]?.args[0] as Record<string, unknown>;
        assert.deepEqual(kwObj, { path: "src/a.ts", pattern: "/raw/", text: "body" });
        assert.equal(hasHeredocKey(kwObj, "pattern"), true);
        assert.equal(hasHeredocKey(kwObj, "text"), true);
        assert.equal(hasHeredocKey(kwObj, "path"), false);

        assert.deepEqual(calls[1]?.args[0], { path: "src/b.ts", range: "1,5" });
        assert.equal(calls[2]?.args.length, 2);
        assert.deepEqual(calls[3]?.args[0], { path: "src/d.ts", text: "premature-close" });
        assert.deepEqual(calls[4]?.args[0], { path: "src/e.ts" });
        assert.deepEqual(calls[5]?.args[0], { items: ["one", "two"] });
        assert.deepEqual(calls[6]?.args[0], { text: 'unquoted "inner end' });
        assert.deepEqual(calls[7]?.args, ["first", "second"]);
    });

    test("{§parse-recovery}: parseCallStatements tolerates unescaped quotes inside object string values and half-quoted keys", () => {
        const calls = parseCallStatements(
            'await plurnk.edit({ path": "a.ts", text: "const msg = "hello";\nreturn msg;" });',
            { line: 10, column: 2 },
        );
        assert.equal(calls.length, 1);
        assert.deepEqual(calls[0]?.position, { line: 10, column: 2 });
        assert.deepEqual(calls[0]?.args[0], {
            path: "a.ts",
            text: 'const msg = "hello";\nreturn msg;',
        });
    });

    test("{§parse-recovery}: parseCallStatements refuses general JS statements, invalid escapes, unterminated constructs, and non-literal arguments with exact positions", () => {
        const errorCases: Array<[string, RegExp]> = [
            ["const x = await plurnk.read({ path: 'a.ts' });", /Unexpected `const`; Code Mode statements are declarative tool calls/u],
            ["for (const f of files) { await plurnk.read(f); }", /Unexpected `for`/u],
            ["return 42;", /Unexpected `return`/u],
            ["await plurnk.read(/* unterminated", /Unterminated block comment/u],
            ['await plurnk.note("unterminated\\', /Unterminated string escape/u],
            ['await plurnk.note("unterminated', /Unterminated string literal/u],
            ['await plurnk.note("\\xZZ");', /Invalid hex escape/u],
            ['await plurnk.note("\\u12G4");', /Invalid unicode escape/u],
            ['await plurnk.note("\\u{1100000}");', /Invalid unicode escape/u],
            ["await plurnk.note(<<<123);", /Invalid heredoc delimiter/u],
            ["await plurnk.note(<<<EOF\nno closer);", /Unterminated heredoc/u],
            ["await plurnk.note(<<EOF)", /Unterminated heredoc/u],
            ["await plurnk.note(<<EOF)\nwrong_tag", /Unterminated heredoc/u],
            ["await plurnk.find({ pattern: /unclosed\n });", /Unterminated regular expression literal/u],
            ["await plurnk.find({ pattern: /unclosed", /Unterminated regular expression literal/u],
            ["await plurnk.read({ = 1 });", /Expected property name in object literal/u],
            ["await plurnk.read({ path });", /Expected `:` after property name `path`/u],
            ["await plurnk.read({ range: 1 2 });", /Expected `,` or `\}` in object literal/u],
            ['await plurnk.read({ path: "a",', /Unterminated object literal/u],
            ['await plurnk.read(["a" "b"]);', /Expected `,` or `\]` in array literal/u],
            ['await plurnk.read(["a",', /Unterminated array literal/u],
            ["await plurnk.read(someVar);", /Unexpected identifier `someVar`/u],
            ["await plurnk.read(@);", /Unexpected token `@\);`/u],
            ["await plurnk.read({ path: ", /Unexpected end of input while reading argument value/u],
            ["await plurnk.read(1 2);", /Expected `,` or `\)` in argument list/u],
            ['await plurnk.read("a",', /Unterminated argument list/u],
            ["123;", /Code Mode syntax error: unexpected `123;`/u],
            ["await plurnk.(1);", /Expected tool name after `\.`/u],
            ["await plurnk[123]();", /Expected string literal inside `\[\.\.\.\]`/u],
            ['await plurnk["read"();', /Expected `\]` after bracketed tool name/u],
            ["await plurnk.read;", /did not invoke an operation; call it with `\(\.\.\.\)`/u],
        ];

        for (const [code, pattern] of errorCases) {
            assert.throws(
                () => parseCallStatements(code, { line: 5, column: 4 }),
                (err: unknown) => err instanceof PlurnkParseError && pattern.test(err.message) && err.line >= 5,
                `Expected ${pattern} for: ${code}`,
            );
        }
    });
});
