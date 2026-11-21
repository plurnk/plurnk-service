import test, { describe } from "node:test";
import assert from "node:assert/strict";
import type {
    BareStatement,
    DoneStatement,
    ExecStatement,
    FailStatement,
    FindStatement,
    KillStatement,
    NoteStatement,
    ReadStatement,
    SendStatement,
} from "@plurnk/plurnk-contracts";
import PlurnkParser from "./PlurnkParser.ts";
import { stringifyStatement } from "./ExpressionSerializer.ts";
import { toStringValue } from "./OptionCoercion.ts";
import { createCallDispatcher } from "./StatementLowering.ts";
import { parsePath } from "./TargetSyntax.ts";

describe("StatementLowering and ExpressionSerializer", () => {
    test("{§parser-lowering} {§parser-build} {§op-shapes}: read and find support inline side-notes, URI pattern-as-path promotion, and multi-member kill fan-out", () => {
        const res = PlurnkParser.parseStatements([
            'await plurnk.read("src/a.ts", { note: "side note from positional" });',
            'await plurnk.read({ path: "src/b.ts", note: "side note from object" });',
            'await plurnk.read({ pattern: "log:///1/1/1/read" });',
            'await plurnk.kill({ pattern: "log:///1/1/2/read" });',
            'await plurnk.kill("log:///1/1/3/read,log:///1/1/4/read", { aside: "retire pair" });',
            'await plurnk.find(["src/x.ts", { path: "src/y.ts", limit: 5 }]);',
        ].join("\n"));

        const stmts = res.items.flatMap((i) => i.kind === "statement" ? [i.statement] : []);
        assert.equal(stmts.length, 10);
        assert.equal((stmts[0] as NoteStatement).op, "note");
        assert.equal((stmts[0] as NoteStatement).body, "side note from positional");
        assert.equal((stmts[1] as ReadStatement).target?.raw, "src/a.ts");
        assert.equal((stmts[2] as NoteStatement).body, "side note from object");
        assert.equal((stmts[4] as ReadStatement).target?.raw, "log:///1/1/1/read");
        assert.equal((stmts[4] as ReadStatement).matcher, null);
        assert.equal((stmts[5] as KillStatement).target?.raw, "log:///1/1/2/read");
        assert.equal((stmts[6] as KillStatement).body, null);
        assert.equal((stmts[6] as KillStatement).aside, "retire pair");
        assert.equal((stmts[7] as KillStatement).body, null);
        assert.equal((stmts[7] as KillStatement).aside, "retire pair");
        assert.deepEqual((stmts[9] as FindStatement).lineMarker, { marks: [5] });
    });

    test("{§op-shapes}: note structured fields, wait forms, delegation/send/conclusion shorthands, and plurnk Functionality key normalization", () => {
        const res = PlurnkParser.parseStatements([
            'await plurnk.note({ title: "T", discovery: "Disc", derivation: "Deriv", fact: "F", idea: "I", plan: "P", decision: "D", hypothesis: "H", finding: "G", summary: "S" });',
            "await plurnk.note(42);",
            'await plurnk.bare("session://ignored", "bare prompt");',
            'await plurnk.work(123);',
            'await plurnk.send("user", { json: { a: 1 } });',
            "await plurnk.send(123);",
            'await plurnk.done("session://caller", "finished");',
            'await plurnk.done({ target: "session://any_peer", text: "done text" });',
            "await plurnk.fail();",
            "await plurnk.fail(404);",
            'await plurnk.wait(15, "waiting on build");',
            'await plurnk.wait("waiting indefinitely");',
            'await plurnk.wait({ duration: "20", reason: "timer" });',
            "await plurnk.wait(true);",
            'await plurnk.members({ files: "src/**" });',
            'await plurnk.question({ question: "Proceed?", choices: ["Yes", "No"], is_multi_select: true, requestedSchema: { type: "object" } });',
            'await plurnk.environment({ key: "FOO", environment: { BAR: "1" } });',
            'await plurnk.personas({ alias: "reviewer", instructions: "Be strict." });',
            'await plurnk.schedule({ id: "nightly", message: "Run audit." });',
            'await plurnk.skills({ dir: "./skills" });',
            'await plurnk("custom_tool", { confirm: true });',
            'await plurnk("env", { action: "list" }, { range: "1,5", aside: "env slice" });',
            'await plurnk.plurnk("mcp", { action: "list" });',
        ].join("\n"));

        const errors = res.items.filter((i) => i.kind === "error");
        assert.deepEqual(errors, []);
        const stmts = res.items.flatMap((i) => i.kind === "statement" ? [i.statement] : []);

        assert.equal((stmts[0] as NoteStatement).body, "T\nDisc\nDeriv\nF\nI\nP\nD\nH\nG\nS");
        assert.equal((stmts[1] as NoteStatement).body, "42");
        assert.equal((stmts[2] as BareStatement).target, null);
        assert.equal((stmts[4] as SendStatement).target, null);
        assert.deepEqual((stmts[4] as SendStatement).body, { raw: '{"a":1}', json: { a: 1 } });
        assert.equal((stmts[6] as DoneStatement).target, null);
        assert.equal((stmts[7] as DoneStatement).target, null);
        assert.equal((stmts[8] as FailStatement).body, null);
        assert.equal((stmts[9] as FailStatement).body?.raw, "404");

        const questionExec = stmts[15] as ExecStatement;
        assert.deepEqual(JSON.parse(questionExec.body ?? "{}"), {
            text: "Proceed?",
            options: ["Yes", "No"],
            multi: true,
            schema: { type: "object" },
        });
        const personasExec = stmts[17] as ExecStatement;
        assert.deepEqual(JSON.parse(personasExec.body ?? "{}"), { name: "reviewer", body: "Be strict." });
        const skillsExec = stmts[19] as ExecStatement;
        assert.deepEqual(JSON.parse(skillsExec.body ?? "{}"), { source: "./skills" });
        const envSlice = stmts[21] as ExecStatement;
        assert.deepEqual(envSlice.lineMarker, { marks: [1, 5] });
        assert.equal(envSlice.aside, "env slice");
    });

    test("{§op-shapes}: standalone executors, bare script promotion, cwd+script pairing, args array quoting, custom runtimes, and 3-part MCP chains", () => {
        const opts = { executors: ["sh", "js", "python3", "plurnk", "gitea", "customrt"] };
        const res = PlurnkParser.parseStatements([
            "await plurnk.sh();",
            'await plurnk.sh("packages/a", "npm test", { range: "1,10", aside: "pos exec" });',
            'await plurnk.sh("echo hi");',
            'await plurnk.js({ text: "scripts/check.ts", cwd: "packages/b", args: ["--fix", "two words"] });',
            'await plurnk.sh({ script: "echo a && echo b" });',
            'await plurnk.python3({ script: "run.py", args: "--verbose" });',
            "await plurnk.sh(123);",
            'await plurnk.customrt({ customKey: 1 }, { range: "2,4", aside: "custom json" });',
            'await plurnk.gitea.issue_read({ index: 3 }, { range: "1,2" });',
            'await sh("ls -la");',
        ].join("\n"), opts);

        assert.deepEqual(res.items.filter((i) => i.kind === "error"), []);
        const stmts = res.items.flatMap((i) => i.kind === "statement" ? [i.statement as ExecStatement] : []);
        assert.equal(stmts[0]?.body, null);
        assert.equal(stmts[1]?.target?.raw, "packages/a");
        assert.equal(stmts[1]?.body, "npm test");
        assert.equal(stmts[3]?.target?.raw, "scripts/check.ts");
        assert.equal(stmts[3]?.cwd, "packages/b");
        assert.equal(stmts[3]?.body, '--fix "two words"');
        assert.equal(stmts[4]?.target, null);
        assert.equal(stmts[4]?.body, "echo a && echo b");
        assert.equal(stmts[5]?.target?.raw, "run.py");
        assert.equal(stmts[5]?.body, "--verbose");
        assert.equal(stmts[6]?.body, "123");
        assert.equal(stmts[7]?.runtime, "customrt");
        assert.equal(stmts[7]?.body, '{"customKey":1}');
        assert.equal(stmts[8]?.runtime, "gitea");
        assert.equal(stmts[8]?.target?.raw, "issue_read");
        assert.equal(stmts[9]?.runtime, "sh");

        // Single-executor mode (`executors: ["customrt"]` or `executors: ["plurnk"]`) routes non-core / custom tools cleanly
        const singleExec = PlurnkParser.lowerToolCall("plurnk", "customrt", { text: "custom" }, { executors: ["customrt"] });
        assert.equal((singleExec.items[0] as { kind: "statement"; statement: ExecStatement }).statement.runtime, "customrt");

        const onlyPlurnk = PlurnkParser.lowerToolCall("plurnk", "custom_panel", { a: 1 }, { executors: ["plurnk"] });
        assert.equal((onlyPlurnk.items[0] as { kind: "statement"; statement: ExecStatement }).statement.runtime, "plurnk");

        const multiWithPlurnk = PlurnkParser.parseStatements(
            'await plurnk.dynamic_family({ alias: "a", kind: "ok" });\nawait plurnk.dynamic_family();',
            { executors: ["sh", "js", "python3", "plurnk"] },
        );
        const dynamicStmts = multiWithPlurnk.items.flatMap((i) => i.kind === "statement" ? [i.statement as ExecStatement] : []);
        assert.equal(dynamicStmts.length, 2);
        assert.equal(dynamicStmts[0]?.runtime, "plurnk");
        assert.equal(dynamicStmts[0]?.target?.raw, "dynamic_family");
        assert.equal(dynamicStmts[0]?.body, '{"alias":"a","kind":"ok"}');
        assert.equal(dynamicStmts[1]?.runtime, "plurnk");
        assert.equal(dynamicStmts[1]?.target?.raw, "dynamic_family");
        assert.equal(dynamicStmts[1]?.body, null);
    });

    test("{§parse-recovery} {§op-shapes}: StatementLowering refuses missing targets, invalid argument types, unknown operations, bad MCP runtime names, and wraps unexpected exceptions", () => {
        const refusalCases: Array<readonly [string, RegExp] | readonly [string, RegExp, readonly string[]]> = [
            ["await plurnk.read();", /read requires a target/u],
            ["await plurnk.read([]);", /read requires a target/u],
            ['await plurnk.read("");', /read requires a target/u],
            ["await plurnk.read({ paths: [] });", /read requires a target/u],
            ["await plurnk.read({ path: 123 });", /read path must be a string/u],
            ["await plurnk.read(123);", /Invalid arguments to plurnk\.read/u],
            ['await plurnk.edit("", "x");', /edit requires a target/u],
            ["await plurnk.edit(123);", /edit requires an options object/u],
            ["await plurnk.edit({});", /edit requires a target/u],
            ['await plurnk.edit({ path: "a.ts", edits: [] });', /edit `edits` array cannot be empty/u],
            ['await plurnk.edit({ path: "a.ts", edits: ["bad"] });', /Each entry in `edits` must be an object/u],
            ["await plurnk.copy(123);", /copy requires both from and to targets/u],
            ["await plurnk.kill([]);", /kill requires a target/u],
            ['await plurnk.kill("");', /kill requires a target/u],
            ["await plurnk.kill({ paths: [] });", /kill requires a target/u],
            ['await plurnk.kill({ paths: [""] });', /kill requires a target/u],
            ["await plurnk.kill({});", /kill requires a target/u],
            ["await plurnk.kill(123);", /kill requires a target/u],
            ['await plurnk.kill("log:///1/1/1/read", "bad");', /kill options must be an object/u],
            ['await plurnk.kill({ path: "log:///1/1/1/read", note: "nope" });', /Unknown option `note` on `plurnk\.kill`/u],
            ["await plurnk.plurnk({ path: 'a.ts' });", /Missing tool name on `plurnk`/u],
            ["await plurnk.not_a_real_op();", /Unknown tool `plurnk\.not_a_real_op`/u],
            ["await UnknownSvc.tool({});", /Unknown runtime "UnknownSvc"; runtime names are lowercase/u],
            ["await $bad.tool({});", /Invalid MCP runtime name "\$bad"/u],
            ["await unknown_standalone();", /Unknown tool `unknown_standalone`/u, ["sh"]],
            ["await a.b.c.d({});", /Invalid call target `a\.b\.c\.d`/u],
        ];

        for (const [source, expected, executors] of refusalCases) {
            const parsed = PlurnkParser.parseStatements(source, executors === undefined ? {} : { executors });
            const errItem = parsed.items.find((i) => i.kind === "error");
            assert.ok(errItem !== undefined && errItem.kind === "error", `Expected error for: ${source}`);
            assert.match(errItem.error.message, expected, source);
            assert.ok(
                typeof errItem.error.recovery === "string" && errItem.error.recovery.length > 0,
                `Expected non-empty recovery for: ${source}`,
            );
            assert.ok(errItem.attempt !== undefined && errItem.attempt.text.length > 0, `Expected attempt for: ${source}`);
        }

        // Non-PlurnkParseError thrown inside produceCalls is wrapped cleanly into a PlurnkParseError item
        const dispatcher = createCallDispatcher();
        const wrapped = dispatcher.lowerCalls(
            () => {
                throw new TypeError("boom");
            },
            { line: 4, column: 1 },
            null,
            { verb: "plurnk", text: "broken" },
        );
        assert.equal(wrapped.length, 1);
        assert.equal(wrapped[0]?.kind, "error");
        if (wrapped[0]?.kind === "error") {
            assert.match(wrapped[0].error.message, /Tool call error: boom/u);
            assert.equal(wrapped[0].error.line, 4);
        }
    });

    test("{§parser-build} {§expression-boundaries}: ExpressionSerializer covers regex slash escaping, fragments, execution variants, and JSON bodies", () => {
        assert.equal(toStringValue(10n), "10");
        assert.equal(toStringValue(null), "");
        assert.equal(toStringValue({ a: 1 }), '{"a":1}');

        const readWithFrag: ReadStatement = {
            op: "read",
            aside: "line1\nline2",
            target: parsePath("README.md#install"),
            lineMarker: { marks: [1, 10] },
            matcher: { dialect: "regex", raw: "/a/b[/]c/i", pattern: "a/b[/]c", flags: "i" },
            headers: null,
            body: null,
            position: { line: 1, column: 0 },
        };
        assert.equal(
            stringifyStatement(readWithFrag),
            'plurnk.read({"path":"README.md#install","range":"1,10","pattern":"/a\\\\/b[/]c/i"}) // line1 line2',
        );

        const customBare: ExecStatement = {
            runtime: "customrt",
            aside: null,
            target: null,
            lineMarker: null,
            body: '{"script":"line1\\nline2"}',
            position: { line: 1, column: 0 },
        };
        assert.equal(
            stringifyStatement(customBare),
            'plurnk.customrt({"script":"line1\\nline2"})',
        );

        const customInvalidJson: ExecStatement = {
            ...customBare,
            body: "{not:\\njson}",
            lineMarker: { marks: [1, 5] },
        };
        assert.equal(
            stringifyStatement(customInvalidJson),
            'plurnk.customrt({"range":"1,5","body":"{not:\\\\njson}"})',
        );

        const shCwdScript: ExecStatement = {
            runtime: "sh",
            aside: null,
            target: parsePath("run.sh"),
            cwd: "packages/core",
            lineMarker: null,
            body: "--check",
            position: { line: 1, column: 0 },
        };
        assert.equal(
            stringifyStatement(shCwdScript),
            'plurnk.sh({"script":"run.sh","cwd":"packages/core","text":"--check"})',
        );

        const mcpEmptyWithRange: ExecStatement = {
            runtime: "gitea",
            aside: null,
            target: parsePath("list_my_repos"),
            lineMarker: { marks: [1, 20] },
            body: null,
            position: { line: 1, column: 0 },
        };
        assert.equal(
            stringifyStatement(mcpEmptyWithRange),
            'gitea.list_my_repos(null, {"range":"1,20"})',
        );

        const resolveNote: NoteStatement = {
            op: "note",
            aside: "plan",
            target: null,
            lineMarker: null,
            body: "Resolve all Open Work.",
            position: { line: 1, column: 0 },
        };
        assert.equal(
            stringifyStatement(resolveNote),
            'plurnk.note({"text":"Resolve all Open Work."}) // plan',
        );

        assert.equal(
            stringifyStatement({
                op: "wait",
                aside: null,
                target: null,
                lineMarker: null,
                seconds: null,
                body: "awaiting background job",
                position: { line: 1, column: 0 },
            }),
            "plurnk.wait({}) // awaiting background job",
        );

        const nearMissCalls = [
            PlurnkParser.lowerMcpCall({ name: "mcp", arguments: { server: "plurnk", tool: "work", arguments: { resource: "session://worker", text: "investigate" } } }),
            PlurnkParser.lowerMcpCall({ name: "mcp", arguments: { server: "plurnk", tool: "send", arguments: { resource: "session://worker", text: "ping" } } }),
            PlurnkParser.lowerMcpCall({ name: "mcp", arguments: { server: "plurnk", tool: "wait", arguments: { resource: "session://worker", seconds: 5 } } }),
            PlurnkParser.lowerMcpCall({ name: "mcp", arguments: { server: "plurnk", tool: "done", arguments: { resource: "message://main/00", text: "resolved" }, aside: "resolved" } }),
        ];
        const nmStmts = nearMissCalls.flatMap((r) => r.items.flatMap((i) => i.kind === "statement" ? [i.statement] : []));
        assert.deepEqual(nmStmts.map((s) => s.op), ["work", "send", "wait", "done"]);
        assert.equal(nmStmts[0]?.op === "work" ? nmStmts[0].target?.raw : null, "session://worker");
        assert.equal((nmStmts[1] as SendStatement).target?.raw, "session://worker");
        assert.equal(nmStmts[2]?.op === "wait" ? nmStmts[2].target : undefined, null);
        assert.equal(nmStmts[2]?.op === "wait" ? nmStmts[2].seconds : null, 5);
        assert.equal((nmStmts[3] as DoneStatement).target?.raw, "message://main/00");
        assert.equal((nmStmts[3] as DoneStatement).aside, "resolved");
    });

    test("{§slot-order} {§parse-recovery}: tolerates explicit multi-target message arrays without silent erasure and refuses invalid non-string targets (#1515)", () => {
        for (const [tool, key] of [
            ["send", "to"],
            ["send", "target"],
            ["done", "target"],
            ["done", "targets"],
            ["fail", "to"],
        ] as const) {
            const lowered = PlurnkParser.lowerMcpCall({
                name: "mcp",
                arguments: {
                    server: "plurnk",
                    tool,
                    arguments: {
                        [key]: ["message://review1/02", "message://review1/03", "message://review1/04"],
                        text: "Combined report.",
                    },
                    aside: "reply to three open messages",
                },
            });
            assert.equal(lowered.items.length, 1);
            assert.equal(lowered.items[0]?.kind, "statement");
            if (lowered.items[0]?.kind !== "statement") continue;
            const stmt = lowered.items[0].statement as SendStatement | DoneStatement | FailStatement;
            assert.equal(stmt.op, tool);
            assert.equal(stmt.target?.raw, "message://review1/02,message://review1/03,message://review1/04");
            const roundTripped = PlurnkParser.toMcpCall(stmt);
            assert.deepEqual(roundTripped, {
                server: "plurnk",
                tool,
                arguments: {
                    target: "message://review1/02,message://review1/03,message://review1/04",
                    text: "Combined report.",
                },
                aside: "reply to three open messages",
            });
            const reparsed = PlurnkParser.parseStatements(stringifyStatement(stmt));
            assert.equal(reparsed.items.length, 1);
            assert.equal(reparsed.items[0]?.kind, "statement");
            if (reparsed.items[0]?.kind === "statement") {
                assert.equal(
                    (reparsed.items[0].statement as SendStatement | DoneStatement | FailStatement).target?.raw,
                    "message://review1/02,message://review1/03,message://review1/04",
                );
            }
        }

        const braced = PlurnkParser.lowerMcpCall({
            name: "mcp",
            arguments: {
                server: "plurnk",
                tool: "done",
                arguments: {
                    target: "{message://review1/02,message://review1/03}",
                    text: "Braced.",
                },
            },
        });
        assert.equal(braced.items.length, 1);
        if (braced.items[0]?.kind === "statement") {
            assert.equal(
                (braced.items[0].statement as DoneStatement).target?.raw,
                "message://review1/02,message://review1/03",
            );
        }

        const actorFanout = PlurnkParser.lowerMcpCall({
            name: "mcp",
            arguments: {
                server: "plurnk",
                tool: "send",
                arguments: {
                    target: ["session://w1", "session://w2"],
                    text: "Status check.",
                },
            },
        });
        const actorStmts = actorFanout.items.flatMap((i) => (i.kind === "statement" ? [i.statement as SendStatement] : []));
        assert.deepEqual(
            actorStmts.map((s) => s.target?.raw),
            ["session://w1", "session://w2"],
        );

        for (const [tool, badTarget] of [
            ["send", []],
            ["send", 42],
            ["send", { uri: "message://a/01" }],
            ["done", []],
            ["done", 99],
            ["fail", [""]],
            ["work", ["session://a", "session://b"]],
            ["fork", 123],
        ] as const) {
            const res = PlurnkParser.lowerMcpCall({
                name: "mcp",
                arguments: {
                    server: "plurnk",
                    tool,
                    arguments: { target: badTarget, text: "hi" },
                },
            });
            assert.equal(res.items[0]?.kind, "error", `${tool} must reject invalid target ${JSON.stringify(badTarget)}`);
        }
    });

    test("{§slot-order} {§op-shapes}: lowers and round-trips persona, model, and effort on work/fork while refusing them on bare (#1521)", () => {
        const workCall = PlurnkParser.lowerMcpCall({
            name: "mcp",
            arguments: {
                server: "plurnk",
                tool: "work",
                arguments: {
                    target: "session://auditor",
                    text: "Audit auth.",
                    persona: "reviewer",
                    model: "fast",
                    effort: "high",
                },
            },
        });
        const firstWork = workCall.items[0];
        assert.equal(firstWork?.kind, "statement");
        const workStmt = firstWork.statement;
        assert.equal(workStmt.op, "work");
        if (workStmt.op === "work") {
            assert.equal(workStmt.persona, "reviewer");
            assert.equal(workStmt.model, "fast");
            assert.equal(workStmt.effort, "high");
        }
        assert.equal(
            PlurnkParser.stringify([workStmt]),
            'plurnk.work({"target":"session://auditor","text":"Audit auth.","persona":"reviewer","model":"fast","effort":"high"})',
        );

        const forkScript = PlurnkParser.parseStatements('plurnk.fork("session://branch", "Try alternative.", { persona: "critic", effort: "low" })');
        const firstFork = forkScript.items[0];
        assert.equal(firstFork?.kind, "statement");
        const forkStmt = firstFork.statement;
        assert.equal(forkStmt.op, "fork");
        if (forkStmt.op === "fork") {
            assert.equal(forkStmt.persona, "critic");
            assert.equal(forkStmt.effort, "low");
        }

        const bareRejected = PlurnkParser.lowerMcpCall({
            name: "mcp",
            arguments: {
                server: "plurnk",
                tool: "bare",
                arguments: { text: "Summarize.", persona: "reviewer" },
            },
        });
        assert.equal(bareRejected.items[0]?.kind, "error");
    });

    test("{§parse-recovery} {§parser-lowering}: recovers region and anchor selectors on model-tier edit/read and shows range in edit refusal recovery (#1541)", () => {
        const regionEdit = PlurnkParser.lowerMcpCall({
            name: "mcp",
            arguments: {
                server: "plurnk",
                tool: "edit",
                arguments: {
                    path: "django/forms/formsets.py",
                    region: "<336,1,336,50>",
                    before: "        self._non_form_errors = self.error_class()",
                    after: "        self._non_form_errors = self.error_class(error_class='nonform')",
                },
            },
        });
        assert.equal(regionEdit.items[0]?.kind, "statement");
        if (regionEdit.items[0]?.kind === "statement" && regionEdit.items[0].statement.op === "edit") {
            assert.deepEqual(regionEdit.items[0].statement.lineMarker, { marks: [336, 1, 336, 50] });
            assert.equal(regionEdit.items[0].statement.matcher?.dialect, "glob");
            assert.equal(regionEdit.items[0].statement.body, "        self._non_form_errors = self.error_class(error_class='nonform')");
        }

        const anchorEdit = PlurnkParser.lowerMcpCall({
            name: "mcp",
            arguments: {
                server: "plurnk",
                tool: "edit",
                arguments: {
                    path: "inspectdb.py",
                    anchor: "except Exception:\n    continue",
                    op: "replace",
                    content: "except Exception:\n    pass",
                },
            },
        });
        assert.equal(anchorEdit.items[0]?.kind, "statement");
        if (anchorEdit.items[0]?.kind === "statement" && anchorEdit.items[0].statement.op === "edit") {
            assert.equal(anchorEdit.items[0].statement.lineMarker, null);
            assert.equal(anchorEdit.items[0].statement.matcher?.dialect, "glob");
            assert.equal(anchorEdit.items[0].statement.body, "except Exception:\n    pass");
        }

        const regionRead = PlurnkParser.lowerMcpCall({
            name: "mcp",
            arguments: {
                server: "plurnk",
                tool: "read",
                arguments: { path: "inspectdb.py", region: "10,20" },
            },
        });
        assert.equal(regionRead.items[0]?.kind, "statement");
        if (regionRead.items[0]?.kind === "statement" && regionRead.items[0].statement.op === "read") {
            assert.deepEqual(regionRead.items[0].statement.lineMarker, { marks: [10, 20] });
        }

        const insertAmbiguous = PlurnkParser.lowerMcpCall({
            name: "mcp",
            arguments: {
                server: "plurnk",
                tool: "edit",
                arguments: { path: "inspectdb.py", line: "128", insert: true, text: "x = 1\n" },
            },
        });
        assert.equal(insertAmbiguous.items[0]?.kind, "error");
        if (insertAmbiguous.items[0]?.kind === "error") {
            assert.match(insertAmbiguous.items[0].error.recovery ?? "", /range: "@a1b2c,@d3e4f"/u);
        }
    });
});
