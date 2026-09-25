import assert from "node:assert/strict";
import test from "node:test";
import type { EditStatement } from "@plurnk/plurnk-contracts";
import LineAnchors from "./line-anchors.ts";

const identity = "worker:///notes.md";

test("LineAnchors: tokens are deterministic Base62 handles over identity, content, and configured context", () => {
    const content = Array.from({ length: 13 }, (_, index) => `line-${index + 1}`).join("\n");
    const token = LineAnchors.token(identity, 7, content);
    assert.match(token, /^@[0-9A-Za-z]{5}$/);
    assert.equal(LineAnchors.token(identity, 7, content), token);
    assert.notEqual(LineAnchors.token("worker:///other.md", 7, content), token);
    assert.notEqual(LineAnchors.token(identity, 8, content), token);

    const nearby = content.replace("line-5", "changed-nearby");
    const outside = content.replace("line-4", "changed-outside");
    assert.notEqual(LineAnchors.token(identity, 7, nearby), token);
    assert.equal(LineAnchors.token(identity, 7, outside), token);
});

test("LineAnchors: context tuning is hash-domain state and fails hard when missing or malformed", () => {
    const prior = process.env.PLURNK_SERVICE_LINE_ANCHOR_CONTEXT_LINES;
    try {
        process.env.PLURNK_SERVICE_LINE_ANCHOR_CONTEXT_LINES = "2";
        const radiusTwo = LineAnchors.token(identity, 1, "alpha");
        process.env.PLURNK_SERVICE_LINE_ANCHOR_CONTEXT_LINES = "3";
        assert.notEqual(LineAnchors.token(identity, 1, "alpha"), radiusTwo);

        delete process.env.PLURNK_SERVICE_LINE_ANCHOR_CONTEXT_LINES;
        assert.throws(() => LineAnchors.token(identity, 1, "alpha"), /LINE_ANCHOR_CONTEXT_LINES/);
        for (const malformed of ["-1", "1.5", "not-a-number"]) {
            process.env.PLURNK_SERVICE_LINE_ANCHOR_CONTEXT_LINES = malformed;
            assert.throws(() => LineAnchors.token(identity, 1, "alpha"), /LINE_ANCHOR_CONTEXT_LINES/);
        }
    } finally {
        if (prior === undefined) delete process.env.PLURNK_SERVICE_LINE_ANCHOR_CONTEXT_LINES;
        else process.env.PLURNK_SERVICE_LINE_ANCHOR_CONTEXT_LINES = prior;
    }
});

test("LineAnchors: rendering preserves physical content and separators while carrying the visible ordinal", () => {
    const complete = "one\ntwo\nthree\nfour\nfive\nsix\nalpha\r\nbeta\rgamma\nten";
    const projection = "alpha\r\nbeta\rgamma\n";
    const anchors = LineAnchors.project(identity, complete, projection, 7);
    const rendered = LineAnchors.render(
        projection,
        7,
        anchors,
        LineAnchors.lineNumberWidth(complete),
    );
    const lines = rendered.split(/\r\n|\r|\n/);
    assert.match(lines[0]!, /^@[0-9A-Za-z]{5}  7:alpha$/);
    assert.match(lines[1]!, /^@[0-9A-Za-z]{5}  8:beta$/);
    assert.match(lines[2]!, /^@[0-9A-Za-z]{5}  9:gamma$/);
    assert.equal(lines[3], "");
    assert.match(rendered, /  7:alpha\r\n/);
    assert.match(rendered, /  8:beta\r/);
    assert.match(rendered, /  9:gamma\n$/);
    assert.throws(
        () => LineAnchors.render(projection, 7, anchors, Number.MAX_SAFE_INTEGER),
        /line-number width/,
    );
});

test("LineAnchors: resolution lowers anchors only in line-coordinate positions", () => {
    const content = "alpha\nbeta\ngamma\n";
    const anchors = LineAnchors.tokens(identity, content);
    const first = anchors[0]!;
    const third = anchors[2]!;

    assert.deepEqual(LineAnchors.resolve(anchors, { marks: [first] }), {
        ok: true,
        marker: { marks: [1] },
    });
    assert.deepEqual(LineAnchors.resolve(anchors, { marks: [first, third] }), {
        ok: true,
        marker: { marks: [1, 3] },
    });
    assert.deepEqual(LineAnchors.resolve(anchors, { marks: [first, 3] }), {
        ok: true,
        marker: { marks: [1, 3] },
    });
    assert.deepEqual(LineAnchors.resolve(anchors, { marks: [1, third] }), {
        ok: true,
        marker: { marks: [1, 3] },
    });
    assert.deepEqual(LineAnchors.resolve(anchors, { marks: [first, 2, third, 4] }), {
        ok: true,
        marker: { marks: [1, 2, 3, 4] },
    });
    assert.deepEqual(LineAnchors.resolve(anchors, { marks: [1, first, 3, 4] }), {
        ok: false,
        failure: { kind: "invalid", anchor: first },
    });
});

test("LineAnchors: changed content or nearby context makes an authored anchor stale; a moved line keeps it (#428 v2)", () => {
    const content = "zero\nalpha\nbeta\ngamma\ndelta\nepsilon\nzeta";
    const anchor = LineAnchors.token(identity, 3, content);
    assert.deepEqual(LineAnchors.resolve(LineAnchors.tokens(identity, content.replace("beta", "changed")), { marks: [anchor] }), {
        ok: false,
        failure: { kind: "missing", anchor },
    });
    assert.deepEqual(LineAnchors.resolve(LineAnchors.tokens(identity, content.replace("delta", "changed-nearby")), { marks: [anchor] }), {
        ok: false,
        failure: { kind: "missing", anchor },
    });
    assert.deepEqual(LineAnchors.resolve(LineAnchors.tokens(identity, `inserted\n${content}`), { marks: [anchor] }), {
        ok: true,
        marker: { marks: [4] },
    }, "an insertion above moves the line; its anchor follows it");
    assert.deepEqual(LineAnchors.resolve(LineAnchors.tokens(identity, `one\ntwo\nthree\n${content}`), { marks: [anchor, LineAnchors.token(identity, 5, content)] }), {
        ok: true,
        marker: { marks: [6, 8] },
    }, "a range of anchors follows the shift together");
});

test("LineAnchors: a mutation precondition checks only its anchored neighborhood", () => {
    const content = Array.from({ length: 12 }, (_, index) => `line-${index + 1}`).join("\n");
    const precondition = {
        identity,
        checks: [{ anchor: LineAnchors.token(identity, 5, content), line: 5 }],
    };
    assert.equal(LineAnchors.satisfies(precondition, content), true);
    assert.equal(LineAnchors.satisfies(precondition, content.replace("line-7", "nearby-change")), false);
    assert.equal(LineAnchors.satisfies(precondition, content.replace("line-8", "outside-change")), true);
});

test("{§line-anchor-disambiguation}: identical short neighborhoods receive independently resolvable contextual handles", () => {
    const block = "function f() {\n    return null;\n}\n\n";
    const content = `${block}${block}${block}tail`;
    const anchors = LineAnchors.tokens(identity, content);
    // Line 6 (`    return null;` of the second block) has the same five-line neighborhood as line 10.
    assert.notEqual(anchors[5], anchors[9]);
    assert.notEqual(anchors[1], anchors[5], "the first block's neighborhood starts at the file head, so it differs");
    for (const line of [2, 6, 10]) {
        assert.deepEqual(LineAnchors.resolve(anchors, { marks: [anchors[line - 1]!] }), {
            ok: true, marker: { marks: [line] },
        });
    }
});

const repeatedFixture = () => {
    const block = (name: string) => [`begin-${name}`, ...Array<string>(12).fill("same"), "target", ...Array<string>(12).fill("same"), `end-${name}`];
    const padding = (name: string) => Array.from({ length: 20 }, (_, i) => `${name}-${i}`);
    const lines = [...padding("head"), ...block("a"), ...padding("middle"), ...block("b"), ...padding("tail")];
    const targets = lines.flatMap((line, index) => line === "target" ? [index] : []);
    return { lines, targets, content: lines.join("\n") };
};

test("{§line-anchor-disambiguation}: deep repeated regions remain distinct and follow unrelated shifts across turns", () => {
    const { content, targets } = repeatedFixture();
    const anchors = LineAnchors.tokens(identity, content);
    assert.notEqual(anchors[targets[0]!], anchors[targets[1]!]);
    const shifted = LineAnchors.tokens(identity, `unrelated\nprefix\n${content}\nsuffix`);
    for (const index of targets) {
        assert.equal(shifted[index + 2], anchors[index], "an expanded anchor follows the unchanged context");
        assert.deepEqual(LineAnchors.resolve(shifted, { marks: [anchors[index]!] }), { ok: true, marker: { marks: [index + 3] } });
    }
    const unique = 5;
    assert.equal(anchors[unique], LineAnchors.tokens(identity, content.replace("begin-b", "different-b"))[unique], "disambiguation elsewhere does not re-key a unique handle");
});

test("{§line-anchor-disambiguation}: context outside the minimum window participates in mutation preconditions", () => {
    const { content, targets, lines } = repeatedFixture();
    const index = targets[0]!;
    const anchor = LineAnchors.token(identity, index + 1, content);
    const precondition = { identity, checks: [{ anchor, line: index + 1 }] };
    assert.equal(LineAnchors.satisfies(precondition, content), true);
    const changed = lines.with(index - 5, "changed distinguishing context").join("\n");
    assert.equal(LineAnchors.satisfies(precondition, changed), false);
    assert.deepEqual(LineAnchors.resolve(LineAnchors.tokens(identity, changed), { marks: [anchor] }), {
        ok: false, failure: { kind: "missing", anchor },
    });
    assert.equal(LineAnchors.satisfies(precondition, lines.with(0, "unrelated").join("\n")), true);
});

test("{§line-anchor-disambiguation}: a removed twin does not redirect either old contextual handle to the survivor", () => {
    const { content, lines, targets } = repeatedFixture();
    const anchors = LineAnchors.tokens(identity, content);
    const remaining = lines.filter((_, index) => index < 20 || index >= 47).join("\n");
    const current = LineAnchors.tokens(identity, remaining);
    for (const index of targets) assert.deepEqual(LineAnchors.resolve(current, { marks: [anchors[index]!] }), {
        ok: false, failure: { kind: "missing", anchor: anchors[index] },
    });
    assert.deepEqual(LineAnchors.resolve(current, { marks: [current[targets[1]! - 27]!] }), {
        ok: true, marker: { marks: [targets[1]! - 26] },
    });
});

test("{§line-anchor-disambiguation}: projection and line separators do not change expanded anchors", () => {
    const { content, lines, targets } = repeatedFixture();
    const anchors = LineAnchors.tokens(identity, content);
    for (const separator of ["\n", "\r\n", "\r"]) {
        const source = lines.join(separator) + separator;
        assert.deepEqual(LineAnchors.tokens(identity, source), anchors);
        for (const index of targets) {
            assert.deepEqual(LineAnchors.project(identity, source, lines[index]!, index + 1), [anchors[index]]);
        }
    }
    assert.deepEqual(LineAnchors.tokens(identity, ""), []);
});

test("{§line-anchor-disambiguation}: zero minimum context still distinguishes repeated lines at file boundaries", () => {
    const prior = process.env.PLURNK_SERVICE_LINE_ANCHOR_CONTEXT_LINES;
    try {
        process.env.PLURNK_SERVICE_LINE_ANCHOR_CONTEXT_LINES = "0";
        for (const count of [1, 2, 3, 7, 16, 33]) {
            const anchors = LineAnchors.tokens(identity, Array<string>(count).fill("same").join("\n"));
            assert.equal(new Set(anchors).size, count, `${count} identical lines remain individually addressable`);
            for (const [index, anchor] of anchors.entries()) {
                assert.deepEqual(LineAnchors.resolve(anchors, { marks: [anchor] }), { ok: true, marker: { marks: [index + 1] } });
            }
        }
    } finally {
        if (prior === undefined) delete process.env.PLURNK_SERVICE_LINE_ANCHOR_CONTEXT_LINES;
        else process.env.PLURNK_SERVICE_LINE_ANCHOR_CONTEXT_LINES = prior;
    }
});

test("{§line-anchor-disambiguation}: arbitrary configured minima distinguish identical lines, including a radius larger than the resource", () => {
    const prior = process.env.PLURNK_SERVICE_LINE_ANCHOR_CONTEXT_LINES;
    try {
        for (const radius of [1, 2, 3, 5, 16, 64]) {
            process.env.PLURNK_SERVICE_LINE_ANCHOR_CONTEXT_LINES = String(radius);
            const content = "same\n".repeat(33);
            const anchors = LineAnchors.tokens(identity, content);
            assert.equal(new Set(anchors).size, 33, `minimum radius ${radius}`);
            assert.deepEqual(LineAnchors.tokens(identity, content), anchors, "derivation does not retain mutable identity state");
        }
    } finally {
        if (prior === undefined) delete process.env.PLURNK_SERVICE_LINE_ANCHOR_CONTEXT_LINES;
        else process.env.PLURNK_SERVICE_LINE_ANCHOR_CONTEXT_LINES = prior;
    }
});

test("{§line-anchor-disambiguation}: a large repetitive resource resolves without unbounded context expansion", () => {
    const anchors = LineAnchors.tokens(identity, "same\n".repeat(4096));
    assert.equal(anchors.length, 4096);
    assert.equal(new Set(anchors).size, 4096);
});

test("{§line-anchors}: residual short-hash ambiguity is refused rather than choosing a line", () => {
    assert.deepEqual(LineAnchors.resolve(["@abcde", "@other", "@abcde"], { marks: ["@abcde"] }), {
        ok: false, failure: { kind: "ambiguous", anchor: "@abcde", matches: [1, 3] },
    });
});

test("{§resolved-edit-statement} LineAnchors: unresolved model syntax fails hard at the scheme boundary", () => {
    const statement: EditStatement = {
        op: "EDIT",
        aside: null,
        target: null,
        metadata: null,
        lineMarker: { marks: [LineAnchors.token(identity, 1, "alpha")] },
        matcher: null, body: "replacement",
        position: { line: 1, column: 1 },
    };
    assert.throws(
        () => LineAnchors.assertResolved([statement]),
        /unresolved line anchor crossed the core-to-scheme boundary/,
    );
});

test("{§anchor-offset} LineAnchors: an offset mark resolves from its anchor's line; continuity checks the anchor itself (#749)", () => {
    const content = "alpha\nbeta\ngamma\ndelta\n";
    const anchors = LineAnchors.tokens(identity, content);
    const [first, second] = [anchors[0]!, anchors[1]!];
    assert.deepEqual(LineAnchors.resolve(anchors, { marks: [`${second}+1`] }), { ok: true, marker: { marks: [3] } });
    assert.deepEqual(LineAnchors.resolve(anchors, { marks: [first, `${second}+2`] }), { ok: true, marker: { marks: [1, 4] } });
    assert.deepEqual(LineAnchors.resolve(anchors, { marks: [`${second}-1`] }), { ok: true, marker: { marks: [1] } });
    assert.deepEqual(LineAnchors.resolve(anchors, { marks: [`${first}-1`] }), { ok: false, failure: { kind: "invalid", anchor: `${first}-1` } });
    assert.deepEqual(LineAnchors.checks({ marks: [first, `${second}+2`] }, { marks: [1, 4] }), [
        { anchor: first, line: 1 },
        { anchor: second, line: 2 },
    ]);
});
