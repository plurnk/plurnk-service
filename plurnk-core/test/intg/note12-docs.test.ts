// {§schemes-directory}: terse fenced examples are pushed; full reference docs
// are materialized under worker://plurnk/docs/ and discovered by the turn-zero FIND.

import test from "node:test";
import assert from "node:assert/strict";
import SchemeRegistry from "../../src/core/SchemeRegistry.ts";

class DocStub {
    static manifest = {
        name: "docstub", channels: { body: "text/plain" }, defaultChannel: "body",
        category: "data", writableBy: ["model"], volatile: false, modelVisible: true,
        example: "## READ0 (docstub:///x)", documentation: "# docstub\nFuller reference content.",
    };
}

test("{§schemes-directory}: teach() pushes an example while docs() carries the pull reference", async () => {
    const registry = new SchemeRegistry();
    registry.register("docstub", new DocStub() as unknown as Parameters<typeof registry.register>[1]);

    const teaching = registry.teach();
    assert.match(teaching, /^```plurnk\n/, "the Resources catalogue is a fenced plurnk block, not a bullet list");
    assert.match(teaching, /## READ0 \(docstub:\/\/\/x\)/, "the scheme's canonical example is its bare heading (no bullet, no redundant scheme prefix — the example self-documents)");
    assert.doesNotMatch(teaching, /\(docs:/, "pull references are discovered rather than linked in the pushed catalog");

    const stub = (await registry.docs()).find((d) => d.name === "docstub");
    assert.equal(stub?.content, "# docstub\nFuller reference content.", "docs() carries the content for materialization at worker://plurnk/docs/<name>.md");

    // A scheme with no example (provisional, e.g. skill) is omitted from the directory entirely.
    assert.doesNotMatch(teaching, /skill:\/\/\//, "a provisional scheme with no example is omitted from the directory");
});
