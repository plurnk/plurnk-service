import test from "node:test";
import assert from "node:assert/strict";
import ByteView from "./byte-view.ts";
import type { LineMarker } from "@plurnk/plurnk-contracts";

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

test("{§find-bytes} byte patterns retain exact coordinates including individual CR and LF bytes", async () => {
    const bytes = new Uint8Array([...PNG, ...Buffer.from("testword02\x00tail")]);
    const match = await ByteView.match({ dialect: "regex", raw: "/PNG|testword02/", pattern: "PNG|testword02", flags: "" }, bytes);
    assert.equal(match.status, 200);
    const [png, word] = match.matches!;
    assert.deepEqual(png, { region: { startLine: 2, startColumn: 1, endLine: 4, endColumn: 3 }, matched: "504e47" });
    assert.deepEqual(word, {
        region: { startLine: 9, startColumn: 1, endLine: 18, endColumn: 3 },
        matched: ByteView.hex(Buffer.from("testword02")),
    });
    for (const [pattern, byte, hex] of [["\\r", 5, "0d"], ["(?<=\\r)\\n", 6, "0a"]] as const) {
        const result = await ByteView.match({ dialect: "regex", raw: `/${pattern}/`, pattern, flags: "" }, bytes);
        assert.equal(result.status, 200);
        assert.deepEqual(result.matches, [{ region: { startLine: byte, startColumn: 1, endLine: byte, endColumn: 3 }, matched: hex }]);
    }
    const point = await ByteView.match({ dialect: "regex", raw: "/^/", pattern: "^", flags: "" }, new Uint8Array([0xff]));
    assert.deepEqual(point.matches, [{ region: { startLine: 1, startColumn: 1, endLine: 1, endColumn: 1 }, matched: "" }]);
});

for (const { marks, expected } of [
    { marks: [2, 3], expected: [0, 9, 3] },
    { marks: [2], expected: [0, 9, 1, 2, 3] },
    { marks: [5], expected: [0, 1, 2, 3, 9] },
    { marks: [0], expected: [9, 0, 1, 2, 3] },
    { marks: [-1], expected: [0, 1, 2, 3, 9] },
    { marks: [1, -1], expected: [9] },
]) test(`{§binary-parity} byte splice <${marks}> preserves every other byte`, () => {
    const result = ByteView.splice(new Uint8Array([0, 1, 2, 3]), [{ marker: { marks } as LineMarker, bytes: new Uint8Array([9]) }]);
    assert.ok("bytes" in result, JSON.stringify(result));
    assert.deepEqual([...result.bytes], expected);
});

test("{§binary-parity} invalid byte scopes and overlapping splices leave the source intact", () => {
    const original = new Uint8Array([0, 1, 2, 3]);
    for (const marks of [[6], [2, 9], [1, 1, 1, 3]]) {
        const result = ByteView.splice(original, [{ marker: { marks } as LineMarker, bytes: new Uint8Array([9]) }]);
        assert.ok("result" in result);
        assert.equal(result.result.status, 416);
    }
    const overlap = ByteView.splice(original, [
        { marker: { marks: [1, 3] }, bytes: new Uint8Array() },
        { marker: { marks: [2] }, bytes: new Uint8Array([9]) },
    ]);
    assert.ok("result" in overlap);
    assert.equal(overlap.result.status, 409);
    assert.match(String(overlap.result.problem?.type), /\/move-region-overlap$/);
    assert.deepEqual([...original], [0, 1, 2, 3]);
});
