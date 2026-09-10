import assert from "node:assert/strict";
import test from "node:test";
import ResourceNames from "./ResourceNames.ts";

test("{§resource-publication-names} names survive; unnamed and duplicate publications use eight hex characters", () => {
    const names = new ResourceNames();
    assert.equal(decodeURIComponent(names.allocate("screenshot.png")), "screenshot.png");
    assert.match(names.allocate("screenshot.png"), /^screenshot\.png\.[a-f0-9]{8}$/u);
    assert.match(names.allocate(), /^[a-f0-9]{8}$/u);
    assert.equal(names.allocate("../a (b)#x.png"), "..%2Fa%20%28b%29%23x.png", "a supplied name remains one address component");
    assert.match(names.allocate(".."), /^[a-f0-9]{8}$/u);
    const stable = (): string[] => {
        const collection = new ResourceNames();
        return [collection.allocate(undefined, "first"), collection.allocate("same", "a"), collection.allocate("same", "b")];
    };
    assert.deepEqual(stable(), stable(), "reconstructing a collection preserves its resource paths");
});
