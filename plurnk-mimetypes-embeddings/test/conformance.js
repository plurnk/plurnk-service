import assert from "node:assert/strict";

const assertMetadata = (metadata) => {
    assert.ok(metadata !== null && typeof metadata === "object");
    assert.ok(
        metadata.inputTokens === null
        || (Number.isSafeInteger(metadata.inputTokens) && metadata.inputTokens >= 0),
    );
    assert.ok(Array.isArray(metadata.warnings));
};

export const assertEmbeddingConformance = async (adapter, { dimension, symmetric }) => {
    const queryText = "capital of France";
    const query = await adapter.embedQuery(queryText);
    assert.ok(query.vector instanceof Uint8Array);
    assert.equal(query.vector.byteLength, dimension * Float32Array.BYTES_PER_ELEMENT);
    assertMetadata(query.metadata);
    assert.deepEqual((await adapter.embedQuery(queryText)).vector, query.vector, "query encoding is deterministic");

    const texts = ["Paris is the capital of France.", "Berlin is the capital of Germany."];
    const progress = [];
    const documents = await adapter.embedDocuments(texts, {
        onProgress: (value) => progress.push(value),
    });
    assert.equal(documents.vectors.length, texts.length);
    assertMetadata(documents.metadata);
    assert.deepEqual(progress.at(-1), { completed: texts.length, total: texts.length });
    for (const [index, text] of texts.entries()) {
        assert.ok(documents.vectors[index] instanceof Uint8Array);
        assert.equal(documents.vectors[index].byteLength, dimension * Float32Array.BYTES_PER_ELEMENT);
        const singleton = await adapter.embedDocuments([text]);
        assert.deepEqual(documents.vectors[index], singleton.vectors[0], `document ${index} retained input order`);
    }

    if (symmetric) {
        const sameDocument = await adapter.embedDocuments([queryText]);
        assert.deepEqual(query.vector, sameDocument.vectors[0], "symmetric profile maps query and document roles identically");
    }

    const reason = new DOMException("conformance cancellation", "AbortError");
    await assert.rejects(
        () => adapter.embedDocuments(["cancelled"], { signal: AbortSignal.abort(reason) }),
        (error) => error === reason || /AbortError|conformance cancellation/u.test(String(error)),
    );
};
