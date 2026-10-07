import test from "node:test";
import assert from "node:assert/strict";
import type { KillStatement, PlurnkStatement, ReadStatement } from "@plurnk/plurnk-contracts";
import PlurnkParser from "./PlurnkParser.ts";

const operations = (source: string): PlurnkStatement[] => {
    const parsed = PlurnkParser.parse(source);
    assert.deepEqual(parsed.items.filter((item) => item.kind === "error" && item.error.severity === "error"), [], source);
    return parsed.items.flatMap((item) => item.kind === "statement" ? [item.statement] : []);
};

test("{§target-group}: READ and KILL compile each path's scope and metadata into ordinary statements", () => {
    const kill = operations('````KILL (log:///1/1/2/FIND) (log:///1/2/3/READ) <23,-1> (notes.md) [{"keep":1}] <!-- free the room -->````') as KillStatement[];
    assert.deepEqual(kill.map(({ target, lineMarker, metadata }) => [target?.raw, lineMarker?.marks ?? null, metadata]), [
        ["log:///1/1/2/FIND", null, null],
        ["log:///1/2/3/READ", [23, -1], null],
        ["notes.md", null, ['{"keep":1}']],
    ]);
    assert.ok(kill.every((member) => !("group" in member) && member.aside === "free the room"));
    assert.deepEqual(kill.map(({ position }) => position), [{ line: 1, column: 0 }, { line: 1, column: 0 }, { line: 1, column: 0 }]);
    const read = operations("````READ (a.md) <1,3> (b.md)````") as ReadStatement[];
    assert.deepEqual(read.map(({ target, lineMarker }) => [target?.raw, lineMarker?.marks ?? null]), [["a.md", [1, 3]], ["b.md", null]]);
});

test("{§target-group}: local patterns stay local and an absent default stays absent", () => {
    const own = operations('````READ (a.md) [{"pattern":"/one/"}] (b.md) [{"pattern":"/two/"}] (c.md)````') as ReadStatement[];
    assert.deepEqual(own.map(({ matcher }) => matcher?.raw ?? null), ["/one/", "/two/", null]);
    assert.equal("group" in operations("````READ (a.md) <1,3>````")[0]!, false);
});

test("{§target-group} {§statement-rendering}: canonical statements reparse with identical selections and bodies", () => {
    const withoutPosition = (ops: PlurnkStatement[]) => ops.map(({ position: _position, ...op }) => op);
    for (const source of [
        "```KILL (log:///1/1/2/FIND) (log:///1/2/3/READ) <23,-1> (notes.md) <!-- free the room -->\n```",
        "```READ (a.md) <1,3> (b.md) /TODO/\n```",
        '```READ (a.md) [{"pattern":"/one/"}] (b.md) [{"keep":1}] /shared/\n```',
        "```KILL (log:///1/2/3/READ) (log:///1/3/2/FIND)\nBoth held the same fact: the host is db.internal.\n```",
    ]) {
        const parsed = operations(source);
        assert.ok(parsed.length >= 2, source);
        const rendered = PlurnkParser.stringify(parsed);
        assert.deepEqual(withoutPosition(operations(rendered)), withoutPosition(parsed));
        assert.equal(PlurnkParser.stringify(operations(rendered)), rendered, "canonical rendering is stable");
    }
});

test("{§target-group} {§log-kill-distillation}: distillation lands once; other operations keep their arity", () => {
    for (const paths of ["(log:///1/2/3/READ) (log:///1/3/2/FIND)", "(log:///1/2/3/READ, log:///1/3/2/FIND)"]) {
        const kills = operations(`\`\`\`KILL ${paths}\nBoth held the same fact.\n\`\`\``) as KillStatement[];
        assert.deepEqual(kills.map(({ body }) => body), ["Both held the same fact.", null]);
    }
    for (const op of ["EDIT", "FIND", "LOOK"]) {
        const parsed = PlurnkParser.parseClient(`\`\`\`${op} (a.md) (b.md)\`\`\``);
        const error = parsed.items.find((item) => item.kind === "error" && item.error.severity === "error");
        assert.ok(error?.kind === "error");
        assert.match(error.error.message, /slot opener/u);
    }
    const invalid = PlurnkParser.parse("```KILL (a.md) <1,3> <4,5> (b.md)```");
    assert.equal(invalid.items.some((item) => item.kind === "statement"), false);
    assert.ok(invalid.items.some((item) => item.kind === "error" && /one scope/u.test(item.error.message)));
});

test("{§safe-uri-target-groups}: explicit URI lists compile in member order at the parser boundary", () => {
    for (const [heading, expected] of [
        ["READ (worker:///a worker:///b)", ["worker:///a", "worker:///b"]],
        ["KILL (log:///1/1/1/READ, log:///1/1/2/READ)", ["log:///1/1/1/READ", "log:///1/1/2/READ"]],
        ["READ (log:///1/1/1/READ, worker:///notes.md https://example.com)", ["log:///1/1/1/READ", "worker:///notes.md", "https://example.com"]],
        ["KILL (log:///1/1/1/READ,log:///1/1/2/READ)", ["log:///1/1/1/READ", "log:///1/1/2/READ"]],
    ] as const) {
        const parsed = operations(PlurnkParser.frame(heading, null));
        assert.deepEqual(parsed.map((op) => "target" in op ? op.target?.raw : null), expected);
    }
    const selections = operations('```KILL (worker:///a worker:///b) <2,4> [{"keep":1}] *.md <!-- inspect both -->\n```') as KillStatement[];
    assert.equal(selections.length, 2);
    const expected = { ...selections[0], target: null };
    for (const op of selections) assert.deepEqual({ ...op, target: null }, expected);
    assert.deepEqual(selections[0]?.lineMarker, { marks: [2, 4] });
    assert.deepEqual(selections[0]?.metadata, ['{"keep":1}']);
    assert.equal(selections[0]?.matcher?.raw, "*.md");
    assert.equal(selections[0]?.aside, "inspect both");
});

test("{§safe-uri-target-groups}: ambiguous, invalid and ineligible targets stay singular and exact", () => {
    for (const [op, raw] of [
        ["READ", "notes and plans.md"], ["READ", "alpha,beta.md"],
        ["READ", "worker:///a local.md"], ["READ", "https://example.com/a,b"],
        ["READ", "worker:///notes%20and%20plans.md"], ["KILL", "log:///1/1/*/{NEXT,READ}"],
        ["KILL", "worker:///a local.md"], ["READ", "worker:///valid https://%"],
        ["FIND", "worker:///a worker:///b"], ["EDIT", "worker:///a worker:///b"],
        ["COPY", "worker:///a worker:///b"], ["MOVE", "worker:///a worker:///b"],
    ]) {
        const parsed = operations(PlurnkParser.frame(`${op} (${raw})${op === "COPY" || op === "MOVE" ? " (worker:///destination)" : ""}`, op === "EDIT" ? "replacement" : null));
        assert.equal(parsed.length, 1);
        const statement = parsed[0]!;
        assert.equal(statement.op === "COPY" || statement.op === "MOVE" ? statement.source.target.raw : statement.target?.raw, raw);
    }
});

test("{§reasoning-operations} {§target-group}: reasoning and client tiers receive the same compiled selections", () => {
    const source = "```READ (a) <1,3> (b) /shared/\n```";
    assert.deepEqual(PlurnkParser.parseReasoningOperations(source), operations(source));
    const client = PlurnkParser.parseClient(source);
    assert.deepEqual(client.items.flatMap((item) => item.kind === "statement" ? [item.statement] : []), operations(source));
});

test("{§trailing-slots} {§safe-uri-target-groups}: a URI list in one slot retains that slot's unambiguous recovered scope", () => {
    const parsed = PlurnkParser.parse("```READ (worker:///a worker:///b) /pattern/ <1,3>\n```");
    const ops = parsed.items.flatMap((item) => item.kind === "statement" ? [item.statement] : []);
    assert.equal(ops.length, 2);
    for (const op of ops) {
        assert.ok(op.op === "READ");
        assert.deepEqual(op.lineMarker, { marks: [1, 3] });
        assert.equal(op.matcher?.raw, "/pattern/");
    }
    assert.deepEqual(parsed.items.filter((item) => item.kind === "error").map((item) => item.error.severity), ["warning"]);
});
