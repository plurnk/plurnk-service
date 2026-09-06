import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import FileByteSource from "./FileByteSource.ts";

test("{§scheme-source-bytes} native identity and inclusive byte windows share one live source", async (t) => {
    const directory = await mkdtemp(join(tmpdir(), "plurnk-byte-source-"));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const file = join(directory, "asset.bin");
    await writeFile(file, Buffer.from([0, 255, 128, 65]));
    const source = new FileByteSource(async () => file);
    assert.equal(await source.nativePath(), file);
    assert.equal(await source.size(), 4);
    assert.deepEqual(await source.read(2, 3), Buffer.from([255, 128]));
    assert.deepEqual(await source.read(4, 8), Buffer.from([65]));
    await writeFile(file, "new");
    assert.equal(await source.size(), 3);
    assert.deepEqual(await source.read(1, 3), Buffer.from("new"));
    await rm(file);
    assert.equal(await source.nativePath(), null);
    assert.equal(await source.size(), null);
    await assert.rejects(source.read(1, 1), /no longer exists/);
    await assert.rejects(new FileByteSource(async () => directory).nativePath(), /not a regular file/);
});

test("{§scheme-source-bytes} unavailable and failed resolution are distinct", async () => {
    assert.equal(await new FileByteSource(async () => null).nativePath(), null);
    const failure = new Error("source admission refused");
    const source = new FileByteSource(async () => { throw failure; });
    await assert.rejects(source.nativePath(), (cause) => cause === failure);
    await assert.rejects(source.size(), (cause) => cause === failure);
    await assert.rejects(source.read(1, 1), (cause) => cause === failure);
});
