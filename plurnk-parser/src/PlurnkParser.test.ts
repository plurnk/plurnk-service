import test, { describe } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
    test("{§parser-boundary} {§parser-lowering} {§mcp-expressions} {§op-shapes}: toMcpCall and lowerMcpCall round-trip every core operation, plurnk Functionality tool, builtin executor, and external MCP server tool", () => {
        const payloads = [
            { server: "plurnk", tool: "note", arguments: { text: "line 1\nline 2" }, aside: "plan" },
            { server: "plurnk", tool: "find", arguments: { path: "src/**/*.ts", range: "1,20", pattern: "/foo/i" }, aside: "search" },
            { server: "plurnk", tool: "read", arguments: { path: "README.md", range: "1,50" } },
            { server: "plurnk", tool: "edit", arguments: { path: "src/a.ts", range: "@abcde,@fghij", text: "export const x = 1;\n" }, aside: "patch" },
            { server: "plurnk", tool: "copy", arguments: { from: "src/a.ts", to: { path: "src/b.ts", range: "1,5" } } },
            { server: "plurnk", tool: "move", arguments: { from: "src/b.ts", to: "src/c.ts" } },
            { server: "plurnk", tool: "kill", arguments: { path: "log:///1/1/2/find" }, aside: "reclaim" },
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
            const expected = {
                server: payload.server,
                tool: payload.tool,
                aside: payload.aside ?? "",
                arguments: payload.arguments,
            };
            const stmt = singleStatement(PlurnkParser.lowerMcpCall({ name: "mcp", arguments: payload }, { executors: ["sh", "js", "python3", "gitea"] }));
            const projected = PlurnkParser.toMcpCall(stmt);
            assert.deepEqual(projected, expected);
            assert.deepEqual(Object.keys(projected), ["server", "tool", "aside", "arguments"]);

            // Internal stringify -> parseStatements round-trip
            const internal = PlurnkParser.stringify([stmt]);
            const reparsed = PlurnkParser.parseStatements(internal, { executors: ["sh", "js", "python3", "gitea"] });
            const reparsedStmts = reparsed.items.flatMap((i) => i.kind === "statement" ? [i.statement] : []);
            assert.equal(reparsedStmts.length, 1);
            assert.deepEqual(PlurnkParser.toMcpCall(reparsedStmts[0]), expected);
            assert.deepEqual(Object.keys(PlurnkParser.toMcpCall(reparsedStmts[0])), ["server", "tool", "aside", "arguments"]);
        }

        // Empty / whitespace-only aside also lowers cleanly to null and replays as aside: ""
        const emptyAsideStmt = singleStatement(PlurnkParser.lowerMcpCall({
            name: "mcp",
            arguments: { server: "plurnk", tool: "read", aside: "   ", arguments: { path: "README.md" } },
        }));
        assert.equal(emptyAsideStmt.aside, null);
        assert.deepEqual(PlurnkParser.toMcpCall(emptyAsideStmt), {
            server: "plurnk",
            tool: "read",
            aside: "",
            arguments: { path: "README.md" },
        });
        assert.equal(PlurnkParser.stringify([emptyAsideStmt]), 'plurnk.read({"path":"README.md"})');
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
        assert.deepEqual(PlurnkParser.toMcpCall(directBash), { server: "plurnk", tool: "sh", aside: "list", arguments: { text: "ls" } });

        const dottedDirect = singleStatement(PlurnkParser.lowerMcpCall({ name: "plurnk.read", arguments: { path: "README.md" } }));
        assert.deepEqual(PlurnkParser.toMcpCall(dottedDirect), { server: "plurnk", tool: "read", aside: "", arguments: { path: "README.md" } });

        const mcpPrefixed = singleStatement(PlurnkParser.lowerMcpCall(
            { name: "mcp__gitea__list_issues", arguments: { owner: "plurnk", repo: "plurnk-service" } },
            { executors: ["gitea"] },
        ));
        assert.deepEqual(PlurnkParser.toMcpCall(mcpPrefixed), {
            server: "gitea",
            tool: "list_issues",
            aside: "",
            arguments: { owner: "plurnk", repo: "plurnk-service" },
        });

        const omittedServer = singleStatement(PlurnkParser.lowerMcpCall({ name: "mcp", arguments: { tool: "done", text: "Completed." } }));
        assert.deepEqual(PlurnkParser.toMcpCall(omittedServer), { server: "plurnk", tool: "done", aside: "", arguments: { text: "Completed." } });

        const dottedTool = singleStatement(PlurnkParser.lowerMcpCall({ name: "mcp", arguments: { tool: "plurnk.done", arguments: { text: "Completed." } } }));
        assert.deepEqual(PlurnkParser.toMcpCall(dottedTool), { server: "plurnk", tool: "done", aside: "", arguments: { text: "Completed." } });

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
            aside: "",
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
            aside: "update release notes",
            arguments: {
                path: "docs/releases/4.2.txt",
                pattern: "* The new :option:`makemigrations --update`",
                text: "* Updated release note.\n",
            },
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
            aside: "",
            arguments: { path: "src/index.ts", range: "1,25" },
        });

        // Shape 4: `name="arguments"` leaked into `aside` when `aside` precedes `arguments` (#1561)
        const dsmlAsideLeak = singleStatement(PlurnkParser.lowerMcpCall({
            name: "mcp",
            arguments: JSON.stringify({
                server: "plurnk",
                tool: "read",
                aside: 'inspect serializer">\n<｜｜DSML｜｜ parameter name="arguments" string="false">{"path": "django/db/migrations/serializer.py", "range": "1,40"}',
            }),
        }));
        assert.deepEqual(PlurnkParser.toMcpCall(dsmlAsideLeak), {
            server: "plurnk",
            tool: "read",
            aside: "inspect serializer",
            arguments: { path: "django/db/migrations/serializer.py", range: "1,40" },
        });

        const dsmlAsideCloseTagLeak = singleStatement(PlurnkParser.lowerMcpCall({
            name: "mcp",
            arguments: JSON.stringify({
                server: "plurnk",
                tool: "read",
                aside: 'inspect serializer</｜DSML｜parameter>\n<｜DSML｜parameter name="arguments" string="false">{"path": "a.py"}</｜DSML｜parameter>',
            }),
        }));
        assert.deepEqual(PlurnkParser.toMcpCall(dsmlAsideCloseTagLeak), {
            server: "plurnk",
            tool: "read",
            aside: "inspect serializer",
            arguments: { path: "a.py" },
        });

        const dsmlEmptyAsideLeak = singleStatement(PlurnkParser.lowerMcpCall({
            name: "mcp",
            arguments: JSON.stringify({
                server: "plurnk",
                tool: "done",
                aside: '">\n<｜｜DSML｜｜ parameter name="arguments" string="false">{"text": "All fixed."}',
            }),
        }));
        assert.deepEqual(PlurnkParser.toMcpCall(dsmlEmptyAsideLeak), {
            server: "plurnk",
            tool: "done",
            aside: "",
            arguments: { text: "All fixed." },
        });

        const xmlAsideLeak = singleStatement(PlurnkParser.lowerMcpCall({
            name: "mcp",
            arguments: {
                server: "plurnk",
                tool: "sh",
                aside: 'run unit tests\n<parameter=arguments>\n{"text": "pytest -q"}',
            },
        }));
        assert.deepEqual(PlurnkParser.toMcpCall(xmlAsideLeak), {
            server: "plurnk",
            tool: "sh",
            aside: "run unit tests",
            arguments: { text: "pytest -q" },
        });

        const xmlEmptyAsideLeak = singleStatement(PlurnkParser.lowerMcpCall({
            name: "mcp",
            arguments: {
                server: "plurnk",
                tool: "read",
                aside: '<parameter=arguments>{"path": "README.md"}</parameter>',
            },
        }));
        assert.deepEqual(PlurnkParser.toMcpCall(xmlEmptyAsideLeak), {
            server: "plurnk",
            tool: "read",
            aside: "",
            arguments: { path: "README.md" },
        });
    });

    test("{§mcp-expressions} {§parse-recovery}: lowerMcpCall unwraps nested tool calls routed through plurnk.mcp on model tier (#1493)", () => {
        const externalViaPlurnkMcp = singleStatement(PlurnkParser.lowerMcpCall({
            name: "mcp",
            arguments: {
                server: "plurnk",
                tool: "mcp",
                arguments: {
                    name: "brave",
                    tool: "brave_web_search",
                    arguments: { query: "2026 Eurovision Song Contest winner song" },
                },
                aside: "search 2026 Eurovision winner",
            },
        }, { executors: ["brave"] }));
        assert.deepEqual(PlurnkParser.toMcpCall(externalViaPlurnkMcp), {
            server: "brave",
            tool: "brave_web_search",
            arguments: { query: "2026 Eurovision Song Contest winner song" },
            aside: "search 2026 Eurovision winner",
        });

        const coreViaPlurnkMcp = singleStatement(PlurnkParser.lowerMcpCall({
            name: "mcp",
            arguments: {
                server: "plurnk",
                tool: "mcp",
                arguments: { server: "plurnk", function: "read", path: "README.md", aside: "read readme" },
            },
        }));
        assert.deepEqual(PlurnkParser.toMcpCall(coreViaPlurnkMcp), {
            server: "plurnk",
            tool: "read",
            arguments: { path: "README.md" },
            aside: "read readme",
        });

        // Genuine plurnk.mcp server configuration calls remain untouched
        const mcpConfig = singleStatement(PlurnkParser.lowerMcpCall({
            name: "mcp",
            arguments: {
                server: "plurnk",
                tool: "mcp",
                arguments: { name: "brave", type: "stdio", command: "npx", args: ["-y", "@brave/mcp"] },
            },
        })) as ExecStatement;
        assert.equal(mcpConfig.runtime, "plurnk");
        assert.equal(mcpConfig.target?.raw, "mcp");

        // Statement-tier parseStatements remains strict
        const statementTier = PlurnkParser.parseStatements(
            'plurnk.mcp({"name":"brave","tool":"brave_web_search","arguments":{"query":"x"}})',
            { executors: ["plurnk", "brave"] },
        );
        const stmt = statementTier.items[0]?.kind === "statement" ? statementTier.items[0].statement as ExecStatement : null;
        assert.equal(stmt?.runtime, "plurnk");
        assert.equal(stmt?.target?.raw, "mcp");
    });

    test("{§mcp-expressions} {§parse-recovery}: lowerMcpCall folds separate channel options into path#channel fragments on model tier (#1494)", () => {
        const localChannel = singleStatement(PlurnkParser.lowerMcpCall({
            name: "mcp",
            arguments: {
                server: "plurnk",
                tool: "read",
                arguments: { path: "data/users.html", channel: "#readable" },
            },
        }));
        assert.deepEqual(PlurnkParser.toMcpCall(localChannel), {
            server: "plurnk",
            tool: "read",
            aside: "",
            arguments: { path: "data/users.html#readable" },
        });

        const urlChannel = singleStatement(PlurnkParser.lowerMcpCall({
            name: "mcp",
            arguments: {
                server: "plurnk",
                tool: "copy",
                arguments: {
                    from: { path: "exec:///sh/6f88d732", channel: "stderr" },
                    to: "workspace:///err.txt",
                },
            },
        }));
        assert.deepEqual(PlurnkParser.toMcpCall(urlChannel), {
            server: "plurnk",
            tool: "copy",
            aside: "",
            arguments: { from: "exec:///sh/6f88d732#stderr", to: "workspace:///err.txt" },
        });

        // Explicit path#fragment wins over redundant channel option
        const explicitWins = singleStatement(PlurnkParser.lowerMcpCall({
            name: "mcp",
            arguments: {
                server: "plurnk",
                tool: "read",
                arguments: { path: "data/users.html#body", channel: "#readable" },
            },
        }));
        assert.deepEqual(PlurnkParser.toMcpCall(explicitWins), {
            server: "plurnk",
            tool: "read",
            aside: "",
            arguments: { path: "data/users.html#body" },
        });

        // Statement-tier parseStatements rejects separate channel option strictly
        const strict = PlurnkParser.parseStatements('plurnk.read({"path":"data/users.html","channel":"#readable"})');
        assert.equal(strict.items[0]?.kind, "error");
    });

    test("{§mcp-expressions} {§parse-recovery}: lowerMcpCall recovers echoed envelope keys, commentary asides, singular line aliases, and wait millisecond bounds while refusing cross-verb payloads (#1513)", () => {
        // Echoed `tool` + `server` inside `done` arguments (`review1-1-12` specimen)
        const echoedDone = singleStatement(PlurnkParser.lowerMcpCall({
            name: "mcp",
            arguments: {
                server: "plurnk",
                tool: "done",
                aside: "deliver project health audit report",
                arguments: {
                    aside: "deliver project health audit report",
                    text: "Audit report complete.",
                    tool: "done",
                    server: "plurnk",
                },
            },
        }));
        assert.deepEqual(PlurnkParser.toMcpCall(echoedDone), {
            server: "plurnk",
            tool: "done",
            arguments: { text: "Audit report complete." },
            aside: "deliver project health audit report",
        });

        // Singular `line` alias + `reason` commentary aside on `edit`
        const editLineReason = singleStatement(PlurnkParser.lowerMcpCall({
            name: "mcp",
            arguments: {
                server: "plurnk",
                tool: "edit",
                arguments: {
                    path: "test/sse.test.mjs",
                    line: "@T2DhH",
                    text: "        reconnectBaseMs: 1,\n",
                    reason: "drop unused delay",
                },
            },
        }));
        assert.deepEqual(PlurnkParser.toMcpCall(editLineReason), {
            server: "plurnk",
            tool: "edit",
            arguments: {
                path: "test/sse.test.mjs",
                range: "@T2DhH",
                text: "        reconnectBaseMs: 1,\n",
            },
            aside: "drop unused delay",
        });

        // `what` commentary aside on `sh`, `tags`/`keep`/`kind`/`status` metadata on `note`, and `stream` + `timeoutMs` on `wait`
        const shWhat = singleStatement(PlurnkParser.lowerMcpCall({
            name: "mcp",
            arguments: {
                server: "plurnk",
                tool: "sh",
                arguments: { what: "find matplotlib installs", text: "python -c 'import matplotlib'" },
            },
        }));
        assert.deepEqual(PlurnkParser.toMcpCall(shWhat), {
            server: "plurnk",
            tool: "sh",
            arguments: { text: "python -c 'import matplotlib'" },
            aside: "find matplotlib installs",
        });

        const noteMeta = singleStatement(PlurnkParser.lowerMcpCall({
            name: "mcp",
            arguments: {
                server: "plurnk",
                tool: "note",
                arguments: { text: "Baseline verified.", tags: ["sympy"], keep: false, kind: "decision", status: "ok" },
            },
        }));
        assert.deepEqual(PlurnkParser.toMcpCall(noteMeta), {
            server: "plurnk",
            tool: "note",
            aside: "",
            arguments: { text: "Baseline verified." },
        });

        const waitMs = singleStatement(PlurnkParser.lowerMcpCall({
            name: "mcp",
            arguments: {
                server: "plurnk",
                tool: "wait",
                arguments: { stream: "sh:///39f6c6b2", timeoutMs: 120000 },
            },
        }));
        assert.deepEqual(PlurnkParser.toMcpCall(waitMs), {
            server: "plurnk",
            tool: "wait",
            aside: "",
            arguments: { seconds: 120 },
        });

        // Genuine cross-verb or garbled payload keys stay refused on the model tier
        const readWithEditBody = PlurnkParser.lowerMcpCall({
            name: "mcp",
            arguments: {
                server: "plurnk",
                tool: "read",
                arguments: { path: "pretty.py", range: "821,836", text: "    def _print_MatAdd(self, expr):\n" },
            },
        });
        assert.equal(readWithEditBody.items[0]?.kind, "error");

        const shGarbledKey = PlurnkParser.lowerMcpCall({
            name: "mcp",
            arguments: { server: "plurnk", tool: "sh", arguments: { _text: "pytest" } },
        });
        assert.equal(shGarbledKey.items[0]?.kind, "error");
    });

    test("{§mcp-expressions} {§parse-recovery}: lowerMcpCall recovers XML invoke-boundary leaks, fallback id/session/stream/process targets, old/new and find/replace edit pairs, done note bodies, and #channel ranges (#1527)", () => {
        // 1. XML invoke-boundary leaks (`sh>`, `<parameter=...>`, `<tool_call><function=mcp>...`)
        const trailingGtTool = singleStatement(PlurnkParser.lowerMcpCall({
            name: "mcp",
            arguments: { server: "plurnk", tool: "sh>", arguments: { text: "pytest -q" } },
        }));
        assert.deepEqual(PlurnkParser.toMcpCall(trailingGtTool), {
            server: "plurnk",
            tool: "sh",
            aside: "",
            arguments: { text: "pytest -q" },
        });

        const implicitTrailingGt = singleStatement(PlurnkParser.lowerMcpCall({
            name: "plurnk.sh>",
            arguments: { text: "git status" },
        }));
        assert.deepEqual(PlurnkParser.toMcpCall(implicitTrailingGt), {
            server: "plurnk",
            tool: "sh",
            aside: "",
            arguments: { text: "git status" },
        });

        const xmlServerParamLeak = singleStatement(PlurnkParser.lowerMcpCall({
            name: "mcp",
            arguments: {
                server: "plurnk\n<parameter=tool>\nread",
                tool: "read",
                arguments: { path: "tests/inheritance.py", range: "1,-1" },
            },
        }));
        assert.deepEqual(PlurnkParser.toMcpCall(xmlServerParamLeak), {
            server: "plurnk",
            tool: "read",
            aside: "",
            arguments: { path: "tests/inheritance.py", range: "1,-1" },
        });

        const xmlToolArgsLeak = singleStatement(PlurnkParser.lowerMcpCall({
            name: "mcp",
            arguments: {
                server: "plurnk",
                tool: 'sh>\n<parameter=arguments>\n{"text": "git diff --stat"}',
            },
        }));
        assert.deepEqual(PlurnkParser.toMcpCall(xmlToolArgsLeak), {
            server: "plurnk",
            tool: "sh",
            aside: "",
            arguments: { text: "git diff --stat" },
        });

        const xmlClosingTagGarbage = singleStatement(PlurnkParser.lowerMcpCall({
            name: "mcp",
            arguments: {
                server: "plurnk\n<parameter=tool>\nnote",
                tool: "</parameter>\n</function>\n</tool_call>\n<tool_call>\n<function=mcp>\n<parameter=server>\nplurnk",
                arguments: { text: "Root cause confirmed." },
                aside: "</parameter>\n<parameter=tool>",
            },
        }));
        assert.deepEqual(PlurnkParser.toMcpCall(xmlClosingTagGarbage), {
            server: "plurnk",
            tool: "note",
            aside: "",
            arguments: { text: "Root cause confirmed." },
        });

        const xmlTrailingServerProse = singleStatement(PlurnkParser.lowerMcpCall({
            name: "mcp",
            arguments: {
                server: "Previous 400 notice observed.\n\n<tool_call>\n<function=mcp>\n<parameter=server>\nplurnk",
                tool: "sh",
                arguments: { text: "python3 -m py_compile a.py" },
                aside: "verify compile",
            },
        }));
        assert.deepEqual(PlurnkParser.toMcpCall(xmlTrailingServerProse), {
            server: "plurnk",
            tool: "sh",
            arguments: { text: "python3 -m py_compile a.py" },
            aside: "verify compile",
        });

        // 2. Model-tier fallback `id` targets and `session`/`stream`/`process` kill aliases
        for (const [args, expectedPath] of [
            [{ id: "log:///1/23/2/read" }, "log:///1/23/2/read"],
            [{ id: "call_meta", path: "log:///1/1/8/find" }, "log:///1/1/8/find"],
            [{ session: "session://worker" }, "session://worker"],
            [{ stream: "exec:///sh/ff10d4c2" }, "exec:///sh/ff10d4c2"],
            [{ process: "sh:///9e99765d" }, "exec:///sh/9e99765d"],
        ] as const) {
            const killed = singleStatement(PlurnkParser.lowerMcpCall({
                name: "mcp",
                arguments: { server: "plurnk", tool: "kill", arguments: args },
            }));
            assert.deepEqual(PlurnkParser.toMcpCall(killed), {
                server: "plurnk",
                tool: "kill",
                aside: "",
                arguments: { path: expectedPath },
            });
        }

        const readById = singleStatement(PlurnkParser.lowerMcpCall({
            name: "mcp",
            arguments: { server: "plurnk", tool: "read", arguments: { id: "log:///1/2/1/send" } },
        }));
        assert.deepEqual(PlurnkParser.toMcpCall(readById), {
            server: "plurnk",
            tool: "read",
            aside: "",
            arguments: { path: "log:///1/2/1/send" },
        });

        const findWithOpaqueCallId = singleStatement(PlurnkParser.lowerMcpCall({
            name: "mcp",
            arguments: { server: "plurnk", tool: "find", arguments: { id: "call_123" } },
        }));
        assert.deepEqual(PlurnkParser.toMcpCall(findWithOpaqueCallId), {
            server: "plurnk",
            tool: "find",
            aside: "",
            arguments: {},
        });

        // 3. `old`/`new`, `find`/`replace`, and `original`/`replacement` on `plurnk.edit`
        for (const editArgs of [
            { path: "a.py", old: "x == 1", new: "x in {1}" },
            { path: "a.py", find: "x == 1", replace: "x in {1}" },
            { path: "a.py", original: "x == 1", replacement: "x in {1}" },
            { id: "a.py", edits: [{ find: "x == 1", replace: "x in {1}" }] },
        ]) {
            const edited = singleStatement(PlurnkParser.lowerMcpCall({
                name: "mcp",
                arguments: { server: "plurnk", tool: "edit", arguments: editArgs },
            }));
            assert.deepEqual(PlurnkParser.toMcpCall(edited), {
                server: "plurnk",
                tool: "edit",
                aside: "",
                arguments: { path: "a.py", pattern: "x == 1", text: "x in {1}" },
            });
        }

        // 4. `note` fallback on `done` and `#channel`-shaped `range` promotion on `read`
        const doneNote = singleStatement(PlurnkParser.lowerMcpCall({
            name: "mcp",
            arguments: { server: "plurnk", tool: "done", arguments: { note: "All unit tests pass." } },
        }));
        assert.deepEqual(PlurnkParser.toMcpCall(doneNote), {
            server: "plurnk",
            tool: "done",
            aside: "",
            arguments: { text: "All unit tests pass." },
        });

        const stdoutInRange = singleStatement(PlurnkParser.lowerMcpCall({
            name: "mcp",
            arguments: { server: "plurnk", tool: "read", arguments: { path: "sh:///ac36348b", range: "#stdout" } },
        }));
        assert.deepEqual(PlurnkParser.toMcpCall(stdoutInRange), {
            server: "plurnk",
            tool: "read",
            aside: "",
            arguments: { path: "exec:///sh/ac36348b#stdout" },
        });

        const numericHashRange = singleStatement(PlurnkParser.lowerMcpCall({
            name: "mcp",
            arguments: { server: "plurnk", tool: "read", arguments: { path: "a.py", range: "#10,20" } },
        }));
        assert.deepEqual(PlurnkParser.toMcpCall(numericHashRange), {
            server: "plurnk",
            tool: "read",
            aside: "",
            arguments: { path: "a.py", range: "10,20" },
        });
    });

    test("{§mcp-expressions} {§op-shapes} {§parse-recovery}: lowerMcpCall recovers wire RENO aliases and URI forms while refusing ambiguous or cross-verb payloads (#1530)", () => {
        // 1. Edit string `context` vs numeric `context`, match/replace/insert pairs, occurrences: 1, and dummy range: "0"
        for (const [editArgs, expectedText] of [
            [{ path: "a.py", context: "x = 1", replacement: "x = 2" }, "x = 2"],
            [{ path: "a.py", match: "x = 1", patternReplace: "x = 2", occurrences: "1", context: 3 }, "x = 2"],
            [{ path: "a.py", span: "x = 1", text: "x = 2", range: "0" }, "x = 2"],
            [{ path: "a.py", marker: "x = 1", text: "x = 2", range: 0 }, "x = 2"],
            [{ path: "a.py", before: "x = 1", after: "x = 2" }, "x = 2"],
            [{ path: "a.py", pattern: "x =", before: "x = 1", after: "x = 2" }, "x = 2"],
            [{ path: "a.py", pattern: "x = 1", text: "x = 2", context: "nearby helper" }, "x = 2"],
            [{ path: "a.py", after: "x = 1", insert: "y = 2" }, "x = 1\ny = 2"],
            [{ path: "a.py", before: "x = 1", insert: "y = 0" }, "y = 0\nx = 1"],
            [{ path: "a.py", start: "x = 1", end: "x = 2", newText: "x = 2" }, "x = 2"],
        ] as const) {
            const stmt = singleStatement(PlurnkParser.lowerMcpCall({
                name: "mcp",
                arguments: { server: "plurnk", tool: "edit", arguments: editArgs },
            }));
            assert.deepEqual(PlurnkParser.toMcpCall(stmt), {
                server: "plurnk",
                tool: "edit",
                aside: "",
                arguments: { path: "a.py", pattern: "x = 1", text: expectedText },
            });
        }

        const spanAsRange = singleStatement(PlurnkParser.lowerMcpCall({
            name: "mcp",
            arguments: { server: "plurnk", tool: "edit", arguments: { path: "a.py", span: "@abcde,@fghij", text: "x = 2" } },
        }));
        assert.deepEqual(PlurnkParser.toMcpCall(spanAsRange), {
            server: "plurnk",
            tool: "edit",
            aside: "",
            arguments: { path: "a.py", range: "@abcde,@fghij", text: "x = 2" },
        });

        // 2. Integer line-bound hoisting (`startLine`/`endLine`, `start`/`end`, `from`/`to`) and numeric `context`/`before`/`after` ignore
        for (const [readArgs, expectedRange] of [
            [{ path: "a.py", startLine: 10, endLine: 25, context: 2 }, "10,25"],
            [{ path: "a.py", start_line: "30", end_line: "40", before: 2, after: 2 }, "30,40"],
            [{ path: "a.py", start: 50, end: 60 }, "50,60"],
            [{ path: "a.py", from: 70, to: 80 }, "70,80"],
            [{ path: "a.py", startLine: 90 }, "90,-1"],
        ] as const) {
            const stmt = singleStatement(PlurnkParser.lowerMcpCall({
                name: "mcp",
                arguments: { server: "plurnk", tool: "read", arguments: readArgs },
            }));
            assert.deepEqual(PlurnkParser.toMcpCall(stmt), {
                server: "plurnk",
                tool: "read",
                aside: "",
                arguments: { path: "a.py", range: expectedRange },
            });
        }

        // 3. Non-HTTP `headers` selection hoisting vs HTTP `headers` preservation
        const hoistedHeaders = singleStatement(PlurnkParser.lowerMcpCall({
            name: "mcp",
            arguments: {
                server: "plurnk",
                tool: "find",
                arguments: {
                    path: "src/**",
                    headers: { headers: { pattern: "/def foo/", range: "1,20", case: "insensitive", context: 30 } },
                },
            },
        }));
        assert.deepEqual(PlurnkParser.toMcpCall(hoistedHeaders), {
            server: "plurnk",
            tool: "find",
            aside: "",
            arguments: { path: "src/**", range: "1,20", pattern: "/def foo/" },
        });

        const httpHeadersPreserved = singleStatement(PlurnkParser.lowerMcpCall({
            name: "mcp",
            arguments: {
                server: "plurnk",
                tool: "read",
                arguments: { path: "https://example.com/data.txt", headers: { range: "bytes=0-99" } },
            },
        }));
        assert.deepEqual(PlurnkParser.toMcpCall(httpHeadersPreserved), {
            server: "plurnk",
            tool: "read",
            aside: "",
            arguments: { path: "https://example.com/data.txt", headers: { range: "bytes=0-99" } },
        });

        // 4. `move`/`copy` source-destination bijection + companion `note`, `wait` `note`, and `kill` `ids`/`streams` URI arrays
        for (const transferArgs of [
            { path: "a.py", to: "b.py" },
            { from: "a.py", target: "b.py" },
            { path: "a.py", path2: "b.py" },
            { oldPath: "a.py", newPath: "b.py" },
            { path: "a.py", target: "b.py" },
        ]) {
            const stmt = singleStatement(PlurnkParser.lowerMcpCall({
                name: "mcp",
                arguments: { server: "plurnk", tool: "copy", arguments: transferArgs },
            }));
            assert.deepEqual(PlurnkParser.toMcpCall(stmt), {
                server: "plurnk",
                tool: "copy",
                aside: "",
                arguments: { from: "a.py", to: "b.py" },
            });
        }

        const moveWithNote = PlurnkParser.lowerMcpCall({
            name: "mcp",
            arguments: { server: "plurnk", tool: "move", arguments: { path: "old.py", to: "new.py", note: "Archive helper." } },
        });
        assert.deepEqual(
            moveWithNote.items.map((item) => item.kind === "statement" ? PlurnkParser.toMcpCall(item.statement) : item),
            [
                { server: "plurnk", tool: "note", aside: "", arguments: { text: "Archive helper." } },
                { server: "plurnk", tool: "move", aside: "", arguments: { from: "old.py", to: "new.py" } },
            ],
        );

        const waitWithNote = singleStatement(PlurnkParser.lowerMcpCall({
            name: "mcp",
            arguments: { server: "plurnk", tool: "wait", arguments: { stream: "sh:///abc12345", seconds: 5, note: "await pytest" } },
        }));
        assert.deepEqual(PlurnkParser.toMcpCall(waitWithNote), {
            server: "plurnk",
            tool: "wait",
            aside: "await pytest",
            arguments: { seconds: 5 },
        });

        const killIds = PlurnkParser.lowerMcpCall({
            name: "mcp",
            arguments: { server: "plurnk", tool: "kill", arguments: { ids: ["log://1/2/3/read", "sh:///1/4/2/sh"] } },
        });
        assert.deepEqual(
            killIds.items.map((item) => item.kind === "statement" ? PlurnkParser.toMcpCall(item.statement) : item),
            [
                { server: "plurnk", tool: "kill", aside: "", arguments: { path: "log:///1/2/3/read" } },
                { server: "plurnk", tool: "kill", aside: "", arguments: { path: "log:///1/4/2/sh" } },
            ],
        );

        // 5. Model-tier URI normalization (`log://<d>/<d>/<d>/<op>`, `<exec>:///<d>/<d>/<d>/<op>`, `<sh|js|python3>:///<8-hex>`) vs preserved authorities
        for (const [rawTarget, canonicalTarget] of [
            ["log://1/2/3/read", "log:///1/2/3/read"],
            ["python3:///2/4/1/python3#stderr", "log:///2/4/1/python3#stderr"],
            ["sh:///a1b2c3d4#stderr", "exec:///sh/a1b2c3d4#stderr"],
            ["js:///a1b2c3d4/resources/out.txt", "exec:///js/a1b2c3d4/resources/out.txt"],
            ["python3:///a1b2c3d4", "exec:///python3/a1b2c3d4"],
            ["workspace://host/example.ts", "workspace://host/example.ts"],
            ["mcp://docs/index", "mcp://docs/index"],
            ["log://worker/1/2/3/read", "log://worker/1/2/3/read"],
        ] as const) {
            const stmt = singleStatement(PlurnkParser.lowerMcpCall({
                name: "mcp",
                arguments: { server: "plurnk", tool: "read", arguments: { path: rawTarget } },
            }));
            assert.deepEqual(PlurnkParser.toMcpCall(stmt), {
                server: "plurnk",
                tool: "read",
                aside: "",
                arguments: { path: canonicalTarget },
            });
        }

        // 6. `find({ pattern })` -> `path: "**"`, `plurnk.write` -> `edit` (`"1,-1"`), and bare `mcp({ text })` -> `note`
        const findDefaultRoot = singleStatement(PlurnkParser.lowerMcpCall({
            name: "mcp",
            arguments: { server: "plurnk", tool: "find", arguments: { pattern: "&parseMatcher" } },
        }));
        assert.deepEqual(PlurnkParser.toMcpCall(findDefaultRoot), {
            server: "plurnk",
            tool: "find",
            aside: "",
            arguments: { path: "**", pattern: "&parseMatcher" },
        });

        const writeWholeFile = singleStatement(PlurnkParser.lowerMcpCall({
            name: "mcp",
            arguments: { server: "plurnk", tool: "write", arguments: { path: "notes.txt", content: "hello\n" } },
        }));
        assert.deepEqual(PlurnkParser.toMcpCall(writeWholeFile), {
            server: "plurnk",
            tool: "edit",
            aside: "",
            arguments: { path: "notes.txt", range: "1,-1", text: "hello\n" },
        });

        const bareNote = singleStatement(PlurnkParser.lowerMcpCall({
            name: "mcp",
            arguments: { text: "Verified invariant holds." },
        }));
        assert.deepEqual(PlurnkParser.toMcpCall(bareNote), {
            server: "plurnk",
            tool: "note",
            aside: "",
            arguments: { text: "Verified invariant holds." },
        });

        const killStreamId = singleStatement(PlurnkParser.lowerMcpCall({
            name: "mcp",
            arguments: { server: "plurnk", tool: "kill", arguments: { streamId: "sh:///e68c60d8" } },
        }));
        assert.deepEqual(PlurnkParser.toMcpCall(killStreamId), {
            server: "plurnk",
            tool: "kill",
            aside: "",
            arguments: { path: "exec:///sh/e68c60d8" },
        });

        const shWithEnv = singleStatement(PlurnkParser.lowerMcpCall({
            name: "mcp",
            arguments: {
                server: "plurnk",
                tool: "sh",
                arguments: { text: "pytest -q", env: { DJANGO_SETTINGS_MODULE: "tests.settings" } },
            },
        })) as ExecStatement;
        assert.equal(shWithEnv.body, "pytest -q");
        assert.deepEqual(shWithEnv.env, { DJANGO_SETTINGS_MODULE: "tests.settings" });
        assert.deepEqual(PlurnkParser.toMcpCall(shWithEnv), {
            server: "plurnk",
            tool: "sh",
            aside: "",
            arguments: { text: "pytest -q", env: { DJANGO_SETTINGS_MODULE: "tests.settings" } },
        });
        const reparsedShWithEnv = singleStatement(
            PlurnkParser.parseStatements(PlurnkParser.stringify([shWithEnv]), { executors: ["sh", "js", "python3"] }),
        );
        assert.deepEqual(PlurnkParser.toMcpCall(reparsedShWithEnv), {
            server: "plurnk",
            tool: "sh",
            aside: "",
            arguments: { text: "pytest -q", env: { DJANGO_SETTINGS_MODULE: "tests.settings" } },
        });

        // sh / python3 / js with `env` (both `text` and `script`) round-trip structurally and execute in child processes
        const envDir = mkdtempSync(join(tmpdir(), "plurnk-parser-env-"));
        try {
            const shScript = join(envDir, "check.sh");
            const pyScript = join(envDir, "check.py");
            const jsScript = join(envDir, "check.js");
            writeFileSync(shScript, '#!/usr/bin/env sh\nprintf "%s" "$DJANGO_SETTINGS_MODULE"\n', "utf8");
            writeFileSync(pyScript, '#!/usr/bin/env python3\nfrom __future__ import annotations\nimport os\nprint(os.environ["DJANGO_SETTINGS_MODULE"], end="")\n', "utf8");
            writeFileSync(jsScript, '#!/usr/bin/env node\nprocess.stdout.write(process.env.DJANGO_SETTINGS_MODULE ?? "");\n', "utf8");

            const execEnvCases = [
                {
                    tool: "sh" as const,
                    bin: "sh",
                    inlineFlag: "-c",
                    inlineText: '#!/usr/bin/env sh\nprintf "%s" "$DJANGO_SETTINGS_MODULE"',
                    scriptPath: shScript,
                },
                {
                    tool: "python3" as const,
                    bin: "python3",
                    inlineFlag: "-c",
                    inlineText: 'from __future__ import annotations\nimport os\nprint(os.environ["DJANGO_SETTINGS_MODULE"], end="")',
                    scriptPath: pyScript,
                },
                {
                    tool: "js" as const,
                    bin: process.execPath,
                    inlineFlag: "-e",
                    inlineText: 'process.stdout.write(process.env.DJANGO_SETTINGS_MODULE ?? "")',
                    scriptPath: jsScript,
                },
            ];

            for (const { tool, bin, inlineFlag, inlineText, scriptPath } of execEnvCases) {
                const inlinePayload = {
                    server: "plurnk",
                    tool,
                    aside: "",
                    arguments: { text: inlineText, env: { DJANGO_SETTINGS_MODULE: "tests.settings" } },
                };
                const inlineStmt = singleStatement(PlurnkParser.lowerMcpCall({ name: "mcp", arguments: inlinePayload })) as ExecStatement;
                assert.equal(inlineStmt.body, inlineText);
                assert.deepEqual(inlineStmt.env, { DJANGO_SETTINGS_MODULE: "tests.settings" });
                assert.deepEqual(PlurnkParser.toMcpCall(inlineStmt), inlinePayload);
                const inlineReparsed = singleStatement(
                    PlurnkParser.parseStatements(PlurnkParser.stringify([inlineStmt]), { executors: ["sh", "js", "python3"] }),
                );
                assert.deepEqual(PlurnkParser.toMcpCall(inlineReparsed), inlinePayload);

                const scriptPayload = {
                    server: "plurnk",
                    tool,
                    aside: "",
                    arguments: { script: scriptPath, env: { DJANGO_SETTINGS_MODULE: "tests.settings" } },
                };
                const scriptStmt = singleStatement(PlurnkParser.lowerMcpCall({ name: "mcp", arguments: scriptPayload })) as ExecStatement;
                assert.equal(scriptStmt.body, null);
                assert.equal(scriptStmt.target?.raw, scriptPath);
                assert.deepEqual(scriptStmt.env, { DJANGO_SETTINGS_MODULE: "tests.settings" });
                assert.deepEqual(PlurnkParser.toMcpCall(scriptStmt), scriptPayload);
                const scriptReparsed = singleStatement(
                    PlurnkParser.parseStatements(PlurnkParser.stringify([scriptStmt]), { executors: ["sh", "js", "python3"] }),
                );
                assert.deepEqual(PlurnkParser.toMcpCall(scriptReparsed), scriptPayload);

                if (tool === "python3" && spawnSync("sh", ["-c", "command -v python3"]).status !== 0) continue;

                const inlineRun = spawnSync(bin, [inlineFlag, inlineStmt.body], {
                    env: { ...process.env, ...inlineStmt.env },
                    encoding: "utf8",
                });
                assert.equal(inlineRun.status, 0, inlineRun.stderr);
                assert.equal(inlineRun.stdout, "tests.settings");

                const scriptRun = spawnSync(bin, [scriptStmt.target.raw], {
                    env: { ...process.env, ...scriptStmt.env },
                    encoding: "utf8",
                });
                assert.equal(scriptRun.status, 0, scriptRun.stderr);
                assert.equal(scriptRun.stdout, "tests.settings");
            }
        } finally {
            rmSync(envDir, { recursive: true, force: true });
        }

        // 6b. Blind-corpus edit.note -> aside and non-HTTP headers scalars
        const editWithNoteAside = singleStatement(PlurnkParser.lowerMcpCall({
            name: "mcp",
            arguments: {
                server: "plurnk",
                tool: "edit",
                arguments: { path: "xarray/dataarray.py", old: "x = 1", new: "x = 2", note: "update x" },
            },
        }));
        assert.deepEqual(PlurnkParser.toMcpCall(editWithNoteAside), {
            server: "plurnk",
            tool: "edit",
            arguments: { path: "xarray/dataarray.py", pattern: "x = 1", text: "x = 2" },
            aside: "update x",
        });

        const killWithNoteAside = singleStatement(PlurnkParser.lowerMcpCall({
            name: "mcp",
            arguments: {
                server: "plurnk",
                tool: "kill",
                arguments: { path: "log:///1/2/3/read", note: "retire read" },
            },
        }));
        assert.equal(killWithNoteAside.op === "kill" ? killWithNoteAside.body : undefined, null);
        assert.deepEqual(PlurnkParser.toMcpCall(killWithNoteAside), {
            server: "plurnk",
            tool: "kill",
            arguments: { path: "log:///1/2/3/read" },
            aside: "retire read",
        });

        const killWithBothAsideAndNote = singleStatement(PlurnkParser.lowerMcpCall({
            name: "mcp",
            arguments: {
                server: "plurnk",
                tool: "kill",
                arguments: { path: "log:///1/2/3/read", note: "ignored fallback" },
                aside: "explicit aside",
            },
        }));
        assert.deepEqual(PlurnkParser.toMcpCall(killWithBothAsideAndNote), {
            server: "plurnk",
            tool: "kill",
            arguments: { path: "log:///1/2/3/read" },
            aside: "explicit aside",
        });

        const strictKillNote = PlurnkParser.parseStatements('await plurnk.kill({ path: "log:///1/2/3/read", note: "rejected" });');
        assert.equal(strictKillNote.items.some((item) => item.kind === "error"), true);

        const findHeadersMaxAndBoolLines = singleStatement(PlurnkParser.lowerMcpCall({
            name: "mcp",
            arguments: {
                server: "plurnk",
                tool: "find",
                arguments: { path: "sympy/**/*.py", pattern: "~evaluate", headers: { max: 5, lines: true } },
            },
        }));
        assert.deepEqual(PlurnkParser.toMcpCall(findHeadersMaxAndBoolLines), {
            server: "plurnk",
            tool: "find",
            aside: "",
            arguments: { path: "sympy/**/*.py", pattern: "~evaluate", range: "5" },
        });

        // 7. Ambiguity & safety refusals stay hard `error` items
        for (const refusedArgs of [
            { server: "plurnk", tool: "edit", arguments: { pattern: "x = 1", text: "x = 2" } },
            { server: "plurnk", tool: "edit", arguments: { path: "a.py", occurrences: 2, pattern: "x = 1", text: "x = 2" } },
            { server: "plurnk", tool: "read", arguments: { path: "a.py", from: "header" } },
            { server: "plurnk", tool: "read", arguments: { path: "a.py", context: "def foo" } },
            { server: "plurnk", tool: "move", arguments: { path: "only-one.py" } },
            { server: "plurnk", tool: "kill", arguments: { ids: ["read"] } },
            { server: "plurnk", tool: "kill", arguments: { id: 22970045 } },
            {},
            { text: "ambiguous", path: "a.py" },
        ]) {
            const refused = PlurnkParser.lowerMcpCall({ name: "mcp", arguments: refusedArgs });
            assert.equal(refused.items.some((item) => item.kind === "error"), true, JSON.stringify(refusedArgs));
        }
    });
});
