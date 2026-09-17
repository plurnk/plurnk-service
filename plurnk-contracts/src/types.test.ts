import assert from "node:assert/strict";
import test from "node:test";
import { WORKER_NAME } from "./types.ts";

test("{§worker-name}: accepts exact ASCII worker identifiers, hashes, and UUIDs", () => {
    for (const name of [
        "a", "A", "0", "approach_a", "Approach_A", "brisk-otter", "3com",
        "trail-", "trail_", "self", "plurnk", "PLURNK", "01abcdef",
        "0f25c39a-a85d-46c8-b073-7f61a477e807", "A".repeat(63), `0${"_".repeat(62)}`,
    ]) {
        assert.equal(WORKER_NAME.test(name), true, JSON.stringify(name));
    }
});

test("{§worker-name}: rejects reserved-leading, oversized, and non-identifier spellings", () => {
    for (const name of [
        "", "_plurnk", "_a", "-a", "a".repeat(64), "dot.name", "~",
        "sp ace", " leading", "trailing ", "é", "a/b", "a:b", "a@b", "a%62",
        "a?b", "a#b", "a\n", "a\r", "a\t", "a\0",
    ]) {
        assert.equal(WORKER_NAME.test(name), false, JSON.stringify(name));
    }
});
