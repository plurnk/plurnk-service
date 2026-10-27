import assert from "node:assert/strict";
import test, { describe } from "node:test";
import ReadProjector from "./read-projector.ts";
import { parsePath } from "@plurnk/plurnk-parser";
import { type LineMarker } from "@plurnk/plurnk-contracts";
import { Results } from "@plurnk/plurnk-schemes";
import { Mimetypes, binaryInputMaximum, MimetypeInputLimitError } from "@plurnk/plurnk-mimetypes";

describe("read-projector.scope", () => {
const project = (marks: LineMarker["marks"], content: string, binary = false) => ReadProjector.project({
    statement: {
        op: "READ", target: parsePath(binary ? "fixture:///entry#bytes" : "fixture:///entry"),
        matcher: null, body: null, metadata: null, lineMarker: { marks }, aside: null,
        position: { line: 1, column: 1 },
    },
    manifest: {
        name: "fixture", category: "data", channels: { body: "text/plain" }, defaultChannel: "body",
        writableBy: [], volatile: false, modelVisible: true,
    },
    representation: { channels: { body: { content, mimetype: "text/plain", state: "static" } } },
    target: "fixture:///entry", identity: "fixture:///entry", publishesLineAnchors: false, mimetypes: new Mimetypes(),
    ...(binary ? { bytes: {
        size: async () => Buffer.byteLength(content),
        read: async (start: number, end: number) => Buffer.from(content).subarray(start - 1, end),
    } } : {}),
});

for (const binary of [false, true]) {
    for (const end of [2, 120, -1]) {
        test(`{§slicer-text-algebra}: ${binary ? "byte" : "text"} <0,${end}> returns content with exact recovery evidence`, async () => {
            const canonical = await project([1, end], "one\ntwo\nthree", binary);
            const recovered = await project([0, end], "one\ntwo\nthree", binary);
            assert.equal(recovered.status, 200);
            assert.equal(recovered.content, canonical.content);
            assert.deepEqual(recovered.range, { ...canonical.range, requested: [0, end] });
            assert.deepEqual(recovered.scopeNormalizations, [{ requested: [0, end], canonical: [1, end] }]);
            assert.equal(Results.assert(recovered), recovered);
        });
    }
    test(`{§slicer-text-algebra}: empty ${binary ? "bytes" : "text"} remains an empty successful read`, async () => {
        const recovered = await project([0, -1], "", binary);
        assert.equal(recovered.status, 204);
        assert.equal(recovered.content, "");
        assert.deepEqual(recovered.range?.requested, [0, -1]);
        assert.deepEqual(recovered.scopeNormalizations, [{ requested: [0, -1], canonical: [1, -1] }]);
    });
}

for (const marks of [[0, 0], [0, -2], [0, 1, 1, 2], [1, 0, 1, 2]] satisfies LineMarker["marks"][]) {
    test(`{§slicer-text-algebra}: <${marks.join(",")}> does not guess another invalid coordinate`, async () => {
        const result = await project(marks, "one\ntwo");
        assert.equal(result.status, 416);
        assert.equal(result.scopeNormalizations, undefined);
    });
}

test("{§slicer-text-algebra}: the single <0> sentinel still selects no text", async () => {
    const result = await project([0], "one\ntwo");
    assert.equal(result.status, 204);
    assert.equal(result.content, "");
    assert.equal(result.scopeNormalizations, undefined);
});
});

describe("read-projector.native", () => {
for (const mimetype of ["image/png", "application/pdf", "audio/wav"]) {
    test(`{§mimetype-binary-input} ${mimetype} native snapshot checks the binary ceiling before loading bytes`, async () => {
        const maximumBytes = binaryInputMaximum();
        let reads = 0;
        await assert.rejects(ReadProjector.project({
            statement: {
                op: "READ", target: parsePath("fixture:///entry"), matcher: null, body: null, metadata: null,
                lineMarker: null, aside: null, position: { line: 1, column: 1 },
            },
            manifest: { name: "fixture", category: "data", channels: {}, defaultChannel: "body", writableBy: [], volatile: false, modelVisible: true },
            publishesLineAnchors: false, target: "fixture:///entry", identity: "fixture:///entry", mimetypes: undefined,
            representation: { channels: { body: { content: "", mimetype, state: "static" } } },
            bytes: { size: async () => maximumBytes + 1, read: async () => { reads += 1; throw new Error("The oversized source was read"); } },
        }), (error: unknown) => {
            assert.ok(error instanceof MimetypeInputLimitError);
            assert.equal(error.mimetype, mimetype);
            assert.equal(error.observedBytes, maximumBytes + 1);
            assert.equal(error.maximumBytes, maximumBytes);
            return true;
        });
        assert.equal(reads, 0);
    });
}
});
