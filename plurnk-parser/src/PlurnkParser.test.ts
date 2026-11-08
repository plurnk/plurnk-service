import test, { describe } from "node:test";
import assert from "node:assert/strict";
import PlurnkParser from "./PlurnkParser.ts";
import { propAccess, isPlurnkOp } from "./CodeMode.ts";
import {
    writtenOp,
    type CopyStatement,
    type DispositionStatement,
    type DoneStatement,
    type EditStatement,
    type ExecStatement,
    type FailStatement,
    type FindStatement,
    type ForkStatement,
    type KillStatement,
    type MoveStatement,
    type NoteStatement,
    type PlurnkStatement,
    type ReadStatement,
    type SendStatement,
    type TodoStatement,
    type WorkStatement,
} from "@plurnk/plurnk-contracts";

const statementsOf = (source: string, executors?: readonly string[]): PlurnkStatement[] => {
    const parsed = PlurnkParser.parse(source, executors === undefined ? {} : { executors });
    const hardErrors = parsed.items.filter((item) => item.kind === "error" && item.error.severity === "error");
    assert.deepEqual(hardErrors, [], source);
    return parsed.items.flatMap((item) => item.kind === "statement" ? [item.statement] : []);
};

describe("PlurnkParser Code Mode", () => {
    test("{§parser-build} {§operation-fences}: propAccess and isPlurnkOp classify identifiers and non-identifiers", () => {
        assert.equal(propAccess("read"), ".read");
        assert.equal(propAccess("issue_read"), ".issue_read");
        assert.equal(propAccess("a|b"), '["a|b"]');
        assert.equal(propAccess("my-tool"), '["my-tool"]');
        assert.equal(isPlurnkOp("read"), true);
        assert.equal(isPlurnkOp("not_an_op"), false);
    });

    test("{§operation-fences} {§fence-pairing}: canonical Code Mode statements parse and round-trip idempotently through stringify", () => {
        const canonical = [
            'await plurnk.find({"path":"src/**/*.ts","range":"1,20","pattern":"/export/","headers":{"Accept":"text/plain"}}); // find exports',
            'await plurnk.read({"path":"README.md","range":"1,50","pattern":"/Plurnk/i","headers":{"Accept":"text/markdown"}}); // read readme',
            'await plurnk.edit({"path":"src/index.ts","range":"@abcde,@fghij","pattern":"/old/","headers":{"Content-Type":"text/plain"},"text":<<<EOF\nexport const x = 1;\n\nEOF}); // update export',
            'await plurnk.copy({"from":"a.txt","to":"b.txt"}); // copy file',
            'await plurnk.move({"from":{"path":"src/old.ts","range":"1,10","pattern":"/foo/","headers":{"Accept":"text/plain"}},"to":{"path":"src/new.ts","range":"5,15","pattern":"/bar/","headers":{"Content-Type":"text/plain"}}}); // move slice',
            'await plurnk.kill({"path":"log:///1/1/1/read","range":"1,5","pattern":"/secret/","remote":true,"headers":{"Authorization":"Bearer x"},"note":"distilled summary"}); // prune log',
            'await plurnk.note({"text":"Remember the invariant."}); // working note',
            'await plurnk.todo({"items":["Step 1","Step 2"]}); // update todo',
            'await plurnk.work({"target":"session://worker_1","text":"Audit the module."}); // delegate work',
            'await plurnk.fork({"target":"session://branch_a","text":"Try alternative."});',
            'await plurnk.bare({"text":"Summarize concisely."});',
            'await plurnk.send({"target":"session://peer","headers":{"X-Trace":"1"},"attachments":["report.pdf"],"text":"Status update."}); // notify peer',
            'await plurnk.done({"target":"message://main/12345678","attachments":["a.png"],"text":"Completed all tasks."}); // finish',
            'await plurnk.fail({"text":"Blocked by upstream outage."});',
            'await plurnk.wait({"seconds":30}); // wait on build',
            'await plurnk.sh({"cwd":"packages/core","range":"1,2","text":"npm test"}); // run tests',
            'await plurnk.js({"text":"return 2 + 2;"});',
            'await plurnk.python3({"text":"print(42)"});',
            'await plurnk.env({"action":"list"}); // list env',
            'await gitea.issue_read({"owner":"plurnk","repo":"plurnk-service","index":1}); // read issue',
        ].join("\n\n");

        const parsed = statementsOf(canonical, ["sh", "js", "python3", "plurnk", "gitea"]);
        assert.equal(parsed.length, 20);
        const rendered = PlurnkParser.stringify(parsed);
        assert.equal(rendered, canonical);
        const reparsed = statementsOf(rendered, ["sh", "js", "python3", "plurnk", "gitea"]);
        assert.equal(PlurnkParser.stringify(reparsed), canonical);
    });

    test("{§op-shapes}: read and find support string shorthands, array targets, and options objects", () => {
        const ops = statementsOf([
            'await plurnk.find();',
            'await plurnk.find("src/**/*.ts", { range: [1, 10], pattern: /test/i, headers: { Accept: "text/plain" }, aside: "with regex" });',
            'await plurnk.read("a.ts", { range: { start: 1, end: 5 } });',
            'await plurnk.read(["x.ts", "y.ts"]);',
            'await plurnk.read({ paths: ["m.ts", { path: "n.ts", range: 12 }] });',
        ].join("\n"));
        assert.equal(ops.length, 7);
        assert.equal((ops[0] as FindStatement).target, null);
        assert.equal((ops[1] as FindStatement).matcher?.raw, "/test/i");
        assert.deepEqual((ops[1] as FindStatement).lineMarker, { marks: [1, 10] });
        assert.equal((ops[1] as FindStatement).aside, "with regex");
        assert.deepEqual((ops[2] as ReadStatement).lineMarker, { marks: [1, 5] });
        assert.equal((ops[3] as ReadStatement).target?.raw, "x.ts");
        assert.equal((ops[4] as ReadStatement).target?.raw, "y.ts");
        assert.equal((ops[5] as ReadStatement).target?.raw, "m.ts");
        assert.deepEqual((ops[6] as ReadStatement).lineMarker, { marks: [12] });
    });

    test("{§op-shapes}: edit supports whole-file content, range replacement, oldText/newText, and multi-hunk edits array", () => {
        const ops = statementsOf([
            'await plurnk.edit("src/a.ts", "const a = 1;");',
            'await plurnk.edit({ path: "src/b.ts", oldText: "const old = 1;", newText: "const next = 2;" });',
            'await plurnk.edit({ path: "src/c.ts", oldText: "line1\\nline2", newText: "replaced" });',
            'await plurnk.edit({ path: "src/d.ts", edits: [{ range: "@abcde,@fghij", newText: "hunk1" }, { oldText: "foo", newText: "" }] });',
        ].join("\n"));
        assert.equal(ops.length, 5);
        assert.equal((ops[0] as EditStatement).body, "const a = 1;");
        assert.equal((ops[1] as EditStatement).matcher?.dialect, "glob");
        assert.equal((ops[1] as EditStatement).matcher?.raw, "const old = 1;");
        assert.equal((ops[1] as EditStatement).body, "const next = 2;");
        assert.equal((ops[2] as EditStatement).matcher?.dialect, "regex");
        assert.equal((ops[3] as EditStatement).body, "hunk1");
        assert.equal((ops[4] as EditStatement).body, null);
    });

    test("{§op-shapes}: copy, move, and kill support positional and object forms", () => {
        const ops = statementsOf([
            'await plurnk.copy("src/a.ts", "src/b.ts");',
            'await plurnk.move({ from: "src/b.ts", to: "src/c.ts", range: "1,5", toRange: "10,15" });',
            'await plurnk.kill("log:///1/1/1/read", "Distilled note.");',
            'await plurnk.kill(["log:///1/1/2/read", "log:///1/1/3/read"]);',
            'await plurnk.kill({ paths: ["log:///1/1/4/read", { path: "log:///1/1/5/read" }], note: "Once." });',
        ].join("\n"));
        assert.equal(ops.length, 7);
        assert.equal((ops[0] as CopyStatement).source.target.raw, "src/a.ts");
        assert.deepEqual((ops[1] as MoveStatement).source.lineMarker, { marks: [1, 5] });
        assert.deepEqual((ops[1] as MoveStatement).destination.lineMarker, { marks: [10, 15] });
        assert.equal((ops[2] as KillStatement).body, "Distilled note.");
        assert.equal((ops[5] as KillStatement).body, "Once.");
        assert.equal((ops[6] as KillStatement).body, null);
    });

    test("{§op-shapes}: note, todo, work, fork, bare, send, done, fail, and wait support all argument shapes", () => {
        const ops = statementsOf([
            'await plurnk.note();',
            'await plurnk.note("Quick note.");',
            'await plurnk.todo();',
            'await plurnk.todo(["First task", { text: "Second task", status: "done" }, { text: "Third task", status: "in_progress" }]);',
            'await plurnk.todo({ items: ["Item A"] });',
            'await plurnk.todo({ todos: ["Item B"] });',
            'await plurnk.work("session://helper", "Run checks.");',
            'await plurnk.work("Run checks in new session.");',
            'await plurnk.fork({ session: "branch_1", prompt: "Review diff." });',
            'await plurnk.bare();',
            'await plurnk.send();',
            'await plurnk.send("Hello user.");',
            'await plurnk.send("session://helper", "Ping.");',
            'await plurnk.send("sh:///12345678", { text: "input\\n", attachments: ["report.pdf"] });',
            'await plurnk.send({ session: "helper", json: { ok: true } });',
            'await plurnk.done({});',
            'await plurnk.done("All done.");',
            'await plurnk.done("message://main/1", "Reply.");',
            'await plurnk.fail({ json: { error: "failed" }, attachments: ["err.log"] });',
            'await plurnk.wait();',
            'await plurnk.wait(15, "Waiting 15s.");',
            'await plurnk.wait("Waiting for child.");',
            'await plurnk.wait({ session: "helper", seconds: 10, text: "Polling." });',
        ].join("\n"));
        assert.equal(ops.length, 23);
        assert.equal((ops[0] as NoteStatement).body, null);
        assert.equal((ops[1] as NoteStatement).body, "Quick note.");
        assert.equal((ops[2] as TodoStatement).body, null);
        assert.equal((ops[3] as TodoStatement).body, "First task\n- [x] Second task\n- [~] Third task");
        assert.equal((ops[4] as TodoStatement).body, "Item A");
        assert.equal((ops[5] as TodoStatement).body, "Item B");
        assert.equal((ops[6] as WorkStatement).target?.raw, "session://helper");
        assert.equal((ops[7] as WorkStatement).body, "Run checks in new session.");
        assert.equal((ops[8] as ForkStatement).target?.raw, "session://branch_1");
        assert.deepEqual((ops[13] as SendStatement).attachments, ["report.pdf"]);
        assert.equal((ops[14] as SendStatement).body?.raw, '{"ok":true}');
        assert.equal((ops[17] as DoneStatement).target?.raw, "message://main/1");
        assert.equal((ops[18] as FailStatement).body?.raw, '{"error":"failed"}');
        assert.deepEqual((ops[18] as FailStatement).attachments, ["err.log"]);
        assert.equal((ops[20] as DispositionStatement).seconds, 15);
        assert.equal((ops[20] as DispositionStatement).aside, "Waiting 15s.");
        assert.equal((ops[21] as DispositionStatement).aside, "Waiting for child.");
        assert.equal((ops[22] as DispositionStatement).target, null);
        assert.equal((ops[22] as DispositionStatement).aside, "Polling.");
        assert.equal(PlurnkParser.stringify([ops[22]]), 'await plurnk.wait({"seconds":10}); // Polling.');
    });

    test("{§op-shapes}: standalone executors, plurnk Functionality tools, and MCP tools compile to ExecStatement", () => {
        const ops = statementsOf([
            'await plurnk.sh("ls -la");',
            'await plurnk.sh("./script.sh", "--flag", { range: "1,5" });',
            'await plurnk.sh({ script: "./run.sh", cwd: "packages/core", args: ["a", "b c"] });',
            'await plurnk.sh();',
            'await plurnk.plurnk("env", { alias: "FOO", value: "bar" });',
            'await plurnk["env|mcp"]();',
            'await plurnk.custom_exec({ key: "val" });',
            'await gitea("raw_body");',
            'await gitea.issue_read({ owner: "plurnk", repo: "service" }, { range: "1,10" });',
            'await plurnk.members({ files: ["src/a.ts"] });',
            'await plurnk.question({ question: "Which?", choices: ["a", "b"], multiSelect: true });',
        ].join("\n"), ["sh", "plurnk", "custom_exec", "gitea"]);
        assert.equal(ops.length, 11);
        assert.equal((ops[0] as ExecStatement).runtime, "sh");
        assert.equal((ops[0] as ExecStatement).body, "ls -la");
        assert.equal((ops[1] as ExecStatement).target?.raw, "./script.sh");
        assert.equal((ops[1] as ExecStatement).body, "--flag");
        assert.equal((ops[2] as ExecStatement).target?.raw, "./run.sh");
        assert.equal((ops[2] as ExecStatement).cwd, "packages/core");
        assert.equal((ops[2] as ExecStatement).body, 'a "b c"');
        assert.equal((ops[3] as ExecStatement).body, null);
        assert.equal((ops[4] as ExecStatement).runtime, "plurnk");
        assert.equal((ops[4] as ExecStatement).target?.raw, "env");
        assert.equal((ops[4] as ExecStatement).body, '{"name":"FOO","value":"bar"}');
        assert.equal((ops[5] as ExecStatement).target?.raw, "env|mcp");
        assert.equal((ops[6] as ExecStatement).runtime, "custom_exec");
        assert.equal((ops[6] as ExecStatement).body, '{"key":"val"}');
        assert.equal((ops[8] as ExecStatement).runtime, "gitea");
        assert.equal((ops[8] as ExecStatement).target?.raw, "issue_read");
        assert.equal(PlurnkParser.stringify([ops[8]]), 'await gitea.issue_read({"owner":"plurnk","repo":"service"}, {"range":"1,10"});');
        assert.equal(PlurnkParser.stringify([ops[9]]), 'await plurnk.members({"path":["src/a.ts"]});');
        assert.equal(PlurnkParser.stringify([ops[10]]), 'await plurnk.question({"text":"Which?","options":["a","b"],"multi":true});');
    });

    test("{§slot-order}: comma, pipe, and URI lists in read, find, and kill expand in member order", () => {
        const ops = statementsOf([
            'await plurnk.read({ path: "workspace:///a workspace:///b" });',
            'await plurnk.find({ path: "src/a.py, src/b.py", pattern: "/needle/" });',
            'await plurnk.kill({ path: "log:///1/1/1/read, log:///1/1/2/read", note: "Both read." });',
        ].join("\n"));
        assert.deepEqual(ops.map((op) => ("target" in op ? op.target?.raw : null)), [
            "workspace:///a",
            "workspace:///b",
            "src/a.py",
            "src/b.py",
            "log:///1/1/1/read",
            "log:///1/1/2/read",
        ]);
        assert.equal((ops[4] as KillStatement).body, "Both read.");
        assert.equal((ops[5] as KillStatement).body, null);
    });

    test("{§whitespace-contract}: model tier separates outside text from Code Mode statements and flags empty turns", () => {
        const turn = [
            "Let me inspect the configuration first.",
            "",
            'await plurnk.read({ path: "package.json" });',
            "",
            "Then I will check the build.",
        ].join("\n");
        const parsed = PlurnkParser.parse(turn);
        assert.deepEqual(parsed.items.map((item) => item.kind), ["text", "statement", "text"]);
        const stmtOnly = PlurnkParser.parseStatements(turn);
        assert.deepEqual(stmtOnly.items.map((item) => item.kind), ["statement"]);

        const proseOnly = PlurnkParser.parse("Just thinking out loud.\n\n```rust\nfn main() {}\n```");
        assert.equal(proseOnly.items.filter((item) => item.kind === "text").length, 1);
        assert.ok(proseOnly.items.some((item) => item.kind === "error" && item.error.message === PlurnkParser.NO_VALID_OPERATION));
    });

    test("{§fence-pairing} {§parse-recovery}: Markdown-fenced Code Mode unwraps with a warning advisory; uppercase method/runtime names recover with advisories", () => {
        const fenced = [
            "```ts",
            'await plurnk.READ({ path: "README.md", range: "10,5" });',
            'await Gitea.issue_read({ "owner"?: string });',
            "```",
        ].join("\n");
        const parsed = PlurnkParser.parse(fenced, { executors: ["gitea"] });
        const statements = parsed.items.flatMap((item) => item.kind === "statement" ? [writtenOp(item.statement)] : []);
        assert.deepEqual(statements, ["read", "gitea"]);
        const warnings = parsed.items.flatMap((item) => item.kind === "error" && item.error.severity === "warning" ? [item.error.message] : []);
        assert.equal(warnings.length, 4);
    });

    test("{§matcher-prefix-claims}: matcher dialects and soft unreadability work in Code Mode", () => {
        const ops = statementsOf([
            'await plurnk.find({ path: "a.xml", pattern: "//book/title" });',
            'await plurnk.find({ path: "a.json", pattern: "$.store.book[*]" });',
            'await plurnk.find({ path: "a.txt", pattern: "~search terms" });',
            'await plurnk.find({ path: "a.ts", pattern: "&>MySymbol" });',
            'await plurnk.find({ path: "a.ts", pattern: "/render\\\\|parse/" });',
            'await plurnk.find({ path: "a.ts", pattern: "/Enum/{5,40}" });',
        ].join("\n"));
        assert.equal((ops[0] as FindStatement).matcher?.dialect, "xpath");
        assert.equal((ops[1] as FindStatement).matcher?.dialect, "jsonpath");
        assert.equal((ops[2] as FindStatement).matcher?.dialect, "fts");
        assert.equal((ops[3] as FindStatement).matcher?.dialect, "graph");
        assert.equal((ops[4] as FindStatement).matcher?.dialect, "regex");
        assert.equal((ops[5] as FindStatement).matcher?.dialect, "unreadable");
    });

    test("{§parse-recovery}: unclosed statements report unparsedTail and invalid calls record ParseAttempt", () => {
        const truncated = PlurnkParser.parse('await plurnk.read({ path: "README.md" });\nawait plurnk.edit({ path: "src/a.ts", content: "unterminated');
        assert.ok(truncated.unparsedTail !== undefined);
        assert.equal(truncated.unparsedTail?.from.line, 2);
        assert.equal(truncated.items.filter((item) => item.kind === "statement").length, 1);

        const refused = PlurnkParser.parse('await plurnk.read();\nawait plurnk.unknownOp();');
        const errors = refused.items.filter((item): item is Extract<typeof item, { kind: "error" }> => item.kind === "error" && item.error.severity === "error");
        assert.equal(errors[0]?.attempt?.verb, "read");
        assert.equal(errors[1]?.attempt?.verb, "unknownOp");
    });

    test("{§fence-pairing}: wrapped and structured tool calls translate silently into canonical Code Mode without advisories", () => {
        const turn = [
            "<tool_call>",
            'await plurnk.read({ path: "mcp:///plurnk/sh.json" });',
            "</tool_call>",
            '<tool_call>{"name": "read", "arguments": {"file_path": "src/a.ts", "range": "1,20"}}</tool_call>',
            "<tool_call><function=EDIT><parameter=path>src/a.ts</parameter><parameter=old_string>old</parameter><parameter=new_string>new</parameter></function></tool_call>",
            '<function_calls><invoke name="mcp__gitea__issue_read"><parameter name="owner">plurnk</parameter><parameter name="number">1414</parameter></invoke></function_calls>',
            '[TOOL_CALLS] [{"name": "plurnk.done", "arguments": {"text": "Finished."}}]',
            '<｜｜DSML｜｜ function_calls>\n<｜｜DSML｜｜ invoke name="plurnk.find">\n<｜｜DSML｜｜ parameter name="path" string="true">astropy/modeling/**</｜｜DSML｜｜ parameter>\n</｜｜DSML｜｜ invoke>\n</｜｜DSML｜｜ function_calls>',
            '<｜｜DSML｜｜ function_calls>\n<｜｜DSML｜｜ invoke name="plurnk.read">\n<｜｜DSML｜｜ parameter name="path" string="false">true">django/db/migrations/serializer.py</｜｜DSML｜｜ parameter>\n<｜｜DSML｜｜ parameter name="range" string="true">1,120</｜｜DSML｜｜ parameter>\n</｜｜DSML｜｜ invoke>\n</｜｜DSML｜｜ function_calls>',
            '<｜｜DSML｜｜ function_calls>\n<｜｜DSML｜｜ invoke name="plurnk.find">\n{"path": "astropy/io/fits/**", "pattern": "/Header|Card|_split/"}\n</｜｜DSML｜｜ parameter>\n</｜｜DSML｜｜ invoke>\n</｜｜DSML｜｜ function_calls>',
            '<｜｜DSML｜｜ function_calls>\n<｜｜DSML｜｜ invoke name="plurnk.find({"path":"pylint/**","pattern":"/notes/","headers":{"Accept":"text/x-python"}})</｜｜DSML｜｜ parameter>\n</｜｜DSML｜｜ invoke>\n</｜｜DSML｜｜ function_calls>',
            '<plurnk.note text="Task: Preserve mathematical expressions." />\n<plurnk.sh command="grep -n \\"__radd__\\" django/utils/functional.py" />\n<plurnk.find path="sympy/physics/mechanics/**" range="1,-1" />\n</plurnk.find>',
            '<｜tool▁calls▁begin｜><｜tool▁call▁begin｜>function<｜tool▁sep｜>plurnk.find\n```json\n{"path":"src/**"}\n```\n<｜tool▁call▁end｜><｜tool▁calls▁end｜>',
            '<|tool_calls_section_begin|><|tool_call_begin|>functions.read:0<|tool_call_argument_begin|>{"path":"README.md","range":"1,10"}<|tool_call_end|><|tool_calls_section_end|>',
            '<|tool_call|>plurnk.todo\n{"text":"- [ ] Check parser"}',
        ].join("\n\n");
        const parsed = PlurnkParser.parse(turn, { executors: ["gitea"] });
        assert.deepEqual(
            parsed.items.map((item) => item.kind),
            Array.from({ length: 15 }, () => "statement"),
        );
        const rendered = PlurnkParser.stringify(
            parsed.items.flatMap((item) => item.kind === "statement" ? [item.statement] : []),
        );
        assert.equal(rendered, [
            'await plurnk.read({"path":"mcp:///plurnk/sh.json"});',
            'await plurnk.read({"path":"src/a.ts","range":"1,20"});',
            'await plurnk.edit({"path":"src/a.ts","pattern":"old","text":"new"});',
            'await gitea.issue_read({"owner":"plurnk","number":"1414"});',
            'await plurnk.done({"text":"Finished."});',
            'await plurnk.find({"path":"astropy/modeling/**"});',
            'await plurnk.read({"path":"django/db/migrations/serializer.py","range":"1,120"});',
            'await plurnk.find({"path":"astropy/io/fits/**","pattern":"/Header|Card|_split/"});',
            'await plurnk.find({"path":"pylint/**","pattern":"/notes/","headers":{"Accept":"text/x-python"}});',
            'await plurnk.note({"text":"Task: Preserve mathematical expressions."});',
            'await plurnk.sh({"text":"grep -n \\"__radd__\\" django/utils/functional.py"});',
            'await plurnk.find({"path":"sympy/physics/mechanics/**","range":"1,-1"});',
            'await plurnk.find({"path":"src/**"});',
            'await plurnk.read({"path":"README.md","range":"1,10"});',
            'await plurnk.todo({"items":["- [ ] Check parser"]});',
        ].join("\n\n"));

        const foreign = '<tool_call>\n{"name": "read_file", "arguments": {"path": "workspace:///notes.md"}}\n</tool_call>';
        const foreignParsed = PlurnkParser.parse(foreign);
        assert.equal(foreignParsed.items.filter((item) => item.kind === "statement").length, 0);
        assert.equal(
            foreignParsed.items.find((item) => item.kind === "text")?.content,
            foreign,
        );
    });

    test("{§fence-pairing}: service-prefixed wrappers, child-tag descriptors, angle-bracketed hybrids, and multiline string literals with fences parse cleanly", () => {
        const turn = [
            '<plurnk_tool_call>\nawait plurnk.edit({"path":"a.py","range":"10","content":"x = 1"});\n</plurnk_tool_call>',
            '<plurnk-tool-call>\n{"name":"plurnk.sh","arguments":"{\\"command\\":\\"pytest -q\\"}"}\n</plurnk-tool-call>',
            '<plurnk_tool_call>\n<name>plurnk.read</name>\n<arguments>{"path":"requests/sessions.py","range":"100,220"}</arguments>\n</plurnk_tool_call>',
            '<plurnk_call>\n<name>members</name>\n<arguments>{"files":["a.rst"]}</arguments>\n</plurnk_call>',
            '<plurnk_tool>\n<name>js</name>\n<params>\n<code>return 42;</code>\n</params>\n</plurnk_tool>',
            '<plurnk_invoke>\n<plurnk_tool>read</plurnk_tool>\n<plurnk_args>{"path":"sympy/core/numbers.py","range":"1,10"}</plurnk_args>\n</plurnk_invoke>',
            '<plurnk_invoke>\n{"name":"plurnk.sh","input":{"command":"git status"}}\n</plurnk_invoke>',
            '<plurnk_tool_use>\n{"command":"plurnk.sh","input":{"command":"git diff"}}\n</plurnk_tool_use>',
            '<plurnk.invoke name="plurnk.read">\n<parameter name="path">django/urls/resolvers.py</parameter>\n<parameter name="range">220,340</parameter>\n</plurnk.invoke>',
            '<plurnk:invoke name="sh">\n<parameter name="command">python tests/runtests.py migrations</plurnk:invoke>',
            '<plurnk:call name="plurnk.edit">\n{"path":"django/views/debug.py","range":"1,2","content":"pass"}\n</plurnk:call>',
            '<plurnk_call name="plurnk.edit">\n{"path":"lib/figure.py","range":"5","content":"pass"}\n</plurnk_call>',
            '<plurnk:tool name="js">\n<plurnk:code>console.log(1);</plurnk:code>\n</plurnk:tool>',
            '<plurnk_tool name="note" text="All 13 kernel PCA tests pass." />',
            '<gitea_invoke name="issue_read">\n<parameter name="owner">plurnk</parameter>\n<parameter name="number">1415</parameter>\n</gitea_invoke>',
            '<gitea_tool_call>{"name":"issue_read","arguments":{"owner":"plurnk","number":1415}}</gitea_tool_call>',
            '<gitea_call><name>issue_read</name><arguments>{"owner":"plurnk","number":1415}</arguments></gitea_call>',
            '<gitea_issue_read owner="plurnk" number="1415" />',
            '<gitea:issue_read owner="plurnk" number="1415" />',
            '<plurnk:read path="requests/sessions.py" range="171,185" xmlns:plurnk="plurnk"/>',
            '<plurnk_edit>\n<path>src/rewrite.py</path>\n<range>541,549</range>\n<content>if True:\n    return</content>\n</plurnk_edit>',
            '<result>\n<name>plurnk.sh</name>\n<parameters>\n<command>git diff</command>\n</parameters>\n</result>',
            '<result name=“todo”>\n<parameter name=“items”>["Step A","Step B"]</parameter>\n</result>',
            '<DSML｜｜invoke name="plurnk.edit">\n<DSML｜｜parameter name="path">storage.py</DSML｜｜parameter>\n<DSML｜｜parameter name="content">ok</DSML｜｜parameter>\n</DSML｜｜invoke>',
            '<｜｜DSML｜｜ calls>\n<｜｜DSML｜｜ invoke name="bash">\n<｜｜DSML｜｜ parameter name="command" string="true">echo hi</｜｜DSML｜｜ parameter>\n</｜｜DSML｜｜ invoke>\n</｜｜DSML｜｜ calls>',
            '<｜｜DSML｜｜ invoke name="plurnk.note({"text":"Redirect verified."}) />',
            '<tool_call>\n`await plurnk.read({"path":"sphinx/ext/autodoc/__init__.py","range":"700,820"});`\n</tool_call>',
            '<plurnk_emission>await plurnk.edit({"path":"wcs.py","range":"12","content":"xy = 1"});</plurnk_emission>',
            '<system>await plurnk.read({"path":"inspectdb.py","range":"180,196"});</system>',
            '<unfenced_code_edit_path>src/rewrite.py</unfenced_code_edit_path>\n<unfenced_code_edit_pattern>old_line</unfenced_code_edit_pattern>\n<unfenced_code_edit_content>new_line</unfenced_code_edit_content>',
            '<await plurnk.edit({"path":"tests.py","range":"198,200","content":"pass"})/>',
            '<await plurnk.read({"path":"CHANGES","range":"64,76"});></await>',
            '<plurnk:await plurnk.find({"path":"CHANGES","range":"1,120","pattern":"/Features/"});>',
            '<plurnk.read({"path":"autodoc.py","range":"660,720"}/>',
            '<plurnk.note({"text":"MRO check"})>',
            '<plurnk.note({"text":"Second MRO check"}></plurnk.note>',
            'await plurnk.done({"text":"Implemented fix:\\n\\n```python\\ndef __add__(self, other):\\n    return self._wrapped + other\\n```\\n\\nAll tests pass."});'.replaceAll("\\n", "\n"),
            'await plurnk.done({"text":"Used `attrgetter(\\"__radd__\\")` and "must be the same" check:\\n\\n```python\\nx = 1\\n```"});'.replaceAll('\\"', '"').replaceAll("\\n", "\n"),
            '<｜｜DSML｜｜ calls>\n<｜｜DSML｜｜ invoke name="plurnk_done">\n<｜｜DSML｜｜ parameter name="text" string="true">Fixed sign:\n\n```python\nself.alphas_ = 1\n```\nDone.</｜｜DSML｜｜ parameter>\n</｜｜DSML｜｜ invoke>\n</｜｜DSML｜｜ calls>',
        ].join("\n\n");

        const parsed = PlurnkParser.parse(turn, { executors: ["sh", "js", "python3", "plurnk", "gitea"] });
        const errors = parsed.items.filter((item) => item.kind === "error");
        assert.deepEqual(errors, []);
        const statements = parsed.items.flatMap((item) => item.kind === "statement" ? [item.statement] : []);
        assert.equal(statements.length, 39);

        // Echoed <result><name>...</name><output>...</output></result> must not be executed as a tool call.
        const echoedResult = '<result>\n<name>plurnk.edit</name>\n<output>{"change":"lines -1 +2"}</output>\n</result>\n\nawait plurnk.note({"text":"Continuing."});';
        const echoedParsed = PlurnkParser.parse(echoedResult);
        assert.equal(echoedParsed.items.filter((item) => item.kind === "statement").length, 1);
    });

    test("{§parser-build} {§op-shapes}: PlurnkParser.lowerToolCall lowers structured plurnk and MCP calls directly without source re-parsing", () => {
        const readResult = PlurnkParser.lowerToolCall("plurnk", "read", { path: "src/index.ts", range: "1,10" });
        assert.equal(readResult.items.length, 1);
        assert.equal(readResult.items[0]?.kind, "statement");
        assert.equal((readResult.items[0] as { kind: "statement"; statement: ReadStatement }).statement.op, "read");
        assert.equal((readResult.items[0] as { kind: "statement"; statement: ReadStatement }).statement.target?.raw, "src/index.ts");

        const shResult = PlurnkParser.lowerToolCall("plurnk", "sh", { command: "echo hi", cwd: "packages/core" }, { executors: ["sh", "plurnk"] });
        assert.equal(shResult.items.length, 1);
        assert.equal(shResult.items[0]?.kind, "statement");
        const shStmt = (shResult.items[0] as { kind: "statement"; statement: ExecStatement }).statement;
        assert.equal(shStmt.runtime, "sh");
        assert.equal(shStmt.body, "echo hi");
        assert.equal(shStmt.target?.raw, "packages/core");

        const envResult = PlurnkParser.lowerToolCall("plurnk", "env", { action: "list" }, { executors: ["plurnk"] });
        assert.equal(envResult.items.length, 1);
        const envStmt = (envResult.items[0] as { kind: "statement"; statement: ExecStatement }).statement;
        assert.equal(envStmt.runtime, "plurnk");
        assert.equal(envStmt.target?.raw, "env");
        assert.equal(envStmt.body, '{"action":"list"}');

        const mcpResult = PlurnkParser.lowerToolCall("gitea", "issue_read", { owner: "plurnk", index: 1419 }, { executors: ["gitea"] });
        assert.equal(mcpResult.items.length, 1);
        const mcpStmt = (mcpResult.items[0] as { kind: "statement"; statement: ExecStatement }).statement;
        assert.equal(mcpStmt.runtime, "gitea");
        assert.equal(mcpStmt.target?.raw, "issue_read");

        const errResult = PlurnkParser.lowerToolCall("plurnk", "read", {});
        assert.equal(errResult.items.length, 1);
        assert.equal(errResult.items[0]?.kind, "error");

        const unknownOptResult = PlurnkParser.parseStatements('await plurnk.read({ path: "src/index.ts", bogus: true });');
        assert.equal(unknownOptResult.items.length, 1);
        assert.equal(unknownOptResult.items[0]?.kind, "error");
        if (unknownOptResult.items[0]?.kind === "error") {
            assert.match(unknownOptResult.items[0].error.message, /Unknown option `bogus` on `plurnk\.read`\./u);
        }
    });

    test("{§fence-pairing} {§op-shapes}: heredocs (<<<EOF) and JS template literals parse raw content losslessly and normalize multiline strings to <<<EOF", () => {
        // 1. Inline heredoc (Option 1) with EOF}); and EOF\n});
        const inline1 = statementsOf([
            "await plurnk.note({\"text\":<<<EOF",
            "line 1",
            "line 2",
            "EOF}); // aside 1",
            "await plurnk.edit({\"path\":\"a.py\",\"text\":<<<EOF",
            "def f():",
            "    return 1",
            "EOF",
            "});",
        ].join("\n"));
        assert.equal(inline1.length, 2);
        assert.equal((inline1[0] as NoteStatement).body, "line 1\nline 2");
        assert.equal((inline1[0] as NoteStatement).aside, "aside 1");
        assert.equal((inline1[1] as EditStatement).body, "def f():\n    return 1");
        assert.equal(
            PlurnkParser.stringify(inline1),
            [
                'await plurnk.note({"text":<<<EOF\nline 1\nline 2\nEOF}); // aside 1',
                'await plurnk.edit({"path":"a.py","text":<<<EOF\ndef f():\n    return 1\nEOF});',
            ].join("\n\n"),
        );

        // 2. Statement-trailing heredoc (Option 2) normalized to Option 1
        const trailing = statementsOf([
            'await plurnk.note({"text": <<<EOF}); // trailing aside',
            "alpha",
            "beta",
            "EOF",
        ].join("\n"));
        assert.equal(trailing.length, 1);
        assert.equal((trailing[0] as NoteStatement).body, "alpha\nbeta");
        assert.equal((trailing[0] as NoteStatement).aside, "trailing aside");
        assert.equal(
            PlurnkParser.stringify(trailing),
            'await plurnk.note({"text":<<<EOF\nalpha\nbeta\nEOF}); // trailing aside',
        );

        // 3. Quoted tags (<<<'EOF', <<<"EOF") and custom tags (<<<END_SCRIPT, <<<PY-1)
        const customTags = statementsOf([
            "await plurnk.sh({\"text\":<<<'END_SCRIPT'",
            "echo \"hello $USER\" && printf '%s\\n' 'a'",
            "END_SCRIPT});",
            "await plurnk.python3({\"text\":<<<\"PY-1\"",
            "x = 1",
            "y = 2",
            "PY-1});",
        ].join("\n"), ["sh", "python3"]);
        assert.equal(customTags.length, 2);
        assert.equal((customTags[0] as ExecStatement).body, "echo \"hello $USER\" && printf '%s\\n' 'a'");
        assert.equal((customTags[1] as ExecStatement).body, "x = 1\ny = 2");
        assert.equal(
            PlurnkParser.stringify(customTags),
            [
                'await plurnk.sh({"text":"echo \\"hello $USER\\" && printf \'%s\\\\n\' \'a\'"});',
                'await plurnk.python3({"text":<<<EOF\nx = 1\ny = 2\nEOF});',
            ].join("\n\n"),
        );

        // 4. Delimiter collision stepping: EOF in body -> <<<EOF1; EOF and EOF1 in body -> <<<EOF2
        const withEof = statementsOf('await plurnk.sh({"text":"cat <<EOF\\nhi\\nEOF"});', ["sh"]);
        assert.equal(
            PlurnkParser.stringify(withEof),
            'await plurnk.sh({"text":<<<EOF1\ncat <<EOF\nhi\nEOF\nEOF1});',
        );
        const withEof1 = statementsOf('await plurnk.sh({"text":"EOF\\nEOF1"});', ["sh"]);
        assert.equal(
            PlurnkParser.stringify(withEof1),
            'await plurnk.sh({"text":<<<EOF2\nEOF\nEOF1\nEOF2});',
        );
        assert.equal(
            (statementsOf(PlurnkParser.stringify(withEof1), ["sh"])[0] as ExecStatement).body,
            "EOF\nEOF1",
        );

        // 5. Lossless newline bijection: "a\nb", "a\nb\n", "\n", ""
        for (const sample of ["a\nb", "a\nb\n", "\n"]) {
            const stmt: NoteStatement = { op: "note", aside: null, target: null, lineMarker: null, body: sample, position: { line: 1, column: 0 } };
            const rendered = PlurnkParser.stringify([stmt]);
            assert.match(rendered, /<<<EOF\n/u);
            const reparsed = statementsOf(rendered);
            assert.equal((reparsed[0] as NoteStatement).body, sample);
        }
        const emptyHeredoc = statementsOf("await plurnk.note({\"text\":<<<EOF\nEOF});");
        assert.equal((emptyHeredoc[0] as NoteStatement).body, null);

        // 6. Raw markdown fences, XML tool tags, unbalanced quotes/parens, and ${...} inside heredoc
        const complexBody = [
            "Here is a fenced block and XML wrapper:",
            "```ts",
            'const s = `hello ${name}`;',
            'await plurnk.read({ path: "not_executed.ts" });',
            "```",
            '<tool_call>{"name":"plurnk.done","arguments":{"text":"ignored"}}</tool_call>',
            'Unbalanced quotes " and \' and parens ((( in regex /^\\d+$/',
        ].join("\n");
        const complexSource = `await plurnk.done({"text":<<<EOF\n${complexBody}\nEOF});`;
        const complexParsed = PlurnkParser.parse(complexSource);
        assert.deepEqual(complexParsed.items.map((item) => item.kind), ["statement"]);
        assert.equal(((complexParsed.items[0] as { kind: "statement"; statement: DoneStatement }).statement).body?.raw, complexBody);

        // 7. JS template literals with newlines and raw ${...} normalize to <<<EOF
        const templateParsed = statementsOf([
            "await plurnk.js({\"text\":`const x = ${1 + 1};",
            "console.log(x);`});",
        ].join("\n"), ["js"]);
        assert.equal((templateParsed[0] as ExecStatement).body, "const x = ${1 + 1};\nconsole.log(x);");
        assert.equal(
            PlurnkParser.stringify(templateParsed),
            "await plurnk.js({\"text\":<<<EOF\nconst x = ${1 + 1};\nconsole.log(x);\nEOF});",
        );

        // 8. Turn 0 todo ("Resolve all Open Work.") stringifies with <<<EOF
        const turn0Todo = statementsOf('await plurnk.todo({"items":["Resolve all Open Work."]});');
        assert.equal(
            PlurnkParser.stringify(turn0Todo),
            "await plurnk.todo({\"items\":[<<<EOF\nResolve all Open Work.\nEOF]});",
        );
        const turn0Reparsed = statementsOf(PlurnkParser.stringify(turn0Todo));
        assert.equal((turn0Reparsed[0] as TodoStatement).body, "Resolve all Open Work.");
    });

    test("{§op-shapes}: text unification and caller target alias normalization across operations", () => {
        const ops = statementsOf([
            'await plurnk.edit({ path: "a.ts", pattern: "old", replacement: "new" });',
            'await plurnk.work({ target: "session://w", text: "do work" });',
            'await plurnk.fork({ target: "session://f", text: "do fork" });',
            'await plurnk.bare({ text: "do bare" });',
            'await plurnk.sh({ text: "echo ok" });',
            'await plurnk.js({ text: "return 1;" });',
            'await plurnk.python3({ text: "print(1)" });',
            'await plurnk.send({ to: "user", text: "Hi user" });',
            'await plurnk.send({ target: "client", text: "Hi client" });',
            'await plurnk.send({ recipient: "session://human", text: "Hi human" });',
            'await plurnk.send("operator", "Positional hi");',
            'await plurnk.done({ target: "caller", text: "Done caller" });',
            'await plurnk.done("user", "Done positional");',
            'await plurnk.fail({ to: "user", text: "Failed user" });',
        ].join("\n"), ["sh", "js", "python3"]);

        assert.equal(ops.length, 14);
        assert.equal((ops[0] as EditStatement).body, "new");
        assert.equal((ops[1] as WorkStatement).body, "do work");
        assert.equal((ops[2] as ForkStatement).body, "do fork");
        assert.equal((ops[3] as WorkStatement).body, "do bare");
        assert.equal((ops[4] as ExecStatement).body, "echo ok");
        assert.equal((ops[5] as ExecStatement).body, "return 1;");
        assert.equal((ops[6] as ExecStatement).body, "print(1)");
        for (const idx of [7, 8, 9, 10]) {
            assert.equal((ops[idx] as SendStatement).target, null);
        }
        assert.equal((ops[11] as DoneStatement).target, null);
        assert.equal((ops[12] as DoneStatement).target, null);
        assert.equal((ops[13] as FailStatement).target, null);

        const emptyDone = PlurnkParser.parseStatements("await plurnk.done();");
        assert.equal(emptyDone.items.length, 1);
        assert.equal(emptyDone.items[0]?.kind, "error");
        if (emptyDone.items[0]?.kind === "error") {
            assert.equal(emptyDone.items[0].error.message, "done requires a text argument.");
            assert.equal(emptyDone.items[0].error.recovery, 'await plurnk.done({ text: "..." });');
        }
    });

    test("{§fence-pairing} {§parse-recovery}: deterministic toleration recovers shell heredocs, extra braces, angle-bracket hybrids, space-separated wrappers, XML attribute near-misses, and tool call ids", () => {
        const turn = [
            // 1. Shell-style heredocs (<<'EOF', <<"EOF", <<EOF, <<-'EOF', <<-EOF) and extra closing `}` (`EOF}});`)
            [
                "await plurnk.sh({",
                '  text: <<\'EOF\'',
                'python -c "print(1)"',
                "EOF",
                "}});",
            ].join("\n"),
            [
                "await plurnk.edit({",
                '  path: "src/a.py",',
                '  range: "10,12",',
                '  text: <<-"EOF"',
                "def f():",
                "    return True",
                "EOF",
                "});",
            ].join("\n"),
            // 2. Leading `<` / angle-bracket hybrids around Code Mode statements (including multiline heredoc + trailing comment + </await>)
            '<await plurnk.sh({ text: "pytest astropy/nddata/tests/test_nddata.py" });',
            [
                "<await plurnk.edit({",
                '  path: "src/b.py",',
                '  range: "1,3",',
                "  text: <<<EOF",
                "x = 1",
                "EOF",
                "}); // apply fix</await>",
            ].join("\n"),
            '<plurnk.edit({ path: "src/c.py", range: "1,1", text: "y = 2" }) // update y</plurnk.edit>',
            '<plurnk.note({ text: "Orientation note" }/>)}',
            '<await plurnk.read>\n{"path": "src/d.py", "range": "1,20"}\n</await>',
            "<plurnk.wait>",
            // 3. Space-separated `<tool calls>` / `<tool call>` / `<tool calls pending>` wrappers and single-backticked call lines
            '<tool calls>\nawait plurnk.read({ path: "src/e.py" });\n</tool calls>',
            '<tool calls pending>\nawait plurnk.find({ path: "src/**" });\n</tool calls>',
            '`await plurnk.read({ path: "src/f.py", range: "1,10" });`',
            // 4. XML tool-call attribute & tag near-misses (<plurnk.tool call="read" .../>, <tool_edit .../>, unescaped quotes in text="...", flat/nameless JSON tool_call)
            '<plurnk.tool call="read" path="src/g.py" range="5,15" />',
            '<tool_edit path="src/h.py" range="1,2" text="z = 3" />',
            '<plurnk.edit path="src/i.py" range="1,4" text="def g():\n    return "quoted"\n" />',
            '<plurnk_tool_call>{"path": "src/j.py", "range": "2,4", "text": "w = 4"}</plurnk_tool_call>',
            '<tool_call>{"name": "plurnk.note", "text": "Flat JSON tool call"}</tool_call>',
            // 5. Hallucinated `id` / `call_id` / `tool_call_id` in Code Mode options objects
            'await plurnk.read({ id: "call_1", call_id: "c2", tool_call_id: "tc3", path: "src/k.py" });',
        ].join("\n\n");

        const ops = statementsOf(turn, ["sh", "plurnk"]);
        assert.equal(ops.length, 17);
        assert.equal((ops[0] as ExecStatement).runtime, "sh");
        assert.equal((ops[0] as ExecStatement).body, 'python -c "print(1)"');
        assert.equal((ops[1] as EditStatement).target?.raw, "src/a.py");
        assert.equal((ops[1] as EditStatement).body, "def f():\n    return True");
        assert.equal((ops[2] as ExecStatement).body, "pytest astropy/nddata/tests/test_nddata.py");
        assert.equal((ops[3] as EditStatement).target?.raw, "src/b.py");
        assert.equal((ops[3] as EditStatement).body, "x = 1");
        assert.equal((ops[3] as EditStatement).aside, "apply fix");
        assert.equal((ops[4] as EditStatement).target?.raw, "src/c.py");
        assert.equal((ops[4] as EditStatement).aside, "update y");
        assert.equal((ops[5] as NoteStatement).body, "Orientation note");
        assert.equal((ops[6] as ReadStatement).target?.raw, "src/d.py");
        assert.equal((ops[7] as DispositionStatement).op, "wait");
        assert.equal((ops[8] as ReadStatement).target?.raw, "src/e.py");
        assert.equal((ops[9] as FindStatement).target?.raw, "src/**");
        assert.equal((ops[10] as ReadStatement).target?.raw, "src/f.py");
        assert.equal((ops[11] as ReadStatement).target?.raw, "src/g.py");
        assert.equal((ops[12] as EditStatement).target?.raw, "src/h.py");
        assert.equal((ops[12] as EditStatement).body, "z = 3");
        assert.equal((ops[13] as EditStatement).target?.raw, "src/i.py");
        assert.equal((ops[13] as EditStatement).body, 'def g():\n    return "quoted"\n');
        assert.equal((ops[14] as EditStatement).target?.raw, "src/j.py");
        assert.equal((ops[14] as EditStatement).body, "w = 4");
        assert.equal((ops[15] as NoteStatement).body, "Flat JSON tool call");
        assert.equal((ops[16] as ReadStatement).target?.raw, "src/k.py");
    });
});
