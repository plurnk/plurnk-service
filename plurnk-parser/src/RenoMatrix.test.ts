import test, { describe } from "node:test";
import assert from "node:assert/strict";
import type { DoneStatement, EditStatement, ExecStatement, NoteStatement, ReadStatement } from "@plurnk/plurnk-contracts";
import PlurnkParser from "./PlurnkParser.ts";

const EXECUTORS = ["sh", "js", "python3", "plurnk", "gitea"] as const;

interface OuterFrame {
    readonly id: string;
    readonly wrap: (inner: string) => string;
    readonly kind: "bare" | "md-code" | "cohere-json" | "envelope";
}

const OUTER_FRAMES: readonly OuterFrame[] = [
    { id: "bare", wrap: (s) => s, kind: "bare" },
    { id: "md-ts-fence", wrap: (s) => `\`\`\`ts\n${s}\n\`\`\``, kind: "md-code" },
    { id: "cohere-action-json", wrap: (s) => `Action: \`\`\`json\n${s}\n\`\`\``, kind: "cohere-json" },
    { id: "xml-tool-call", wrap: (s) => `<tool_call>\n${s}\n</tool_call>`, kind: "envelope" },
    { id: "unclosed-tool-call", wrap: (s) => `<tool_call>\n${s}`, kind: "envelope" },
    { id: "dsml-function-calls", wrap: (s) => `<｜DSML｜ function_calls>\n${s}\n</｜DSML｜ function_calls>`, kind: "envelope" },
    { id: "deepseek-section", wrap: (s) => `<｜tool▁calls▁begin｜>\n${s}\n<｜tool▁calls▁end｜>`, kind: "envelope" },
    { id: "lfm-tool-call-start", wrap: (s) => `<|tool_call_start|>${s}<|tool_call_end|>`, kind: "envelope" },
    { id: "mistral-tool-calls", wrap: (s) => `[TOOL_CALLS]${s}[/TOOL_CALLS]`, kind: "envelope" },
];

interface PayloadSpecimen {
    readonly id: string;
    readonly expectedText: string;
    readonly asCodeModeValue: string;
    readonly asJsonValue: string;
    readonly asXmlBody: string;
    readonly asXmlHeredocAttr: string;
}

const NESTED_SHELL_SCRIPT = [
    "#!/usr/bin/env sh",
    "cat <<'EOF' > /tmp/first.txt",
    'alpha "quoted" /> </plurnk>',
    "<tool_call>inner literal</tool_call>",
    "EOF",
    "cat <<-EOF > /tmp/second.txt",
    "\tbeta ${RAW} `ticks`",
    "\tEOF",
    "echo done",
].join("\n");

const ADVERSARIAL_CODE = [
    'export function render(tag = "<div/>") {',
    '  const raw = "</tool_call></invoke></function></parameter></arg_value></plurnk>";',
    "  const md = \"```ts\\nawait plurnk.kill({ path: 'x' });\\n```\";",
    "  return `${tag}:${raw}:${md}`;",
    "}",
].join("\n");

const PAYLOAD_SPECIMENS: readonly PayloadSpecimen[] = [
    {
        id: "single-line",
        expectedText: "export const VERSION = 6;",
        asCodeModeValue: JSON.stringify("export const VERSION = 6;"),
        asJsonValue: "export const VERSION = 6;",
        asXmlBody: "export const VERSION = 6;",
        asXmlHeredocAttr: "<<<EOF\nexport const VERSION = 6;\nEOF",
    },
    {
        id: "adversarial-heredoc",
        expectedText: ADVERSARIAL_CODE,
        asCodeModeValue: `<<<EOF\n${ADVERSARIAL_CODE}\nEOF`,
        asJsonValue: ADVERSARIAL_CODE,
        asXmlBody: `<<<EOF\n${ADVERSARIAL_CODE}\nEOF`,
        asXmlHeredocAttr: `<<<EOF\n${ADVERSARIAL_CODE}\nEOF`,
    },
    {
        id: "quoted-wrapper-heredoc",
        expectedText: "line 1\nline 2 with \"quotes\" and 'ticks'",
        asCodeModeValue: `"<<<EOF\nline 1\nline 2 with "quotes" and 'ticks'\nEOF"`,
        asJsonValue: "<<<EOF\nline 1\nline 2 with \"quotes\" and 'ticks'\nEOF",
        asXmlBody: "<<<EOF\nline 1\nline 2 with \"quotes\" and 'ticks'\nEOF",
        asXmlHeredocAttr: `"<<<EOF\nline 1\nline 2 with "quotes" and 'ticks'\nEOF"`,
    },
    {
        id: "nested-sequential-shell-heredocs",
        expectedText: NESTED_SHELL_SCRIPT,
        asCodeModeValue: `<<<EOF\n${NESTED_SHELL_SCRIPT}\nEOF`,
        asJsonValue: NESTED_SHELL_SCRIPT,
        asXmlBody: `<<<EOF\n${NESTED_SHELL_SCRIPT}\nEOF`,
        asXmlHeredocAttr: `<<<EOF\n${NESTED_SHELL_SCRIPT}\nEOF`,
    },
    {
        id: "stepped-eof1-with-inner-eof",
        expectedText: "<<<EOF\nliteral heredoc example\nEOF",
        asCodeModeValue: "<<<EOF1\n<<<EOF\nliteral heredoc example\nEOF\nEOF1",
        asJsonValue: "<<<EOF1\n<<<EOF\nliteral heredoc example\nEOF\nEOF1",
        asXmlBody: "<<<EOF1\n<<<EOF\nliteral heredoc example\nEOF\nEOF1",
        asXmlHeredocAttr: "<<<EOF1\n<<<EOF\nliteral heredoc example\nEOF\nEOF1",
    },
    {
        id: "embedded-heredoc-in-markdown",
        expectedText: "# Example\n<<<EOF\nliteral heredoc example\nEOF\nDone.",
        asCodeModeValue: "<<<EOF1\n# Example\n<<<EOF\nliteral heredoc example\nEOF\nDone.\nEOF1",
        asJsonValue: "# Example\n<<<EOF\nliteral heredoc example\nEOF\nDone.",
        asXmlBody: "<<<EOF1\n# Example\n<<<EOF\nliteral heredoc example\nEOF\nDone.\nEOF1",
        asXmlHeredocAttr: "<<<EOF1\n# Example\n<<<EOF\nliteral heredoc example\nEOF\nDone.\nEOF1",
    },
];

describe("RENO Cartesian Matrix & Demo Emissions Witness", () => {
    test("{§fence-pairing} {§parser-build} {§parse-recovery}: Cartesian matrix of Outer Frames × Call Framings × Payload Shapes lowers losslessly without sentinels", () => {
        let verifiedCells = 0;

        for (const payload of PAYLOAD_SPECIMENS) {
            const callFramings: ReadonlyArray<{ readonly id: string; readonly isCodeMode: boolean; readonly emit: () => string }> = [
                {
                    id: "code-mode",
                    isCodeMode: true,
                    emit: () => `await plurnk.edit({ path: "src/target.ts", text: ${payload.asCodeModeValue} });`,
                },
                {
                    id: "openai-json",
                    isCodeMode: false,
                    emit: () => JSON.stringify({
                        type: "function",
                        function: {
                            name: "plurnk.edit",
                            arguments: { path: "src/target.ts", text: payload.asJsonValue },
                        },
                    }),
                },
                {
                    id: "flat-json",
                    isCodeMode: false,
                    emit: () => JSON.stringify({
                        name: "plurnk.edit",
                        path: "src/target.ts",
                        text: payload.asJsonValue,
                    }),
                },
                {
                    id: "xml-invoke-parameter",
                    isCodeMode: false,
                    emit: () => [
                        '<invoke name="plurnk.edit">',
                        '<parameter name="path">src/target.ts</parameter>',
                        `<parameter name="text">${payload.asXmlBody}</parameter>`,
                        "</invoke>",
                    ].join("\n"),
                },
                {
                    id: "xml-function-equals",
                    isCodeMode: false,
                    emit: () => [
                        "<function=plurnk.edit>",
                        "<parameter=path>src/target.ts</parameter>",
                        `<parameter=text>\n${payload.asXmlBody}\n</parameter>`,
                        "</function>",
                    ].join("\n"),
                },
                {
                    id: "direct-xml-paired",
                    isCodeMode: false,
                    emit: () => `<plurnk.edit path="src/target.ts">\n${payload.asXmlBody}\n</plurnk.edit>`,
                },
                {
                    id: "direct-xml-heredoc-attr-self-closing",
                    isCodeMode: false,
                    emit: () => `<plurnk.edit path="src/target.ts" text=${payload.asXmlHeredocAttr} />`,
                },
                {
                    id: "direct-xml-heredoc-attr-unclosed",
                    isCodeMode: false,
                    emit: () => `<plurnk.edit path="src/target.ts" text=${payload.asXmlHeredocAttr}>`,
                },
                {
                    id: "glm-arg-key-value",
                    isCodeMode: false,
                    emit: () => [
                        "plurnk.edit",
                        "<arg_key>path</arg_key>",
                        "<arg_value>src/target.ts</arg_value>",
                        "<arg_key>text</arg_key>",
                        `<arg_value>${payload.asXmlBody}</arg_value>`,
                    ].join("\n"),
                },
                {
                    id: "pythonic-bracketed",
                    isCodeMode: false,
                    emit: () => `[plurnk.edit(path="src/target.ts", text=${JSON.stringify(payload.asJsonValue)})]`,
                },
            ];

            for (const outer of OUTER_FRAMES) {
                for (const framing of callFramings) {
                    const isJsonFraming = framing.id === "openai-json" || framing.id === "flat-json";
                    if (outer.kind === "md-code") {
                        // Markdown Code Mode fences must NOT unwrap when inner payload contains a nested ``` fence.
                        if (!framing.isCodeMode || payload.asCodeModeValue.includes("```")) continue;
                    } else if (outer.kind === "cohere-json") {
                        // Cohere `Action: ```json` fences decode JSON descriptors without nested ``` fences.
                        if (!isJsonFraming || JSON.stringify(payload.asJsonValue).includes("```")) continue;
                    } else if (outer.kind === "bare") {
                        // Bare prose intentionally never executes raw unwrapped JSON, bare `[func(...)]`, or tagless GLM lines.
                        if (isJsonFraming || framing.id === "glm-arg-key-value" || framing.id === "pythonic-bracketed") continue;
                    }

                    const source = outer.wrap(framing.emit());
                    const label = `[outer=${outer.id} × framing=${framing.id} × payload=${payload.id}]`;
                    const parsed = PlurnkParser.parse(source, { executors: EXECUTORS });

                    assert.equal(parsed.unparsedTail, undefined, `${label}: unexpected unparsedTail ${JSON.stringify(parsed.unparsedTail)}`);
                    const errors = parsed.items.filter((i) => i.kind === "error");
                    assert.deepEqual(errors, [], `${label}: unexpected errors`);

                    const stmts = parsed.items.flatMap((i) => i.kind === "statement" ? [i.statement] : []);
                    assert.equal(stmts.length, 1, `${label}: expected 1 statement, got ${stmts.length}`);
                    const edit = stmts[0] as EditStatement;
                    assert.equal(edit.op, "edit", label);
                    assert.equal(edit.target?.raw, "src/target.ts", label);
                    assert.equal(edit.body, payload.expectedText, label);

                    // Idempotent reflective serialization round-trip (`PlurnkParser.stringify` -> `PlurnkParser.parseStatements`).
                    const reflected = PlurnkParser.stringify([edit]);
                    const reparsed = PlurnkParser.parseStatements(reflected, { executors: EXECUTORS });
                    assert.equal(reparsed.unparsedTail, undefined, `${label}: round-trip unparsedTail`);
                    const reStmts = reparsed.items.flatMap((i) => i.kind === "statement" ? [i.statement] : []);
                    assert.equal(reStmts.length, 1, `${label}: round-trip count`);
                    assert.equal((reStmts[0] as EditStatement).body, payload.expectedText, `${label}: round-trip body`);

                    verifiedCells += 1;
                }
            }
        }

        // Verify standalone Harmony & Mistral [ARGS] native framings across all payloads as well.
        for (const payload of PAYLOAD_SPECIMENS) {
            const harmony = `<|start|>assistant<|channel|>commentary to=plurnk.edit <|constrain|>json<|message|>${JSON.stringify({ path: "src/target.ts", text: payload.asJsonValue })}<|call|>`;
            const hParsed = PlurnkParser.parse(harmony, { executors: EXECUTORS });
            assert.deepEqual(hParsed.items.filter((i) => i.kind === "error"), []);
            const hStmt = hParsed.items.find((i) => i.kind === "statement")?.statement as EditStatement;
            assert.equal(hStmt.body, payload.expectedText, `harmony × ${payload.id}`);

            const mistral = `[TOOL_CALLS]plurnk.edit[ARGS]${JSON.stringify({ path: "src/target.ts", text: payload.asJsonValue })}`;
            const mParsed = PlurnkParser.parse(mistral, { executors: EXECUTORS });
            assert.deepEqual(mParsed.items.filter((i) => i.kind === "error"), []);
            const mStmt = mParsed.items.find((i) => i.kind === "statement")?.statement as EditStatement;
            assert.equal(mStmt.body, payload.expectedText, `mistral-args × ${payload.id}`);

            verifiedCells += 2;
        }

        // Protocol entry points (`parseStatements`, `lowerToolCall`) preserve plain string literals verbatim without model string-heredoc recovery.
        const rawHeredocLiteral = "<<<EOF\nliteral heredoc example\nEOF";
        const mcpLowered = PlurnkParser.lowerToolCall("plurnk", "edit", { path: "src/target.ts", text: rawHeredocLiteral });
        const mcpEdit = mcpLowered.items.find((i) => i.kind === "statement")?.statement as EditStatement;
        assert.equal(mcpEdit.body, rawHeredocLiteral, "lowerToolCall preserves raw <<<EOF string literal");

        const strictStmt = PlurnkParser.parseStatements(`plurnk.edit({"path":"src/target.ts","text":${JSON.stringify(rawHeredocLiteral)}})`);
        const strictEdit = strictStmt.items.find((i) => i.kind === "statement")?.statement as EditStatement;
        assert.equal(strictEdit.body, rawHeredocLiteral, "parseStatements preserves raw <<<EOF JSON string literal");

        assert.ok(verifiedCells >= 400, `Expected >= 400 verified matrix cells, ran ${verifiedCells}`);
    });

    test("{§fence-pairing} {§matcher-prefix-claims} {§parse-recovery}: direct RENO lowering preserves HEREDOC_OBJECT_KEYS literal pattern semantics without string re-serialization", () => {
        // A multiline `pattern` supplied via XML `<<<EOF` attribute or `<parameter>` heredoc must lower as a literal `glob` matcher (not regex).
        const xmlAttrHeredocPattern = [
            '<plurnk.edit path="src/calc.py" pattern=<<<EOF',
            "def compute(items):",
            "    return items[0] + (1 * 2)",
            "EOF text=<<<EOF",
            "def compute(items):",
            "    return items[0] + 2",
            "EOF />",
        ].join("\n");
        const parsed1 = PlurnkParser.parse(xmlAttrHeredocPattern, { executors: EXECUTORS });
        assert.deepEqual(parsed1.items.filter((i) => i.kind === "error"), []);
        const edit1 = parsed1.items.find((i) => i.kind === "statement")?.statement as EditStatement;
        assert.equal(edit1.matcher?.dialect, "glob");
        assert.equal(edit1.matcher?.raw, "def compute(items):\n    return items[0] + (1 * 2)");

        const xmlParamHeredocPattern = [
            '<tool_call>',
            '<invoke name="plurnk.edit">',
            '<parameter name="path">src/calc.py</parameter>',
            '<parameter name="pattern"><<<EOF',
            "def compute(items):",
            "    return items[0] + (1 * 2)",
            "EOF</parameter>",
            '<parameter name="text"><<<EOF',
            "def compute(items):",
            "    return items[0] + 2",
            "EOF</parameter>",
            "</invoke>",
            "</tool_call>",
        ].join("\n");
        const parsed2 = PlurnkParser.parse(xmlParamHeredocPattern, { executors: EXECUTORS });
        assert.deepEqual(parsed2.items.filter((i) => i.kind === "error"), []);
        const edit2 = parsed2.items.find((i) => i.kind === "statement")?.statement as EditStatement;
        assert.equal(edit2.matcher?.dialect, "glob");
        assert.equal(edit2.matcher?.raw, "def compute(items):\n    return items[0] + (1 * 2)");
    });

    test("{§fence-pairing} {§parse-recovery}: recovers all 5 exact extensibility-demo RENO & nested-heredoc emissions cleanly (#1439)", () => {
        // 1. extend-chat T16: `plurnk.sh` with `<<<EOF` containing nested `cat <<'EOF' > test-acp.mjs ... EOF` before outer `EOF`.
        const extendChatT16 = [
            'plurnk.sh({ "text": <<<EOF',
            "cat <<'EOF' > /tmp/test-acp.mjs",
            'import WebSocket from "ws";',
            'const ws = new WebSocket("ws://127.0.0.1:4100/acp");',
            'ws.on("open", () => console.log("connected"));',
            "EOF",
            "node /tmp/test-acp.mjs",
            "EOF })",
        ].join("\n");
        const p1 = PlurnkParser.parse(extendChatT16, { executors: EXECUTORS });
        assert.equal(p1.unparsedTail, undefined);
        assert.deepEqual(p1.items.filter((i) => i.kind === "error"), []);
        const s1 = p1.items.find((i) => i.kind === "statement")?.statement as ExecStatement;
        assert.equal(s1.runtime, "sh");
        assert.ok(s1.body?.includes("node /tmp/test-acp.mjs"));

        // 2. extend-chat T27: self-closing `<plurnk.edit path="..." text="...unescaped quotes and /> in JSX/JS..." />` with trailing `</plurnk.edit>`.
        const extendChatT27 = [
            '<plurnk.edit path="bridge/index.mjs" text="import { WebSocket } from "ws";',
            "const selfClosing = '<br/>';",
            'export function start() { return "ok"; }',
            '" /></plurnk.edit>',
        ].join("\n");
        const p2 = PlurnkParser.parse(extendChatT27, { executors: EXECUTORS });
        assert.equal(p2.unparsedTail, undefined);
        assert.deepEqual(p2.items.filter((i) => i.kind === "error"), []);
        const s2 = p2.items.find((i) => i.kind === "statement")?.statement as EditStatement;
        assert.equal(s2.target?.raw, "bridge/index.mjs");
        assert.ok(s2.body?.includes("const selfClosing = '<br/>';"));
        assert.ok(s2.body?.includes('export function start() { return "ok"; }'));

        // 3. extend-chat T46: unclosed `<plurnk.edit path="..." text="<<<EOF\n...\nEOF">` with stray `</plurnk>` before `EOF`.
        const extendChatT46 = [
            '<plurnk.edit path="bridge/client.mjs" text="<<<EOF',
            'export const send = (msg) => ({ type: "prompt", msg });</plurnk>',
            'EOF">',
        ].join("\n");
        const p3 = PlurnkParser.parse(extendChatT46, { executors: EXECUTORS });
        assert.equal(p3.unparsedTail, undefined);
        assert.deepEqual(p3.items.filter((i) => i.kind === "error"), []);
        const s3 = p3.items.find((i) => i.kind === "statement")?.statement as EditStatement;
        assert.equal(s3.target?.raw, "bridge/client.mjs");
        assert.equal(s3.body, 'export const send = (msg) => ({ type: "prompt", msg });');

        // 4. extend-watch T10: `plurnk.sh` with `<<<EOF` containing TWO sequential `cat << 'EOF' > file ... EOF` blocks before outer `EOF`.
        const extendWatchT10 = [
            'plurnk.sh({ "text": <<<EOF',
            "cat << 'EOF' > /tmp/payload-1.json",
            '{"action":"opened","number":1}',
            "EOF",
            "cat << 'EOF' > /tmp/payload-2.json",
            '{"action":"Synchronize","number":1}',
            "EOF",
            "ls -la /tmp/payload-1.json /tmp/payload-2.json",
            "EOF })",
        ].join("\n");
        const p4 = PlurnkParser.parse(extendWatchT10, { executors: EXECUTORS });
        assert.equal(p4.unparsedTail, undefined);
        assert.deepEqual(p4.items.filter((i) => i.kind === "error"), []);
        const s4 = p4.items.find((i) => i.kind === "statement")?.statement as ExecStatement;
        assert.equal(s4.runtime, "sh");
        assert.ok(s4.body?.includes("ls -la /tmp/payload-1.json /tmp/payload-2.json"));

        // 5. extend-tracker T5: Code Mode `plurnk.edit({ path: "...", text: "<<<EOF\n...\nEOF" })` with quoted heredoc wrapper containing unescaped quotes.
        const extendTrackerT5 = [
            'await plurnk.edit({ path: "mcp-tracker/server.mjs", text: "<<<EOF',
            'import http from "node:http";',
            'const label = "tracker-v1";',
            "export default label;",
            'EOF" });',
        ].join("\n");
        const p5 = PlurnkParser.parse(extendTrackerT5, { executors: EXECUTORS });
        assert.equal(p5.unparsedTail, undefined);
        assert.deepEqual(p5.items.filter((i) => i.kind === "error"), []);
        const s5 = p5.items.find((i) => i.kind === "statement")?.statement as EditStatement;
        assert.equal(s5.target?.raw, "mcp-tracker/server.mjs");
        assert.equal(s5.body, 'import http from "node:http";\nconst label = "tracker-v1";\nexport default label;');
    });

    test("{§fence-pairing} {§parse-recovery}: sibling-call boundary isolation, hybrid XML/DSML envelopes, leading-backtick calls, and heredoc closer drift", () => {
        // 1. Unclosed object literal before a sibling `plurnk.*` / executor / `await` call never swallows the sibling call.
        for (const sibling of [
            'plurnk.sh({"text":"pytest -q"}) // run suite',
            'gitea.list_issues({"repo":"demo"}) // check board',
            'await custom.ping({"ok":true}) // probe',
        ]) {
            const fused = `plurnk.note({"text":"import from django.forms.fields."\n\n${sibling}`;
            const res = PlurnkParser.parse(fused, { executors: EXECUTORS });
            assert.equal(res.unparsedTail, undefined);
            const errs = res.items.filter((i) => i.kind === "error");
            const stmts = res.items.filter((i) => i.kind === "statement");
            assert.equal(errs.length, 1, `expected syntax error on unclosed note before ${sibling}`);
            assert.equal(stmts.length, 1, `expected sibling call to survive: ${sibling}`);
        }

        // Negative guard: unescaped quotes followed by Python `self.check()` inside `plurnk.edit` stay inside the string.
        const unescapedPy = 'plurnk.edit({"path":"a.py","text":"msg = "hello"\nself.check()\n"})';
        const pyRes = PlurnkParser.parse(unescapedPy, { executors: EXECUTORS });
        assert.deepEqual(pyRes.items.filter((i) => i.kind === "error"), []);
        const pyEdit = pyRes.items.find((i) => i.kind === "statement")?.statement as EditStatement;
        assert.equal(pyEdit.body, 'msg = "hello"\nself.check()\n');

        // 2. Direct XML tool body with `<script>` inside JSON/CodeMode heredoc is not hijacked by `DIRECT_XML_PARAM_KEYS`.
        const xmlJsonHeredoc = [
            "<plurnk.edit>",
            '{"path":"tpl.html","text":<<<EOF',
            '<script src="app.js"></script>',
            "EOF}",
            "</plurnk.edit>",
        ].join("\n");
        const r2 = PlurnkParser.parse(xmlJsonHeredoc, { executors: EXECUTORS });
        assert.deepEqual(r2.items.filter((i) => i.kind === "error"), []);
        const s2 = r2.items.find((i) => i.kind === "statement")?.statement as EditStatement;
        assert.equal(s2.target?.raw, "tpl.html");
        assert.equal(s2.body, '<script src="app.js"></script>');

        // 3. Bare `<plurnk class="sh">{...}</plurnk>` and `<plurnk op="read" path="a.ts"/>`.
        const barePlurnkXml = [
            '<plurnk class="sh">{"text":"echo ok"}</plurnk>',
            '<plurnk op="read" path="src/a.ts"/>',
        ].join("\n\n");
        const r3 = PlurnkParser.parse(barePlurnkXml, { executors: EXECUTORS });
        assert.deepEqual(r3.items.filter((i) => i.kind === "error"), []);
        const stmts3 = r3.items.filter((i) => i.kind === "statement").map((i) => i.statement);
        assert.equal(stmts3.length, 2);
        assert.equal((stmts3[0] as ExecStatement).runtime, "sh");
        assert.equal((stmts3[1] as ReadStatement).op, "read");

        // 4. Unclosed `<tool>` prefix tags before Code Mode calls.
        const unclosedToolPrefix = [
            '<tool>plurnk.edit({"path":"a.py","text":"x = 1\\n"})',
            "",
            '<tool>plurnk.read({"path":"a.py"})',
        ].join("\n");
        const r4 = PlurnkParser.parse(unclosedToolPrefix, { executors: EXECUTORS });
        assert.deepEqual(r4.items.filter((i) => i.kind === "error"), []);
        assert.equal(r4.items.filter((i) => i.kind === "statement").length, 2);

        // 5. Direct `<plurnk.note>{...}` closed by orphaned DSML closing tags.
        const orphanDsml = [
            '<plurnk.note>{"text":"RangeSlider holds mouse grab.","tokens":0}</｜｜DSML｜｜ parameter>',
            "</｜｜DSML｜｜ invoke>",
            "</｜｜DSML｜｜ calls>",
        ].join("\n");
        const r5 = PlurnkParser.parse(orphanDsml, { executors: EXECUTORS });
        assert.deepEqual(r5.items.filter((i) => i.kind === "error"), []);
        const s5Note = r5.items.find((i) => i.kind === "statement")?.statement as NoteStatement;
        assert.equal(s5Note.op, "note");
        assert.equal(s5Note.body, "RangeSlider holds mouse grab.");

        // 6. Hybrid XML-attribute heredoc closed by Code Mode `"}) // aside`.
        const hybridXmlAttr = [
            '<plurnk.edit path="sympy/pretty.py" range="10,12" text="<<<EOF',
            "coeff = S(coeff)",
            "EOF",
            '"}) // Fix coeff coercion',
        ].join("\n");
        const r6 = PlurnkParser.parse(hybridXmlAttr, { executors: EXECUTORS });
        assert.deepEqual(r6.items.filter((i) => i.kind === "error"), []);
        const s6 = r6.items.find((i) => i.kind === "statement")?.statement as EditStatement;
        assert.equal(s6.target?.raw, "sympy/pretty.py");
        assert.equal(s6.body, "coeff = S(coeff)");
        assert.equal(s6.aside, "Fix coeff coercion");

        // 7. Single leading/wrapping backtick on standalone `plurnk.*` call vs inline prose code span.
        const leadingTick = '`plurnk.done({"text":"Fixed `ccode(sinc(x))`."}) // finish';
        const wrappedTick = '`plurnk.done({"text":"All green."});` // done';
        for (const [src, expectedBody, expectedAside] of [
            [leadingTick, "Fixed `ccode(sinc(x))`.", "finish"],
            [wrappedTick, "All green.", "done"],
        ] as const) {
            const rt = PlurnkParser.parse(src, { executors: EXECUTORS });
            assert.deepEqual(rt.items.filter((i) => i.kind === "error"), []);
            const doneStmt = rt.items.find((i) => i.kind === "statement")?.statement as DoneStatement;
            assert.equal(doneStmt.op, "done");
            assert.equal(doneStmt.body?.raw, expectedBody);
            assert.equal(doneStmt.aside, expectedAside);
        }

        const proseWithInlineTick = [
            '`plurnk.done({"text":"x"})` finishes the loop when work settles.',
            "",
            'plurnk.read({"path":"README.md"})',
        ].join("\n");
        const rp = PlurnkParser.parse(proseWithInlineTick, { executors: EXECUTORS });
        assert.equal(rp.items.filter((i) => i.kind === "statement").length, 1);
        assert.equal(rp.items.filter((i) => i.kind === "text").length, 1);

        // 8. Over-angled `<<<EOF>>`, doubled `EOF\nEOF})`, `EOF]})`, and `EOF\n"})` heredoc closers.
        for (const variant of [
            'plurnk.sh({"text":<<<EOF>>\npytest\nEOF})',
            'plurnk.sh({"text":<<<EOF\npytest\nEOF\nEOF})',
            'plurnk.sh({"text":<<<EOF\npytest\nEOF]})',
            'plurnk.sh({"text":<<<EOF\npytest\nEOF\n"})',
        ]) {
            const rv = PlurnkParser.parse(variant, { executors: EXECUTORS });
            assert.deepEqual(rv.items.filter((i) => i.kind === "error"), [], `failed on ${variant}`);
            const sv = rv.items.find((i) => i.kind === "statement")?.statement as ExecStatement;
            assert.equal(sv.runtime, "sh");
            assert.equal(sv.body, "pytest");
        }

        // 9. Omitted `}` before `)` on `{`-opened call across string, multiline string + aside, heredoc, and envelopes.
        const missingBraceCalls = [
            ['plurnk.edit({"path":"testing/test_assertrewrite.py","range":"526,1,527,1","text":"")', null, null],
            ['plurnk.edit({"path":".agents/plugins/linear/server.mjs","text":"#<<<EOF\\nnode server.mjs\\nEOF\\n") // zero-dep Linear MCP server', "#<<<EOF\nnode server.mjs\nEOF\n", "zero-dep Linear MCP server"],
            ['plurnk.edit({"path":"src/a.py","text":<<<EOF\nreturn 1\nEOF)', "return 1", null],
        ] as const;
        for (const frame of OUTER_FRAMES.filter((f) => f.kind !== "cohere-json")) {
            for (const [callSrc, expectedBody, expectedAside] of missingBraceCalls) {
                const rm = PlurnkParser.parse(frame.wrap(callSrc), { executors: EXECUTORS });
                assert.equal(rm.unparsedTail, undefined, `unexpected unparsedTail on ${frame.id}: ${callSrc}`);
                assert.deepEqual(rm.items.filter((i) => i.kind === "error"), [], `failed on ${frame.id}: ${callSrc}`);
                const edit = rm.items.find((i) => i.kind === "statement")?.statement as EditStatement;
                assert.equal(edit.op, "edit");
                assert.equal(edit.body, expectedBody);
                assert.equal(edit.aside, expectedAside);
            }
        }
        const strictMissingBrace = PlurnkParser.parseStatements('plurnk.edit({"path":"a.py","text":"")', { executors: EXECUTORS });
        assert.ok(strictMissingBrace.items.some((i) => i.kind === "error") || strictMissingBrace.unparsedTail !== undefined);

        // 10. Stray `}` before `/>` in self-closing XML call (quoted and bare attrs) without truncating inner quotes.
        for (const xmlStrayBrace of [
            '<plurnk.read path="sympy/utilities/iterables.py" range="1800,1850"} />',
            '<plurnk.read path="sympy/utilities/iterables.py" range=1800,1850} />',
        ]) {
            const rx = PlurnkParser.parse(xmlStrayBrace, { executors: EXECUTORS });
            assert.deepEqual(rx.items.filter((i) => i.kind === "error"), [], `failed on ${xmlStrayBrace}`);
            const rd = rx.items.find((i) => i.kind === "statement")?.statement as ReadStatement;
            assert.equal(rd.op, "read");
            assert.equal(rd.target?.raw, "sympy/utilities/iterables.py");
            assert.deepEqual(rd.lineMarker?.marks, [1800, 1850]);
        }
        const innerBraceSlash = '<plurnk.sh text="echo "} /> ok""/>';
        const ri = PlurnkParser.parse(innerBraceSlash, { executors: EXECUTORS });
        assert.deepEqual(ri.items.filter((i) => i.kind === "error"), []);
        const riStmt = ri.items.find((i) => i.kind === "statement")?.statement as ExecStatement;
        assert.equal(riStmt.body, 'echo "} /> ok"');

        // 11. Hybrid XML-attribute heredoc closed by bare `}` without `)` (with and without aside).
        for (const [hybridBareBrace, expectedAside] of [
            ["<plurnk.edit path=\"sympy/utilities/codegen.py\" range=\"10,12\" text=<<<EOF\nreturn expr\nEOF}", null],
            ["<plurnk.edit path=\"sympy/utilities/codegen.py\" range=\"10,12\" text=<<<EOF\nreturn expr\nEOF}; // codegen fix", "codegen fix"],
        ] as const) {
            const rh = PlurnkParser.parse(hybridBareBrace, { executors: EXECUTORS });
            assert.deepEqual(rh.items.filter((i) => i.kind === "error"), [], `failed on ${hybridBareBrace}`);
            const eh = rh.items.find((i) => i.kind === "statement")?.statement as EditStatement;
            assert.equal(eh.op, "edit");
            assert.equal(eh.target?.raw, "sympy/utilities/codegen.py");
            assert.equal(eh.body, "return expr");
            assert.equal(eh.aside, expectedAside);
        }

        // 12. Split-quote heredoc delimiters (`<<"EOF ... EOF"`, `<<<"EOF ... EOF"`, `<<'EOF ... EOF'`).
        for (const splitSrc of [
            'plurnk.note({"text":<<"EOF\nCheck Base power identity.\nEOF"})',
            'plurnk.note({"text":<<<"EOF\nCheck Base power identity.\nEOF"})',
            "plurnk.note({'text':<<'EOF\nCheck Base power identity.\nEOF'})",
        ]) {
            for (const frame of OUTER_FRAMES.filter((f) => f.kind !== "cohere-json")) {
                const rs = PlurnkParser.parse(frame.wrap(splitSrc), { executors: EXECUTORS });
                assert.deepEqual(rs.items.filter((i) => i.kind === "error"), [], `failed on ${frame.id}: ${splitSrc}`);
                const ns = rs.items.find((i) => i.kind === "statement")?.statement as NoteStatement;
                assert.equal(ns.op, "note");
                assert.equal(ns.body, "Check Base power identity.");
            }
        }

        // 13. Ambiguous keys and unquoted arbitrary shell remain explicit parse refusals.
        for (const refused of [
            '<plurnk.sh t="pytest"/>',
            'plurnk.sh({"text":cd /testbed && pytest})',
            'plurnk.read({"path":"a.py","range":"@"})',
        ]) {
            const rr = PlurnkParser.parse(refused, { executors: EXECUTORS });
            assert.ok(rr.items.some((i) => i.kind === "error"), `expected refusal on ${refused}`);
        }
    });

    test("{§fence-pairing} {§parser-build} {§parse-recovery}: Cartesian matrix of hyphenated 2-segment <server>.<tool> and 3-segment plurnk.<server>.<tool> MCP calls lowers identically across frames and framings (#1439)", () => {
        const mcpExecutors = [...EXECUTORS, "verification-service"] as const;
        const callPrefixes = [
            "verification-service.verification_code",
            "plurnk.verification-service.verification_code",
        ] as const;

        let verifiedCells = 0;
        for (const prefix of callPrefixes) {
            const framings: ReadonlyArray<{ readonly id: string; readonly isCodeMode: boolean; readonly isJson: boolean; readonly emit: () => string }> = [
                {
                    id: "code-mode",
                    isCodeMode: true,
                    isJson: false,
                    emit: () => `${prefix}({ "label": "oauth-demo" }) // verify token`,
                },
                {
                    id: "await-code-mode",
                    isCodeMode: true,
                    isJson: false,
                    emit: () => `await ${prefix}({ "label": "oauth-demo" });`,
                },
                {
                    id: "openai-json",
                    isCodeMode: false,
                    isJson: true,
                    emit: () => JSON.stringify({
                        type: "function",
                        function: {
                            name: prefix,
                            arguments: { label: "oauth-demo" },
                        },
                    }),
                },
                {
                    id: "flat-json",
                    isCodeMode: false,
                    isJson: true,
                    emit: () => JSON.stringify({
                        name: prefix,
                        label: "oauth-demo",
                    }),
                },
                {
                    id: "xml-invoke-parameter",
                    isCodeMode: false,
                    isJson: false,
                    emit: () => [
                        `<invoke name="${prefix}">`,
                        '<parameter name="label">oauth-demo</parameter>',
                        "</invoke>",
                    ].join("\n"),
                },
                {
                    id: "xml-function-equals",
                    isCodeMode: false,
                    isJson: false,
                    emit: () => [
                        `<function=${prefix}>`,
                        "<parameter=label>oauth-demo</parameter>",
                        "</function>",
                    ].join("\n"),
                },
                {
                    id: "direct-xml-self-closing",
                    isCodeMode: false,
                    isJson: false,
                    emit: () => `<${prefix} label="oauth-demo" />`,
                },
                {
                    id: "direct-xml-paired",
                    isCodeMode: false,
                    isJson: false,
                    emit: () => `<${prefix}>{"label":"oauth-demo"}</${prefix}>`,
                },
                {
                    id: "angle-hybrid",
                    isCodeMode: false,
                    isJson: false,
                    emit: () => `<${prefix}({"label":"oauth-demo"})/>`,
                },
                {
                    id: "glm-arg-key-value",
                    isCodeMode: false,
                    isJson: false,
                    emit: () => [
                        prefix,
                        "<arg_key>label</arg_key>",
                        "<arg_value>oauth-demo</arg_value>",
                    ].join("\n"),
                },
                {
                    id: "pythonic-bracketed",
                    isCodeMode: false,
                    isJson: false,
                    emit: () => `[${prefix}(label="oauth-demo")]`,
                },
            ];

            for (const outer of OUTER_FRAMES) {
                for (const framing of framings) {
                    if (outer.kind === "md-code" && !framing.isCodeMode) continue;
                    if (outer.kind === "cohere-json" && !framing.isJson) continue;
                    if (outer.kind === "bare" && (framing.isJson || framing.id === "glm-arg-key-value" || framing.id === "pythonic-bracketed")) continue;

                    const source = outer.wrap(framing.emit());
                    const label = `[prefix=${prefix} × outer=${outer.id} × framing=${framing.id}]`;
                    const parsed = PlurnkParser.parse(source, { executors: mcpExecutors });
                    assert.equal(parsed.unparsedTail, undefined, `${label}: unexpected unparsedTail ${JSON.stringify(parsed.unparsedTail)}`);
                    assert.deepEqual(parsed.items.filter((i) => i.kind === "error"), [], `${label}: unexpected errors`);
                    const stmts = parsed.items.flatMap((i) => i.kind === "statement" ? [i.statement] : []);
                    assert.equal(stmts.length, 1, `${label}: expected 1 statement, got ${stmts.length}`);
                    const execStmt = stmts[0] as ExecStatement;
                    assert.equal(execStmt.runtime, "verification-service", label);
                    assert.equal(execStmt.target?.raw, "verification_code", label);
                    assert.deepEqual(JSON.parse(execStmt.body ?? "null"), { label: "oauth-demo" }, label);
                    verifiedCells += 1;
                }
            }

            // Standalone backticked, leading-backtick, Harmony, Mistral [ARGS], and sibling-call isolation.
            for (const standalone of [
                `\`${prefix}({"label":"oauth-demo"});\` // tick`,
                `\`${prefix}({"label":"oauth-demo"}) // leading-tick`,
                `<|start|>assistant<|channel|>commentary to=${prefix} <|constrain|>json<|message|>{"label":"oauth-demo"}<|call|>`,
                `[TOOL_CALLS]${prefix}[ARGS]{"label":"oauth-demo"}`,
            ]) {
                const parsed = PlurnkParser.parse(standalone, { executors: mcpExecutors });
                assert.equal(parsed.unparsedTail, undefined, `standalone failed: ${standalone}`);
                assert.deepEqual(parsed.items.filter((i) => i.kind === "error"), [], `standalone errors: ${standalone}`);
                const execStmt = parsed.items.find((i) => i.kind === "statement")?.statement as ExecStatement;
                assert.equal(execStmt.runtime, "verification-service", standalone);
                assert.equal(execStmt.target?.raw, "verification_code", standalone);
                assert.deepEqual(JSON.parse(execStmt.body ?? "null"), { label: "oauth-demo" }, standalone);
                verifiedCells += 1;
            }

            const siblingFused = `plurnk.note({"text":"broken"\n\n${prefix}({"label":"oauth-demo"})`;
            const siblingRes = PlurnkParser.parse(siblingFused, { executors: mcpExecutors });
            assert.equal(siblingRes.items.filter((i) => i.kind === "error").length, 1);
            const survived = siblingRes.items.find((i) => i.kind === "statement")?.statement as ExecStatement;
            assert.equal(survived.runtime, "verification-service");
            assert.equal(survived.target?.raw, "verification_code");
            verifiedCells += 1;
        }
        assert.ok(verifiedCells >= 140, `Expected >= 140 verified MCP cells, ran ${verifiedCells}`);
    });
});
