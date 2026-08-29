// Contract: {§mimetype-error-policy}. Issue #92 is provenance.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import BaseHandler from "../BaseHandler.ts";
import { EmbeddingVector } from "../index.ts";
import MimetypeInputError from "../MimetypeInputError.ts";
import Mimetypes from "../Mimetypes.ts";
import TreeSitterExtractor from "../TreeSitterExtractor.ts";
import TreeSitterLanguageHandler from "../treesitter/handler.ts";
import type {
    TreeSitterNode,
    TreeSitterParser,
    TreeSitterTree,
} from "../TreeSitterExtractor.ts";
import type {
    Discovery,
    HandlerInfo,
    MimeRef,
    MimeSymbol,
} from "../types.ts";

const HANDLER_PACKAGE = "@acme/mimetype-fixture";
const EMBEDDINGS_PACKAGE = "@plurnk/plurnk-mimetypes-embeddings";
const metadata = {
    mimetype: "application/x-fixture",
    glyph: "🧪",
    extensions: [".fixture"] as const,
};

const info: HandlerInfo = {
    ...metadata,
    packageName: HANDLER_PACKAGE,
    projectionRevision: "test-1",
    binary: false,
    source: "package",
};

function discovery(handler: HandlerInfo = info): Discovery {
    return {
        registry: {
            byExtension: new Map([[".fixture", handler.mimetype]]),
            byFilename: new Map(),
        },
        handlers: new Map([[handler.mimetype, handler]]),
        skipped: [],
    };
}

function embeddingArtifact() {
    const vector = EmbeddingVector.encode([1]);
    return {
        dimension: 1,
        model: "fixture@1",
        embedQuery: async () => ({
            vector,
            metadata: { inputTokens: null, warnings: [], accounting: [] },
        }),
        embedDocuments: async (texts: readonly string[]) => ({
            vectors: texts.map(() => vector),
            metadata: { inputTokens: null, warnings: [], accounting: [] },
        }),
    };
}

function fakeNode(text: string): TreeSitterNode {
    return {
        type: "root",
        text,
        startIndex: 0,
        endIndex: text.length,
        startPosition: { row: 0, column: 0 },
        endPosition: { row: 0, column: text.length },
        childCount: 0,
        namedChildCount: 0,
        nextNamedSibling: null,
        child: () => null,
        namedChild: () => null,
        childForFieldName: () => null,
        descendantsOfType: () => [],
    };
}

describe("#92 causal projection failures", () => {
    it("classifies validate() rejection once and preserves its cause", async () => {
        const cause = new SyntaxError("fixture source is malformed");
        class InvalidHandler extends BaseHandler {
            override validate(): never {
                throw cause;
            }
        }
        const mimetypes = new Mimetypes({
            discovery: discovery(),
            loader: async () => ({ default: InvalidHandler }),
        });

        await assert.rejects(
            mimetypes.process(
                { hint: metadata.mimetype, content: "malformed" },
                { channels: [] },
            ),
            (error: unknown) => {
                assert.equal((error as Error).name, "MimetypeInputError");
                assert.equal((error as Error).cause, cause);
                assert.equal(
                    (error as { mimetype?: unknown }).mimetype,
                    metadata.mimetype,
                );
                return true;
            },
        );
    });

    it("validates only structure-dependent queries and preserves the source cause", async () => {
        const parseCause = new SyntaxError("fixture structure is malformed");
        class InvalidStructureHandler extends BaseHandler {
            override validate(): never {
                throw parseCause;
            }
        }
        const mimetypes = new Mimetypes({
            discovery: discovery(),
            loader: async () => ({ default: InvalidStructureHandler }),
        });

        for (const matcher of [
            { dialect: "jsonpath" as const, pattern: "$.value" },
            { dialect: "xpath" as const, pattern: "//value" },
        ]) {
            await assert.rejects(
                mimetypes.query(
                    { hint: metadata.mimetype, content: "malformed needle" },
                    matcher,
                ),
                (error: unknown) => {
                    assert.equal((error as Error).name, "QueryParseFailureError");
                    const inputFailure = (error as Error).cause as Error;
                    assert.equal(inputFailure.name, "MimetypeInputError");
                    assert.equal(inputFailure.cause, parseCause);
                    return true;
                },
            );
        }

        const matches = await mimetypes.query(
            { hint: metadata.mimetype, content: "malformed needle" },
            { dialect: "regex", pattern: "needle" },
        );
        assert.equal(matches.length, 1);
        assert.equal(matches[0].matched, "needle");
    });

    it("does not convert a readable-projection defect into an empty embedding", async () => {
        const cause = new Error("readable projection implementation failed");
        class BrokenReadableHandler extends BaseHandler {
            override content(): never {
                throw cause;
            }
        }
        const mimetypes = new Mimetypes({
            discovery: discovery(),
            loader: async (packageName) => packageName === EMBEDDINGS_PACKAGE
                ? embeddingArtifact()
                : { default: BrokenReadableHandler },
        });

        await assert.rejects(
            mimetypes.process(
                { hint: metadata.mimetype, content: "valid" },
                { channels: ["embedding"] },
            ),
            (error) => error === cause,
        );
    });

    it("retains empty embedding as the honest unsupported-readable capability value", async () => {
        const binaryInfo: HandlerInfo = { ...info, binary: true };
        class BinaryWithoutReadableProjection extends BaseHandler {}
        const mimetypes = new Mimetypes({
            discovery: discovery(binaryInfo),
            loader: async (packageName) => packageName === EMBEDDINGS_PACKAGE
                ? embeddingArtifact()
                : { default: BinaryWithoutReadableProjection },
        });

        const result = await mimetypes.process(
            { hint: metadata.mimetype, content: new Uint8Array([1, 2, 3]) },
            { channels: ["embedding"] },
        );
        assert.equal(result.embedding?.byteLength, 0);
        assert.equal(result.notices, undefined);
    });

    it("maps a typed source-projection rejection to the query fallback class", async () => {
        const parseCause = new SyntaxError("fixture structure is malformed");
        const inputFailure = new MimetypeInputError({
            mimetype: metadata.mimetype,
            cause: parseCause,
        });
        class MalformedStructureHandler extends BaseHandler {
            override deepJson(): never {
                throw inputFailure;
            }
        }
        const mimetypes = new Mimetypes({
            discovery: discovery(),
            loader: async () => ({ default: MalformedStructureHandler }),
        });

        await assert.rejects(
            mimetypes.query(
                { hint: metadata.mimetype, content: "malformed" },
                { dialect: "jsonpath", pattern: "$.value" },
            ),
            (error: unknown) => {
                assert.equal((error as Error).name, "QueryParseFailureError");
                assert.equal((error as Error).cause, inputFailure);
                assert.equal(inputFailure.cause, parseCause);
                return true;
            },
        );
    });

    it("preserves a tree-sitter query execution defect", async () => {
        const cause = new Error("query execution implementation failed");
        class BrokenQuery {
            captures(): never {
                throw cause;
            }
        }
        class ReferencesHandler extends TreeSitterExtractor {
            protected override async loadParser(): Promise<TreeSitterParser> {
                this.setQueryContext({}, BrokenQuery);
                return {
                    parse: (content): TreeSitterTree => ({ rootNode: fakeNode(content) }),
                };
            }

            protected override extractFromTree(): MimeSymbol[] {
                return [];
            }

            override references(content: string | Uint8Array): Promise<MimeRef[]> {
                return this.collectRefs(content, "(identifier) @ref.use", () => []);
            }
        }

        await assert.rejects(
            new ReferencesHandler(metadata).references("value"),
            (error) => error === cause,
        );
    });

    it("preserves a tree-sitter query compilation defect", async () => {
        const cause = new Error("query compilation implementation failed");
        class BrokenQuery {
            constructor() {
                throw cause;
            }
        }
        class ReferencesHandler extends TreeSitterExtractor {
            protected override async loadParser(): Promise<TreeSitterParser> {
                this.setQueryContext({}, BrokenQuery);
                return {
                    parse: (content): TreeSitterTree => ({ rootNode: fakeNode(content) }),
                };
            }

            protected override extractFromTree(): MimeSymbol[] {
                return [];
            }

            override references(content: string | Uint8Array): Promise<MimeRef[]> {
                return this.collectRefs(content, "invalid fixture query", () => []);
            }
        }

        await assert.rejects(
            new ReferencesHandler(metadata).references("value"),
            (error) => error === cause,
        );
    });

    it("preserves a built-in mapping import defect", async () => {
        const cause = new Error("mapping import implementation failed");
        const handler = new TreeSitterLanguageHandler({
            mimetype: "text/x-python",
            glyph: "🐍",
            extensions: [".py"],
        }, {
            mimetype: "text/x-python",
            glyph: "🐍",
            extensions: [".py"],
            slug: "python",
            revision: "test-1",
            importMapping: async () => { throw cause; },
        });

        try {
            await assert.rejects(
                handler.extractRaw("def value():\n    return 1\n"),
                (error) => error === cause,
            );
        } finally {
            await handler.dispose();
        }
    });
});
