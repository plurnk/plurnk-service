// note 12 — the schemes catalogue surfaces a scheme's daughter-provided usage `example`
// inline + a plurnk:///docs/<name> doc-link when the manifest ships `documentation`
// (optional). In-tree schemes ship none yet, so the link is future-proof — it lights up
// the day plurnk-schemes adds the field, exactly as execs do via ExecInfo.documentation.
// docs() carries the content for materialization at plurnk:///docs/<name> (loop_run writes
// it like an operator doc; its token cost then rides the manifest entry).

import test from "node:test";
import assert from "node:assert/strict";
import SchemeRegistry from "../../src/core/SchemeRegistry.ts";

class DocStub {
    static teach = "a documented stub scheme";
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
    assert.match(teaching, /Example: <<READ\(docstub:\/\/\/x\)::READ/, "the daughter usage example is surfaced inline");
    assert.match(teaching, /Docs: plurnk:\/\/\/docs\/docstub/, "a doc-link renders when the scheme ships documentation");

    const stub = registry.docs().find((d) => d.name === "docstub");
    assert.equal(stub?.content, "# docstub\nFuller reference content.", "docs() carries the content for materialization at plurnk:///docs/<name>");

    // An in-tree scheme without documentation renders no doc-link (optional, no clutter).
    assert.doesNotMatch(teaching, /Docs: plurnk:\/\/\/docs\/known\b/, "a scheme without documentation gets no doc-link");
});
