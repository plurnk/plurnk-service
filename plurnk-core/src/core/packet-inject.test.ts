import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { resolveInjectPath, readPacketInject } from "./packet-inject.ts";

// {§packet-inject}: ~ expansion, per-turn read, fail-hard on a broken path.
test("resolveInjectPath expands ~/, leaves absolute paths alone", () => {
    assert.equal(resolveInjectPath("~/notes.md"), join(homedir(), "notes.md"), "~/ → home dir");
    assert.equal(resolveInjectPath("/etc/notes.md"), "/etc/notes.md", "absolute path untouched");
});

test("readPacketInject: unset → null; a real file → content; a missing path FAILS HARD", async () => {
    const prior = process.env.PLURNK_SERVICE_PACKET_INJECT;
    const dir = await mkdtemp(join(tmpdir(), "plurnk-inject-"));
    try {
        delete process.env.PLURNK_SERVICE_PACKET_INJECT;
        assert.equal(await readPacketInject(), null, "unset → no section");

        process.env.PLURNK_SERVICE_PACKET_INJECT = "  ";
        assert.equal(await readPacketInject(), null, "blank → no section");

        const path = join(dir, "inject.md");
        await writeFile(path, "# Operator says\nbe terse");
        process.env.PLURNK_SERVICE_PACKET_INJECT = path;
        assert.match(await readPacketInject() ?? "", /be terse/, "a real file rides back as the section content");

        process.env.PLURNK_SERVICE_PACKET_INJECT = join(dir, "nonexistent.md");
        await assert.rejects(readPacketInject(), /ENOENT/, "a set-but-unreadable path fails hard");
    } finally {
        if (prior === undefined) delete process.env.PLURNK_SERVICE_PACKET_INJECT; else process.env.PLURNK_SERVICE_PACKET_INJECT = prior;
        await rm(dir, { recursive: true, force: true });
    }
});
