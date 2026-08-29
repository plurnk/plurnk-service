// Contract: {§mimetype-lifecycle}.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import Mimetypes from "../Mimetypes.ts";
import BaseHandler from "../BaseHandler.ts";
import EmbeddingVector from "../EmbeddingVector.ts";
import TreeSitterExtractor from "../TreeSitterExtractor.ts";
import type {
    QueryConstructor,
    TreeSitterNode,
    TreeSitterParser,
    TreeSitterTree,
} from "../TreeSitterExtractor.ts";
import type { HandlerMetadata, MimeSymbol } from "../types.ts";
import type { Discovery, HandlerInfo, Registry } from "../types.ts";

const EMB_PKG = "@plurnk/plurnk-mimetypes-embeddings";
const TOK_PKG = "@plurnk/plurnk-mimetypes-tokenizers";

const INFO: HandlerInfo = {
    mimetype: "text/x-test",
    glyph: "🧪",
    packageName: "@plurnk/x",
    projectionRevision: "test-1",
    extensions: [".tst"],
    binary: false,
    source: "package",
};

function makeDiscovery(): Discovery {
    const registry: Registry = {
        byExtension: new Map([[".tst", "text/x-test"]]),
        byFilename: new Map(),
    };
    return { registry, handlers: new Map([["text/x-test", INFO]]), skipped: [] };
}

// A disposable embedder that records how many times dispose() was awaited.
function makeEmbedder() {
    let disposed = 0;
    return {
        disposed: () => disposed,
        dimension: 2,
        model: "fixture@1",
        async embedQuery() {
            return {
                vector: EmbeddingVector.encode([0, 0]),
                metadata: { inputTokens: null, warnings: [], accounting: [] },
            };
        },
        async embedDocuments(texts: readonly string[]) {
            return {
                vectors: texts.map(() => EmbeddingVector.encode([0, 0])),
                metadata: { inputTokens: null, warnings: [], accounting: [] },
            };
        },
        async dispose(): Promise<void> {
            disposed += 1;
        },
    };
}

function mk(embedder: unknown | null) {
    return new Mimetypes({
        discovery: makeDiscovery(),
        loader: async (pkg) => {
            if (pkg === EMB_PKG) {
                if (embedder === null) {
                    throw Object.assign(
                        new Error(`Cannot find package '${EMB_PKG}' imported from test`),
                        { code: "ERR_MODULE_NOT_FOUND" },
                    );
                }
                return embedder;
            }
            return { default: BaseHandler };
        },
    });
}

function lifecycleMimetypes({
    Handler = BaseHandler,
    embedder,
    tokenizers,
}: {
    Handler?: new (metadata: HandlerMetadata) => BaseHandler;
    embedder?: unknown;
    tokenizers?: unknown;
} = {}): Mimetypes {
    return new Mimetypes({
        discovery: makeDiscovery(),
        loader: async (pkg) => {
            if (pkg === EMB_PKG) return embedder;
            if (pkg === TOK_PKG) return tokenizers;
            return { default: Handler };
        },
    });
}

describe("{§mimetype-lifecycle} — Mimetypes.dispose()", () => {
    it("D1: awaits the embedder's dispose() once it was loaded", async () => {
        const embedder = makeEmbedder();
        const m = mk(embedder);
        await m.process({ path: "a.tst", content: "x" }, { channels: ["embedding"] });
        await m.dispose();
        assert.equal(embedder.disposed(), 1, "embedder.dispose() must be awaited");
    });

    it("D2: no-op when no embedder was ever loaded", async () => {
        const embedder = makeEmbedder();
        const m = mk(embedder);
        await m.dispose(); // never triggered the embedding channel
        assert.equal(embedder.disposed(), 0, "nothing loaded → nothing to release");
    });

    it("D3: releases cleanly after an absent artifact resolution", async () => {
        const m = mk(null);
        await m.embedderInfo(); // forces the (failing) load attempt to be cached
        await assert.doesNotReject(m.dispose());
    });

    it("D4: is idempotent and re-lazy-inits afterward", async () => {
        const embedder = makeEmbedder();
        const m = mk(embedder);
        await m.process({ path: "a.tst", content: "x" }, { channels: ["embedding"] });
        await m.dispose();
        await m.dispose(); // second call: embedder already dropped, no re-dispose
        assert.equal(embedder.disposed(), 1, "second dispose() must not re-release");
        // Channel still works — the embedder re-loads transparently.
        const out = await m.process({ path: "a.tst", content: "x" }, { channels: ["embedding"] });
        assert.ok(out.embedding instanceof Uint8Array);
        await m.dispose();
        assert.equal(embedder.disposed(), 2, "re-loaded embedder disposes again");
    });

    it("D5: clears cached handler instances", async () => {
        const embedder = makeEmbedder();
        const m = mk(embedder);
        await m.process({ path: "a.tst", content: "x\ny" }, { channels: ["symbols"] });
        await m.dispose();
        // Re-resolving after dispose still produces a usable result.
        const out = await m.process({ path: "a.tst", content: "x\ny" }, { channels: ["symbols"] });
        assert.ok(out.symbols, "handler re-resolves after dispose()");
    });

    it("constructs and disposes one owned handler under concurrent first resolution", async () => {
        let constructions = 0;
        let disposals = 0;
        class Handler extends BaseHandler {
            constructor(metadata: HandlerMetadata) {
                super(metadata);
                constructions += 1;
            }

            override async dispose(): Promise<void> {
                disposals += 1;
            }
        }
        const m = lifecycleMimetypes({ Handler });

        const [first, second] = await Promise.all([
            m.getHandler(INFO.mimetype),
            m.getHandler(INFO.mimetype),
        ]);
        assert.equal(first, second, "concurrent resolution shares one handler identity");
        assert.equal(constructions, 1);

        await m.dispose();
        await m.dispose();
        assert.equal(disposals, 1, "one cached handler generation is released once");

        await m.getHandler(INFO.mimetype);
        await m.dispose();
        assert.equal(constructions, 2, "post-disposal use creates one new generation");
        assert.equal(disposals, 2);
    });

    it("attempts every handler and artifact teardown and preserves every failure", async () => {
        const embeddingFailure = new Error("embedding dispose failed");
        const tokenizerFailure = new Error("tokenizer dispose failed");
        const handlerFailure = new Error("handler dispose failed");
        class Handler extends BaseHandler {
            override async dispose(): Promise<void> {
                throw handlerFailure;
            }
        }
        const m = lifecycleMimetypes({
            Handler,
            embedder: {
                dimension: 2,
                model: "fixture@1",
                async embedQuery() {
                    return { vector: EmbeddingVector.encode([0, 0]), metadata: { inputTokens: null, warnings: [], accounting: [] } };
                },
                async embedDocuments(texts: readonly string[]) {
                    return { vectors: texts.map(() => EmbeddingVector.encode([0, 0])), metadata: { inputTokens: null, warnings: [], accounting: [] } };
                },
                async dispose(): Promise<void> { throw embeddingFailure; },
            },
            tokenizers: {
                async resolve(): Promise<null> { return null; },
                async dispose(): Promise<void> { throw tokenizerFailure; },
            },
        });
        await Promise.all([
            m.getHandler(INFO.mimetype),
            m.embedderInfo(),
            m.tokenizer("test-model"),
        ]);

        await assert.rejects(
            () => m.dispose(),
            (error: unknown) => {
                assert.ok(error instanceof AggregateError);
                assert.equal(error.message, "mimetype resource shutdown failed");
                assert.deepEqual(error.errors, [embeddingFailure, tokenizerFailure, handlerFailure]);
                return true;
            },
        );
    });

    it("concurrent dispose calls await the same teardown attempt", async () => {
        const entered = Promise.withResolvers<void>();
        const release = Promise.withResolvers<void>();
        let disposals = 0;
        const m = lifecycleMimetypes({
            embedder: {
                dimension: 2,
                model: "fixture@1",
                async embedQuery() {
                    return { vector: EmbeddingVector.encode([0, 0]), metadata: { inputTokens: null, warnings: [], accounting: [] } };
                },
                async embedDocuments(texts: readonly string[]) {
                    return { vectors: texts.map(() => EmbeddingVector.encode([0, 0])), metadata: { inputTokens: null, warnings: [], accounting: [] } };
                },
                async dispose(): Promise<void> {
                    disposals += 1;
                    entered.resolve();
                    await release.promise;
                },
            },
        });
        await m.embedderInfo();

        const first = m.dispose();
        await entered.promise;
        let secondSettled = false;
        const second = m.dispose().then(() => { secondSettled = true; });
        await new Promise<void>((resolve) => setImmediate(resolve));
        assert.equal(secondSettled, false, "a concurrent caller waits for the active disposal");
        release.resolve();
        await Promise.all([first, second]);
        assert.equal(disposals, 1);
    });

    it("Tree-sitter handlers delete cached query and parser resources once per generation", async () => {
        let parserDeletes = 0;
        let queryDeletes = 0;
        const rootNode: TreeSitterNode = {
            type: "program",
            text: "x",
            startIndex: 0,
            endIndex: 1,
            startPosition: { row: 0, column: 0 },
            endPosition: { row: 0, column: 1 },
            childCount: 0,
            namedChildCount: 0,
            nextNamedSibling: null,
            child: () => null,
            namedChild: () => null,
            childForFieldName: () => null,
            descendantsOfType: () => [],
        };
        class Query {
            constructor(_language: unknown, _source: string) {}
            captures(): [] { return []; }
            delete(): void { queryDeletes += 1; }
        }
        class Handler extends TreeSitterExtractor {
            protected async loadParser(): Promise<TreeSitterParser> {
                this.setQueryContext({}, Query as QueryConstructor);
                return {
                    parse: () => ({ rootNode, delete() {} }),
                    delete: () => { parserDeletes += 1; },
                } as TreeSitterParser & { delete(): void };
            }

            protected extractFromTree(_tree: TreeSitterTree, _content: string): MimeSymbol[] {
                return [];
            }

            async prime(): Promise<void> {
                await this.collectRefs("x", "(identifier) @ref.use", () => []);
            }
        }
        const handler = new Handler({
            mimetype: INFO.mimetype,
            glyph: INFO.glyph,
            extensions: INFO.extensions,
        });
        const disposable = handler as Handler & { dispose(): Promise<void> };

        await handler.prime();
        await disposable.dispose();
        await disposable.dispose();
        assert.equal(queryDeletes, 1);
        assert.equal(parserDeletes, 1);

        await handler.prime();
        await disposable.dispose();
        assert.equal(queryDeletes, 2, "reuse allocates and releases a fresh query");
        assert.equal(parserDeletes, 2, "reuse allocates and releases a fresh parser");
    });
});
