import test, { describe } from "node:test";
import assert from "node:assert/strict";
import type { EditStatement, ExecStatement, PlurnkStatement, ReadStatement } from "@plurnk/plurnk-contracts";
import { decodeChildTagCalls, parseXmlToolCallBody } from "./MarkupReader.ts";
import { buildExecutorSpellings } from "./OptionCoercion.ts";
import PlurnkParser from "./PlurnkParser.ts";
import { createSourceIndex, readTrailingAside } from "./SourceIndex.ts";
import {
    coerceParamValue,
    hasFencedCodeModeCall,
    normalizeDecodedArgs,
    parseWrapperTag,
    resolveCallChain,
    unescapeAttrValue,
} from "./TargetResolver.ts";

const EXECUTORS = ["sh", "js", "python3", "plurnk", "gitea"] as const;
const SPELLINGS = buildExecutorSpellings(EXECUTORS);

const parseCanonical = (source: string): string => {
    const parsed = PlurnkParser.parse(source, { executors: EXECUTORS });
    const errors = parsed.items.filter((i) => i.kind === "error");
    assert.deepEqual(errors, [], `Unexpected parse errors for:\n${source}`);
    const stmts = parsed.items.flatMap((i): PlurnkStatement[] => i.kind === "statement" ? [i.statement] : []);
    return PlurnkParser.stringify(stmts);
};

describe("SourceIndex, TargetResolver, MarkupReader, and EnvelopeScanner", () => {
    test("{§parser-build} {§whitespace-contract}: SourceIndex computes 1-based lines, astral code-point columns, line bounds, and split trailing asides", () => {
        const src = "first\r\n😀second\nthird";
        const idx = createSourceIndex(src);
        assert.equal(idx.lineCount, 3);
        assert.deepEqual(idx.lineBounds(0), { start: 0, end: 5, rawEnd: 6, nextLineStart: 7 });
        assert.deepEqual(idx.lineBounds(1), { start: 7, end: 15, rawEnd: 15, nextLineStart: 16 });
        assert.deepEqual(idx.positionAt(0), { line: 1, column: 0 });
        // `😀` is 2 UTF-16 code units (offsets 7..9), so `s` at offset 9 is code-point column 1.
        assert.deepEqual(idx.positionAt(9), { line: 2, column: 1 });
        assert.deepEqual(idx.positionAt(16), { line: 3, column: 0 });

        const glued = readTrailingAside(" note here### log:///1/2/1/sh · 10\nnext", 0);
        assert.equal(glued.aside, "note here");
        assert.equal(" note here### log:///1/2/1/sh · 10\nnext".slice(glued.endOffset), "### log:///1/2/1/sh · 10\nnext");
    });

    test("{§parser-build} {§fence-pairing} {§parse-recovery}: TargetResolver classifies wrapper tags, strict vs lenient call chains, mcp__ targets, and attribute coercion", () => {
        assert.deepEqual(parseWrapperTag("tool_call"), { isWrapper: true });
        assert.deepEqual(parseWrapperTag("｜DSML｜ function_calls"), { isWrapper: true });
        assert.deepEqual(parseWrapperTag("antml:invoke"), { isWrapper: true, defaultService: undefined });
        assert.deepEqual(parseWrapperTag("gitea:invoke"), { isWrapper: true, defaultService: "gitea" });
        assert.deepEqual(parseWrapperTag("plurnk.read"), { isWrapper: false });

        assert.equal(resolveCallChain("", SPELLINGS), null);
        assert.equal(resolveCallChain("tool_call", SPELLINGS), null);
        assert.deepEqual(resolveCallChain("functions.plurnk.read:0", SPELLINGS), ["plurnk", "read"]);
        assert.equal(resolveCallChain("plurnk.unknown_member", SPELLINGS, true), null);
        assert.deepEqual(resolveCallChain("plurnk.unknown_member", SPELLINGS, false), ["plurnk", "unknown_member"]);
        assert.equal(resolveCallChain("plurnk.invoke", SPELLINGS, false), null);

        assert.equal(resolveCallChain("other_svc.list", SPELLINGS, true), null);
        assert.deepEqual(resolveCallChain("other_svc.list", SPELLINGS, false), ["other_svc", "list"]);
        assert.deepEqual(resolveCallChain("gitea.issue_read", SPELLINGS, true), ["gitea", "issue_read"]);

        assert.deepEqual(resolveCallChain("mcp__gitea__issue_read", SPELLINGS, true), ["gitea", "issue_read"]);
        assert.deepEqual(resolveCallChain("mcp__plurnk__read", SPELLINGS, true), ["plurnk", "read"]);
        assert.equal(resolveCallChain("mcp__plurnk__bogus", SPELLINGS, true), null);
        assert.equal(resolveCallChain("mcp__unknown__fetch", SPELLINGS, true), null);
        assert.deepEqual(resolveCallChain("mcp__unknown__fetch", SPELLINGS, false), ["unknown", "fetch"]);
        assert.equal(resolveCallChain("mcp__unknown__tool", SPELLINGS, false), null);

        assert.deepEqual(resolveCallChain("bash", SPELLINGS), ["plurnk", "sh"]);
        assert.deepEqual(resolveCallChain("python", SPELLINGS), ["plurnk", "python3"]);
        assert.deepEqual(resolveCallChain("tool_read", SPELLINGS), ["plurnk", "read"]);
        assert.equal(resolveCallChain("tool_nonexistent", SPELLINGS), null);
        assert.deepEqual(resolveCallChain("gitea_issue_read", SPELLINGS), ["gitea", "issue_read"]);

        assert.deepEqual(resolveCallChain("issue_read", SPELLINGS, false, "gitea"), ["gitea", "issue_read"]);
        assert.deepEqual(resolveCallChain("read", SPELLINGS, false, "gitea"), ["gitea", "read"]);
        assert.deepEqual(resolveCallChain("read", SPELLINGS, false, "unregistered_svc"), ["plurnk", "read"]);

        assert.deepEqual(normalizeDecodedArgs(undefined), []);
        assert.deepEqual(normalizeDecodedArgs("   "), []);
        assert.deepEqual(normalizeDecodedArgs('{"path":"a.ts"}'), [{ path: "a.ts" }]);
        assert.deepEqual(normalizeDecodedArgs("{ echo hi; }"), ["{ echo hi; }"]);
        assert.deepEqual(normalizeDecodedArgs(["a.ts", { range: "1,5" }]), ["a.ts", { range: "1,5" }]);

        assert.equal(unescapeAttrValue('hello\\n\\t\\"world\\"', '"'), 'hello\n\t"world"');
        assert.equal(unescapeAttrValue("bad\\q\\n'quote\\'", "'"), "bad\\q\n'quote'");
        assert.deepEqual(coerceParamValue("<<<EOF\nline 1\nEOF"), { value: "line 1", isHeredoc: true });
        assert.equal(hasFencedCodeModeCall('gitea.issue_read({ index: 1 })', SPELLINGS), true);
        assert.equal(hasFencedCodeModeCall('sh.exec({ text: "ls" })', SPELLINGS), false);
    });

    test("{§fence-pairing} {§parse-recovery}: MarkupReader decodes GLM arg_key pairs, parameter tags, direct field tags, fenced JSON, and refuses <result><output/></result> echoes", () => {
        assert.deepEqual(
            parseXmlToolCallBody("<parameters><arg_key>path</arg_key><arg_value>a.ts</arg_value><arg_key>items</arg_key><arg_value>[\"x\"]</arg_value><arg_key>invalid</arg_key><arg_value>{broken</arg_value></parameters>"),
            { path: "a.ts", items: ["x"], invalid: "{broken" },
        );
        assert.deepEqual(
            parseXmlToolCallBody('<antml:parameter name="path">src/a.ts</antml:parameter><param=limit>true">25</param>'),
            { path: "src/a.ts", limit: "25" },
        );
        assert.deepEqual(
            parseXmlToolCallBody("<path>src/b.ts</path><range>1,10</range>"),
            { path: "src/b.ts", range: "1,10" },
        );
        assert.deepEqual(
            parseXmlToolCallBody("```json\n{\"path\":\"c.ts\"}\n```"),
            { path: "c.ts" },
        );
        assert.equal(parseXmlToolCallBody("{not valid json"), "{not valid json");
        assert.deepEqual(parseXmlToolCallBody("   "), {});

        const pos = { line: 1, column: 0 };
        assert.deepEqual(
            decodeChildTagCalls("plurnk.read\n<arg_key>path</arg_key><arg_value>x.ts</arg_value>", SPELLINGS, pos),
            [{ chain: ["plurnk", "read"], args: [{ path: "x.ts" }], position: pos }],
        );
        assert.deepEqual(
            decodeChildTagCalls("<gitea:name>issue_read</gitea:name><gitea:arguments>{\"index\":9}</gitea:arguments>", SPELLINGS, pos),
            [{ chain: ["gitea", "issue_read"], args: [{ index: 9 }], position: pos }],
        );
        assert.equal(
            decodeChildTagCalls("<name>plurnk.read</name><output>file contents</output>", SPELLINGS, pos, undefined, true),
            null,
        );
        assert.deepEqual(
            decodeChildTagCalls("<name>plurnk.read</name><arguments>{\"path\":\"x.ts\"}</arguments><output>ignored</output>", SPELLINGS, pos, undefined, true),
            [{ chain: ["plurnk", "read"], args: [{ path: "x.ts" }], position: pos }],
        );
    });

    test("{§parser-build} {§fence-pairing}: ChunkScanner unwraps Code Mode fences while preserving prose fences, nested fences, string/heredoc fences, and dangling empty fences", () => {
        const fencedTurn = [
            "Checking the file first:",
            "```ts",
            'plurnk.read({ path: "src/index.ts" });',
            "```",
            "```javascript",
            'gitea.issue_read({ index: 5 });',
            "```",
            "And prose code blocks that must remain fenced:",
            "```js",
            "console.log({ ok: true });",
            "node.appendChild(child);",
            "```",
            "```python",
            "print('not a tool call')",
            "```",
        ].join("\n");
        const parsed = PlurnkParser.parse(fencedTurn, { executors: EXECUTORS });
        assert.deepEqual(parsed.items.filter((i) => i.kind === "error"), []);
        const stmts = parsed.items.flatMap((i) => i.kind === "statement" ? [i.statement] : []);
        assert.equal(stmts.length, 2);
        assert.equal((stmts[0] as ReadStatement).target?.raw, "src/index.ts");
        assert.equal((stmts[1] as ExecStatement).runtime, "gitea");
        const texts = parsed.items.flatMap((i) => i.kind === "text" ? [i.content] : []).join("\n");
        assert.ok(texts.includes("```js\nconsole.log({ ok: true });\nnode.appendChild(child);\n```"));
        assert.ok(texts.includes("```python\nprint('not a tool call')\n```"));

        const nested = "```ts\nawait plurnk.note({ text: \"hi\" });\n~~~\ninner\n~~~\n```";
        const nestedParsed = PlurnkParser.parse(nested, { executors: EXECUTORS });
        assert.equal(nestedParsed.items.filter((i) => i.kind === "statement").length, 0);
        assert.equal(nestedParsed.items[0]?.kind, "text");

        const dangling = PlurnkParser.parse('await plurnk.read({ path: "a.ts" });\n```\n   ', { executors: EXECUTORS });
        assert.equal(dangling.unparsedTail, undefined);
        assert.equal(dangling.items.filter((i) => i.kind === "statement").length, 1);

        const protectedBlocks = [
            "```xml",
            '<plurnk.read path="inside-fence.ts" />',
            "```",
            'await plurnk.edit({ path: "x.xml", text: <<<EOF',
            '<tool_call>{"name":"plurnk.read","args":{"path":"inside-heredoc.ts"}}</tool_call>',
            "EOF });",
        ].join("\n");
        const protParsed = PlurnkParser.parse(protectedBlocks, { executors: EXECUTORS });
        const protStmts = protParsed.items.flatMap((i) => i.kind === "statement" ? [i.statement] : []);
        assert.equal(protStmts.length, 1);
        assert.equal((protStmts[0] as EditStatement).body, '<tool_call>{"name":"plurnk.read","args":{"path":"inside-heredoc.ts"}}</tool_call>');
    });

    test("{§fence-pairing} {§parse-recovery}: EnvelopeScanner decodes JSON descriptors, Pythonic calls, Mistral [ARGS], Cohere Action, proxy tool_uses, XML attributes, and stuttered hybrids", () => {
        const cases: Array<[string, string]> = [
            [
                '<tool_call>{"type":"function","function":{"name":"plurnk.read","arguments":{"path":"src/a.ts"}}}</tool_call>',
                'plurnk.read({"path":"src/a.ts"})',
            ],
            [
                '<tool_call>{"command":"sh","arguments":{"text":"ls"}}</tool_call>',
                'plurnk.sh({"text":"ls"})',
            ],
            [
                '<tool_call>{"tool":"plurnk.find","path":"src/**","id":"call_1","timeout":5000}</tool_call>',
                'plurnk.find({"path":"src/**"})',
            ],
            [
                '<tool_call>{"path":"src/x.ts","content":"export const x = 1;","call_id":"1"}</tool_call>',
                'plurnk.edit({"path":"src/x.ts","text":"export const x = 1;"})',
            ],
            [
                '<tool_call>{"decision":"Keep schema strict."}</tool_call>',
                'plurnk.note({"text":"Keep schema strict."})',
            ],
            [
                '<tool_call>{"todos":["Write matrix tests"]}</tool_call>',
                'plurnk.todo({"items":["Write matrix tests"]})',
            ],
            [
                '<tool_calls>\n{"name":"plurnk.note","args":{"text":"one"}}\n{"name":"plurnk.wait","args":{"seconds":5}}\n</tool_calls>',
                'plurnk.note({"text":"one"})\n\nplurnk.wait({"seconds":5})',
            ],
            [
                '<tool_call>{"recipient_name":"functions.plurnk.read","parameters":{"path":"src/p.ts"}}</tool_call>',
                'plurnk.read({"path":"src/p.ts"})',
            ],
            [
                '<tool_call>{"tool_uses":[{"recipient_name":"functions.plurnk.read","parameters":{"path":"a.ts"}},{"recipient_name":"functions.gitea.issue_read","parameters":{"index":3}}]}</tool_call>',
                'plurnk.read({"path":"a.ts"})\n\ngitea.issue_read({"index":3})',
            ],
            [
                '<|tool_call_start|>[plurnk.find(path="src/**", range="1,10"), gitea.issue_read({"owner":"plurnk","repo":"svc"}, index=2, active=True, closed=False, milestone=None, labels=["bug", \'\'\'p1\'\'\']), plurnk.wait()]<|tool_call_end|>',
                'plurnk.find({"path":"src/**","range":"1,10"})\n\ngitea.issue_read({"owner":"plurnk","repo":"svc","index":2,"active":true,"closed":false,"milestone":null,"labels":["bug","p1"]})\n\nplurnk.wait({})',
            ],
            [
                '[TOOL_CALLS]plurnk.read[ARGS]{"path":"a.ts"}gitea.issue_read[ARGS]{"index":7}',
                'plurnk.read({"path":"a.ts"})\n\ngitea.issue_read({"index":7})',
            ],
            [
                '<|python_tag|>[{"name":"plurnk.read","arguments":{"path":"c.ts"}}]',
                'plurnk.read({"path":"c.ts"})',
            ],
            [
                '<|python_tag|>[plurnk.read(path="d.ts")]',
                'plurnk.read({"path":"d.ts"})',
            ],
            [
                '<｜DSML｜ invoke name="multi_tool_use.parallel">\n<｜DSML｜ parameter name="tool_uses">[{"recipient_name":"functions.plurnk.read","parameters":{"path":"a.ts"}},{"recipient_name":"functions.plurnk.note","text":"batch note"}]</｜DSML｜ parameter>\n</｜DSML｜ invoke>',
                'plurnk.read({"path":"a.ts"})\n\nplurnk.note({"text":"batch note"})',
            ],
            [
                '<｜tool▁call▁begin｜>function<｜tool▁sep｜>plurnk.read<｜tool▁call▁argument▁begin｜>{"path":"ds.ts"}<｜tool▁call▁end｜>',
                'plurnk.read({"path":"ds.ts"})',
            ],
            [
                '<antml:await plurnk.read({"path":"h.ts"})/></await>',
                'plurnk.read({"path":"h.ts"})',
            ],
            [
                '<tool<plurnk.edit({"path":"p.json","text":"{}"})',
                'plurnk.edit({"path":"p.json","text":"{}"})',
            ],
            [
                '<tool_call <plurnk.edit({"path":"p.json","text":"{}"})/>',
                'plurnk.edit({"path":"p.json","text":"{}"})',
            ],
            [
                '<<plurnk.edit({"path":"p.json","text":"{}"})',
                'plurnk.edit({"path":"p.json","text":"{}"})',
            ],
            [
                '<｜DSML｜<plurnk.edit({"path":"p.json","text":"{}"})',
                'plurnk.edit({"path":"p.json","text":"{}"})',
            ],
        ];

        for (const [input, expected] of cases) {
            assert.equal(parseCanonical(input), expected, input);
        }

        // Prose with inline-backticked `<result name=...>` stays untouched; mid-line glued `<tool_call>` splits cleanly.
        const docProse = 'For example, `<result name=plurnk>ok</result>` or `<result name="read">ok</result>` in documentation.';
        const docParsed = PlurnkParser.parse(docProse, { executors: EXECUTORS });
        assert.equal(docParsed.items.filter((i) => i.kind === "statement").length, 0);
        assert.equal(docParsed.items[0]?.kind === "text" ? docParsed.items[0].content : "", docProse);

        const gluedMidLine = PlurnkParser.parse('Prose glued to tag<tool_call>{"name":"plurnk.wait","args":{"seconds":1}}</tool_call>', { executors: EXECUTORS });
        assert.equal(gluedMidLine.items.length, 2);
        assert.equal(gluedMidLine.items[0]?.kind === "text" ? gluedMidLine.items[0].content : "", "Prose glued to tag");
        assert.equal(gluedMidLine.items[1]?.kind, "statement");

        // Unterminated call inside `<tool_call>[...]` unwraps to surface a clean call-level diagnostic rather than prose.
        const malformedInner = PlurnkParser.parse('<tool_call>[plurnk.read(path="unterminated)]</tool_call>', { executors: EXECUTORS });
        assert.ok(malformedInner.unparsedTail !== undefined || malformedInner.items.some((i) => i.kind === "error"));
    });
});
