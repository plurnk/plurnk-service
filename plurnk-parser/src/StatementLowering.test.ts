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
import { stringifyStatement } from "./CodeSerializer.ts";
import { pickHeredocTag, toStringValue } from "./HeredocSyntax.ts";
import { createCallDispatcher } from "./StatementLowering.ts";
import { parsePath } from "./TargetSyntax.ts";

describe("StatementLowering and CodeSerializer", () => {
    test("{§parser-build} {§op-shapes}: read, find, and kill support inline side-notes, URI pattern-as-path promotion, and multi-member note deduplication", () => {
        const res = PlurnkParser.parseStatements([
            'await plurnk.read("src/a.ts", { note: "side note from positional" });',
            'await plurnk.read({ path: "src/b.ts", note: "side note from object" });',
            'await plurnk.read({ pattern: "log:///1/1/1/read" });',
            'await plurnk.kill({ pattern: "log:///1/1/2/read" });',
            'await plurnk.kill("log:///1/1/3/read,log:///1/1/4/read", { note: "distill once" });',
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
        assert.equal((stmts[6] as KillStatement).body, "distill once");
        assert.equal((stmts[7] as KillStatement).body, null);
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
            'await plurnk.destroy({ confirm: true });',
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
            ["await plurnk.plurnk({ path: 'a.ts' });", /Missing operation name on `plurnk`/u],
            ["await plurnk.not_a_real_op();", /Unknown operation `plurnk\.not_a_real_op`/u],
            ["await UnknownSvc.tool({});", /Unknown runtime "UnknownSvc"; runtime names are lowercase/u],
            ["await $bad.tool({});", /Invalid MCP runtime name "\$bad"/u],
            ["await unknown_standalone();", /Unknown operation `unknown_standalone`/u, ["sh"]],
            ["await a.b.c.d({});", /Invalid call target `a\.b\.c\.d`/u],
        ];

        for (const [source, expected, executors] of refusalCases) {
            const parsed = PlurnkParser.parseStatements(source, executors === undefined ? {} : { executors });
            const errItem = parsed.items.find((i) => i.kind === "error");
            assert.ok(errItem !== undefined && errItem.kind === "error", `Expected error for: ${source}`);
            assert.match(errItem.error.message, expected, source);
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
            assert.match(wrapped[0].error.message, /Code Mode syntax error: boom/u);
            assert.equal(wrapped[0].error.line, 4);
        }
    });

    test("{§parser-build} {§fence-pairing}: CodeSerializer and HeredocSyntax cover regex slash escaping, fragments, execution variants, multiline JSON bodies, and tag collision avoidance", () => {
        assert.equal(pickHeredocTag("plain"), "EOF");
        assert.equal(pickHeredocTag("contains EOF and EOF1"), "EOF2");
        assert.equal(toStringValue(10n), "10");
        assert.equal(toStringValue(null), "");
        assert.equal(toStringValue({ a: 1 }), '{"a":1}');

        // Local target with fragment + regex with escaped and bracketed slashes
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
            'plurnk.read({"path":"README.md#install","range":"1,10","pattern":<<<EOF\n/a\\/b[/]c/i\nEOF}) // line1 line2',
        );

        // ExecStatement variants: custom runtime target=null (no range vs with range), cwd+script, MCP tool with range & empty body, multiline JSON body vs invalid JSON `{...}`
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
            'plurnk.customrt({"script":<<<EOF\nline1\nline2\nEOF})',
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

        // Special note `"Resolve all Open Work."` heredoc form and `wait` fallback from body to aside
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
            'plurnk.note({"text":<<<EOF\nResolve all Open Work.\nEOF}) // plan',
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

        // Near-miss `resource` target alias across delegation/send/conclusion/wait and model-tier omitted `)` recovery
        const nearMiss = PlurnkParser.parse([
            'await plurnk.work({ resource: "session://worker", text: "investigate" })',
            'await plurnk.send({ resource: "session://worker", text: "ping" })',
            'await plurnk.wait({ resource: "session://worker", seconds: 5 })',
            'await plurnk.done({ resource: "message://main/00", text: "resolved", } // trailing comma + omitted )',
        ].join("\n\n"));
        assert.equal(nearMiss.unparsedTail, undefined);
        const nmStmts = nearMiss.items.flatMap((i) => i.kind === "statement" ? [i.statement] : []);
        assert.deepEqual(nmStmts.map((s) => s.op), ["work", "send", "wait", "done"]);
        assert.equal(nmStmts[0]?.op === "work" ? nmStmts[0].target?.raw : null, "session://worker");
        assert.equal((nmStmts[1] as SendStatement).target?.raw, "session://worker");
        assert.equal(nmStmts[2]?.op === "wait" ? nmStmts[2].target : undefined, null);
        assert.equal(nmStmts[2]?.op === "wait" ? nmStmts[2].seconds : null, 5);
        assert.equal((nmStmts[3] as DoneStatement).target?.raw, "message://main/00");
        assert.equal((nmStmts[3] as DoneStatement).aside, "trailing comma + omitted )");
    });
});
