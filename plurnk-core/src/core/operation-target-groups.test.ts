import test from "node:test";
import assert from "node:assert/strict";
import { PlurnkParser } from "@plurnk/plurnk-parser";
import { type KillStatement, type PlurnkStatement, type ReadStatement } from "@plurnk/plurnk-contracts";
import { expandTargetGroup } from "./operation-target-groups.ts";

// Fixture executors: every fence tag this file's DSL text writes opens as an executor.
const fixtureExecutors = (text: string): readonly string[] => [...new Set([...text.matchAll(/^`{3,}[0-9]*([a-z][A-Za-z0-9_.+-]*)/gmu)].map((match) => match[1]!))];

const parseOp = (source: string, op: PlurnkStatement["op"]): PlurnkStatement => {
    const parsed = PlurnkParser.parse([
        source, PlurnkParser.frame("NOTE", null),
    ].join("\n"), { executors: fixtureExecutors([
        source, PlurnkParser.frame("NOTE", null),
    ].join("\n")) });
    const item = parsed.items.find(
        (candidate) => candidate.kind === "statement" && candidate.statement.op === op,
    );
    if (item?.kind !== "statement") throw new Error(`fixture did not parse ${op}`);
    return item.statement;
};

test("{§safe-uri-target-groups}: space and comma separators expand in member order", () => {
    const statements = [
        parseOp("````READ (worker:///a worker:///b)````", "READ"),
        parseOp("````KILL (log:///1/1/1/READ, log:///1/1/2/READ)````", "KILL"),
        parseOp("````READ (log:///1/1/1/READ, worker:///notes.md https://example.com)````", "READ"),
        parseOp("````KILL (log:///1/1/1/READ,log:///1/1/2/READ)````", "KILL"),
    ];

    assert.deepEqual(
        statements.map((statement) => expandTargetGroup(statement).map((expanded) => "target" in expanded ? expanded.target?.raw : undefined)),
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
        aside: "inspect both",

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
        matcher: { dialect: "glob", raw: "*.md" }, body: null,
        position: { line: 7, column: 3 },
    };

    const expanded = expandTargetGroup(original);
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
        parseOp("````READ (notes and plans.md)````", "READ"),
        parseOp("````READ (alpha,beta.md)````", "READ"),
        parseOp("````READ (worker:///a local.md)````", "READ"),
        parseOp("````READ (https://example.com/a,b)````", "READ"),
        parseOp("````READ (worker:///notes%20and%20plans.md)````", "READ"),
        parseOp("````KILL (log:///1/1/*/{NEXT,READ})````", "KILL"),
        parseOp("````KILL (worker:///a local.md)````", "KILL"),
        parseOp("````FIND (worker:///a worker:///b)````", "FIND"),
        parseOp("````EDIT (worker:///a worker:///b)\nreplacement\n````", "EDIT"),
        parseOp("````COPY (worker:///a worker:///b) (worker:///destination)````", "COPY"),
        parseOp("````MOVE (worker:///a worker:///b) (worker:///destination)````", "MOVE"),
    ];

    for (const statement of statements) {
        assert.deepEqual(expandTargetGroup(statement), [statement]);
    }
});

test("{§safe-uri-target-groups}: one invalid URI preserves the authored target", () => {
    const statement = parseOp("````READ (worker:///valid https://%)````", "READ");

    assert.deepEqual(expandTargetGroup(statement), [statement]);
});

test("{§target-group} {§safe-uri-target-groups}: a slot group is one member per slot, any target kind, each with its own selection", () => {
    const kill = expandTargetGroup(parseOp('````KILL (log:///1/1/2/FIND) (log:///1/2/3/READ) <23,-1> (notes.md) [{"keep":1}] <!-- free the room -->````', "KILL")) as KillStatement[];
    assert.deepEqual(kill.map(({ target, lineMarker, metadata }) => [target?.raw, lineMarker?.marks ?? null, metadata]), [
        ["log:///1/1/2/FIND", null, null],
        ["log:///1/2/3/READ", [23, -1], null],
        ["notes.md", null, ['{"keep":1}']],
    ]);
    assert.ok(kill.every((member) => !("group" in member) && member.aside === "free the room"), "members are ordinary statements sharing the aside");
});

test("{§target-group} {§safe-uri-target-groups}: the heading's naked pattern is every member's; a slot's own pattern option is that member's", () => {
    const shared = expandTargetGroup(parseOp("````READ (a.md) (b.md) /TODO/````", "READ")) as ReadStatement[];
    assert.deepEqual(shared.map(({ matcher }) => matcher?.raw), ["/TODO/", "/TODO/"]);
    const own = expandTargetGroup(parseOp('````READ (a.md) [{"pattern": "/one/"}] (b.md) [{"pattern": "/two/"}] (c.md)````', "READ")) as ReadStatement[];
    assert.deepEqual(own.map(({ matcher }) => matcher?.raw ?? null), ["/one/", "/two/", null]);
});

test("{§target-group} {§log-kill-distillation}: a distilling body lands once, with the first member", () => {
    const members = expandTargetGroup(parseOp("````KILL (log:///1/2/3/READ) (log:///1/3/2/FIND)\nBoth held the same fact.\n````", "KILL")) as KillStatement[];
    assert.deepEqual(members.map(({ body }) => body), ["Both held the same fact.", null]);
});
