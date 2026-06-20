// note 12 — the scheme directory surfaces each scheme's `example` one-liner as its
// directory line + a plurnk://docs/<name>.md doc-link when the manifest ships
// `documentation`; docs() carries that content for materialization at
// plurnk://docs/<name>.md (loop_run writes it like an operator doc, so its token cost
// rides the manifest entry). In-tree schemes now ship both — the verbose prose
// relocated OUT of the hot path into the pull doc. The link stays optional: a scheme
// with no `example` (provisional, e.g. skill) is omitted from the directory entirely.

import test from "node:test";
import assert from "node:assert/strict";
import SchemeRegistry from "../../src/core/SchemeRegistry.ts";

class DocStub {
    static manifest = {
        name: "docstub", channels: { body: "text/plain" }, defaultChannel: "body",
        category: "data", scope: "session", writableBy: ["model"], volatile: false, modelVisible: true,
        example: "<<READ(docstub:///x)::READ", documentation: "# docstub\nFuller reference content.",
    };
}

test("[note 12] teach() surfaces a scheme's example + doc-link; docs() carries it for materialization", () => {
    const registry = new SchemeRegistry();
    registry.register("docstub", new DocStub() as unknown as Parameters<typeof registry.register>[1]);

    const teaching = registry.teach();
    assert.match(teaching, /\* docstub:\/\/\/ <<READ\(docstub:\/\/\/x\)::READ/, "the scheme's canonical example is its directory line");
    assert.match(teaching, /\(docs: plurnk:\/\/docs\/docstub\.md\)/, "a doc-link renders when the scheme ships documentation");

    const stub = registry.docs().find((d) => d.name === "docstub");
    assert.equal(stub?.content, "# docstub\nFuller reference content.", "docs() carries the content for materialization at plurnk://docs/<name>.md");

    // A scheme with no example (provisional, e.g. skill) is omitted from the directory entirely.
    assert.doesNotMatch(teaching, /skill:\/\/\//, "a provisional scheme with no example is omitted from the directory");
});
