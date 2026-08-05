import test from "node:test";
import assert from "node:assert/strict";
import {
    parsePath,
    type CopyStatement,
    type EditStatement,
    type ReadStatement,
    type UrlPath,
} from "@plurnk/plurnk-contracts";
import DurableStatement from "./DurableStatement.ts";

const url = (raw: string): UrlPath => {
    const parsed = parsePath(raw);
    if (parsed?.kind !== "url") throw new Error(`${raw} did not parse as a URL`);
    return parsed;
};

test("DurableStatement projects URL credential slots without mutating execution input", () => {
    const target = url("https://user:password@example.test/path?#body{Set-Cookie: a=1}{Set-Cookie: b=2}");
    const statement: ReadStatement = {
        op: "READ",
        suffix: "",
        signal: null,
        target,
        lineMarker: null,
        body: null,
        position: { line: 1, column: 0 },
    };

    const projected = DurableStatement.project(statement);
    if (projected.op !== "READ" || projected.target?.kind !== "url") {
        throw new Error("projected READ lost its URL target");
    }
    assert.equal(projected.target.raw, "https://__redacted__:__redacted__@example.test/path?#body{Set-Cookie: __redacted__}{Set-Cookie: __redacted__}");
    assert.equal(projected.target.username, "__redacted__");
    assert.equal(projected.target.password, "__redacted__");
    assert.equal(projected.target.query, "", "an explicit empty query survives");
    assert.deepEqual(projected.target.headers, [
        ["Set-Cookie", "__redacted__"],
        ["Set-Cookie", "__redacted__"],
    ]);
    assert.equal(target.username, "user");
    assert.equal(target.password, "password");
    assert.deepEqual(target.headers, [["Set-Cookie", "a=1"], ["Set-Cookie", "b=2"]]);
});

test("DurableStatement applies the same projection to a COPY destination", () => {
    const statement: CopyStatement = {
        op: "COPY",
        suffix: "",
        signal: null,
        target: url("worker:///source"),
        lineMarker: null,
        body: {
            target: url("https://:password@example.test/destination{Authorization: secret}"),
            lineMarker: { marks: [1, 1] },
        },
        position: { line: 1, column: 0 },
    };

    const projected = DurableStatement.project(statement);
    if (projected.op !== "COPY" || projected.body?.target.kind !== "url") {
        throw new Error("projected COPY lost its URL destination");
    }
    assert.equal(projected.body.target.raw, "https://:__redacted__@example.test/destination{Authorization: __redacted__}");
    assert.equal(projected.body.target.username, null);
    assert.equal(projected.body.target.password, "__redacted__");
    assert.deepEqual(projected.body.target.headers, [["Authorization", "__redacted__"]]);
    assert.deepEqual(projected.body.lineMarker, { marks: [1, 1] });
});

test("DurableStatement leaves query text, authored bodies, and local targets exact", () => {
    const statement: EditStatement = {
        op: "EDIT",
        suffix: "",
        signal: null,
        target: url("https://example.test/path?authored=query-secret{Authorization: header-secret}"),
        lineMarker: null,
        body: "authored body-secret",
        position: { line: 1, column: 0 },
    };
    const projected = DurableStatement.project(statement);
    if (projected.op !== "EDIT" || projected.target?.kind !== "url") {
        throw new Error("projected EDIT lost its URL target");
    }
    assert.equal(projected.target.query, "authored=query-secret");
    assert.deepEqual(projected.target.headers, [["Authorization", "__redacted__"]]);
    assert.equal(projected.body, "authored body-secret");

    const local: EditStatement = {
        ...statement,
        target: { kind: "local", raw: "local/path" },
    };
    assert.deepEqual(DurableStatement.project(local), local);
});
