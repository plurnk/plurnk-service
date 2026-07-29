import test from "node:test";
import assert from "node:assert/strict";
import LogBody from "./LogBody.ts";

const content = (value: string, mimetype = "text/markdown") => ({
    content: value,
    mimetype,
});

test("LogBody resolves built-in result-backed bodies", () => {
    for (const op of ["READ", "FIND", "model", "prompt"]) {
        assert.deepEqual(
            LogBody.resolve({ op, tx: "", rx: content(`${op} body`) }),
            { content: `${op} body`, mimetype: "text/markdown", startLine: 1 },
            op,
        );
    }

    assert.deepEqual(
        LogBody.resolve({
            op: "EDIT",
            tx: { body: "input" },
            rx: {
                receipt: {
                    effect: {
                        context: "10:before\n11:after",
                    },
                },
            },
        }),
        { content: "10:before\n11:after", mimetype: "text/plain", startLine: null },
    );

    for (const [op, rx] of [
        ["EDIT", { span: "1:edited" }],
        ["COPY", { receipt: "1:copied" }],
        ["MOVE", { body: "1:moved" }],
    ] as const) {
        assert.equal(LogBody.resolve({ op, tx: "", rx }).content, Object.values(rx)[0], op);
    }
});

test("LogBody resolves built-in statement-backed and pushed bodies", () => {
    assert.equal(LogBody.resolve({ op: "EXEC", tx: { body: "jq ." }, rx: null }).content, "jq .");

    for (const op of ["PLAN", "SEND", "WORK", "FORK"]) {
        assert.equal(LogBody.resolve({ op, tx: { body: `${op} body` }, rx: null }).content, `${op} body`, op);
    }

    assert.equal(
        LogBody.resolve({ op: "SEND", tx: "", rx: "child deliverable", mimetypeRx: "text/markdown" }).content,
        "child deliverable",
    );
    assert.equal(
        LogBody.resolve({ op: "error", tx: "", rx: { message: "failure detail" } }).content,
        "failure detail",
    );
});

test("LogBody gives extension rows the same structural body contract", () => {
    assert.deepEqual(
        LogBody.resolve({ op: "extension", tx: "", rx: content("plugin result", "text/plain") }),
        { content: "plugin result", mimetype: "text/plain", startLine: 1 },
    );
    assert.deepEqual(
        LogBody.resolve({ op: "extension", tx: { body: "plugin statement" }, rx: null, mimetypeTx: "text/markdown" }),
        { content: "plugin statement", mimetype: "text/markdown", startLine: 1 },
    );
    assert.equal(LogBody.resolve({ op: "extension", tx: "", rx: null }).content, "");
});

test("LogBody decodes persisted JSON envelopes before resolving", () => {
    assert.deepEqual(
        LogBody.resolve({
            op: "prompt",
            tx: "",
            rx: JSON.stringify({ content: "persisted", mimetype: "text/markdown", startLine: null }),
            mimetypeRx: "application/json",
        }),
        { content: "persisted", mimetype: "text/markdown", startLine: null },
    );
});
