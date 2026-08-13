/**
 * GBNF compatibility tests exercise both deliberate examples and seeded
 * derivations against the exported rule model. {§gbnf-rail-purpose}
 */

import test from "node:test";
import assert from "node:assert/strict";
import { PlurnkParser } from "../../src/index.ts";
import {
    buildModel,
    serializeGbnf,
    type GItem,
    type GModel,
    type GSeq,
} from "../../scriptify/generate-gbnf.ts";

const model = buildModel();

const inClass = (item: Extract<GItem, { kind: "cls" }>, cp: number): boolean => {
    const hit = item.ranges.some(([start, end]) => cp >= start && cp <= end);
    return item.negate ? !hit : hit;
};

const derives = (entry: string, input: string): boolean => {
    const memo = new Map<string, number[]>();

    const matchItem = (item: GItem, position: number): number[] => {
        switch (item.kind) {
            case "lit":
                return input.startsWith(item.text, position) ? [position + item.text.length] : [];
            case "cls": {
                if (position >= input.length) return [];
                const codePoint = input.codePointAt(position)!;
                return inClass(item, codePoint) ? [position + String.fromCodePoint(codePoint).length] : [];
            }
            case "ref":
                return matchRule(item.name, position);
            case "rep": {
                const reached = new Set<number>(item.min === 0 ? [position] : []);
                let frontier = [position];
                let count = 0;
                while (frontier.length > 0 && count < item.max) {
                    const next = new Set<number>();
                    for (const current of frontier) {
                        for (const end of matchItem(item.item, current)) {
                            if (end > current && !reached.has(end)) next.add(end);
                        }
                    }
                    count++;
                    if (count >= item.min) for (const end of next) reached.add(end);
                    frontier = [...next];
                }
                return [...reached];
            }
        }
    };

    const matchSequence = (sequence: GSeq, position: number): number[] => {
        let positions = [position];
        for (const item of sequence) {
            const next = new Set<number>();
            for (const current of positions) {
                for (const end of matchItem(item, current)) next.add(end);
            }
            positions = [...next];
            if (positions.length === 0) return [];
        }
        return positions;
    };

    const matchRule = (name: string, position: number): number[] => {
        const key = `${name}:${position}`;
        const cached = memo.get(key);
        if (cached) return cached;
        memo.set(key, []);
        const rule = model.get(name);
        assert.ok(rule, `GBNF model has no rule named ${name}`);
        const ends = new Set<number>();
        for (const alternative of rule) {
            for (const end of matchSequence(alternative, position)) ends.add(end);
        }
        const result = [...ends];
        memo.set(key, result);
        return result;
    };

    return matchRule(entry, 0).includes(input.length);
};

const mulberry32 = (seed: number): (() => number) => () => {
    seed |= 0;
    seed = (seed + 0x6D2B79F5) | 0;
    let value = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value;
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
};

const minimumLengths = (() => {
    const lengths = new Map<string, number>([...model.keys()].map((name) => [name, Infinity]));
    const itemMinimum = (item: GItem): number => {
        switch (item.kind) {
            case "lit": return item.text.length;
            case "cls": return 1;
            case "ref": return lengths.get(item.name)!;
            case "rep": return item.min * itemMinimum(item.item);
        }
    };
    let changed = true;
    while (changed) {
        changed = false;
        for (const [name, alternatives] of model) {
            const next = Math.min(...alternatives.map((sequence) =>
                sequence.reduce((total, item) => total + itemMinimum(item), 0)));
            if (next < lengths.get(name)!) {
                lengths.set(name, next);
                changed = true;
            }
        }
    }
    return lengths;
})();

const SAMPLE_POOL = [...Array.from({ length: 0x7F - 0x20 }, (_, index) => 0x20 + index), 0x0A];

const sample = (entry: string, random: () => number): string => {
    let budget = 240;
    const sampleSequence = (sequence: GSeq): string => sequence.map(sampleItem).join("");
    const sampleItem = (item: GItem): string => {
        switch (item.kind) {
            case "lit":
                budget -= item.text.length;
                return item.text;
            case "cls": {
                budget--;
                const pool = item.negate
                    ? SAMPLE_POOL.filter((codePoint) => inClass(item, codePoint))
                    : item.ranges.flatMap(([start, end]) =>
                        Array.from({ length: end - start + 1 }, (_, index) => start + index));
                return String.fromCodePoint(pool[Math.floor(random() * pool.length)]!);
            }
            case "ref": {
                const alternatives = model.get(item.name)!;
                const sequenceMinimum = (sequence: GSeq): number => sequence.reduce((total, child) => {
                    if (child.kind === "ref") return total + minimumLengths.get(child.name)!;
                    if (child.kind === "rep") return total + (child.min === 0 ? 0 : sequenceMinimum([child.item]));
                    return total + (child.kind === "lit" ? child.text.length : 1);
                }, 0);
                const alternative = budget <= 0
                    ? alternatives.toSorted((left, right) => sequenceMinimum(left) - sequenceMinimum(right))[0]!
                    : alternatives[Math.floor(random() * alternatives.length)]!;
                return sampleSequence(alternative);
            }
            case "rep": {
                let count = item.min;
                while (count < item.max && budget > 0 && random() < 0.6) count++;
                return Array.from({ length: count }, () => sampleItem(item.item)).join("");
            }
        }
    };
    return sampleSequence([{ kind: "ref", name: entry }]);
};

const CHANNEL_OPEN = "<|channel>thought\n";
const CHANNEL_CLOSE = "<channel|>";
const channel = (body = ""): string => `${CHANNEL_OPEN}${body}${CHANNEL_CLOSE}`;
const derivesTurn = (content: string, reasoning = "", separator = ""): boolean =>
    derives("root-turn", `${channel(reasoning)}${separator}${content}`);

const plan = (body: string): string => `# PLAN0\n${body}\n\n`;
const mid = (op: string, slots = "", body?: string): string =>
    body === undefined ? `## ${op}0${slots}\n\n` : `## ${op}0${slots}\n${body}\n\n`;
const terminal = (code: number, body: string, slots = ""): string => `## SEND0 [${code}]${slots}\n${body}`;
const turn = (planBody: string, operations: string[], code = 200, sendBody = "done", sendSlots = ""): string =>
    `${plan(planBody)}${operations.join("")}${terminal(code, sendBody, sendSlots)}`;

// {§gbnf-turn-shape}
test("GBNF root requires PLAN first and one terminal SEND last", () => {
    assert.equal(derivesTurn(turn("decompose", [mid("READ", " (worker:///x)")], 102, "reading")), true);
    assert.equal(derivesTurn(turn("answer", [], 200, "Paris")), true);
    assert.equal(derivesTurn(`${mid("READ", " (worker:///x)")}${terminal(102, "reading")}`), false);
    assert.equal(derivesTurn(plan("incomplete")), false);
    assert.equal(derivesTurn(`${plan("p")}stray prose\n${terminal(200, "done")}`), false);
});

test("GBNF optionally frames the complete PLURNK document in a paired fence", () => {
    const content = turn("decompose", [mid("READ", " (worker:///x)")], 102, "reading");
    assert.equal(derivesTurn(content), true);
    assert.equal(derivesTurn(`\`\`\`plurnk\n${content}\n\`\`\``), true);
    assert.equal(derivesTurn(`\`\`\`plurnk\n${content}`), false);
});

// {§no-idle-102}
test("GBNF excludes zero-operation 102 and restores it after one internal operation", () => {
    assert.equal(derivesTurn(turn("think", [], 102, "working")), false);
    assert.equal(derivesTurn(turn("think", [], 102, "working", " (worker://~)")), false);
    assert.equal(derivesTurn(turn("think", [mid("READ", " (worker:///x)")], 102, "working")), true);
    assert.equal(derivesTurn(turn("think", [mid("SEND", "", "progress")], 102, "working")), true);
    for (const code of [200, 202, 300, 499]) {
        assert.equal(derivesTurn(turn("think", [], code, "terminal")), true, String(code));
    }

    const tolerant = PlurnkParser.parse(`${plan("think")}${terminal(102, "working")}`);
    assert.deepEqual(tolerant.items.filter((item) => item.kind === "error"), []);
});

// {§gbnf-reasoning-boundary}
test("GBNF root has exactly one leading Harmony reasoning channel", () => {
    const content = turn("intent", [], 200, "answer");
    assert.equal(derivesTurn(content, "Analyze the task."), true);
    assert.equal(derivesTurn(content), true);
    assert.equal(derivesTurn(content, "reason", "\n \t"), true);
    assert.equal(derivesTurn(content, "reason", " ".repeat(7)), true);
    assert.equal(derives("root-turn", content), false);
    assert.equal(derives("root-turn", `${channel("first")}${channel("second")}${content}`), false);
    assert.equal(derivesTurn(content, "reason", " ".repeat(8)), false);
    assert.equal(derivesTurn(content, "reason", " prose "), false);
    assert.equal(derives("root-turn", `<think>reasoning</think>${content}`), false);
    assert.equal(derives("root-turn", channel("reason")), false);
});

test("reasoning channel rejects nested channel delimiters and cannot recur after PLAN", () => {
    const content = turn("p", [mid("READ", " (worker:///x)")], 102, "waiting");
    assert.equal(derives("channel", `${CHANNEL_OPEN}outer ${CHANNEL_OPEN}inner${CHANNEL_CLOSE}`), false);
    assert.equal(derivesTurn(`${plan("p")}${channel("between")}${terminal(200, "done")}`), false);
    assert.equal(derivesTurn(content, "one uninterrupted reasoning span"), true);
});

test("ANTLR preserves provider preamble text before the PLAN anchor", () => {
    const source = `plain preamble\n${turn("do the thing", [mid("READ", " (worker:///x)")], 200, "done")}`;
    const result = PlurnkParser.parse(source);
    assert.deepEqual(result.items.filter((item) => item.kind === "error"), []);
    assert.deepEqual(
        result.items.filter((item) => item.kind === "text").map(({ text }) => text),
        ["plain", "preamble"],
    );
    assert.equal(result.items.find((item) => item.kind === "statement")?.statement.op, "PLAN");
});

test("ANTLR recognizes a PLAN anchor directly after provider preamble text", () => {
    const source = `harmless status.${turn("do the thing", [mid("READ", " (worker:///x)")], 200, "done")}`;
    const result = PlurnkParser.parse(source);
    assert.deepEqual(result.items.filter((item) => item.kind === "error"), []);
    assert.deepEqual(
        result.items.filter((item) => item.kind === "text").map(({ text }) => text),
        ["harmless", "status."],
    );
    assert.deepEqual(
        result.items.filter((item) => item.kind === "statement").map(({ statement }) => statement.op),
        ["PLAN", "READ", "SEND"],
    );
    assert.deepEqual(
        result.items.find((item) => item.kind === "statement")?.statement.position,
        { line: 1, column: "harmless status.".length },
    );
});

test("separator-free PLAN tolerance does not promote ordinary hashes or inline operations", () => {
    const source = `ordinary.# PLAN0! remains preamble\n${turn(
        "keep inline ## READ0 (worker:///not-an-operation) as body",
        [],
        200,
        "done",
    )}`;
    const result = PlurnkParser.parse(source);
    assert.deepEqual(result.items.filter((item) => item.kind === "error"), []);
    assert.deepEqual(
        result.items.filter((item) => item.kind === "text").map(({ text }) => text),
        ["ordinary.", "#", "PLAN0!", "remains", "preamble"],
    );
    const statements = result.items.filter((item) => item.kind === "statement").map(({ statement }) => statement);
    assert.deepEqual(statements.map(({ op }) => op), ["PLAN", "SEND"]);
    assert.equal(statements[0]?.body, "keep inline ## READ0 (worker:///not-an-operation) as body");
});

// {§park-202-only} {§waitpid-dispositions}
test("GBNF terminal dispositions and 202 park scope are bounded", () => {
    assert.equal(derivesTurn(turn("p", [], 202, "bounded", " <30>")), true);
    assert.equal(derivesTurn(turn("p", [], 202, "polled", " <30,5>")), true);
    assert.equal(derivesTurn(turn("p", [], 202, "indefinite", " <-1>")), true);
    assert.equal(derivesTurn(turn("p", [], 202, "targeted", " (worker://parent) <30,5>")), true);
    assert.equal(derivesTurn(turn("p", [], 200, "no park", " <30>")), false);
    assert.equal(derivesTurn(turn("p", [], 499, "abort")), true);
    assert.equal(derivesTurn(turn("p", [], 300, "choose")), true);
    assert.equal(derivesTurn(turn("p", [], 500, "invalid")), false);
});

test("GBNF admits canonical authenticated HTTP and WebSocket targets", () => {
    for (const target of [
        "https://user:pass@example.test:8443/path?q=1#frag",
        "ws://example.test/socket",
        "wss://example.test/socket",
    ]) {
        assert.equal(derivesTurn(turn("read", [mid("READ", ` (${target})`)], 102, "reading")), true, target);
    }
});

test("GBNF permits fourteen internal operations, rejects fifteen, and always needs a terminal", () => {
    const operation = mid("READ", " (worker:///x)");
    assert.equal(derivesTurn(turn("p", Array.from({ length: 14 }, () => operation), 102, "done")), true);
    assert.equal(derivesTurn(turn("p", Array.from({ length: 15 }, () => operation), 102, "done")), false);
    assert.equal(derivesTurn(`${plan("p")}${operation.repeat(14)}`), false);
});

test("GBNF matcher bodies are one line while content bodies may be multiline", () => {
    assert.equal(derivesTurn(turn("p", [mid("FIND", " (a)", "/needle/i")], 102, "done")), true);
    assert.equal(derivesTurn(turn("p", [mid("FIND", " (a)", "line one\nline two")], 102, "done")), false);
    assert.equal(derivesTurn(turn("p", [mid("EDIT", " (a)", "line one\nline two")], 102, "done")), true);
    assert.equal(derivesTurn(turn("p", [], 200, "multi\nline")), true);
});

test("GBNF permits Base62 line anchors only on EDIT", () => {
    assert.equal(
        derivesTurn(turn("p", [mid("EDIT", " (worker:///x) <@aZ09b>", "replacement")], 102, "done")),
        true,
    );
    assert.equal(
        derivesTurn(turn("p", [mid("EDIT", " (worker:///x) <@aZ09b,@0Aa9Z>", "replacement")], 102, "done")),
        true,
    );
    assert.equal(
        derivesTurn(turn("p", [mid("READ", " (worker:///x) <@aZ09b>")], 102, "done")),
        false,
    );
});

// {§gbnf-curation-shaping}
test("GBNF OPEN and FOLD shape curation syntax while the parser owns selection validity", () => {
    for (const op of ["OPEN", "FOLD"]) {
        assert.equal(derivesTurn(turn("p", [mid(op, " [memory]")], 102, "done")), true, `${op} targetless tag filter`);
        assert.equal(derivesTurn(turn("p", [mid(op, "", "needle")], 102, "done")), true, `${op} matcher-only selection`);
        assert.equal(derivesTurn(turn("p", [mid(op, " [memory,+archive,-stale] (log:///**)", "needle")], 102, "done")), true, op);
        assert.equal(derivesTurn(turn("p", [mid(op, " [+archive,memory,-stale]")], 102, "done")), true, `${op} mixed curation terms`);
        assert.equal(derivesTurn(turn("p", [mid(op, " [+archive] (log:///**)")], 102, "done")), true, `${op} target-selected mutation`);
        assert.equal(derivesTurn(turn("p", [mid(op, " [+archive]", "needle")], 102, "done")), true, `${op} matcher-selected mutation`);

        const signedOnly = turn("p", [mid(op, " [+archive]")], 102, "done");
        assert.equal(derivesTurn(signedOnly), true, `${op} rail leaves selector validity to the parser`);
        assert.deepEqual(
            PlurnkParser.parse(signedOnly).items
                .filter((item) => item.kind === "error")
                .map((item) => item.error.message),
            ["signed tags modify selected log items but do not select them - add a path, body pattern, or unsigned tag"],
        );

        const localTarget = turn("p", [mid(op, " (notes.md)")], 102, "done");
        assert.equal(derivesTurn(localTarget), false, `${op} rail emits canonical log targets only`);
        assert.deepEqual(
            PlurnkParser.parse(localTarget).items.filter((item) => item.kind === "error"),
            [],
            `${op} tolerant ingestion leaves target ownership to runtime`,
        );
        assert.equal(derivesTurn(turn("p", [mid(op, " [memory] (log:///**) <1,2>")], 102, "done")), false, op);
    }
});

// {§empty-section}
test("GBNF represents every rail-legal empty operation as an empty section", () => {
    const cases = [
        ["FIND", " (a)", true],
        ["READ", " (a)", true],
        ["EDIT", " (a) <1>", true],
        ["COPY", " (a)", false],
        ["MOVE", " (a)", false],
        ["OPEN", " (log:///1)", true],
        ["FOLD", " (log:///1)", true],
        ["EXEC", "", true],
        ["BARE", "", false],
        ["WORK", " (worker://child)", false],
        ["FORK", " (worker://child)", false],
        ["KILL", " (worker://child)", true],
        ["SEND", "", true],
    ] as const;

    for (const [op, slots, admitted] of cases) {
        assert.equal(derives("statement", mid(op, slots)), admitted, op);
    }
});

// {§destination-scope-boundary}
test("GBNF COPY and MOVE destinations admit a terminal scope without residue", () => {
    for (const op of ["COPY", "MOVE"]) {
        assert.equal(derives("statement", mid(op, " (worker:///src.md)", "worker:///slice.md<0>")), true, op);
        assert.equal(derives("statement", mid(op, " (worker:///src.md)", "worker:///slice.md<0>:")), true, `${op} rail leaves semantic rejection to AstBuilder`);
    }
});

// {§send-mid-reservation}
test("GBNF mid-turn SENDs are statusless or carry non-disposition three-digit codes", () => {
    assert.equal(derivesTurn(turn("p", [mid("SEND", "", "progress")], 200, "done")), true);
    assert.equal(derivesTurn(turn("p", [mid("SEND", " (worker://child)", "progress")], 200, "done")), true);
    assert.equal(derivesTurn(turn("p", [mid("SEND", " [400]", "progress")], 200, "done")), true);
    assert.equal(derivesTurn(turn("p", [mid("SEND", " [400] (worker://child)")], 200, "done")), true);
    for (const code of [102, 200, 202, 300, 499]) {
        assert.equal(derivesTurn(turn("p", [mid("SEND", ` [${code}]`, "not terminal")], 200, "done")), false, String(code));
    }
    assert.equal(derives("send-statement", "## SEND0 [40]\nmessage\n\n"), false);
    assert.equal(derives("send-statement", "## SEND0 [4000]\nmessage\n\n"), false);
});

test("GBNF BARE, EXEC, WORK, and FORK retain their operation-specific slots and bodies", () => {
    assert.equal(derives("statement", mid("EXEC", " [node] (./) <60,5>", "npm test")), true);
    assert.equal(derives("statement", mid("EXEC", " <60,5> [node] (./)", "npm test")), false);
    assert.equal(derives("statement", mid("BARE", " [+fact]", "What is the capital of Germany?")), true);
    assert.equal(derives("statement", mid("BARE", "", "prompt")), true);
    assert.equal(derives("statement", mid("BARE", " [-stale]", "prompt")), false);
    assert.equal(derives("statement", mid("BARE", " (worker://child)", "prompt")), false);
    assert.equal(derives("statement", mid("BARE", " <1>", "prompt")), false);
    assert.equal(derives("statement", mid("BARE")), false);
    assert.equal(derives("statement", mid("WORK", " [feature/x] (worker://child)", "implement it")), true);
    assert.equal(derives("statement", mid("FORK", " (worker://child)", "recheck it")), true);
    assert.equal(derives("statement", mid("WORK", " (worker://child)")), false);
    assert.equal(derives("statement", mid("FORK", " (worker://child)")), false);
});

test("GBNF PLAN is a nonempty slotless H1 lane-0 anchor only", () => {
    assert.equal(derivesTurn(turn("intent", [], 200, "done")), true);
    assert.equal(derivesTurn(`# PLAN0 [tag]\nintent\n\n${terminal(200, "done")}`), false);
    assert.equal(derivesTurn(`# PLAN0\n\n${terminal(200, "done")}`), false);
    assert.equal(derivesTurn(`# PLAN\nintent\n\n${terminal(200, "done")}`), false);
    assert.equal(derivesTurn(`# PLANouter\nintent\n\n${terminal(200, "done")}`), false);
    assert.equal(derives("statement", mid("PLAN", "", "intent")), false);
});

// {§rail-heading-boundaries}
test("GBNF reserves every operation heading stem for canonical lane 0", () => {
    assert.equal(derivesTurn(turn("quote ## READ0 here", [], 200, "done")), false);
    assert.equal(derivesTurn(turn("# PLAN2\nquoted plan\n\n## SEND2 [200]\nquoted answer", [], 200, "done")), false);
    assert.equal(derives("statement", mid("EDIT", " (note.md)", "## READ0 (x)")), false);
    assert.equal(derives("statement", mid("EDIT", " (note.md)", "## READ2 (x)")), false);
    assert.equal(derives("statement", mid("EXEC", " [sh]", "pwd\n\n## SEND0 [102]\nnot a terminal section")), false);
});

test("GBNF terminal SEND body is required and target is optional", () => {
    assert.equal(derivesTurn(turn("p", [], 200, "done")), true);
    assert.equal(derivesTurn(turn("p", [], 200, "done", " (worker://parent)")), true);
    assert.equal(derivesTurn(`${plan("p")}## SEND0 [200]`), false);
    assert.equal(derivesTurn(`${plan("p")}## SEND0 [200]\n`), false);
});

test("GBNF fixes lane 0 and canonical comma scopes while ANTLR tolerates wider lanes and dash scopes", () => {
    assert.equal(derives("statement", "## READ0 (x)\n\n"), true);
    assert.equal(derives("statement", "## READouter (x)\n\n"), false);
    assert.equal(derives("statement", "## READ (x)\n\n"), false);
    assert.equal(derives("statement", "## READ0 (x) <1,5>\n\n"), true);
    assert.equal(derives("statement", "## READ0 (x) <1-5>\n\n"), false);

    assert.equal(PlurnkParser.parseStatements("## READouter (x) <1-5>").items.some((item) => item.kind === "error"), false);
    assert.equal(PlurnkParser.parseStatements("## READ (x) <1-5>").items.some((item) => item.kind === "error"), false);
});

// {§path-parentheses}
test("GBNF targets require canonical escaping for delimiters and parentheses", () => {
    assert.equal(derives("statement", "## READ0 (https://example.test/a%28b%29)\n\n"), true);
    assert.equal(derives("statement", String.raw`## READ0 (https://example.test/a\(b\))

`), true);
    assert.equal(derives("statement", "## READ0 (https://example.test/a(b))\n\n"), false);
    assert.equal(derives("statement", "## READ0 (a<b)\n\n"), false);
});

// {§slot-order}
test("GBNF emits spaced canonical slot order while ANTLR accepts spaced permutations", () => {
    const canonical = "## FIND0 [+tag] (source) <1,5>\nneedle\n\n";
    const implicit = "## FIND0 [tag] (source) <1,5>\nneedle\n\n";
    const reordered = "## FIND0 (source) [+tag] <1,5>\nneedle\n\n";
    const compact = "## FIND0 [+tag](source)<1,5>\nneedle\n\n";
    assert.equal(derives("statement", canonical), true);
    assert.equal(derives("statement", implicit), false);
    assert.equal(derives("statement", reordered), false);
    assert.equal(derives("statement", compact), false);
    assert.equal(PlurnkParser.parseStatements(reordered).items.some((item) => item.kind === "error"), false);
    assert.equal(PlurnkParser.parseStatements(implicit).items.some((item) => item.kind === "error"), false);
    assert.equal(PlurnkParser.parseStatements(compact).items.some((item) => item.kind === "error"), false);
});

test("GBNF preserves signs as operators only at the start of a tag term", () => {
    assert.equal(derives("statement", "## FIND0 [+a+b-c] (source)\n\n"), true);
    assert.equal(derives("statement", "## FIND0 [+-tag] (source)\n\n"), false);
    assert.equal(derives("statement", "## FOLD0 [a+b-c,-stale+old] (log:///**)\n\n"), true);
});

test("representative rail turns round-trip through ANTLR", () => {
    for (const content of [
        turn("read", [mid("READ", " (worker:///x)")], 102, "reading"),
        turn("edit", [mid("EDIT", " [+draft] (notes.md) <2>", "replacement")], 200, "done"),
        turn("delegate", [mid("WORK", " (worker://child)", "do it")], 202, "waiting"),
    ]) {
        assert.equal(derivesTurn(content, "reasoning"), true, content);
        const parsed = PlurnkParser.parse(content);
        assert.deepEqual(parsed.items.filter((item) => item.kind === "error"), [], content);
        assert.equal(parsed.unparsedTail, undefined, content);
    }
});

test("rail-legal malformed matcher remains one bounded AstBuilder error", () => {
    const content = turn("find", [mid("FIND", " (data.json)", "$[(")], 102, "searching");
    assert.equal(derivesTurn(content), true);
    const parsed = PlurnkParser.parse(content);
    const errors = parsed.items.filter((item) => item.kind === "error");
    assert.equal(errors.length, 1);
    assert.equal(errors[0]?.error.source, "visitor");
    assert.equal(parsed.unparsedTail, undefined);
});

test("100 seeded turn derivations preserve the PLAN-through-terminal-SEND frame", () => {
    for (let seed = 1; seed <= 100; seed++) {
        const generated = sample("root-turn", mulberry32(seed));
        assert.equal(derives("root-turn", generated), true, `seed ${seed}`);
        assert.ok(generated.startsWith(CHANNEL_OPEN), `seed ${seed}`);
        assert.ok(generated.includes("# PLAN0\n"), `seed ${seed}`);
        const projected = generated.slice(generated.indexOf(CHANNEL_CLOSE) + CHANNEL_CLOSE.length).trimStart();
        const result = PlurnkParser.parse(projected);
        assert.equal(result.unparsedTail, undefined, `seed ${seed}`);
        const statements = result.items.filter((item) => item.kind === "statement");
        assert.equal(statements[0]?.statement.op, "PLAN", `seed ${seed}`);
        assert.equal(statements.at(-1)?.statement.op, "SEND", `seed ${seed}`);
        assert.ok(
            result.items.filter((item) => item.kind === "error").every((item) => item.error.source === "visitor"),
            `seed ${seed}: ${JSON.stringify(result.items)}`,
        );
    }
});

test("300 seeded statement derivations build one statement or one bounded visitor error", () => {
    for (let seed = 1; seed <= 300; seed++) {
        const generated = sample("statement", mulberry32(10_000 + seed));
        assert.equal(derives("statement", generated), true, `seed ${seed}`);
        const result = PlurnkParser.parseStatements(generated);
        assert.equal(result.unparsedTail, undefined, `seed ${seed}: ${JSON.stringify(result)}`);
        const statements = result.items.filter((item) => item.kind === "statement");
        const errors = result.items.filter((item) => item.kind === "error");
        assert.equal(statements.length + errors.length, 1, `seed ${seed}: ${JSON.stringify(result.items)}`);
        assert.ok(errors.every((item) => item.error.source === "visitor"), `seed ${seed}: ${JSON.stringify(errors)}`);
    }
});

test("serialized GBNF has one root and no undefined references", () => {
    const serialized = serializeGbnf(model, "root-turn");
    assert.match(serialized, /^root ::= root-turn$/m);
    const references = new Set<string>();
    for (const alternatives of model.values()) {
        const visit = (item: GItem): void => {
            if (item.kind === "ref") references.add(item.name);
            else if (item.kind === "rep") visit(item.item);
        };
        for (const sequence of alternatives) for (const item of sequence) visit(item);
    }
    for (const reference of references) assert.ok(model.has(reference), reference);
});

test("test recognizer can inspect alternate serialized roots", () => {
    const tiny: GModel = new Map([
        ["root", [[{ kind: "ref", name: "word" }]]],
        ["word", [[{ kind: "lit", text: "ok" }]]],
    ]);
    assert.match(serializeGbnf(tiny, "root"), /word ::= "ok"/);
});
