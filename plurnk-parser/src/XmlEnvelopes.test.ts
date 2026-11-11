import test, { describe } from "node:test";
import assert from "node:assert/strict";
import {
    formatTranslatedCall,
    padNewlines,
    parseWrapperTag,
    parseXmlToolCallBody,
    replaceXmlInvocations,
    resolveToolCallTarget,
    translateXmlToolCalls,
    tryTranslateChildTagCall,
    unescapeXmlAttrValue,
} from "./XmlEnvelopes.ts";
import { buildExecutorSpellings } from "./OptionCoercion.ts";

const SPELLINGS = buildExecutorSpellings(["sh", "js", "python3", "plurnk", "gitea"]);

describe("XmlEnvelopes", () => {
    test("{§parser-build} {§fence-pairing}: parseWrapperTag and padNewlines classify wrapper verbs, DSML tags, and service prefixes", () => {
        assert.deepEqual(parseWrapperTag("tool_call"), { isWrapper: true });
        assert.deepEqual(parseWrapperTag("｜DSML｜ function_calls"), { isWrapper: true });
        assert.deepEqual(parseWrapperTag("antml:invoke"), { isWrapper: true, defaultService: undefined });
        assert.deepEqual(parseWrapperTag("gitea:invoke"), { isWrapper: true, defaultService: "gitea" });
        assert.deepEqual(parseWrapperTag("plurnk.read"), { isWrapper: false });

        assert.equal(padNewlines("one", "a\nb\nc"), "one\n\n");
        assert.equal(padNewlines("a\nb", "single"), "a\nb");
    });

    test("{§fence-pairing} {§parse-recovery}: resolveToolCallTarget handles strict vs lenient services, mcp__, native executor fallbacks, and defaultService", () => {
        assert.equal(resolveToolCallTarget("", SPELLINGS), null);
        assert.equal(resolveToolCallTarget("tool_call", SPELLINGS), null);
        assert.equal(resolveToolCallTarget("functions.plurnk.read:0", SPELLINGS), "plurnk.read");
        assert.equal(resolveToolCallTarget("plurnk.unknown_member", SPELLINGS, true), null);
        assert.equal(resolveToolCallTarget("plurnk.unknown_member", SPELLINGS, false), "plurnk.unknown_member");
        assert.equal(resolveToolCallTarget("plurnk.invoke", SPELLINGS, false), null);

        // External service strict vs lenient
        assert.equal(resolveToolCallTarget("other_svc.list", SPELLINGS, true), null);
        assert.equal(resolveToolCallTarget("other_svc.list", SPELLINGS, false), "other_svc.list");
        assert.equal(resolveToolCallTarget("gitea.issue_read", SPELLINGS, true), "gitea.issue_read");

        // mcp__ and service__tool forms
        assert.equal(resolveToolCallTarget("mcp__gitea__issue_read", SPELLINGS, true), "gitea.issue_read");
        assert.equal(resolveToolCallTarget("mcp__plurnk__read", SPELLINGS, true), "plurnk.read");
        assert.equal(resolveToolCallTarget("mcp__plurnk__bogus", SPELLINGS, true), null);
        assert.equal(resolveToolCallTarget("mcp__unknown__fetch", SPELLINGS, true), null);
        assert.equal(resolveToolCallTarget("mcp__unknown__fetch", SPELLINGS, false), "unknown.fetch");
        assert.equal(resolveToolCallTarget("mcp__unknown__tool", SPELLINGS, false), null);

        // Native tool executor fallbacks (`bash`, `shell`, `python`, `py`) and `service_tool` prefixes
        assert.equal(resolveToolCallTarget("bash", SPELLINGS), "plurnk.sh");
        assert.equal(resolveToolCallTarget("python", SPELLINGS), "plurnk.python3");
        assert.equal(resolveToolCallTarget("tool_read", SPELLINGS), "plurnk.read");
        assert.equal(resolveToolCallTarget("tool_nonexistent", SPELLINGS), null);
        assert.equal(resolveToolCallTarget("gitea_issue_read", SPELLINGS), "gitea.issue_read");

        // defaultService routing
        assert.equal(resolveToolCallTarget("issue_read", SPELLINGS, false, "gitea"), "gitea.issue_read");
        assert.equal(resolveToolCallTarget("read", SPELLINGS, false, "gitea"), "gitea.read");
        assert.equal(resolveToolCallTarget("read", SPELLINGS, false, "unregistered_svc"), "plurnk.read");
    });

    test("{§fence-pairing} {§parse-recovery}: formatTranslatedCall, unescapeXmlAttrValue, and parseXmlToolCallBody cover JSON, GLM, parameter tags, and direct fields", () => {
        assert.equal(formatTranslatedCall("plurnk.wait", undefined), "plurnk.wait()");
        assert.equal(formatTranslatedCall("plurnk.wait", "   "), "plurnk.wait()");
        assert.equal(formatTranslatedCall("plurnk.read", '{"path":"a.ts"}'), 'plurnk.read({"path":"a.ts"})');
        assert.equal(formatTranslatedCall("plurnk.note", "plain string"), 'plurnk.note("plain string")');
        assert.equal(formatTranslatedCall("plurnk.read", ["a.ts", { range: "1,5" }]), 'plurnk.read("a.ts", {"range":"1,5"})');

        assert.equal(unescapeXmlAttrValue("hello\\n\\t\\\"world\\\"", '"'), 'hello\n\t"world"');
        // Invalid JSON escape `\q` falls back to basic unescaping
        assert.equal(unescapeXmlAttrValue("bad\\q\\n'quote\\'", "'"), "bad\\q\n'quote'");

        // GLM arg_key/arg_value with JSON coercion
        assert.deepEqual(
            parseXmlToolCallBody("<parameters><arg_key>path</arg_key><arg_value>a.ts</arg_value><arg_key>items</arg_key><arg_value>[\"x\"]</arg_value><arg_key>invalid</arg_key><arg_value>{broken</arg_value></parameters>"),
            { path: "a.ts", items: ["x"], invalid: "{broken" },
        );

        // Anthropic / DSML `<parameter name="...">` and `<param=key>` forms + `true">` artifact cleanup
        assert.deepEqual(
            parseXmlToolCallBody('<antml:parameter name="path">src/a.ts</antml:parameter><param=limit>true">25</param>'),
            { path: "src/a.ts", limit: "25" },
        );

        // Direct XML field tags (only recognized keys match)
        assert.deepEqual(
            parseXmlToolCallBody("<path>src/b.ts</path><range>1,10</range>"),
            { path: "src/b.ts", range: "1,10" },
        );

        // Fenced JSON body and malformed JSON fallback
        assert.deepEqual(
            parseXmlToolCallBody("```json\n{\"path\":\"c.ts\"}\n```"),
            { path: "c.ts" },
        );
        assert.equal(parseXmlToolCallBody("{not valid json"), "{not valid json");
        assert.deepEqual(parseXmlToolCallBody("   "), {});
    });

    test("{§fence-pairing} {§parse-recovery}: tryTranslateChildTagCall translates GLM & child-tag descriptors and refuses <result><name/><output/></result> echoes", () => {
        assert.equal(
            tryTranslateChildTagCall("plurnk.read\n<arg_key>path</arg_key><arg_value>x.ts</arg_value>", SPELLINGS),
            'plurnk.read({"path":"x.ts"})',
        );
        assert.equal(
            tryTranslateChildTagCall("<gitea:name>issue_read</gitea:name><gitea:arguments>{\"index\":9}</gitea:arguments>", SPELLINGS),
            'gitea.issue_read({"index":9})',
        );
        assert.equal(
            tryTranslateChildTagCall("<name>plurnk.wait</name>", SPELLINGS),
            "plurnk.wait()",
        );
        // Result wrapper carrying `<output>` without `<arguments>` is a hallucinated tool output echo, not a call
        assert.equal(
            tryTranslateChildTagCall("<name>plurnk.read</name><output>file contents</output>", SPELLINGS, undefined, true),
            null,
        );
        // Same `<result>` wrapper WITH `<arguments>` IS translated
        assert.equal(
            tryTranslateChildTagCall("<name>plurnk.read</name><arguments>{\"path\":\"x.ts\"}</arguments><output>ignored</output>", SPELLINGS, undefined, true),
            'plurnk.read({"path":"x.ts"})',
        );
    });

    test("{§fence-pairing} {§parse-recovery}: replaceXmlInvocations and translateXmlToolCalls cover DSML inline calls, <function=...>, DeepSeek sep, smart quotes, direct tags, unfenced_code_edit, and angle hybrids", () => {
        // 1. DSML malformed inline call with trailing comment
        const dsmlInline = '<｜DSML｜ invoke name="await plurnk.find({ path: \'src/**\' }) // scan"</｜DSML｜ parameter></｜DSML｜ invoke>';
        assert.equal(translateXmlToolCalls(dsmlInline, SPELLINGS), "plurnk.find({ path: 'src/**' });// scan");

        // 2. `<function=name>` + `<invoke call=“...”>` with smart quotes, xmlns ignored, and string body merged into `content`
        const fnAndInvoke = [
            '<function=plurnk.note><parameter name="text">hello</parameter></function>',
            '<invoke xmlns="http://example.com" call=“plurnk.edit” path=‘src/a.ts’>raw body content</invoke>',
        ].join("\n");
        const fnTranslated = translateXmlToolCalls(fnAndInvoke, SPELLINGS);
        assert.equal(
            fnTranslated,
            'plurnk.note({"text":"hello"})\nplurnk.edit({"path":"src/a.ts","content":"raw body content"})',
        );

        // 3. DeepSeek `<｜tool▁call▁begin｜>function<｜tool▁sep｜>plurnk.read<｜tool▁call▁argument▁begin｜>{...}<｜tool▁call▁end｜>`
        const deepseek = '<｜tool▁call▁begin｜>function<｜tool▁sep｜>plurnk.read<｜tool▁call▁argument▁begin｜>{"path":"ds.ts"}<｜tool▁call▁end｜>';
        assert.equal(translateXmlToolCalls(deepseek, SPELLINGS), 'plurnk.read({"path":"ds.ts"})');

        // 4. Direct XML element calls: paired with raw string body, self-closing with unescaped inner quotes, and bare no-arg `<plurnk.wait>`
        const directXml = [
            '<plurnk.edit path="src/q.ts">line 1</plurnk.edit>',
            '<plurnk.edit path="src/u.ts" text="const s = "unescaped";" />',
            "<plurnk.wait>",
        ].join("\n");
        assert.equal(
            translateXmlToolCalls(directXml, SPELLINGS),
            [
                'plurnk.edit({"path":"src/q.ts","content":"line 1"})',
                'plurnk.edit({"path":"src/u.ts","text":"const s = \\"unescaped\\";"})',
                "plurnk.wait();",
            ].join("\n"),
        );

        // 5. `<unfenced_code_edit_*>` triplet
        const unfencedEdit = [
            "<unfenced_code_edit_path>src/f.ts</unfenced_code_edit_path>",
            "<unfenced_code_edit_range>1,3</unfenced_code_edit_range>",
            "<unfenced_code_edit_pattern>/old/</unfenced_code_edit_pattern>",
            "<unfenced_code_edit_content>\nnewText\n</unfenced_code_edit_content>",
        ].join("\n");
        assert.equal(
            translateXmlToolCalls(unfencedEdit, SPELLINGS),
            'plurnk.edit({"path":"src/f.ts","range":"1,3","pattern":"/old/","content":"newText"})',
        );

        // 6. Angle-bracketed Code Mode hybrid calls + untouched plain prose
        const hybrid = '<antml:await plurnk.read({"path":"h.ts"})/></await>';
        assert.equal(translateXmlToolCalls(hybrid, SPELLINGS), 'plurnk.read({"path":"h.ts"});');

        const plainProse = "Nothing XML-shaped to translate here.";
        assert.deepEqual(replaceXmlInvocations(plainProse, SPELLINGS), { text: plainProse, translated: false });
        assert.equal(translateXmlToolCalls(plainProse, SPELLINGS), null);

        // 7. Plain-text `<result name=...>` in prose stays untouched, whereas structured `<result name=...><parameter ...>` translates.
        const resultProse = 'For example, `<result name=plurnk>ok</result>` or `<result name="read">ok</result>` in documentation.';
        assert.deepEqual(replaceXmlInvocations(resultProse, SPELLINGS), { text: resultProse, translated: false });
        const structuredResult = '<result name="todo"><parameter name="items">["A"]</parameter></result>';
        assert.equal(translateXmlToolCalls(structuredResult, SPELLINGS), 'plurnk.todo({"items":["A"]})');

        // 8. Proxy `<invoke name="tool">` / `multi_tool_use` carrying `recipient_name` + `parameters` or `tool_uses`.
        const dsmlProxySingle = [
            '<｜DSML｜ invoke name="tool">',
            '<｜DSML｜ parameter name="recipient_name">functions.plurnk.read</｜DSML｜ parameter>',
            '<｜DSML｜ parameter name="parameters">{"path":"src/proxy.ts"}</｜DSML｜ parameter>',
            "</｜DSML｜ invoke>",
        ].join("\n");
        assert.equal(translateXmlToolCalls(dsmlProxySingle, SPELLINGS)?.trim(), 'plurnk.read({"path":"src/proxy.ts"})');

        const dsmlProxyBatch = [
            '<｜DSML｜ invoke name="multi_tool_use.parallel">',
            '<｜DSML｜ parameter name="tool_uses">[{"recipient_name":"functions.plurnk.read","parameters":{"path":"a.ts"}},{"recipient_name":"functions.plurnk.note","text":"batch note"}]</｜DSML｜ parameter>',
            "</｜DSML｜ invoke>",
        ].join("\n");
        assert.equal(
            translateXmlToolCalls(dsmlProxyBatch, SPELLINGS)?.trim(),
            'plurnk.read({"path":"a.ts"})\nplurnk.note({"text":"batch note"})',
        );
    });
});
