import test from "node:test";
import assert from "node:assert/strict";
import {
    PlurnkParser,
    type KillStatement,
    type PlurnkStatement,
} from "@plurnk/plurnk-contracts";
import { expandSafeUriTargetGroup } from "./operation-target-groups.ts";

const parseOp = (source: string, op: PlurnkStatement["op"]): PlurnkStatement => {
    const parsed = PlurnkParser.parse(`## PLAN_\n\n${source}\n\n### SEND_ (NEXT)`);
    const item = parsed.items.find(
        (candidate) => candidate.kind === "statement" && candidate.statement.op === op,
    );
    if (item?.kind !== "statement") throw new Error(`fixture did not parse ${op}`);
    return item.statement;
};

test("{§safe-uri-target-groups}: space and comma separators expand in member order", () => {
    const statements = [
        parseOp("### READ_ (worker:///a worker:///b)", "READ"),
        parseOp("### KILL_ (log:///1/1/1/READ, log:///1/1/2/READ)", "KILL"),
        parseOp("### READ_ (log:///1/1/1/READ, worker:///notes.md https://example.com)", "READ"),
        parseOp("### KILL_ (log:///1/1/1/READ,log:///1/1/2/READ)", "KILL"),
    ];

    assert.deepEqual(
        statements.map((statement) => expandSafeUriTargetGroup(statement).map((expanded) => "target" in expanded ? expanded.target?.raw : undefined)),
        [
            ["worker:///a", "worker:///b"],
            ["log:///1/1/1/READ", "log:///1/1/2/READ"],
            ["log:///1/1/1/READ", "worker:///notes.md", "https://example.com"],
            ["log:///1/1/1/READ", "log:///1/1/2/READ"],
        ],
    );
});

test("{§safe-uri-target-groups}: expansion preserves every non-target statement field", () => {
    const original: KillStatement = {
        op: "KILL",
        delimiter: "suffix",
        annotation: "inspect both",

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
        parseOp("### READ_ (notes and plans.md)", "READ"),
        parseOp("### READ_ (alpha,beta.md)", "READ"),
        parseOp("### READ_ (worker:///a local.md)", "READ"),
        parseOp("### READ_ (https://example.com/a,b)", "READ"),
        parseOp("### READ_ (worker:///notes%20and%20plans.md)", "READ"),
        parseOp("### KILL_ (log:///1/1/*/{PLAN,READ})", "KILL"),
        parseOp("### KILL_ (worker:///a local.md)", "KILL"),
        parseOp("### FIND_ (worker:///a worker:///b)", "FIND"),
        parseOp("### EDIT_ (worker:///a worker:///b)\nreplacement", "EDIT"),
        parseOp("### COPY_ (worker:///a worker:///b) (worker:///destination)", "COPY"),
        parseOp("### MOVE_ (worker:///a worker:///b) (worker:///destination)", "MOVE"),
    ];

    for (const statement of statements) {
        assert.deepEqual(expandSafeUriTargetGroup(statement), [statement]);
    }
});

test("{§safe-uri-target-groups}: one invalid URI preserves the authored target", () => {
    const statement = parseOp("### READ_ (worker:///valid https://%)", "READ");

    assert.deepEqual(expandSafeUriTargetGroup(statement), [statement]);
});
