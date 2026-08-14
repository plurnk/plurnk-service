import test from "node:test";
import assert from "node:assert/strict";
import TagSignal, { InvalidTagSignalError } from "./TagSignal.ts";

test("TagSignal.applied accepts implicit or explicit additions and deduplicates stored identities", () => {
    assert.deepEqual(TagSignal.applied(null), { add: [] });
    assert.deepEqual(
        TagSignal.applied(["research/topic", "+research/topic", "+a+b"]),
        { add: ["research/topic", "a+b"] },
    );
});

test("TagSignal.applied rejects removals and noncanonical identities", () => {
    for (const term of [
        "-research",
        "+",
        "++research",
        "+-research",
        "+two words",
        "+nonbreaking\u00a0space",
        "+comma,tag",
        "+bracket[tag",
        "+control\u0000tag",
        "+control\u0085tag",
    ]) {
        assert.throws(() => TagSignal.applied([term]), InvalidTagSignalError, term);
    }
});

test("TagSignal.curation partitions selectors and changes without retaining signs", () => {
    assert.deepEqual(
        TagSignal.curation(["research", "research", "+archive", "+archive", "-stale"]),
        {
            filter: ["research"],
            add: ["archive"],
            remove: ["stale"],
        },
    );
    assert.throws(
        () => TagSignal.curation(["+archive", "-archive"]),
        /cannot both add and remove tag 'archive'/,
    );
    assert.throws(() => TagSignal.curation(["bad tag"]), InvalidTagSignalError);
});
