import test from "node:test";
import assert from "node:assert/strict";
import PlurnkParser from "./PlurnkParser.ts";

const parse = (heading: string, body: string | null = null) => {
    const parsed = PlurnkParser.parseClient(PlurnkParser.frame(heading, body), { executors: ["sh", "gitea"] });
    assert.deepEqual(parsed.items.filter((item) => item.kind === "error"), [], heading);
    assert.equal(parsed.unparsedTail, undefined, heading);
    return parsed.items.flatMap((item) => item.kind === "statement" ? [item.statement] : []);
};

test("{§slot-order}: SEND accepts completion metadata before its message path", () => {
    const result = PlurnkParser.parse("```SEND [200] (message://dogfood04/6094c6e9)\nFinal deliverable\n```");
    assert.deepEqual(result.items.filter((item) => item.kind === "error"), []);
    const statements = result.items.flatMap((item) => item.kind === "statement" ? [item.statement] : []);
    assert.equal(statements.length, 1);
    const statement = statements[0]!;
    assert.equal(statement.op, "SEND");
    assert.equal(statement.target?.raw, "message://dogfood04/6094c6e9");
    assert.deepEqual(statement.metadata, ["200"]);
    assert.deepEqual(statement.body, { raw: "Final deliverable", json: null });
});

for (const op of ["FIND", "READ", "EDIT", "KILL", "SEND", "LOOK", "sh", "gitea"]) {
    test(`{§slot-order}: ${op} accepts metadata before or after its path/scope pair`, () => {
        const metadata = '[{"request":{"value":"]"}}]';
        const body = op === "EDIT" || op === "SEND" || op === "sh" || op === "gitea" ? "literal body" : null;
        const canonical = parse(`${op} (item) <1,3> ${metadata}`, body);
        for (const slots of [
            `${metadata} (item) <1,3>`,
            `(item) ${metadata} <1,3>`,
            `${metadata}(item)<1,3>`,
        ]) assert.deepEqual(parse(`${op} ${slots}`, body), canonical, slots);
    });
}

for (const op of ["FIND", "READ", "EDIT", "KILL", "LOOK"]) {
    test(`{§slot-order}: ${op} retains single-path scope-first tolerance around metadata`, () => {
        const metadata = '[{"keep":1}]';
        const canonical = parse(`${op} (item) <1,3> ${metadata}`);
        for (const slots of [
            `${metadata} <1,3> (item)`,
            `<1,3> ${metadata} (item)`,
            `<1,3> (item) ${metadata}`,
        ]) assert.deepEqual(parse(`${op} ${slots}`), canonical, slots);
    });
}

for (const op of ["BARE", "WORK", "FORK", "WAIT"]) {
    test(`{§slot-order}: ${op} accepts leading metadata without changing its body`, () => {
        const metadata = op === "WAIT" ? "[60]" : '[{"env":{"EXAMPLE":"value"}}]';
        assert.deepEqual(parse(`${op} ${metadata} (worker://child)`, "literal body"),
            parse(`${op} (worker://child) ${metadata}`, "literal body"));
    });
}

test("{§scheme-metadata-modifier}: prefix and suffix blocks retain exact bytes in authored order", () => {
    const statements = parse('READ [opaque] (item) <1> [{"x": [1,2]}]');
    assert.ok(statements[0]?.op === "READ");
    assert.deepEqual(statements[0].metadata, ["opaque", '{"x": [1,2]}']);
    assert.deepEqual(statements, parse('READ (item) <1> [opaque] [{"x": [1,2]}]'));
});

test("{§slot-order} {§reasoning-operations}: reasoning uses the same metadata binding", () => {
    const canonical = ["FIND (item) <1,3> [{\"pattern\":\"/needle/\"}]", "READ (item) <4,6> [{\"keep\":1}]"];
    const reordered = ["FIND [{\"pattern\":\"/needle/\"}] (item) <1,3>", "READ [{\"keep\":1}] (item) <4,6>"];
    const program = (headings: string[]) => headings.map((heading) => PlurnkParser.frame(heading, null)).join("\n\n");
    const warnings: string[] = [];
    const statements = PlurnkParser.parseReasoningOperations(program(reordered), (warning) => warnings.push(warning.message));
    assert.equal(statements.length, 2);
    assert.deepEqual(statements, PlurnkParser.parseReasoningOperations(program(canonical)));
    assert.deepEqual(warnings, []);
});

test("{§lifecycle-slots}: metadata ordering does not add NOTE metadata", () => {
    const parsed = PlurnkParser.parse("```NOTE [200]\nliteral body\n```");
    assert.ok(parsed.items.some((item) => item.kind === "error" && item.error.severity === "error"));
    assert.equal(parsed.items.some((item) => item.kind === "statement"), false);
});
