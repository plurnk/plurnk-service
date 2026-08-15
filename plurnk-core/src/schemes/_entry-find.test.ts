import test from "node:test";
import assert from "node:assert/strict";
import type { FindStatement } from "@plurnk/plurnk-contracts";
import { projectFindResult, type CatalogMatch } from "./_entry-find.ts";
import { pathScope } from "./_path-scope.ts";

const statement: FindStatement = {
    op: "FIND",
    suffix: "",
    signal: null,
    target: {
        kind: "url",
        raw: "worker:///doc.md",
        scheme: "worker",
        username: null,
        password: null,
        hostname: null,
        port: null,
        pathname: "/doc.md",
        query: null,
        fragment: null,
    },
    lineMarker: null,
    body: { dialect: "regex", raw: "/selected/", pattern: "selected", flags: "" },
    position: { line: 1, column: 1 },
};

const item: CatalogMatch = [
    { path: "worker:///doc.md", mimetype: "text/markdown", weight: 4, lines: 1 },
];

test("{§find-result-projection}: a valid exact match without an addressable location remains a successful selection", () => {
    const result = projectFindResult(
        statement,
        { kind: "exact", pathname: "/doc.md", candidatePrefix: "/doc.md" },
        [{ item, match: { pathname: "/doc.md", matches: [] } }],
    );

    assert.equal(result.status, 200);
    assert.deepEqual(result.results, []);
    assert.equal(result.content, "[]");
    assert.equal(result.matchingPathCount, 1);
    assert.equal(result.matchLocationCount, 0);
    assert.deepEqual(result.range, {
        unit: "matchLocation",
        total: 0,
        requested: [1, 16],
    });
});

test("{§find-result-projection}: exact duplicate locations are materialized and counted once", () => {
    const location = {
        locator: "$.selected",
        region: { startLine: 1, startColumn: 1, endLine: 1, endColumn: 9 },
    };
    const result = projectFindResult(
        statement,
        { kind: "exact", pathname: "/doc.md", candidatePrefix: "/doc.md" },
        [{ item, match: { pathname: "/doc.md", matches: [location, location] } }],
    );

    assert.deepEqual(result.results, [location]);
    assert.equal(result.matchLocationCount, 1);
});

test("{§find-result-projection}: resource results are default-first channel groups and scopes are one-element groups", () => {
    const result = projectFindResult(
        { ...statement, body: null },
        pathScope("*", false),
        [{ item, match: { pathname: "/doc.md", matches: [] } }],
        [{ path: "worker:///src/**", items: 2, weight: 8 }],
    );

    assert.deepEqual(result.results, [
        [{ path: "worker:///doc.md", mimetype: "text/markdown", weight: 4, lines: 1 }],
        [{ path: "worker:///src/**", items: 2, weight: 8 }],
    ]);
    assert.equal(result.content, [
        "[[{\"path\":\"worker:///doc.md\",\"mimetype\":\"text/markdown\",\"tokens\":4,\"lines\":1}],",
        "[{\"path\":\"worker:///src/**\",\"items\":2,\"tokens\":8}]]",
    ].join("\n"));
    assert.equal(result.returnedItemsWeightTotal, 12);
});
