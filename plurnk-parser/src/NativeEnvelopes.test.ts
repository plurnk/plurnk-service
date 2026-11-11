import test, { describe } from "node:test";
import assert from "node:assert/strict";
import { unwrapCodeModeFences, translateToolCallsOutsideFences } from "./NativeEnvelopes.ts";
import { buildExecutorSpellings } from "./OptionCoercion.ts";

const SPELLINGS = buildExecutorSpellings(["sh", "js", "python3", "plurnk", "gitea"]);

describe("NativeEnvelopes", () => {
    test("{§parser-build} {§fence-pairing}: unwrapCodeModeFences unwraps Code Mode fences while preserving prose, non-Code-Mode, nested, and string/heredoc fences", () => {
        const fencedTs = [
            "Checking the file first:",
            "```ts",
            'await plurnk.read({ path: "src/index.ts" });',
            "```",
            "And an example markdown block:",
            "```python",
            "print('not a tool call')",
            "```",
        ].join("\n");
        const unwrapped = unwrapCodeModeFences(fencedTs, SPELLINGS).source;
        assert.ok(unwrapped.includes('await plurnk.read({ path: "src/index.ts" });'));
        assert.ok(!unwrapped.includes("```ts"));
        assert.ok(unwrapped.includes("```python\nprint('not a tool call')\n```"));

        // Nested fences inside a fence remain untouched so literal markdown blocks aren't corrupted.
        const nested = [
            "```ts",
            'await plurnk.note({ text: "hi" });',
            "~~~",
            "inner",
            "~~~",
            "```",
        ].join("\n");
        assert.equal(unwrapCodeModeFences(nested, SPELLINGS).source, nested);

        // Fences inside heredoc bodies or multiline string arguments remain untouched.
        const insideHeredoc = [
            "await plurnk.edit({ path: \"README.md\", text: <<<EOF",
            "```ts",
            "await plurnk.read({ path: \"ignored.ts\" });",
            "```",
            "EOF });",
        ].join("\n");
        assert.equal(unwrapCodeModeFences(insideHeredoc, SPELLINGS).source, insideHeredoc);

        const insideMultilineString = [
            "await plurnk.edit({ path: \"README.md\", text: `",
            "```ts",
            "await plurnk.read({ path: \"ignored.ts\" });",
            "```",
            "` });",
        ].join("\n");
        assert.equal(unwrapCodeModeFences(insideMultilineString, SPELLINGS).source, insideMultilineString);

        // Trailing dangling empty fence after a tool call is stripped in model mode, preserved without executorSpellings.
        const danglingAfterCall = 'await plurnk.read({ path: "a.ts" });\n```\n   ';
        assert.equal(unwrapCodeModeFences(danglingAfterCall, SPELLINGS).source, 'await plurnk.read({ path: "a.ts" });\n\n   ');
        assert.equal(unwrapCodeModeFences(danglingAfterCall).source, danglingAfterCall);
    });

    test("{§fence-pairing} {§parse-recovery}: unwrapCodeModeFences translates Cohere Action JSON fences and normalizes malformed heredocs", () => {
        const cohere = [
            "Action: ```json",
            '[{"tool_name": "plurnk.read", "parameters": {"path": "a.ts"}}, {"tool_name": "gitea.issue_read", "parameters": {"index": 4}}]',
            "```",
        ].join("\n");
        const cohereOut = unwrapCodeModeFences(cohere, SPELLINGS).source;
        assert.ok(cohereOut.includes('await plurnk.read({"path":"a.ts"})'));
        assert.ok(cohereOut.includes('await gitea.issue_read({"index":4})'));

        // Malformed heredocs: wrapped `{<<<EOF...EOF})`, trailing digits `EOF1`, inline `<<EOF)` empty opener, and `</tool_call>EOF` split closer.
        const wrappedHeredoc = 'await plurnk.note({<<<EOF\nhello\nEOF})';
        assert.equal(unwrapCodeModeFences(wrappedHeredoc, SPELLINGS).source, "await plurnk.note(<<<EOF\nhello\nEOF})");

        const digitCloser = 'await plurnk.edit({ path: "a.ts", text: <<<EOF\nbody\nEOF2 });';
        assert.equal(unwrapCodeModeFences(digitCloser, SPELLINGS).source, 'await plurnk.edit({ path: "a.ts", text: <<<EOF\nbody\nEOF });');

        const emptyOpener = 'await plurnk.edit({ path: "a.ts", text: <<<EOF })';
        assert.equal(unwrapCodeModeFences(emptyOpener, SPELLINGS).source, 'await plurnk.edit({ path: "a.ts", text: "" })');

        const inlineCloserTag = 'await plurnk.note({ text: <<<EOF\nhello</tool_call>EOF });';
        assert.equal(unwrapCodeModeFences(inlineCloserTag, SPELLINGS).source, 'await plurnk.note({ text: <<<EOF\nhello\nEOF });');
    });

    test("{§fence-pairing} {§parse-recovery}: translateToolCallsOutsideFences transduces JSON descriptors (OpenAI function, tool/command, inferred edit/note/todo, JSONL)", () => {
        const cases: Array<[string, string]> = [
            // OpenAI function envelope
            [
                '<tool_call>{"type":"function","function":{"name":"plurnk.read","arguments":{"path":"src/a.ts"}}}</tool_call>',
                'await plurnk.read({"path":"src/a.ts"})',
            ],
            // Command with explicit arguments + restArgs stripping ignored keys
            [
                '<tool_call>{"command":"sh","arguments":{"text":"ls"}}</tool_call>',
                'await plurnk.sh({"text":"ls"})',
            ],
            [
                '<tool_call>{"tool":"plurnk.find","path":"src/**","id":"call_1","timeout":5000}</tool_call>',
                'await plurnk.find({"path":"src/**"})',
            ],
            // Nameless inferred edit, note, and todo objects
            [
                '<tool_call>{"path":"src/x.ts","content":"export const x = 1;","call_id":"1"}</tool_call>',
                'await plurnk.edit({"path":"src/x.ts","content":"export const x = 1;","call_id":"1"})',
            ],
            [
                '<tool_call>{"decision":"Keep schema strict."}</tool_call>',
                'await plurnk.note({"decision":"Keep schema strict."})',
            ],
            [
                '<tool_call>{"todos":["Write matrix tests"]}</tool_call>',
                'await plurnk.todo({"todos":["Write matrix tests"]})',
            ],
            // Multi-line JSONL inside wrapper
            [
                '<tool_calls>\n{"name":"plurnk.note","args":{"text":"one"}}\n{"name":"plurnk.wait","args":{"seconds":5}}\n</tool_calls>',
                'await plurnk.note({"text":"one"})\nawait plurnk.wait({"seconds":5})',
            ],
        ];
        for (const [input, expected] of cases) {
            const actual = translateToolCallsOutsideFences(input, SPELLINGS).trim();
            assert.equal(actual, expected, input);
        }

        // Non-tool JSON inside wrapper remains untouched.
        const nonTool = '<result>{"unrelated": 123}</result>';
        assert.equal(translateToolCallsOutsideFences(nonTool, SPELLINGS), nonTool);
    });

    test("{§fence-pairing} {§parse-recovery}: translateToolCallsOutsideFences transduces Liquid Pythonic calls with kwargs, triple quotes, arrays, dicts, and positional dicts", () => {
        const pythonic = [
            '<|tool_call_start|>[plurnk.find(path="src/**", limit=10), gitea.issue_read({"owner":"plurnk","repo":"svc"}, index=2, active=True, closed=False, milestone=None, labels=["bug", \'\'\'p1\'\'\']), plurnk.wait()]<|tool_call_end|>',
        ].join("\n");
        const out = translateToolCallsOutsideFences(pythonic, SPELLINGS).trim();
        assert.deepEqual(out.split("\n"), [
            'await plurnk.find({"path":"src/**","limit":10})',
            'await gitea.issue_read({"owner":"plurnk","repo":"svc","index":2,"active":true,"closed":false,"milestone":null,"labels":["bug","p1"]})',
            "await plurnk.wait()",
        ]);

        // Single positional literal argument (non-kwarg)
        const singlePositional = '<tool_call>[plurnk.note("""hello\\nworld""")]</tool_call>';
        assert.equal(translateToolCallsOutsideFences(singlePositional, SPELLINGS).trim(), 'await plurnk.note("hello\\nworld")');

        // Unterminated call inside wrapper strips the bracket/tag wrapper so the parser surfaces a clean call-level diagnostic, while non-calls stay untouched.
        const malformed = "<tool_call>[plurnk.read(path=\"unterminated)]</tool_call>";
        assert.equal(translateToolCallsOutsideFences(malformed, SPELLINGS), 'plurnk.read(path="unterminated)');
        const nonCallBracket = "<tool_call>[not_a_call]</tool_call>";
        assert.equal(translateToolCallsOutsideFences(nonCallBracket, SPELLINGS), nonCallBracket);
    });

    test("{§fence-pairing} {§parse-recovery}: translateToolCallsOutsideFences handles Mistral [TOOL_CALLS], unclosed GLM/python_tag prefixes, Seed think tags, system wrappers, and backticked calls", () => {
        // Chained Mistral Tekken v7+ [TOOL_CALLS]name[ARGS]{...}name2[ARGS]{...}
        const mistral = '[TOOL_CALLS]plurnk.read[ARGS]{"path":"a.ts"}gitea.issue_read[ARGS]{"index":7}';
        assert.equal(
            translateToolCallsOutsideFences(mistral, SPELLINGS),
            'await plurnk.read({"path":"a.ts"})\nawait gitea.issue_read({"index":7})',
        );

        // Unclosed GLM-4.5 `<|tool_call|>func\n<arg_key>...</arg_key><arg_value>...</arg_value>`
        const unclosedGlmXml = "<|tool_call|>plurnk.edit\n<arg_key>path</arg_key><arg_value>b.ts</arg_value>\n<arg_key>text</arg_key><arg_value>ok</arg_value>";
        assert.ok(
            translateToolCallsOutsideFences(unclosedGlmXml, SPELLINGS).includes('await plurnk.edit({"path":"b.ts","text":"ok"})'),
        );

        // Unclosed GLM-4 `<|tool_call|>func\n{...}` with blank lines inside JSON string
        const unclosedGlmJson = '<|tool_call|>plurnk.note\n{"text": "para1\\n\\npara2"}';
        assert.equal(
            translateToolCallsOutsideFences(unclosedGlmJson, SPELLINGS).trim(),
            'await plurnk.note({"text":"para1\\n\\npara2"})',
        );

        // Unclosed `<|python_tag|>` with JSON array and with Pythonic call
        const pyTagJson = '<|python_tag|>[{"name":"plurnk.read","arguments":{"path":"c.ts"}}]';
        assert.equal(translateToolCallsOutsideFences(pyTagJson, SPELLINGS).trim(), 'await plurnk.read({"path":"c.ts"})');

        const pyTagCall = '<|python_tag|>[plurnk.read(path="d.ts")]';
        assert.equal(translateToolCallsOutsideFences(pyTagCall, SPELLINGS).trim(), 'await plurnk.read({"path":"d.ts"})');

        // Seed / MiniMax `<seed:think>` stripping, over-escaped JSON keys `{\"path\":...}`, half-quoted `{path":...}`, `<system>` unwrapping, and single-backticked call lines
        const mixed = [
            "<seed:think>internal reasoning</seed:think>",
            "<system>`await plurnk.note({ text: \"sys\" })`</system>",
            "<system>not a call</system>",
            '`await plurnk.read({ path: "e.ts" });` // read e',
            '`await unknown_svc.foo({ a: 1 });`',
            'await plurnk.read({\\"path\\": \\"f.ts\\"})',
            'await plurnk.read({path": "g.ts"})',
            'Prose glued to tag<tool_call>{"name":"plurnk.wait","args":{"seconds":1}}</tool_call>',
        ].join("\n");
        const mixedOut = translateToolCallsOutsideFences(mixed, SPELLINGS);
        assert.ok(!mixedOut.includes("internal reasoning"));
        assert.ok(mixedOut.includes('await plurnk.note({ text: "sys" })'));
        assert.ok(mixedOut.includes("<system>not a call</system>"));
        assert.ok(mixedOut.includes('await plurnk.read({ path: "e.ts" }); // read e'));
        assert.ok(mixedOut.includes('`await unknown_svc.foo({ a: 1 });`'));
        assert.ok(mixedOut.includes('await plurnk.read({"path": "f.ts"})'));
        assert.ok(mixedOut.includes('await plurnk.read({"path": "g.ts"})'));
        assert.ok(mixedOut.includes('Prose glued to tag\nawait plurnk.wait({"seconds":1})'));

        // Fenced markdown blocks protect segment-level XML/prefix envelopes and heredoc bodies protect even matched `<tool_call>` tags
        const protectedBlocks = [
            "```xml",
            '<plurnk.read path="inside-fence.ts" />',
            "```",
            "await plurnk.edit({ path: \"x.xml\", text: <<<EOF",
            '<tool_call>{"name":"plurnk.read","args":{"path":"inside-heredoc.ts"}}</tool_call>',
            "EOF });",
        ].join("\n");
        assert.equal(translateToolCallsOutsideFences(protectedBlocks, SPELLINGS), protectedBlocks);
    });
});
