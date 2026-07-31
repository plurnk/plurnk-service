import test from "node:test";
import assert from "node:assert/strict";
import LogBody from "./LogBody.ts";

const content = (value: string, mimetype = "text/markdown") => ({
    content: value,
    mimetype,
});

const receipt = (context: string, requested = "<2>") => ({
    revision: "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789",
    unit: "lines",
    before: 2,
    after: 2,
    effect: {
        requested,
        source: "2",
        result: "2",
        removed: 1,
        inserted: 1,
        context,
    },
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
                receipt: receipt("10:before\n11:after"),
            },
        }),
        { content: "10:before\n11:after", mimetype: "text/plain", startLine: null },
    );

    for (const [op, rx] of [
        ["EDIT", { span: "1:edited" }],
    ] as const) {
        assert.equal(LogBody.resolve({ op, tx: "", rx }).content, Object.values(rx)[0], op);
    }
});

test("LogBody resolves COPY/MOVE bodies only from ordered textual effects", () => {
    assert.deepEqual(
        LogBody.resolve({
            op: "COPY",
            tx: "",
            rx: {
                effects: [{
                    target: "worker:///destination",
                    action: "update",
                    receipt: receipt("1:before\n2:copied"),
                }],
            },
        }),
        { content: "1:before\n2:copied", mimetype: "text/plain", startLine: null },
    );
    assert.deepEqual(
        LogBody.resolve({
            op: "MOVE",
            tx: "",
            rx: {
                effects: [
                    {
                        target: "worker:///destination",
                        action: "update",
                        receipt: receipt("1:destination", "<1>"),
                    },
                    {
                        target: "worker:///source",
                        action: "update",
                        receipt: receipt("1:source", "<2>"),
                    },
                ],
            },
        }),
        {
            content: "1:destination\n\n1:source",
            mimetype: "text/plain",
            startLine: null,
        },
    );
    assert.equal(
        LogBody.resolve({
            op: "MOVE",
            tx: "",
            rx: {
                effects: [
                    { target: "worker:///destination", action: "create" },
                    { target: "worker:///source", action: "delete" },
                ],
            },
        }).content,
        "",
        "whole-channel effects have no invented textual receipt",
    );
    assert.equal(
        LogBody.resolve({ op: "COPY", tx: "", rx: { span: "legacy" } }).content,
        "",
        "COPY/MOVE do not retain a second legacy body contract",
    );
});

test("LogBody rejects malformed EDIT and COPY/MOVE result receipts", () => {
    assert.throws(
        () => LogBody.resolve({ op: "EDIT", tx: "", rx: { receipt: { effect: { context: "x" } } } }),
        /EDIT receipt/,
    );
    assert.throws(
        () => LogBody.resolve({ op: "COPY", tx: "", rx: { effects: [] } }),
        /non-empty array/,
    );
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
