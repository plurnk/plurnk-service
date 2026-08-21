import assert from "node:assert/strict";
import test from "node:test";

import {
    REGISTRY_VISIBILITY_ATTEMPTS,
    awaitRegistryVersion,
} from "./registry-visibility.mjs";

test("registry visibility tolerates ordinary post-publication propagation", async () => {
    const observed = [null, "1.7.0", "1.8.0"];
    const waits = [];

    await awaitRegistryVersion({
        name: "@plurnk/example",
        version: "1.8.0",
        lookup: async () => observed.shift(),
        wait: async (milliseconds) => waits.push(milliseconds),
    });

    assert.equal(REGISTRY_VISIBILITY_ATTEMPTS, 30);
    assert.deepEqual(waits, [10_000, 10_000]);
});

test("registry visibility remains bounded and names the unpublished artifact", async () => {
    let attempts = 0;

    await assert.rejects(
        awaitRegistryVersion({
            name: "@plurnk/example",
            subject: "example leaf",
            version: "1.8.0",
            attempts: 3,
            lookup: async () => {
                attempts += 1;
                return null;
            },
            wait: async () => undefined,
        }),
        /example leaf: published but the registry never served 1\.8\.0/,
    );
    assert.equal(attempts, 3);
});
