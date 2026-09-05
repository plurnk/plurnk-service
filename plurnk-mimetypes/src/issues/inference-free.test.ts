import assert from "node:assert/strict";
import { test } from "node:test";
import * as api from "../index.ts";

test("{§mimetype-channel-selection} content projection exposes no embedding inference API", () => {
    for (const method of ["embedderInfo", "embedDocuments", "embedQuery"]) {
        assert.equal(method in api.Mimetypes.prototype, false, `${method} must not remain a framework capability`);
    }
    assert.equal("EmbeddingVector" in api, false);
    assert.equal(typeof api.Mimetypes.prototype.tokenizer, "function", "prompt tokenization remains independent");
});
