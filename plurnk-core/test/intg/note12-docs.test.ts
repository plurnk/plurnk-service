// note 12 — the scheme directory surfaces each scheme's `example` one-liner as its
// directory line; docs() carries the manifest's `documentation` content for materialization
// at plurnk://docs/<name>.md (loop_run writes it like an operator doc, so its token cost rides
// the entry). The doc is NOT linked inline (#270) — it's discovered via the turn-1
// FIND(plurnk://docs/**) foist, keeping the raw packet free of doc links. A scheme with no
// `example` (provisional, e.g. skill) is omitted from the directory entirely.

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

test("[note 12] teach() surfaces a scheme's example (no inline doc-link); docs() carries it for materialization", () => {
    const registry = new SchemeRegistry();
    registry.register("docstub", new DocStub() as unknown as Parameters<typeof registry.register>[1]);

    const teaching = registry.teach();
    assert.match(teaching, /^```plurnk\n/, "the Schemes catalog is a fenced plurnk block (#436), not a bullet list");
    assert.match(teaching, /<<READ\(docstub:\/\/\/x\)::READ/, "the scheme's canonical example is its bare op line (no bullet, no redundant scheme prefix — the example self-documents)");
    assert.doesNotMatch(teaching, /\(docs:/, "no inline doc-link in the raw packet — docs are discovered via the turn-1 FIND(plurnk://docs/**) foist (#270)");

    const stub = registry.docs().find((d) => d.name === "docstub");
    assert.equal(stub?.content, "# docstub\nFuller reference content.", "docs() carries the content for materialization at plurnk://docs/<name>.md");

    // A scheme with no example (provisional, e.g. skill) is omitted from the directory entirely.
    assert.doesNotMatch(teaching, /skill:\/\/\//, "a provisional scheme with no example is omitted from the directory");
});
