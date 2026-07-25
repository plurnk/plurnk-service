import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { missingDigestDirs } from "../../bin/digest-missing.ts";

test("digest:missing selects only interrupted benchmark specimens", async () => {
    const root = await mkdtemp(join(tmpdir(), "plurnk-digest-missing-"));
    try {
        const interrupted = join(root, "demo-interrupted-a1");
        const complete = join(root, "demo-complete-b2");
        const unrelated = join(root, "notes");
        await Promise.all([
            mkdir(interrupted),
            mkdir(join(complete, "digest"), { recursive: true }),
            mkdir(unrelated),
        ]);
        await Promise.all([
            writeFile(join(interrupted, "plurnk.db"), ""),
            writeFile(join(complete, "plurnk.db"), ""),
            writeFile(join(unrelated, "readme.txt"), ""),
        ]);

        assert.deepEqual(missingDigestDirs(root), [interrupted]);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});
