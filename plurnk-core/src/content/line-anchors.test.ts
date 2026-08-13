import assert from "node:assert/strict";
import test from "node:test";
import type { EditStatement } from "@plurnk/plurnk-contracts";
import LineAnchors from "./line-anchors.ts";

const identity = "worker:///notes.md";

test("LineAnchors: tokens are deterministic Base62 handles over identity, ordinal, and configured context", () => {
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
    const prior = process.env.PLURNK_SERVICE_EDIT_ANCHOR_CONTEXT_LINES;
    try {
        process.env.PLURNK_SERVICE_EDIT_ANCHOR_CONTEXT_LINES = "2";
        const radiusTwo = LineAnchors.token(identity, 1, "alpha");
        process.env.PLURNK_SERVICE_EDIT_ANCHOR_CONTEXT_LINES = "3";
        assert.notEqual(LineAnchors.token(identity, 1, "alpha"), radiusTwo);

        delete process.env.PLURNK_SERVICE_EDIT_ANCHOR_CONTEXT_LINES;
        assert.throws(() => LineAnchors.token(identity, 1, "alpha"), /EDIT_ANCHOR_CONTEXT_LINES/);
        for (const malformed of ["-1", "1.5", "not-a-number"]) {
            process.env.PLURNK_SERVICE_EDIT_ANCHOR_CONTEXT_LINES = malformed;
            assert.throws(() => LineAnchors.token(identity, 1, "alpha"), /EDIT_ANCHOR_CONTEXT_LINES/);
        }
    } finally {
        if (prior === undefined) delete process.env.PLURNK_SERVICE_EDIT_ANCHOR_CONTEXT_LINES;
        else process.env.PLURNK_SERVICE_EDIT_ANCHOR_CONTEXT_LINES = prior;
    }
});

test("LineAnchors: rendering preserves physical content and separators while carrying the visible ordinal", () => {
    const complete = "one\ntwo\nthree\nfour\nfive\nsix\nalpha\r\nbeta\rgamma\nten";
    const projection = "alpha\r\nbeta\rgamma\n";
    const anchors = LineAnchors.project(identity, complete, projection, 7);
    const rendered = LineAnchors.render(projection, 7, anchors);
    const lines = rendered.split(/\r\n|\r|\n/);
    assert.match(lines[0]!, /^@[0-9A-Za-z]{5}:7:alpha$/);
    assert.match(lines[1]!, /^@[0-9A-Za-z]{5}:8:beta$/);
    assert.match(lines[2]!, /^@[0-9A-Za-z]{5}:9:gamma$/);
    assert.equal(lines[3], "");
    assert.match(rendered, /:7:alpha\r\n/);
    assert.match(rendered, /:8:beta\r/);
    assert.match(rendered, /:9:gamma\n$/);
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
    assert.deepEqual(LineAnchors.resolve(anchors, { marks: [first, 2, third, 4] }), {
        ok: true,
        marker: { marks: [1, 2, 3, 4] },
    });
    assert.deepEqual(LineAnchors.resolve(anchors, { marks: [1, first, 3, 4] }), {
        ok: false,
        failure: { kind: "invalid", anchor: first },
    });
});

test("LineAnchors: changed content, nearby context, or ordinal makes an authored anchor stale", () => {
    const content = "zero\nalpha\nbeta\ngamma\ndelta\nepsilon\nzeta";
    const anchor = LineAnchors.token(identity, 3, content);
    assert.deepEqual(LineAnchors.resolve(LineAnchors.tokens(identity, content.replace("beta", "changed")), { marks: [anchor] }), {
        ok: false,
        failure: { kind: "stale", anchor },
    });
    assert.deepEqual(LineAnchors.resolve(LineAnchors.tokens(identity, content.replace("delta", "changed-nearby")), { marks: [anchor] }), {
        ok: false,
        failure: { kind: "stale", anchor },
    });
    assert.deepEqual(LineAnchors.resolve(LineAnchors.tokens(identity, `inserted\n${content}`), { marks: [anchor] }), {
        ok: false,
        failure: { kind: "stale", anchor },
    });
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

test("LineAnchors: a rare target-local collision fails as ambiguous", () => {
    const collisionIdentity = "worker:///collision-0.md";
    const content = Array.from({ length: 25_000 }, (_, index) => `line-${index + 1}`).join("\n");
    const anchors = LineAnchors.tokens(collisionIdentity, content);
    const anchor = "@cvYPX";
    assert.equal(anchors[1_468], anchor);
    assert.equal(anchors[19_258], anchor);
    assert.deepEqual(LineAnchors.resolve(anchors, { marks: [anchor] }), {
        ok: false,
        failure: { kind: "ambiguous", anchor, matches: [1_469, 19_259] },
    });
});

test("LineAnchors: unresolved model syntax fails hard at the scheme boundary", () => {
    const statement: EditStatement = {
        op: "EDIT",
        suffix: "0",
        signal: null,
        target: null,
        lineMarker: { marks: [LineAnchors.token(identity, 1, "alpha")] },
        body: "replacement",
        position: { line: 1, column: 1 },
    };
    assert.throws(
        () => LineAnchors.assertResolved([statement]),
        /unresolved line anchor crossed the core-to-scheme boundary/,
    );
});
