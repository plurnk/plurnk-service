import assert from "node:assert/strict";
import { setTimeout } from "node:timers/promises";
import { liveTest as test } from "../../live-test.ts";

let cleaned = false;
const cleanup = async () => {
    await setTimeout(50);
    cleaned = true;
    console.log("deadline cleanup completed");
    if (process.env.PLURNK_TEST_CLEANUP_FAIL === "1") throw new Error("cleanup failed visibly");
};
test("deadline fixture", async (t) => {
    try {
        await setTimeout(5000, undefined, { signal: t.signal });
    } catch (error) {
        t.signal.throwIfAborted();
        throw error;
    } finally {
        await cleanup();
    }
});

test("next specimen sees completed cleanup", () => {
    assert.equal(cleaned, true);
    console.log("next specimen started after cleanup");
});
