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
            arguments: { path: "data/users.html#readable" },
        });

        const urlChannel = singleStatement(PlurnkParser.lowerMcpCall({
            name: "mcp",
            arguments: {
                server: "plurnk",
                tool: "copy",
                arguments: {
                    from: { path: "sh:///6f88d732", channel: "stderr" },
                    to: "workspace:///err.txt",
                },
            },
        }));
        assert.deepEqual(PlurnkParser.toMcpCall(urlChannel), {
            server: "plurnk",
            tool: "copy",
            arguments: { from: "sh:///6f88d732#stderr", to: "workspace:///err.txt" },
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
            arguments: { text: "pytest -q" },
        });

        const implicitTrailingGt = singleStatement(PlurnkParser.lowerMcpCall({
            name: "plurnk.sh>",
            arguments: { text: "git status" },
        }));
        assert.deepEqual(PlurnkParser.toMcpCall(implicitTrailingGt), {
            server: "plurnk",
            tool: "sh",
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
            [{ stream: "sh:///ff10d4c2" }, "sh:///ff10d4c2"],
            [{ process: "sh:///9e99765d" }, "sh:///9e99765d"],
        ] as const) {
            const killed = singleStatement(PlurnkParser.lowerMcpCall({
                name: "mcp",
                arguments: { server: "plurnk", tool: "kill", arguments: args },
            }));
            assert.deepEqual(PlurnkParser.toMcpCall(killed), {
                server: "plurnk",
                tool: "kill",
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
            arguments: { path: "log:///1/2/1/send" },
        });

        const findWithOpaqueCallId = singleStatement(PlurnkParser.lowerMcpCall({
            name: "mcp",
            arguments: { server: "plurnk", tool: "find", arguments: { id: "call_123" } },
        }));
        assert.deepEqual(PlurnkParser.toMcpCall(findWithOpaqueCallId), {
            server: "plurnk",
            tool: "find",
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
            arguments: { text: "All unit tests pass." },
        });

        const stdoutInRange = singleStatement(PlurnkParser.lowerMcpCall({
            name: "mcp",
            arguments: { server: "plurnk", tool: "read", arguments: { path: "sh:///ac36348b", range: "#stdout" } },
        }));
        assert.deepEqual(PlurnkParser.toMcpCall(stdoutInRange), {
            server: "plurnk",
            tool: "read",
            arguments: { path: "sh:///ac36348b#stdout" },
        });

        const numericHashRange = singleStatement(PlurnkParser.lowerMcpCall({
            name: "mcp",
            arguments: { server: "plurnk", tool: "read", arguments: { path: "a.py", range: "#10,20" } },
        }));
        assert.deepEqual(PlurnkParser.toMcpCall(numericHashRange), {
            server: "plurnk",
            tool: "read",
            arguments: { path: "a.py", range: "10,20" },
        });
    });
});
