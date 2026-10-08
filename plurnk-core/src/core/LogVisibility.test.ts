import test from "node:test";
import assert from "node:assert/strict";
import LogVisibility from "./LogVisibility.ts";
import LineAnchors from "../content/line-anchors.ts";

test("LogVisibility composes whole and surgical scoped KILLs as one-way interval algebra", () => {
    assert.deepEqual(LogVisibility.apply([], [1, -1], 30), [[1, -1]]);
    const one = LogVisibility.apply([], [20, 20], 30);
    assert.deepEqual(one, [[20, 20]]);
    const tail = LogVisibility.apply(one, [17, -1], 30);
    assert.deepEqual(tail, [[17, -1]], "a wider range absorbs the narrower one");
    assert.deepEqual(LogVisibility.apply([[3, 5]], [7, 7], 30), [[3, 5], [7, 7]], "disjoint ranges accumulate");
    assert.deepEqual(LogVisibility.apply([[1, 16]], [17, -1], 30), [[1, -1]], "covering every line is complete suppression");
    assert.deepEqual(LogVisibility.apply([[1, -1]], [4, 4], 30), [[1, -1]], "nothing restores a suppressed line");
});

test("LogVisibility intersects bulk numeric scopes with each body", () => {
    assert.deepEqual(
        LogVisibility.resolveScope({ marks: [17, -1] }, "log:///1/1/1/READ", "short\nbody"),
        { ok: true, range: null },
    );
    assert.deepEqual(
        LogVisibility.resolveScope(
            { marks: [17, -1] },
            "log:///1/1/2/READ",
            Array.from({ length: 20 }, (_, index) => String(index + 1)).join("\n"),
        ),
        { ok: true, range: [17, -1] },
    );
});

test("LogVisibility resolves both published and log-bound anchors in the immutable body", () => {
    const content = "alpha\nbeta\ngamma";
    const identity = "log:///1/2/3/READ";
    const logAnchor = LineAnchors.token(identity, 2, content);
    const published = LineAnchors.tokens("worker:///source.md", content);
    assert.deepEqual(
        LogVisibility.resolveScope({ marks: [logAnchor] }, identity, content),
        { ok: true, range: [2, 2] },
    );
    assert.deepEqual(
        LogVisibility.resolveScope({ marks: [published[1]!] }, identity, content, published),
        { ok: true, range: [2, 2] },
    );
    assert.deepEqual(
        LogVisibility.resolveScope({ marks: [logAnchor] }, "log:///1/2/4/READ", content),
        { ok: true, range: null },
    );
});

test("LogVisibility rejects character regions but treats absent lines as no-ops", () => {
    assert.deepEqual(
        LogVisibility.resolveScope({ marks: [1, 2, 3, 4] }, "log:///1/1/1", "a\nb\nc"),
        {
            ok: false,
            status: 400,
            code: "curation-scope-invalid",
            detail: "Log-body scopes require one line or an inclusive two-line range; received 4 coordinates.",
            recovery: "Trim one line with <L> or lines L through M with <L,M>; KILL (log:///1/1/1) with no scope retires the whole row.",
        },
    );
    assert.deepEqual(
        LogVisibility.resolveScope({ marks: [99] }, "log:///1/1/1", "a\nb\nc"),
        { ok: true, range: null },
    );
    assert.deepEqual(
        LogVisibility.resolveScope({ marks: [3, 2] }, "log:///1/1/1", "a\nb\nc"),
        {
            ok: false,
            status: 400,
            code: "curation-scope-invalid",
            detail: "Range <3,2> runs backward; a range names its first line first.",
            recovery: "Trim one line with <L> or lines L through M with <L,M>; KILL (log:///1/1/1) with no scope retires the whole row.",
        },
    );
});

// {§log-scope-recovery} {§diagnostic-observation} — every refusal ends in the same forms; the written scope is never rebuilt.
test("{§log-scope-recovery} {§range-starts-at-one}: a zero or backward log-body scope is refused with the forms that work on the row", () => {
    const refusal = (marks: [number] | [number, number], content = "a\nb\nc") => LogVisibility.resolveScope({ marks }, "log:///1/9/2/READ", content);
    assert.deepEqual(refusal([0, -1]), {
        ok: false,
        status: 416,
        code: "range-not-satisfiable",
        detail: "Range <0,-1> starts at 0, which is not a line; lines are numbered from 1.",
        recovery: "Trim one line with <L> or lines L through M with <L,M>; KILL (log:///1/9/2/READ) with no scope retires the whole row.",
    });
    assert.deepEqual(refusal([0, -1], ""), refusal([0, -1]), "an empty body is refused by the same rule, never clamped");
    assert.deepEqual(refusal([0, 17]), {
        ok: false,
        status: 416,
        code: "range-not-satisfiable",
        detail: "Range <0,17> starts at 0, which is not a line; lines are numbered from 1.",
        recovery: "Trim one line with <L> or lines L through M with <L,M>; KILL (log:///1/9/2/READ) with no scope retires the whole row.",
    });
    assert.deepEqual(refusal([0]), {
        ok: false,
        status: 400,
        code: "curation-scope-invalid",
        detail: "<0> is not a line of a log body; lines are numbered from 1.",
        recovery: "Trim one line with <L> or lines L through M with <L,M>; KILL (log:///1/9/2/READ) with no scope retires the whole row.",
    });
    assert.deepEqual(refusal([2, 0]), {
        ok: false,
        status: 400,
        code: "curation-scope-invalid",
        detail: "Range <2,0> ends at 0, which is not a line; a range ends at a line from 1, or at -1 for the last line.",
        recovery: "Trim one line with <L> or lines L through M with <L,M>; KILL (log:///1/9/2/READ) with no scope retires the whole row.",
    });
    for (const [marks, range] of [[[1, -1], [1, -1]], [[1], [1, 1]], [[2, 3], [2, 3]]] as const) {
        assert.deepEqual(LogVisibility.resolveScope({ marks: [...marks] }, "log:///1/9/2/READ", "a\nb\nc"), { ok: true, range: [...range] }, "the forms the recoveries name work");
    }
});


test("{§line-anchor-disambiguation}: log curation uses published contextual anchors even when their context is outside the retained READ slice", () => {
    const block = (label: string) => `${label}\nbefore-2\nbefore-1\ntarget\nafter-1\nafter-2\nend-${label}`;
    const source = `${block("a")}\n${block("b")}`;
    const anchors = LineAnchors.tokens("worker:///source.md", source);
    assert.notEqual(anchors[3], anchors[10]);
    assert.deepEqual(LogVisibility.resolveScope({ marks: [anchors[3]!] }, "log:///1/2/3/READ", "target", [anchors[3]!]), {
        ok: true, range: [1, 1],
    });
    assert.deepEqual(LogVisibility.resolveScope({ marks: [anchors[10]!] }, "log:///1/2/3/READ", "target", [anchors[3]!]), {
        ok: true, range: null,
    });
});
