import test from "node:test";
import assert from "node:assert/strict";
import { PlurnkParser } from "../../src/index.ts";

const bodies = ["Check the configured timeout.", "/timeout/", "$.timeout", "//timeout", "~timeout", "&timeout", "<!-- inspect defaults -->", "First thought.\nSecond thought."];

for (const op of ["READ", "FIND"]) {
    for (const body of bodies) {
        test(`{§retrieval-annotation}: ${op} preserves ${JSON.stringify(body)} as memory, never as selection`, () => {
            const source = PlurnkParser.frame(`${op} (config.ts)`, body);
            const parsed = PlurnkParser.parse(source);
            assert.deepEqual(parsed.items.filter((item) => item.kind === "error"), []);
            const statements = parsed.items.flatMap((item) => item.kind === "statement" ? [item.statement] : []);
            assert.deepEqual(statements.map((statement) => statement.op), ["NOTE", op]);
            assert.equal("body" in statements[0]! ? statements[0]!.body : undefined, body);
            assert.equal("body" in statements[1]! ? statements[1]!.body : undefined, null);
            assert.equal("matcher" in statements[1]! ? statements[1]!.matcher : undefined, null);
            assert.equal(statements[1]!.aside, null);
            const canonical = PlurnkParser.stringify(statements);
            assert.equal(canonical, `${PlurnkParser.frame("NOTE", body)}\n\n${PlurnkParser.frame(`${op} (config.ts)`, null)}`);
            const again = PlurnkParser.parse(canonical);
            assert.deepEqual(again.items.filter((item) => item.kind === "error"), []);
            const reasoning = PlurnkParser.parseReasoningOperations(source);
            assert.deepEqual(reasoning.map((statement) => statement.op), ["NOTE", op]);
            assert.equal(reasoning[0]!.body, body);
        });
    }
    test(`{§retrieval-annotation}: ${op} keeps header selection independent of its annotation`, () => {
        const parsed = PlurnkParser.parse(PlurnkParser.frame(`${op} (config.ts) /timeout/ <!-- inspect -->`, "/not-a-selector/"));
        assert.deepEqual(parsed.items.filter((item) => item.kind === "error"), []);
        const statements = parsed.items.flatMap((item) => item.kind === "statement" ? [item.statement] : []);
        assert.equal("body" in statements[0]! ? statements[0]!.body : undefined, "/not-a-selector/");
        assert.equal("matcher" in statements[1]! ? statements[1]!.matcher?.raw : undefined, "/timeout/");
        assert.equal(statements[1]!.aside, "inspect");
    });
}

test("{§retrieval-annotation}: grouped READs retain one annotation; quoted operations stay literal", () => {
    const body = PlurnkParser.frame("EDIT (unwanted.ts)", "never execute this quotation");
    const parsed = PlurnkParser.parse(PlurnkParser.frame("READ (a.ts) (b.ts)", body));
    assert.deepEqual(parsed.items.filter((item) => item.kind === "error"), []);
    const statements = parsed.items.flatMap((item) => item.kind === "statement" ? [item.statement] : []);
    assert.deepEqual(statements.map((statement) => statement.op), ["NOTE", "READ", "READ"]);
    assert.equal("body" in statements[0]! ? statements[0]!.body : undefined, body);
});
