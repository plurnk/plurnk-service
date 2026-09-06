// Contract: {§mimetype-lifecycle}.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import Mimetypes from "../Mimetypes.ts";
import MimetypeDerivationError from "../MimetypeDerivationError.ts";
import BaseHandler from "../BaseHandler.ts";
import TreeSitterExtractor from "../TreeSitterExtractor.ts";
import TreeSitterLanguageHandler from "../treesitter/handler.ts";
import type {
    QueryConstructor,
    TreeSitterNode,
    TreeSitterParser,
    TreeSitterTree,
} from "../TreeSitterExtractor.ts";
import type { HandlerMetadata, MimeSymbol } from "../types.ts";
import type { Discovery, HandlerInfo, Registry } from "../types.ts";

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

function lifecycleMimetypes({
    Handler = BaseHandler,
    tokenizers,
}: {
    Handler?: new (metadata: HandlerMetadata) => BaseHandler;
    tokenizers?: unknown;
} = {}): Mimetypes {
    return new Mimetypes({
        discovery: makeDiscovery(),
        loader: async (pkg) => {
            if (pkg === TOK_PKG) return tokenizers;
            return { default: Handler };
        },
    });
}

describe("{§mimetype-lifecycle} — Mimetypes.dispose()", () => {
    for (const strict of [false, true]) {
        it(`releases cleanly after real missing-grammar resolution (strict=${strict})`, async () => {
            class Handler extends TreeSitterLanguageHandler {
                constructor(metadata: HandlerMetadata) {
                    super(metadata, {
                        mimetype: INFO.mimetype,
                        glyph: INFO.glyph,
                        extensions: INFO.extensions,
                        slug: "definitely-absent",
                        revision: "test-1",
                        importMapping: async () => ({ extract: () => [] }),
                    });
                }
            }
            const m = lifecycleMimetypes({ Handler });
            const processing = m.process(
                { path: "a.tst", content: "x" },
                { channels: ["symbols"], strict },
            );
            if (strict) {
                await assert.rejects(processing, {
                    name: "GrammarNotInstalledError",
                    plurnkPackage: "@plurnk/plurnk-mimetypes-grammar-definitely-absent",
                });
            } else {
                const result = await processing;
                assert.equal(result.ok, true);
                assert.deepEqual(result.symbols, []);
                assert.equal(result.grammarMissing, "@plurnk/plurnk-mimetypes-grammar-definitely-absent");
                assert.ok(result.notices?.some(({ kind }) => kind === "grammar_degraded"));
            }
            await assert.doesNotReject(m.dispose());
            await assert.doesNotReject(m.dispose());
        });
    }

    it("reports parser acquisition failure to its caller, not again during teardown", async () => {
        const failure = new Error("parser initialization failed");
        let acquisitions = 0;
        class Handler extends TreeSitterExtractor {
            protected async loadParser(): Promise<TreeSitterParser> {
                acquisitions += 1;
                throw failure;
            }
            protected extractFromTree(): MimeSymbol[] { return []; }
        }
        const m = lifecycleMimetypes({ Handler });
        const process = () => m.process(
            { path: "a.tst", content: "x" },
            { channels: ["symbols"], strict: true },
        );
        const preservesFailure = (error: unknown): boolean => {
            assert.ok(error instanceof MimetypeDerivationError);
            assert.equal(error.path, "a.tst");
            assert.equal(error.cause, failure);
            return true;
        };
        await assert.rejects(process(), preservesFailure);
        await assert.doesNotReject(m.dispose());
        await assert.rejects(process(), preservesFailure);
        assert.equal(acquisitions, 2, "disposal permits a fresh acquisition generation");
        await assert.doesNotReject(m.dispose());
    });

    for (const artifact of ["tokenizer"] as const) {
        it(`reports ${artifact} acquisition failure to its caller, not again during teardown`, async () => {
            const failure = new Error(`${artifact} artifact initialization failed`);
            const m = new Mimetypes({
                discovery: makeDiscovery(),
                loader: async () => { throw failure; },
            });
            const acquisition = m.tokenizer("test-model");
            await assert.rejects(acquisition, (error) => error === failure);
            await assert.doesNotReject(m.dispose());
        });
    }

    it("D5: clears cached handler instances", async () => {
        const m = lifecycleMimetypes();
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
        const tokenizerFailure = new Error("tokenizer dispose failed");
        const handlerFailure = new Error("handler dispose failed");
        class Handler extends BaseHandler {
            override async dispose(): Promise<void> {
                throw handlerFailure;
            }
        }
        const m = lifecycleMimetypes({
            Handler,
            tokenizers: {
                async resolve(): Promise<null> { return null; },
                async dispose(): Promise<void> { throw tokenizerFailure; },
            },
        });
        await Promise.all([
            m.getHandler(INFO.mimetype),
            m.tokenizer("test-model"),
        ]);

        await assert.rejects(
            () => m.dispose(),
            (error: unknown) => {
                assert.ok(error instanceof AggregateError);
                assert.equal(error.message, "mimetype resource shutdown failed");
                assert.deepEqual(error.errors, [tokenizerFailure, handlerFailure]);
                return true;
            },
        );
    });

    it("concurrent dispose calls await the same teardown attempt", async () => {
        const entered = Promise.withResolvers<void>();
        const release = Promise.withResolvers<void>();
        let disposals = 0;
        const m = lifecycleMimetypes({
            tokenizers: {
                async resolve(): Promise<null> { return null; },
                async dispose(): Promise<void> {
                    disposals += 1;
                    entered.resolve();
                    await release.promise;
                },
            },
        });
        await m.tokenizer("test-model");

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

    for (const failingDelete of [false, true]) {
        it(`Tree-sitter teardown attempts query before parser and preserves delete failures (failing=${failingDelete})`, async () => {
            let parserDeletes = 0;
            let queryDeletes = 0;
            const order: string[] = [];
            const queryFailure = new Error("query delete failed");
            const parserFailure = new Error("parser delete failed");
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
                delete(): void {
                    queryDeletes += 1;
                    order.push("query");
                    if (failingDelete) throw queryFailure;
                }
            }
            class Handler extends TreeSitterExtractor {
                protected async loadParser(): Promise<TreeSitterParser> {
                    this.setQueryContext({}, Query as QueryConstructor);
                    return {
                        parse: () => ({ rootNode, delete() {} }),
                        delete: () => {
                            parserDeletes += 1;
                            order.push("parser");
                            if (failingDelete) throw parserFailure;
                        },
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
            async function dispose(): Promise<void> {
                if (!failingDelete) return disposable.dispose();
                await assert.rejects(disposable.dispose(), (error: unknown) => {
                    assert.ok(error instanceof AggregateError);
                    assert.equal(error.message, "Tree-sitter handler shutdown failed");
                    assert.deepEqual(error.errors, [queryFailure, parserFailure]);
                    return true;
                });
            }

            await handler.prime();
            await dispose();
            await disposable.dispose();
            assert.equal(queryDeletes, 1);
            assert.equal(parserDeletes, 1);

            await handler.prime();
            await dispose();
            assert.equal(queryDeletes, 2, "reuse allocates and releases a fresh query");
            assert.equal(parserDeletes, 2, "reuse allocates and releases a fresh parser");
            assert.deepEqual(order, ["query", "parser", "query", "parser"]);
        });
    }
});
