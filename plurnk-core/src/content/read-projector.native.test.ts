import assert from "node:assert/strict";
import test from "node:test";
import { parsePath } from "@plurnk/plurnk-parser";
import { binaryInputMaximum, MimetypeInputLimitError } from "@plurnk/plurnk-mimetypes";
import ReadProjector from "./read-projector.ts";

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
