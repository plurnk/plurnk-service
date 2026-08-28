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
    const target = url("https://user:password@example.test/path?#body");
    const statement: ReadStatement = {
        op: "READ",
        delimiter: "",
        annotation: null,
        signal: null,
        target,
        metadata: ["Set-Cookie: a=1", "Set-Cookie: b=2"],
        lineMarker: null,
        body: null,
        position: { line: 1, column: 0 },
    };

    const projected = DurableStatement.project(statement);
    if (projected.op !== "READ" || projected.target?.kind !== "url") {
        throw new Error("projected READ lost its URL target");
    }
    assert.equal(projected.target.raw, "https://__redacted__:__redacted__@example.test/path?#body");
    assert.equal(projected.target.username, "__redacted__");
    assert.equal(projected.target.password, "__redacted__");
    assert.equal(projected.target.query, "", "an explicit empty query survives");
    assert.deepEqual(projected.metadata, ["__redacted__", "__redacted__"]);
    assert.equal(target.username, "user");
    assert.equal(target.password, "password");
    assert.deepEqual(statement.metadata, ["Set-Cookie: a=1", "Set-Cookie: b=2"]);
});

test("DurableStatement applies the same projection to both COPY operands", () => {
    const statement: CopyStatement = {
        op: "COPY",
        delimiter: "",
        annotation: null,
        signal: null,
        source: {
            target: url("https://user:password@example.test/source"),
            metadata: ["Authorization: source-secret"],
            lineMarker: null,
        },
        destination: {
            target: url("https://:password@example.test/destination"),
            metadata: ["Authorization: destination-secret"],
            lineMarker: { marks: [1, 1] },
        },
        position: { line: 1, column: 0 },
    };

    const projected = DurableStatement.project(statement);
    if (projected.op !== "COPY" || projected.destination.target.kind !== "url") {
        throw new Error("projected COPY lost its URL destination");
    }
    assert.equal(projected.destination.target.raw, "https://:__redacted__@example.test/destination");
    assert.equal(projected.destination.target.username, null);
    assert.equal(projected.destination.target.password, "__redacted__");
    assert.deepEqual(projected.source.metadata, ["__redacted__"]);
    assert.deepEqual(projected.destination.metadata, ["__redacted__"]);
    assert.deepEqual(projected.destination.lineMarker, { marks: [1, 1] });
});

test("DurableStatement leaves query text, authored bodies, and local targets exact", () => {
    const statement: EditStatement = {
        op: "EDIT",
        delimiter: "",
        annotation: null,
        signal: null,
        target: url("https://example.test/path?authored=query-secret"),
        metadata: ["Authorization: header-secret"],
        lineMarker: null,
        body: "authored body-secret",
        position: { line: 1, column: 0 },
    };
    const projected = DurableStatement.project(statement);
    if (projected.op !== "EDIT" || projected.target?.kind !== "url") {
        throw new Error("projected EDIT lost its URL target");
    }
    assert.equal(projected.target.query, "authored=query-secret");
    assert.deepEqual(projected.metadata, ["__redacted__"]);
    assert.equal(projected.body, "authored body-secret");

    const local: EditStatement = {
        ...statement,
        target: { kind: "local", raw: "local/path" },
    };
    assert.deepEqual(DurableStatement.project(local), {
        ...local,
        metadata: ["__redacted__"],
    });
});
