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
            'await plurnk.find({"path":"src/**/*.ts","range":"1,20","pattern":"/export/","metadata":["{\\"depth\\":2}"]}); // find exports',
            'await plurnk.read({"path":"README.md","range":"1,50","pattern":"/Plurnk/i","metadata":["{\\"raw\\":true}"]}); // read readme',
            'await plurnk.edit({"path":"src/index.ts","range":"@abcde,@fghij","pattern":"/old/","metadata":["{\\"encoding\\":\\"utf8\\"}"],"content":"export const x = 1;\\n"}); // update export',
            'await plurnk.copy({"from":"a.txt","to":"b.txt"}); // copy file',
            'await plurnk.move({"from":{"path":"src/old.ts","range":"1,10","pattern":"/foo/","metadata":["m1"]},"to":{"path":"src/new.ts","range":"5,15","pattern":"/bar/","metadata":["m2"]}}); // move slice',
            'await plurnk.kill({"path":"log:///1/1/1/read","range":"1,5","pattern":"/secret/","metadata":["9"],"note":"distilled summary"}); // prune log',
            'await plurnk.note({"text":"Remember the invariant."}); // working note',
            'await plurnk.todo({"items":["Step 1","Step 2"]}); // update todo',
            'await plurnk.work({"target":"session://worker_1","metadata":["{\\"model\\":\\"fast\\"}"],"prompt":"Audit the module."}); // delegate work',
            'await plurnk.fork({"target":"session://branch_a","prompt":"Try alternative."});',
            'await plurnk.bare({"prompt":"Summarize concisely."});',
            'await plurnk.send({"target":"session://peer","range":"1,10","metadata":["{\\"eof\\":true}"],"text":"Status update."}); // notify peer',
            'await plurnk.done({"target":"message://main/12345678","metadata":["{\\"attach\\":[\\"a.png\\"]}"],"text":"Completed all tasks."}); // finish',
            'await plurnk.fail({"text":"Blocked by upstream outage."});',
            'await plurnk.wait({"target":"sh:///12345678","seconds":30,"text":"Waiting for build."}); // wait on build',
            'await plurnk.sh({"cwd":"packages/core","range":"1,2","metadata":["{\\"env\\":{\\"CI\\":\\"1\\"}}"],"command":"npm test"}); // run tests',
            'await plurnk.js({"code":"return 2 + 2;"});',
            'await plurnk.python3({"code":"print(42)"});',
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
            'await plurnk.fork({ session: "branch_1", model: "fast", effort: "low", persona: "reviewer", prompt: "Review diff." });',
            'await plurnk.bare();',
            'await plurnk.send();',
            'await plurnk.send("Hello user.");',
            'await plurnk.send("session://helper", "Ping.");',
            'await plurnk.send("sh:///12345678", { text: "input\\n", metadata: "{\\"eof\\":true}" });',
            'await plurnk.send({ session: "helper", json: { ok: true } });',
            'await plurnk.done();',
            'await plurnk.done("All done.");',
            'await plurnk.done("message://main/1", "Reply.");',
            'await plurnk.fail({ json: { error: "failed" } });',
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
        assert.deepEqual((ops[8] as ForkStatement).metadata, ['{"model":"fast","effort":"low","persona":"reviewer"}']);
        assert.equal((ops[14] as SendStatement).body?.raw, '{"ok":true}');
        assert.equal((ops[17] as DoneStatement).target?.raw, "message://main/1");
        assert.equal((ops[18] as FailStatement).body?.raw, '{"error":"failed"}');
        assert.equal((ops[20] as DispositionStatement).seconds, 15);
        assert.equal((ops[22] as DispositionStatement).target?.raw, "session://helper");
    });

    test("{§op-shapes}: standalone executors, plurnk Functionality tools, and MCP tools compile to ExecStatement", () => {
        const ops = statementsOf([
            'await plurnk.sh("ls -la");',
            'await plurnk.sh("./script.sh", "--flag", { env: { FOO: "bar" } });',
            'await plurnk.sh({ script: "./run.sh", args: ["a", "b c"] });',
            'await plurnk.sh();',
            'await plurnk.plurnk("env", { action: "list" });',
            'await plurnk["env|mcp"]();',
            'await plurnk.custom_exec({ key: "val" });',
            'await gitea("raw_body");',
            'await gitea.issue_read({ owner: "plurnk", repo: "service" }, { range: "1,10", metadata: ["m"] });',
        ].join("\n"), ["sh", "plurnk", "custom_exec", "gitea"]);
        assert.equal(ops.length, 9);
        assert.equal((ops[0] as ExecStatement).runtime, "sh");
        assert.equal((ops[0] as ExecStatement).body, "ls -la");
        assert.equal((ops[1] as ExecStatement).target?.raw, "./script.sh");
        assert.equal((ops[1] as ExecStatement).body, "--flag");
        assert.equal((ops[2] as ExecStatement).body, 'a "b c"');
        assert.equal((ops[3] as ExecStatement).body, null);
        assert.equal((ops[4] as ExecStatement).runtime, "plurnk");
        assert.equal((ops[4] as ExecStatement).target?.raw, "env");
        assert.equal((ops[5] as ExecStatement).target?.raw, "env|mcp");
        assert.equal((ops[6] as ExecStatement).runtime, "custom_exec");
        assert.equal((ops[6] as ExecStatement).body, '{"key":"val"}');
        assert.equal((ops[8] as ExecStatement).runtime, "gitea");
        assert.equal((ops[8] as ExecStatement).target?.raw, "issue_read");
        assert.equal(PlurnkParser.stringify([ops[8]]), 'await gitea.issue_read({"owner":"plurnk","repo":"service"}, {"range":"1,10","metadata":["m"]});');
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
            '<｜｜DSML｜｜ function_calls>\n<｜｜DSML｜｜ invoke name="plurnk.find({"path":"pylint/**","pattern":"/notes/","metadata":"text/x-python"})</｜｜DSML｜｜ parameter>\n</｜｜DSML｜｜ invoke>\n</｜｜DSML｜｜ function_calls>',
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
            'await plurnk.edit({"path":"src/a.ts","pattern":"old","content":"new"});',
            'await gitea.issue_read({"owner":"plurnk","number":"1414"});',
            'await plurnk.done({"text":"Finished."});',
            'await plurnk.find({"path":"astropy/modeling/**"});',
            'await plurnk.read({"path":"django/db/migrations/serializer.py","range":"1,120"});',
            'await plurnk.find({"path":"astropy/io/fits/**","pattern":"/Header|Card|_split/"});',
            'await plurnk.find({"path":"pylint/**","pattern":"/notes/","metadata":["text/x-python"]});',
            'await plurnk.note({"text":"Task: Preserve mathematical expressions."});',
            'await plurnk.sh({"command":"grep -n \\"__radd__\\" django/utils/functional.py"});',
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
    });
});
