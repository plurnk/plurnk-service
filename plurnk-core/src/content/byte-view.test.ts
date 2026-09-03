import test from "node:test";
import assert from "node:assert/strict";
import ByteView from "./byte-view.ts";

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

test("{§read-bytes} one hexadecimal octet per line: coordinate = line = byte", () => {
    assert.equal(ByteView.hexLines(PNG), "89\n50\n4e\n47\n0d\n0a\n1a\n0a");
    assert.equal(ByteView.hex(PNG.subarray(1, 4)), "504e47");
    assert.equal(ByteView.hexLines(new Uint8Array()), "");
});

test("{§find-bytes} the Latin-1 view is one character per byte, newlines included", () => {
    const latin1 = ByteView.latin1(PNG);
    assert.equal(latin1.length, PNG.length);
    assert.equal(latin1.charCodeAt(0), 0x89);
    assert.equal(latin1.slice(1, 4), "PNG");
});

test("{§find-bytes} evidence located in the Latin-1 view comes back in byte coordinates with the bytes in hex", () => {
    const bytes = new Uint8Array([...PNG, ...Buffer.from("testword02\x00tail")]);
    const latin1 = ByteView.latin1(bytes);
    // "PNG" sits at bytes 2..4; the newline bytes 0x0d 0x0a put "testword02" on the third text line.
    const [png, word] = ByteView.byteEvidence(latin1, bytes, [
        { region: { startLine: 1, startColumn: 2, endLine: 1, endColumn: 5 }, matched: "PNG" },
        { region: { startLine: 3, startColumn: 1, endLine: 3, endColumn: 11 }, matched: "testword02" },
    ]);
    assert.deepEqual(png, { region: { startLine: 2, startColumn: 1, endLine: 4, endColumn: 3 }, matched: "504e47" });
    assert.deepEqual(word, {
        region: { startLine: 9, startColumn: 1, endLine: 18, endColumn: 3 },
        matched: ByteView.hex(Buffer.from("testword02")),
    });
    assert.deepEqual(ByteView.byteEvidence(latin1, bytes, [{ locator: "x" }]), [{ locator: "x" }], "locator-only evidence passes through");
});
