import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { crc32, inflateRawSync } from "node:zlib";
import Zip from "./Zip.ts";

// Reads every entry back through the central directory, as an unzip tool does.
const entries = (archive: Buffer): Map<string, Buffer> => {
    const end = archive.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
    const count = archive.readUInt16LE(end + 10);
    let at = archive.readUInt32LE(end + 16);
    const out = new Map<string, Buffer>();
    for (let n = 0; n < count; n++) {
        assert.equal(archive.readUInt32LE(at), 0x02014b50);
        const size = archive.readUInt32LE(at + 20);
        const nameLength = archive.readUInt16LE(at + 28);
        const local = archive.readUInt32LE(at + 42);
        const name = archive.subarray(at + 46, at + 46 + nameLength).toString("utf8");
        const start = local + 30 + archive.readUInt16LE(local + 26);
        const data = inflateRawSync(archive.subarray(start, start + size));
        assert.equal(crc32(data), archive.readUInt32LE(at + 16), name);
        out.set(name, data);
        at += 46 + nameLength;
    }
    return out;
};

test("{§share} a folder zips to one top-level entry whose files inflate to their exact bytes", () => {
    const root = mkdtempSync(join(tmpdir(), "zip-test-"));
    try {
        const folder = join(root, "share_this_session_here");
        mkdirSync(join(folder, "nested"), { recursive: true });
        writeFileSync(join(folder, "digest.md"), "# digest\n");
        writeFileSync(join(folder, "nested", "bunny-2-1.user.md"), "packet ü\n".repeat(200));
        Zip.writeFolder(folder, `${folder}.zip`);
        const read = entries(readFileSync(`${folder}.zip`));
        assert.deepEqual([...read.keys()], ["share_this_session_here/digest.md", "share_this_session_here/nested/bunny-2-1.user.md"]);
        assert.equal(read.get("share_this_session_here/digest.md")!.toString(), "# digest\n");
        assert.equal(read.get("share_this_session_here/nested/bunny-2-1.user.md")!.toString(), "packet ü\n".repeat(200));
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});
