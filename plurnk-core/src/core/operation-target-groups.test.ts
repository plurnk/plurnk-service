import test from "node:test";
import assert from "node:assert/strict";
import {
    PlurnkParser,
    type OpenStatement,
    type PlurnkStatement,
} from "@plurnk/plurnk-contracts";
import { expandSafeUriTargetGroup } from "./operation-target-groups.ts";

const parseOp = (source: string, op: PlurnkStatement["op"]): PlurnkStatement => {
    const parsed = PlurnkParser.parse(`# PLAN0\n\n${source}\n\n## SEND0 [102]`);
    const item = parsed.items.find(
        (candidate) => candidate.kind === "statement" && candidate.statement.op === op,
    );
    if (item?.kind !== "statement") throw new Error(`fixture did not parse ${op}`);
    return item.statement;
};

test("{§safe-uri-target-groups}: space and comma separators expand in member order", () => {
    const statements = [
        parseOp("## READ0 (worker:///a worker:///b)", "READ"),
        parseOp("## FOLD0 (log:///1/1/1/READ, log:///1/1/2/READ)", "FOLD"),
        parseOp("## OPEN0 (log:///1/1/1/READ, worker:///notes.md https://example.com)", "OPEN"),
    ];

    assert.deepEqual(
        statements.map((statement) => expandSafeUriTargetGroup(statement).map(({ target }) => target?.raw)),
        [
            ["worker:///a", "worker:///b"],
            ["log:///1/1/1/READ", "log:///1/1/2/READ"],
            ["log:///1/1/1/READ", "worker:///notes.md", "https://example.com"],
        ],
    );
});

test("{§safe-uri-target-groups}: expansion preserves every non-target statement field", () => {
    const original: OpenStatement = {
        op: "OPEN",
        delimiter: "suffix",
        annotation: "inspect both",
        signal: ["memory"],
        target: {
            kind: "url",
            raw: "worker:///a worker:///b",
            scheme: "worker",
            username: null,
            password: null,
            hostname: null,
            port: null,
            pathname: "/a%20worker:///b",
            query: null,
            fragment: null,
        },
        metadata: ["trace: one"],
        lineMarker: { marks: [2, 4] },
        body: { dialect: "glob", raw: "*.md" },
        position: { line: 7, column: 3 },
    };

    const expanded = expandSafeUriTargetGroup(original);
    assert.equal(expanded.length, 2);
    for (const statement of expanded) {
        assert.deepEqual(
            { ...statement, target: null },
            { ...original, target: null },
        );
    }
});

test("{§safe-uri-target-groups}: ambiguous or ineligible targets remain one exact statement", () => {
    const statements = [
        parseOp("## READ0 (notes and plans.md)", "READ"),
        parseOp("## READ0 (alpha,beta.md)", "READ"),
        parseOp("## READ0 (worker:///a local.md)", "READ"),
        parseOp("## READ0 (https://example.com/a,b)", "READ"),
        parseOp("## READ0 (worker:///notes%20and%20plans.md)", "READ"),
        parseOp("## FOLD0 (log:///1/1/*/{PLAN,READ})", "FOLD"),
        parseOp("## FIND0 (worker:///a worker:///b)", "FIND"),
        parseOp("## EDIT0 (worker:///a worker:///b)\nreplacement", "EDIT"),
        parseOp("## COPY0 (worker:///a worker:///b)\nworker:///destination", "COPY"),
        parseOp("## MOVE0 (worker:///a worker:///b)\nworker:///destination", "MOVE"),
    ];

    for (const statement of statements) {
        assert.deepEqual(expandSafeUriTargetGroup(statement), [statement]);
    }
});

test("{§safe-uri-target-groups}: one invalid URI preserves the authored target", () => {
    const statement = parseOp("## READ0 (worker:///valid https://%)", "READ");

    assert.deepEqual(expandSafeUriTargetGroup(statement), [statement]);
});
