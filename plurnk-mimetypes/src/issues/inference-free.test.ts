import assert from "node:assert/strict";
import { test } from "node:test";
import * as api from "../index.ts";

test("{§mimetype-channel-selection} content projection exposes no embedding inference API", () => {
    for (const method of ["embedderInfo", "embedDocuments", "embedQuery"]) {
        assert.equal(method in api.Mimetypes.prototype, false, `${method} must not remain a framework capability`);
    }
    assert.equal("EmbeddingVector" in api, false);
    // Token counting is wholly a consumer concern: the framework neither tokenizes nor budgets
    // for its own projection, so it offers no vocabulary seam to mistake for one.
    for (const gone of ["tokenizer", "countTokens"]) {
        assert.equal(gone in api.Mimetypes.prototype, false, `${gone} must not remain a framework capability`);
    }
    for (const gone of ["TokenizerResolution", "TokenCountOptions"]) assert.equal(gone in api, false);
});
