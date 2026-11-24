import assert from "node:assert/strict";
import test from "node:test";
import { PlurnkParseError } from "@plurnk/plurnk-contracts";
import { parseCallStatements } from "./CallExpressionParser.ts";

test("{§parser-lowering} parseCallStatements decodes comments, escapes, literals, type placeholders, concat, kwargs, and bracketed calls", () => {
    const source = [
        "// leading comment",
        "/* block comment */",
        'await plurnk["read"]({ path: "a\\n\\r\\t\\b\\f\\v\\0\\\\\\\'\\"\\`\\$\\x41\\u0042\\u{1F600}\\q\\\n\\\r\nz", extra?: true; count: 1_000, hex: 0x10, bin: 0b101, oct: 0o17 }); // read file',
        "srv['search'](query = 'he' + 'llo ' + 42, flag = True, off = False, empty = None, undef = undefined, nan = NaN, inf = Infinity)",
        "srv.typed({ a: Array<string | Record<string, number>>[], r: /ab[c/d]\\/e/gi, list: [1, `two\r\nthree`] })",
    ].join("\n");

    const parsed = parseCallStatements(source);
    assert.equal(parsed.length, 3);

    assert.deepEqual(parsed[0]?.chain, ["plurnk", "read"]);
    assert.equal(parsed[0]?.aside, "read file");
    const firstArg = parsed[0]?.args[0] as Record<string, unknown>;
    assert.equal(firstArg.path, "a\n\r\t\b\f\v\0\\'\"`$AB😀qz");
    assert.equal(firstArg.extra, true);
    assert.equal(firstArg.count, 1000);
    assert.equal(firstArg.hex, 16);
    assert.equal(firstArg.bin, 5);
    assert.equal(firstArg.oct, 15);

    assert.deepEqual(parsed[1]?.chain, ["srv", "search"]);
    const secondArg = parsed[1]?.args[0] as Record<string, unknown>;
    assert.equal(secondArg.query, "hello 42");
    assert.equal(secondArg.flag, true);
    assert.equal(secondArg.off, false);
    assert.equal(secondArg.empty, null);
    assert.equal(secondArg.undef, undefined);
    assert.equal(Number.isNaN(secondArg.nan), true);
    assert.equal(secondArg.inf, Number.POSITIVE_INFINITY);

    assert.deepEqual(parsed[2]?.chain, ["srv", "typed"]);
    const thirdArg = parsed[2]?.args[0] as Record<string, unknown>;
    assert.deepEqual(thirdArg.a, []);
    assert.equal(thirdArg.r, "/ab[c/d]\\/e/gi");
    assert.deepEqual(thirdArg.list, [1, "two\nthree"]);
});

test("{§parser-lowering} parseCallStatements refuses malformed escapes, literals, identifiers, and JavaScript control flow", () => {
    const invalidInputs: ReadonlyArray<readonly [string, RegExp]> = [
        ["/* unterminated", /Unterminated block comment/u],
        ['plurnk.read("unterminated)', /Unterminated string literal/u],
        ['plurnk.read("\\")', /Unterminated string literal/u],
        ['plurnk.read("\\xZZ")', /Invalid hex escape/u],
        ['plurnk.read("\\u12")', /Invalid unicode escape/u],
        ['plurnk.read("\\u{}")', /Invalid unicode escape/u],
        ["plurnk.read({ 123 })", /Expected `:` after property/u],
        ["plurnk.read({ +: 1 })", /Expected property name/u],
        ["plurnk.read({ a: 1 b: 2 })", /Expected `,` or `\}`/u],
        ["plurnk.read({ a: 1,", /Unterminated object literal/u],
        ["plurnk.read([1 2])", /Expected `,` or `\]`/u],
        ["plurnk.read([1, 2,", /Unterminated array literal/u],
        ["plurnk.read(/abc\n/)", /Unterminated regular expression/u],
        ["plurnk.read(/abc", /Unterminated regular expression/u],
        ["plurnk.read(someVariable)", /Unexpected identifier `someVariable`/u],
        ["plurnk.read(@)", /Unexpected token `@\)`/u],
        ["plurnk.read(1 2)", /Expected `,` or `\)`/u],
        ["plurnk.read(1, 2,", /Unterminated argument list/u],
        ["123()", /Syntax error/u],
        ["plurnk.()", /Expected tool name after `\.`/u],
        ["plurnk[123]()", /Expected string literal inside `\[\.\.\.\]`/u],
        ['plurnk["read"()', /Expected `\]` after bracketed tool name/u],
        ["plurnk.read", /did not invoke a tool/u],
        ["const x = plurnk.read({})", /Unexpected `const`; general JavaScript control flow is not supported/u],
    ];

    for (const [input, pattern] of invalidInputs) {
        assert.throws(
            () => parseCallStatements(input),
            (err: unknown) => err instanceof PlurnkParseError && pattern.test(err.message),
            `expected ${JSON.stringify(input)} to match ${String(pattern)}`,
        );
    }
});
