import test from "node:test";
import assert from "node:assert/strict";
import LogVisibility from "./LogVisibility.ts";
import LineAnchors from "../content/line-anchors.ts";

test("LogVisibility composes whole and surgical OPEN/FOLD as interval algebra", () => {
    const full = LogVisibility.apply([], "FOLD", [1, -1], 30);
    assert.deepEqual(full, [[1, -1]]);
    const oneOpen = LogVisibility.apply(full, "OPEN", [20, 20], 30);
    assert.deepEqual(oneOpen, [[1, 19], [21, -1]]);
    const tailOpen = LogVisibility.apply(oneOpen, "OPEN", [17, -1], 30);
    assert.deepEqual(tailOpen, [[1, 16]]);
    assert.deepEqual(LogVisibility.apply(tailOpen, "OPEN", [1, -1], 30), []);
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
            detail: "Log-body scopes require one line or an inclusive two-line range; received 4 coordinates.",
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
            detail: "A log-body range requires positive, ordered line coordinates or -1 as its end.",
        },
    );
});
