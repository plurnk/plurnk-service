// {§schemes-directory}: reference docs
// are materialized under worker://~/_plurnk/plurnk/ and discovered by the turn-zero FIND.

import test from "node:test";
import assert from "node:assert/strict";
import SchemeRegistry from "../../src/core/SchemeRegistry.ts";

class DocStub {
    static manifest = {
        name: "docstub", channels: { body: "text/plain" }, defaultChannel: "body",
        category: "data", entryOwner: "commons", inherit: "none", writableBy: ["model"], volatile: false, modelVisible: true,
        documentation: "# docstub\n\n## Summary\n\nRead docstub resources.\n\nFuller reference content.",
    };
}

test("{§schemes-directory}: scheme references preserve documentation without redundant entries", async () => {
    const registry = new SchemeRegistry();
    registry.register("docstub", new DocStub() as unknown as Parameters<typeof registry.register>[1]);

    const docs = await registry.docs();
    const stub = docs.find((d) => d.name === "docstub");
    assert.equal(stub?.content, "# docstub\n\n## Summary\n\nRead docstub resources.\n\nFuller reference content.", "docs() carries the content for materialization through the shared skills catalog");
    assert.equal(docs.some(({ name }) => name === "log" || name === "prompt"), false, "self-evident log and prompt resources add no redundant pull docs");

    assert.equal(docs.some(({ name }) => name === "skill"), false, "an unregistered scheme contributes no reference");
});
