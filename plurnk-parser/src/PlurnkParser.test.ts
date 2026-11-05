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
        assert.equal(isPlurnkOp("READ"), true);
        assert.equal(isPlurnkOp("not_an_op"), false);
    });

    test("{§operation-fences} {§fence-pairing}: canonical Code Mode statements parse and round-trip idempotently through stringify", () => {
        const canonical = [
            'await plurnk.find({"path":"src/**/*.ts","range":"1,20","pattern":"/export/","metadata":["{\\"depth\\":2}"]}); // find exports',
            'await plurnk.read({"path":"README.md","range":"1,50","pattern":"/Plurnk/i","metadata":["{\\"raw\\":true}"]}); // read readme',
            'await plurnk.edit({"path":"src/index.ts","range":"@abcde,@fghij","pattern":"/old/","metadata":["{\\"encoding\\":\\"utf8\\"}"],"content":"export const x = 1;\\n"}); // update export',
            'await plurnk.copy({"from":"a.txt","to":"b.txt"}); // copy file',
            'await plurnk.move({"from":{"path":"src/old.ts","range":"1,10","pattern":"/foo/","metadata":["m1"]},"to":{"path":"src/new.ts","range":"5,15","pattern":"/bar/","metadata":["m2"]}}); // move slice',
            'await plurnk.kill({"path":"log:///1/1/1/READ","range":"1,5","pattern":"/secret/","metadata":["9"],"note":"distilled summary"}); // prune log',
            'await plurnk.note({"text":"Remember the invariant."}); // working note',
            'await plurnk.todo({"text":"- [ ] Step 1\\n- [x] Step 2"}); // update todo',
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

    test("{§op-shapes}: READ and FIND support string shorthands, array targets, and options objects", () => {
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

    test("{§op-shapes}: EDIT supports whole-file content, range replacement, oldText/newText, and multi-hunk edits array", () => {
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

    test("{§op-shapes}: COPY, MOVE, and KILL support positional and object forms", () => {
        const ops = statementsOf([
            'await plurnk.copy("src/a.ts", "src/b.ts");',
            'await plurnk.move({ from: "src/b.ts", to: "src/c.ts", range: "1,5", toRange: "10,15" });',
            'await plurnk.kill("log:///1/1/1/READ", "Distilled note.");',
            'await plurnk.kill(["log:///1/1/2/READ", "log:///1/1/3/READ"]);',
            'await plurnk.kill({ paths: ["log:///1/1/4/READ", { path: "log:///1/1/5/READ" }], note: "Once." });',
        ].join("\n"));
        assert.equal(ops.length, 7);
        assert.equal((ops[0] as CopyStatement).source.target.raw, "src/a.ts");
        assert.deepEqual((ops[1] as MoveStatement).source.lineMarker, { marks: [1, 5] });
        assert.deepEqual((ops[1] as MoveStatement).destination.lineMarker, { marks: [10, 15] });
        assert.equal((ops[2] as KillStatement).body, "Distilled note.");
        assert.equal((ops[5] as KillStatement).body, "Once.");
        assert.equal((ops[6] as KillStatement).body, null);
    });

    test("{§op-shapes}: NOTE, TODO, WORK, FORK, BARE, SEND, DONE, FAIL, and WAIT support all argument shapes", () => {
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
        assert.equal((ops[3] as TodoStatement).body, "- [ ] First task\n- [x] Second task\n- [~] Third task");
        assert.equal((ops[4] as TodoStatement).body, "- [ ] Item A");
        assert.equal((ops[5] as TodoStatement).body, "- [ ] Item B");
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

    test("{§slot-order}: comma, pipe, and URI lists in READ, FIND, and KILL expand in member order", () => {
        const ops = statementsOf([
            'await plurnk.read({ path: "workspace:///a workspace:///b" });',
            'await plurnk.find({ path: "src/a.py, src/b.py", pattern: "/needle/" });',
            'await plurnk.kill({ path: "log:///1/1/1/READ, log:///1/1/2/READ", note: "Both read." });',
        ].join("\n"));
        assert.deepEqual(ops.map((op) => ("target" in op ? op.target?.raw : null)), [
            "workspace:///a",
            "workspace:///b",
            "src/a.py",
            "src/b.py",
            "log:///1/1/1/READ",
            "log:///1/1/2/READ",
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
        assert.deepEqual(statements, ["READ", "gitea"]);
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
        assert.equal(errors[0]?.attempt?.verb, "READ");
        assert.equal(errors[1]?.attempt?.verb, "unknownOp");
    });
});
