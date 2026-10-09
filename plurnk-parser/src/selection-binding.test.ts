import test from "node:test";
import assert from "node:assert/strict";
import PlurnkParser from "./PlurnkParser.ts";

const parse = (heading: string) => PlurnkParser.parse(`\`\`\`${heading}\n\`\`\``);
const statements = (heading: string) => {
    const parsed = parse(heading);
    assert.deepEqual(parsed.items.filter((item) => item.kind === "error" && item.error.severity === "error"), [], heading);
    return parsed.items.flatMap((item) => item.kind === "statement" ? [item.statement] : []);
};

for (const op of ["READ", "KILL"] as const) {
    test(`{§target-group}: ${op} compiles each path with its own scope and metadata`, () => {
        for (const heading of [
            `${op} (a)<1,3>[{"keep":1}](b)[{"keep":2}]<4,6>`,
            `${op} (a) [{"keep":1}] <1,3> (b) <4,6> [{"keep":2}]`,
            `${op} [{"keep":1}] (a) <1,3> (b) <4,6> [{"keep":2}]`,
        ]) {
            const ops = statements(heading);
            assert.equal(ops.length, 2);
            assert.deepEqual(ops.map((statement) => {
                assert.equal(statement.op, op);
                assert.ok(statement.op === "READ" || statement.op === "KILL");
                assert.equal("group" in statement, false, "the AST has one representation per selection");
                return [statement.target?.raw, statement.lineMarker?.marks, statement.metadata];
            }), [["a", [1, 3], ['{"keep":1}']], ["b", [4, 6], ['{"keep":2}']]]);
        }
    });

    test(`{§target-group}: ${op} applies the naked matcher independently of the first member's options`, () => {
        for (const own of [0, 1]) {
            const paths = ["a", "b"].map((path, index) => `(${path})${index === own ? ' [{"pattern":"/local/"}]' : ""}`).join(" ");
            const ops = statements(`${op} ${paths} /shared/`);
            assert.deepEqual(ops.map((statement) => {
                assert.ok(statement.op === "READ" || statement.op === "KILL");
                return [statement.target?.raw, statement.matcher?.raw, statement.metadata];
            }), [["a", own === 0 ? "/local/" : "/shared/", null], ["b", own === 1 ? "/local/" : "/shared/", null]]);
        }
    });

    test(`{§trailing-slots}: ${op} refuses ambiguous scope relocation without executing any group member`, () => {
        const parsed = PlurnkParser.parse(`\`\`\`${op} (a) (b) /pattern/ <1,3>\n\`\`\`\n\n\`\`\`NOTE\nsibling retained\n\`\`\``);
        assert.deepEqual(parsed.items.flatMap((item) => item.kind === "statement" ? [item.statement.op] : []), ["NOTE"]);
        const errors = parsed.items.filter((item) => item.kind === "error" && item.error.severity === "error");
        assert.equal(errors.length, 1);
        assert.ok(errors[0]?.kind === "error");
        assert.equal(errors[0].error.message, "The scope `<1,3>` follows the shared pattern of a target group.");
        assert.equal(errors[0].error.recovery, "In a target group each `(path)` carries its own scope and option block, and the one shared pattern comes last.");
        assert.equal(parsed.items.some((item) => item.kind === "error" && item.error.severity === "warning"), false, "no false claim that the scope was applied");
    });

    test(`{§trailing-slots}: ${op} retains unambiguous single-path scope recovery`, () => {
        const parsed = parse(`${op} (a) /pattern/ <1,3>`);
        assert.deepEqual(parsed.items.filter((item) => item.kind === "error" && item.error.severity === "error"), []);
        const ops = parsed.items.flatMap((item) => item.kind === "statement" ? [item.statement] : []);
        assert.equal(ops.length, 1);
        assert.ok(ops[0]?.op === op);
        assert.equal(ops[0].target?.raw, "a");
        assert.deepEqual(ops[0].lineMarker, { marks: [1, 3] });
        assert.equal(ops[0].matcher?.raw, "/pattern/");
        assert.ok(parsed.items.some((item) => item.kind === "error" && item.error.severity === "warning"));
    });
}

for (const op of ["COPY", "MOVE"] as const) {
    test(`{§transfer-resource-selections}: ${op} keeps both operand pairs through adjacency and metadata order`, () => {
        for (const heading of [
            `${op} (a)<1,3>[{"pattern":"/first/"}](b)[{"pattern":"/second/"}]<4,6>`,
            `${op} (a) [{"pattern":"/first/"}] <1,3> (b) <4,6> [{"pattern":"/second/"}]`,
            `${op} [{"pattern":"/first/"}] (a) <1,3> (b) <4,6> [{"pattern":"/second/"}]`,
        ]) {
            const ops = statements(heading);
            assert.equal(ops.length, 1);
            assert.ok(ops[0]?.op === op);
            assert.deepEqual([ops[0].source, ops[0].destination].map(({ target, lineMarker, matcher }) =>
                [target.raw, lineMarker?.marks, matcher?.raw]), [["a", [1, 3], "/first/"], ["b", [4, 6], "/second/"]]);
        }
    });
}

for (const op of ["READ", "KILL", "COPY", "MOVE"] as const) {
    test(`{§slot-order}: ${op} binds leading metadata to the first operand and inter-path metadata to the preceding operand`, () => {
        const ops = statements(`${op} [{"first":1}] (a) [{"second":2}] (b) [{"third":3}]`);
        const selections = ops.flatMap((statement) => {
            if (statement.op === "COPY" || statement.op === "MOVE") {
                return [statement.source, statement.destination].map(({ target, metadata }) => [target.raw, metadata]);
            }
            assert.ok(statement.op === "READ" || statement.op === "KILL");
            return [[statement.target?.raw, statement.metadata]];
        });
        assert.deepEqual(selections, [
            ["a", ['{"first":1}', '{"second":2}']],
            ["b", ['{"third":3}']],
        ]);
    });
}
