import assert from "node:assert/strict";
import test from "node:test";
import FileSnapshot from "./FileSnapshot.ts";

test("{§file-commit-serialization}: unrelated paths progress and failure releases the next same-path commit", async () => {
    const started = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const events: string[] = [];
    const first = FileSnapshot.serialize("first", async () => {
        started.resolve();
        await release.promise;
        events.push("first");
        throw new Error("fixture: commit failed");
    });
    const failure = assert.rejects(first, /fixture: commit failed/);
    await started.promise;
    const second = FileSnapshot.serialize("first", async () => { events.push("second"); });
    try {
        await FileSnapshot.serialize("independent", async () => { events.push("independent"); });
        assert.deepEqual(events, ["independent"]);
    } finally { release.resolve(); }
    await Promise.all([failure, second]);
    assert.deepEqual(events, ["independent", "first", "second"]);
    assert.equal(await FileSnapshot.serialize("first", async () => "reused"), "reused");
});
