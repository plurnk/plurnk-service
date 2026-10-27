import assert from "node:assert/strict";
import test, { describe } from "node:test";
import ContentUse from "./ContentUse.ts";
import PatternSelection from "./PatternSelection.ts";
import { type Db } from "./Db.ts";
import { Mimetypes } from "@plurnk/plurnk-mimetypes";
import { type PlurnkSchemeContext } from "./scheme-types.ts";
import { parsePath } from "@plurnk/plurnk-parser";

describe("ContentUse", () => {
test("{§matcher-dispatch}: concurrent consumers are not serialized and collection waits for neither", async () => {
    const db = {} as Db;
    const release = Promise.withResolvers<void>();
    const entered: number[] = [];
    const uses = [1, 2].map((id) => ContentUse.read(db, async () => {
        entered.push(id);
        await release.promise;
    }));
    assert.deepEqual(entered, [1, 2]);
    assert.equal(await ContentUse.collect(db, async () => { throw new Error("must not collect in-use sources"); }), null);
    release.resolve();
    await Promise.all(uses);
    assert.equal(await ContentUse.collect(db, async () => "collected"), "collected");
});

test("{§matcher-dispatch}: new consumers wait for collection, including failed collection", async () => {
    const db = {} as Db;
    const release = Promise.withResolvers<void>();
    const events: string[] = [];
    const failure = new Error("collector failed");
    const collecting = ContentUse.collect(db, async () => {
        events.push("collect");
        await release.promise;
        throw failure;
    });
    const rejected = assert.rejects(collecting, (error) => error === failure);
    const read = ContentUse.read(db, async () => { events.push("read"); });
    assert.deepEqual(events, ["collect"]);
    release.resolve();
    await Promise.all([read, rejected]);
    assert.deepEqual(events, ["collect", "read"]);
    await assert.rejects(ContentUse.read(db, async () => { throw failure; }), (error) => error === failure);
    assert.equal(await ContentUse.collect(db, async () => "released"), "released");
});
});

describe("PatternSelection", () => {
const ctx = { mimetypes: new Mimetypes() } as unknown as PlurnkSchemeContext;
const match = (content: string, marks: readonly number[]) => PatternSelection.match({
    matcher: { dialect: "glob", raw: "old*" }, content, mimetype: "text/plain", target: parsePath("workspace:///entry")!, marks, ctx, scheme: "workspace", operation: "EDIT",
});

test("{§mimetype-error-policy} a pattern scope's -1 is the last logical line whether or not the text ends in a newline", async () => {
    for (const content of ["keep\nold value", "keep\nold value\n"]) {
        const bounded = await match(content, [2, -1]);
        assert.ok(!("result" in bounded), `<2,-1> on ${JSON.stringify(content)} selects`);
        assert.deepEqual(bounded.spans, [{ startLine: 2, startColumn: 1, endLine: 2, endColumn: 10 }], `${JSON.stringify(content)}: -1 clamps to line 2, the last line`);
        const past = await match(content, [3, -1]);
        assert.ok("result" in past, `<3,-1> on ${JSON.stringify(content)} names no line`);
        assert.equal(past.result.status, 400);
        assert.match(String(past.result.problem?.type), /\/pattern-scope-invalid$/);
    }
});

test("{§zero-width-column-one-insert} an exact-source operation never widens an enclosing match or silently drops an unlocated one", async () => {
    for (const evidence of [
        { matched: "name", matching: "//name", enclosingRegions: [{ startLine: 1, startColumn: 1, endLine: 1, endColumn: 4 }] },
        { matched: 1, matching: "count(//name)" },
    ]) {
        const source = { mimetypes: { query: async () => [evidence] } } as unknown as PlurnkSchemeContext;
        const result = await PatternSelection.match({
            matcher: { dialect: "xpath", raw: "//name" }, content: "abc", mimetype: "text/test",
            target: parsePath("workspace:///entry")!, marks: undefined, ctx: source, scheme: "workspace", operation: "EDIT",
        });
        assert.ok("result" in result, JSON.stringify(result));
        assert.equal(result.result.status, 422);
        assert.match(String(result.result.problem?.type), /\/pattern-source-unlocated$/);
    }
});
});
