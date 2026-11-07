import test from "node:test";
import assert from "node:assert/strict";
import { parsePath } from "@plurnk/plurnk-parser";
import { type CopyStatement, type EditStatement, type ReadStatement, type UrlPath } from "@plurnk/plurnk-contracts";
import DurableStatement from "./DurableStatement.ts";

const url = (raw: string): UrlPath => {
    const parsed = parsePath(raw);
    if (parsed?.kind !== "url") throw new Error(`${raw} did not parse as a URL`);
    return parsed;
};

test("{§log-history-projection} DurableStatement projects URL credential slots without mutating execution input", () => {
    const target = url("https://user:password@example.test/path?#body");
    const statement: ReadStatement = {
        op: "read",
        aside: null,
        target,
        headers: { "Set-Cookie": "a=1", "X-Token": "b=2" },
        lineMarker: null,
        matcher: null, body: null,
        position: { line: 1, column: 0 },
    };

    const projected = DurableStatement.project(statement);
    if (projected.op !== "read" || projected.target?.kind !== "url") {
        throw new Error("projected read lost its URL target");
    }
    assert.equal(projected.target.raw, "https://__redacted__:__redacted__@example.test/path?#body");
    assert.equal(projected.target.username, "__redacted__");
    assert.equal(projected.target.password, "__redacted__");
    assert.equal(projected.target.query, "", "an explicit empty query survives");
    assert.deepEqual(projected.headers, { "Set-Cookie": "__redacted__", "X-Token": "__redacted__" });
    assert.equal(target.username, "user");
    assert.equal(target.password, "password");
    assert.deepEqual(statement.headers, { "Set-Cookie": "a=1", "X-Token": "b=2" });
});

test("{§log-history-projection} DurableStatement applies the same projection to both COPY operands", () => {
    const statement: CopyStatement = {
        op: "copy",
        aside: null,
        source: { target: url("https://user:password@example.test/source"), headers: { Authorization: "source-secret" }, lineMarker: null, matcher: null },
        destination: { target: url("https://:password@example.test/destination"), headers: { Authorization: "destination-secret" }, lineMarker: { marks: [1, 1] }, matcher: null },
        position: { line: 1, column: 0 },
    };

    const projected = DurableStatement.project(statement);
    if (projected.op !== "copy" || projected.destination.target.kind !== "url") {
        throw new Error("projected copy lost its URL destination");
    }
    assert.equal(projected.destination.target.raw, "https://:__redacted__@example.test/destination");
    assert.equal(projected.destination.target.username, null);
    assert.equal(projected.destination.target.password, "__redacted__");
    assert.deepEqual(projected.source.headers, { Authorization: "__redacted__" });
    assert.deepEqual(projected.destination.headers, { Authorization: "__redacted__" });
    assert.deepEqual(projected.destination.lineMarker, { marks: [1, 1] });
});

test("{§log-history-projection} DurableStatement leaves query text, authored bodies, and local targets exact", () => {
    const statement: EditStatement = {
        op: "edit",
        aside: null,
        target: url("https://example.test/path?authored=query-secret"),
        headers: { Authorization: "header-secret" },
        lineMarker: null,
        matcher: null, body: "authored body-secret",
        position: { line: 1, column: 0 },
    };
    const projected = DurableStatement.project(statement);
    if (projected.op !== "edit" || projected.target?.kind !== "url") {
        throw new Error("projected edit lost its URL target");
    }
    assert.equal(projected.target.query, "authored=query-secret");
    assert.deepEqual(projected.headers, { Authorization: "__redacted__" });
    assert.equal(projected.body, "authored body-secret");

    const local: EditStatement = {
        ...statement,
        target: { kind: "local", raw: "local/path" },
    };
    assert.deepEqual(DurableStatement.project(local), {
        ...local,
        headers: { Authorization: "__redacted__" },
    });
});
