import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import PacketLint from "./PacketLint.ts";

test("lintDir globs only packet files and tags each finding by file", () => {
    const dir = mkdtempSync(join(tmpdir(), "packetlint-"));
    try {
        // A bare op in prose is an op-fence deviation; the clean user packet stays clean.
        writeFileSync(join(dir, "packet001.system.md"), "## Resources\n\nHere is an example.\n## READ0 (worker:///plan.md)\n");
        writeFileSync(join(dir, "packet001.user.md"), "## Log\n\nShort clean prose.\n");
        writeFileSync(join(dir, "digest.md"), "not a packet file — must be ignored");
        const { packets, findings } = PacketLint.lintDir(dir);
        assert.deepEqual(packets, ["packet001.system.md", "packet001.user.md"]);
        const opFence = findings.filter((f) => f.rule === "op-fence");
        assert.equal(opFence.length, 1);
        assert.equal(opFence[0].file, "packet001.system.md");
        assert.equal(findings.filter((f) => f.file === "packet001.user.md").length, 0);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});
