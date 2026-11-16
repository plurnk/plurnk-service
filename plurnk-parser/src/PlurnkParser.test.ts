import test, { describe } from "node:test";
import assert from "node:assert/strict";
import type { ExecStatement, FindStatement, PlurnkStatement } from "@plurnk/plurnk-contracts";
import PlurnkParser from "./PlurnkParser.ts";

const singleStatement = (result: ReturnType<typeof PlurnkParser.lowerMcpCall>): PlurnkStatement => {
    const errors = result.items.filter((i) => i.kind === "error");
    assert.deepEqual(errors, []);
    const stmts = result.items.flatMap((i) => i.kind === "statement" ? [i.statement] : []);
    assert.equal(stmts.length, 1);
    return stmts[0];
};

describe("PlurnkParser MCP IR and statements", () => {
    test("{§mcp-expressions} {§op-shapes}: toMcpCall and lowerMcpCall round-trip every core operation, plurnk Functionality tool, builtin executor, and external MCP server tool", () => {
        const payloads = [
            { server: "plurnk", tool: "note", arguments: { text: "line 1\nline 2" }, aside: "plan" },
            { server: "plurnk", tool: "find", arguments: { path: "src/**/*.ts", range: "1,20", pattern: "/foo/i" }, aside: "search" },
            { server: "plurnk", tool: "read", arguments: { path: "README.md", range: "1,50" } },
            { server: "plurnk", tool: "edit", arguments: { path: "src/a.ts", range: "@abcde,@fghij", text: "export const x = 1;\n" }, aside: "patch" },
            { server: "plurnk", tool: "copy", arguments: { from: "src/a.ts", to: { path: "src/b.ts", range: "1,5" } } },
            { server: "plurnk", tool: "move", arguments: { from: "src/b.ts", to: "src/c.ts" } },
            { server: "plurnk", tool: "kill", arguments: { path: "log:///1/1/2/find", note: "distilled" } },
            { server: "plurnk", tool: "work", arguments: { target: "session://worker", text: "investigate" } },
            { server: "plurnk", tool: "fork", arguments: { target: "session://helper", text: "verify" } },
            { server: "plurnk", tool: "bare", arguments: { text: "summarize" } },
            { server: "plurnk", tool: "wait", arguments: { seconds: 10 }, aside: "poll" },
            { server: "plurnk", tool: "send", arguments: { target: "session://worker", text: "status?" } },
            { server: "plurnk", tool: "done", arguments: { text: "Fixed and verified." } },
            { server: "plurnk", tool: "fail", arguments: { text: "Blocked on upstream." } },
            { server: "plurnk", tool: "sh", arguments: { text: "pytest -q" }, aside: "run tests" },
            { server: "plurnk", tool: "env", arguments: { name: "FOO" } },
            { server: "gitea", tool: "list_issues", arguments: { owner: "plurnk", repo: "plurnk-service", state: "open" }, aside: "check board" },
        ];

        for (const payload of payloads) {
            const stmt = singleStatement(PlurnkParser.lowerMcpCall({ name: "mcp", arguments: payload }, { executors: ["sh", "js", "python3", "gitea"] }));
            const projected = PlurnkParser.toMcpCall(stmt);
            assert.deepEqual(projected, payload);

            // Internal stringify -> parseStatements round-trip
            const internal = PlurnkParser.stringify([stmt]);
            const reparsed = PlurnkParser.parseStatements(internal, { executors: ["sh", "js", "python3", "gitea"] });
            const reparsedStmts = reparsed.items.flatMap((i) => i.kind === "statement" ? [i.statement] : []);
            assert.equal(reparsedStmts.length, 1);
            assert.deepEqual(PlurnkParser.toMcpCall(reparsedStmts[0]), payload);
        }
    });

    test("{§mcp-expressions} {§parse-recovery}: lowerMcpCall routes any default tool name on internal sh/js/python3 servers and recovers stringified or hoisted arguments", () => {
        // Point B: any tool name passed to `sh`, `bash`, `js`, `python3` executes that runtime with `command` or `text`
        const shDefault = singleStatement(PlurnkParser.lowerMcpCall({
            name: "mcp",
            arguments: { server: "sh", tool: "exec", arguments: { command: "git status --short" } },
        })) as ExecStatement;
        assert.equal(shDefault.runtime, "sh");
        assert.equal(shDefault.target, null);
        assert.equal(shDefault.body, "git status --short");

        const pyScript = singleStatement(PlurnkParser.lowerMcpCall({
            name: "mcp",
            arguments: { server: "python", tool: "tests/runtests.py", arguments: { args: ["urlpatterns"] } },
        })) as ExecStatement;
        assert.equal(pyScript.runtime, "python3");
        assert.equal(pyScript.target?.raw, "tests/runtests.py");
        assert.equal(pyScript.body, "urlpatterns");

        // JSON-stringified inner `arguments` + hoisted sibling key (`pattern` on outer `mcp` object)
        const hoisted = singleStatement(PlurnkParser.lowerMcpCall({
            name: "mcp",
            arguments: JSON.stringify({
                server: "plurnk",
                tool: "find",
                arguments: '{"path":"django/urls/resolvers.py"}',
                pattern: "to_python",
                aside: "grep to_python",
            }),
        })) as FindStatement;
        assert.equal(hoisted.op, "find");
        assert.equal(hoisted.target?.raw, "django/urls/resolvers.py");
        assert.equal(hoisted.matcher?.raw, "to_python");
        assert.equal(hoisted.aside, "grep to_python");

        // Deterministic recovery on near-miss wire tool names and omitted `server: "plurnk"`
        const directBash = singleStatement(PlurnkParser.lowerMcpCall({ name: "bash", arguments: { command: "ls", aside: "list" } }));
        assert.deepEqual(PlurnkParser.toMcpCall(directBash), { server: "plurnk", tool: "sh", arguments: { text: "ls" }, aside: "list" });

        const dottedDirect = singleStatement(PlurnkParser.lowerMcpCall({ name: "plurnk.read", arguments: { path: "README.md" } }));
        assert.deepEqual(PlurnkParser.toMcpCall(dottedDirect), { server: "plurnk", tool: "read", arguments: { path: "README.md" } });

        const mcpPrefixed = singleStatement(PlurnkParser.lowerMcpCall(
            { name: "mcp__gitea__list_issues", arguments: { owner: "plurnk", repo: "plurnk-service" } },
            { executors: ["gitea"] },
        ));
        assert.deepEqual(PlurnkParser.toMcpCall(mcpPrefixed), {
            server: "gitea",
            tool: "list_issues",
            arguments: { owner: "plurnk", repo: "plurnk-service" },
        });

        const omittedServer = singleStatement(PlurnkParser.lowerMcpCall({ name: "mcp", arguments: { tool: "done", text: "Completed." } }));
        assert.deepEqual(PlurnkParser.toMcpCall(omittedServer), { server: "plurnk", tool: "done", arguments: { text: "Completed." } });

        const dottedTool = singleStatement(PlurnkParser.lowerMcpCall({ name: "mcp", arguments: { tool: "plurnk.done", arguments: { text: "Completed." } } }));
        assert.deepEqual(PlurnkParser.toMcpCall(dottedTool), { server: "plurnk", tool: "done", arguments: { text: "Completed." } });

        // Refusal on genuinely unknown wire tool name or malformed JSON populates recovery and attempt
        const unknownTool = PlurnkParser.lowerMcpCall({ name: "reed", arguments: { path: "a.txt" } });
        assert.equal(unknownTool.items[0]?.kind, "error");
        if (unknownTool.items[0]?.kind === "error") {
            assert.ok(unknownTool.items[0].error.recovery?.startsWith("mcp("));
            assert.ok(unknownTool.items[0].attempt?.text.startsWith("reed("));
        }
        const badJson = PlurnkParser.lowerMcpCall({ name: "mcp", arguments: "{unclosed" });
        assert.equal(badJson.items[0]?.kind, "error");
        if (badJson.items[0]?.kind === "error") {
            assert.ok(badJson.items[0].error.recovery?.startsWith("mcp("));
            assert.ok(badJson.items[0].attempt?.text.startsWith("mcp("));
        }
    });

    test("{§mcp-expressions} {§parse-recovery}: lowerMcpCall recovers DeepSeek DSML invoke-boundary parameter leaks (#1489)", () => {
        // Shape 1: `name="arguments"` swallowed into `tool` with `string="false"` + outer `aside`
        const dsmlEnvelope = singleStatement(PlurnkParser.lowerMcpCall({
            name: "mcp",
            arguments: JSON.stringify({
                server: "plurnk",
                tool: 'note">\n<｜｜DSML｜｜ parameter name="arguments" string="false">{"text": "Goal: unroll all/any generator expressions."}',
                aside: "design note",
            }),
        }));
        assert.deepEqual(PlurnkParser.toMcpCall(dsmlEnvelope), {
            server: "plurnk",
            tool: "note",
            arguments: { text: "Goal: unroll all/any generator expressions." },
            aside: "design note",
        });

        // Shape 2a: direct expanded `name="text"` swallowed into `tool` preserving trailing newline
        const dsmlDirectNote = singleStatement(PlurnkParser.lowerMcpCall({
            name: "mcp",
            arguments: JSON.stringify({
                server: "plurnk",
                tool: 'note">\n<｜｜DSML｜｜ parameter name="text" string="true">Edited debug.py: import Http404\n',
            }),
        }));
        assert.deepEqual(PlurnkParser.toMcpCall(dsmlDirectNote), {
            server: "plurnk",
            tool: "note",
            arguments: { text: "Edited debug.py: import Http404\n" },
        });

        // Shape 2b: first parameter `path` swallowed into `tool` alongside outer sibling `pattern` and `text`
        const dsmlSplitEdit = singleStatement(PlurnkParser.lowerMcpCall({
            name: "mcp",
            arguments: JSON.stringify({
                server: "plurnk",
                tool: 'edit">\n<｜｜DSML｜｜ parameter name="path" string="true">docs/releases/4.2.txt',
                pattern: "* The new :option:`makemigrations --update`",
                text: "* Updated release note.\n",
                aside: "update release notes",
            }),
        }));
        assert.deepEqual(PlurnkParser.toMcpCall(dsmlSplitEdit), {
            server: "plurnk",
            tool: "edit",
            arguments: {
                path: "docs/releases/4.2.txt",
                pattern: "* The new :option:`makemigrations --update`",
                text: "* Updated release note.\n",
            },
            aside: "update release notes",
        });

        // Shape 3: multiple `<|DSML|parameter>` tags and closing tags leaked across `server` / `tool`
        const dsmlMulti = singleStatement(PlurnkParser.lowerMcpCall({
            name: "mcp",
            arguments: JSON.stringify({
                server: 'plurnk">\n<|DSML|parameter name="tool" string="true">read</|DSML|parameter>\n<|DSML|parameter name="path" string="true">src/index.ts</|DSML|parameter>\n<|DSML|parameter name="range" string="true">1,25</|DSML|parameter>',
            }),
        }));
        assert.deepEqual(PlurnkParser.toMcpCall(dsmlMulti), {
            server: "plurnk",
            tool: "read",
            arguments: { path: "src/index.ts", range: "1,25" },
        });
    });
});
