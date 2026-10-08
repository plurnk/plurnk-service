// {§scope-on-scopeless} — a scope on an operation that takes none is dropped with one advisory naming the
// operation's slots; the heading runs. Replayed from zai run426 (deprecation-impl), where the bare grammar
// diagnostic had left a dead turn (#853).
import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { PlurnkParser } from "../../src/index.ts";

const recorded = (prefix: string) => {
    const dir = new URL("../fixtures/recorded/", import.meta.url);
    const name = readdirSync(dir).find((entry) => entry.startsWith(prefix));
    assert.ok(name, `a recorded fixture named ${prefix}*`);
    return readFileSync(new URL(name, dir), "utf8");
};
const parse = (input: string) => PlurnkParser.parse(input, { executors: ["sh", "python3"] });
const statements = (input: string) => parse(input).items.flatMap((item) => item.kind === "statement" ? [item.statement] : []);
const diagnostics = (input: string) => parse(input).items.flatMap((item) => item.kind === "error" ? [`${item.error.severity}: ${item.error.message}`] : []);

test("{§scope-on-scopeless} zai run426: `WORK (worker://…) <1,-1>` runs the WORK with its whole task and names the ignored scope (recorded)", () => {
    const text = recorded("zai-run426-");
    const executed = statements(text);
    const work = executed.find((statement) => statement.op === "WORK");
    assert.ok(work, "the WORK ran");
    assert.equal(work.op === "WORK" ? work.target?.raw : null, "worker://deprecation-implementer");
    assert.equal(work.lineMarker, null);
    assert.ok((work.op === "WORK" ? work.body : "").length > 200, "the child's complete task is the body");
    const line = text.split("\n").findIndex((entry) => entry.startsWith("```WORK (worker://deprecation-implementer) <1,-1>")) + 1;
    assert.ok(line > 0);
    assert.ok(diagnostics(text).includes("warning: `WORK` takes a target only; the scope `<1,-1>` was ignored."), diagnostics(text).join("\n"));
    assert.ok(!diagnostics(text).some((entry) => entry.startsWith("error:")), "no hard diagnostic, no dead turn");
});

test("{§scope-on-scopeless} FORK, BARE, NOTE and a recipientless SEND drop a scope in any position; a recipient SEND keeps its scope", () => {
    for (const [input, op, message] of [
        ["```FORK (worker://x) <@abcde,@fghij>\nTask.\n```", "FORK", "`FORK` takes a target only; the scope `<@abcde,@fghij>` was ignored."],
        ["```BARE <3> <!-- why -->\nPrompt.\n```", "BARE", "`BARE` takes a target only; the scope `<3>` was ignored."],
        ["```WORK <1,-1> (worker://x)\nTask.\n```", "WORK", "`WORK` takes a target only; the scope `<1,-1>` was ignored."],
        ["```NOTE <3>\nRemember.\n```", "NOTE", "`NOTE` takes no target or scope; the scope `<3>` was ignored."],
        ["```SEND <3>\nhi\n```", "SEND", "`SEND` without a recipient takes no scope; the scope `<3>` was ignored."],
    ] as const) {
        const [statement] = statements(input);
        assert.equal(statement?.op, op, input);
        assert.equal(statement !== undefined && "lineMarker" in statement ? statement.lineMarker : "missing", null, input);
        assert.deepEqual(diagnostics(input), [`warning: ${message}`], input);
    }
    const [send] = statements("```SEND (worker://a) <3>\nhi\n```");
    assert.deepEqual(send?.op === "SEND" ? send.lineMarker : null, { marks: [3] }, "{§send-directed-scope}: a recipient SEND carries its scope to the recipient");
    assert.equal(statements("```BARE <!-- aside -->\nPrompt.\n```")[0]?.aside, "aside", "an aside is not a scope");
});
