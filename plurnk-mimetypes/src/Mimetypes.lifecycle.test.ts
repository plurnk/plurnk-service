import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import Mimetypes from "./Mimetypes.ts";
import BaseHandler from "./BaseHandler.ts";
import MimetypeExtensionError from "./MimetypeExtensionError.ts";
import MimetypeDerivationError from "./MimetypeDerivationError.ts";
import MimetypeInputError from "./MimetypeInputError.ts";
import type { Discovery, HandlerInfo, MimeSymbol, Registry, HandlerMetadata, MimeRef } from "./types.ts";
import TreeSitterExtractor, { type TreeSitterNode, type TreeSitterParser, type TreeSitterTree } from "./TreeSitterExtractor.ts";
import TreeSitterLanguageHandler, { resolveWasmPath } from "./treesitter/handler.ts";
import { isExactModuleAbsent } from "./module-absence.ts";

function makeDiscovery(handlers: HandlerInfo[]): Discovery {
    const byExtension = new Map<string, string>();
    const byFilename = new Map<string, string>();
    const handlerMap = new Map<string, HandlerInfo>();
    for (const info of handlers) {
        handlerMap.set(info.mimetype, info);
        for (const ext of info.extensions) {
            if (ext.startsWith(".")) byExtension.set(ext.toLowerCase(), info.mimetype);
            else byFilename.set(ext, info.mimetype);
        }
    }
    const registry: Registry = { byExtension, byFilename };
    return { registry, handlers: handlerMap, packageAttributions: new Map(), skipped: [] };
}

// ─── Mimetypes.dispose.test.ts ───
{
const INFO: HandlerInfo = {
    mimetype: "text/x-test",
    glyph: "🧪",
    packageName: "@plurnk/x",
    projectionRevision: "test-1",
    extensions: [".tst"],
    binary: false,
    source: "package",
};

const INFO2: HandlerInfo = { ...INFO, mimetype: "text/x-test2", packageName: "@plurnk/x2", extensions: [".tst2"] };

function lifecycleMimetypes({
    Handler = BaseHandler,
    Second = BaseHandler,
}: {
    Handler?: new (metadata: HandlerMetadata) => BaseHandler;
    Second?: new (metadata: HandlerMetadata) => BaseHandler;
} = {}): Mimetypes {
    return new Mimetypes({
        discovery: makeDiscovery([INFO, INFO2]),
        loader: async (pkg) => ({ default: pkg === INFO2.packageName ? Second : Handler }),
    });
}

describe("{§mimetype-lifecycle} Mimetypes.dispose()", () => {
    for (const strict of [false, true]) {
        it(`{§mimetype-lifecycle} releases cleanly after real missing-grammar resolution (strict=${strict})`, async () => {
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

    it("{§mimetype-lifecycle} reports parser acquisition failure to its caller, not again during teardown", async () => {
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

    it("{§mimetype-lifecycle} a handler re-resolves after dispose()", async () => {
        const m = lifecycleMimetypes();
        await m.process({ path: "a.tst", content: "x\ny" }, { channels: ["symbols"] });
        await m.dispose();
        const out = await m.process({ path: "a.tst", content: "x\ny" }, { channels: ["symbols"] });
        assert.ok(out.symbols, "handler re-resolves after dispose()");
    });

    it("{§mimetype-lifecycle} constructs and disposes one owned handler under concurrent first resolution", async () => {
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

    it("{§mimetype-lifecycle} attempts every handler teardown and preserves every failure", async () => {
        const firstFailure = new Error("first handler dispose failed");
        const secondFailure = new Error("second handler dispose failed");
        class First extends BaseHandler {
            override async dispose(): Promise<void> { throw firstFailure; }
        }
        class Second extends BaseHandler {
            override async dispose(): Promise<void> { throw secondFailure; }
        }
        const m = lifecycleMimetypes({ Handler: First, Second });
        await Promise.all([m.getHandler(INFO.mimetype), m.getHandler(INFO2.mimetype)]);

        await assert.rejects(
            () => m.dispose(),
            (error: unknown) => {
                assert.ok(error instanceof AggregateError);
                assert.equal(error.message, "mimetype resource shutdown failed");
                assert.deepEqual(new Set(error.errors), new Set([firstFailure, secondFailure]));
                return true;
            },
        );
    });

    it("{§mimetype-lifecycle} concurrent dispose calls await the same teardown attempt", async () => {
        const entered = Promise.withResolvers<void>();
        const release = Promise.withResolvers<void>();
        let disposals = 0;
        class Blocking extends BaseHandler {
            override async dispose(): Promise<void> {
                disposals += 1;
                entered.resolve();
                await release.promise;
            }
        }
        const m = lifecycleMimetypes({ Handler: Blocking });
        await m.getHandler(INFO.mimetype);

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
        it(`{§mimetype-lifecycle} Tree-sitter teardown attempts query before parser and preserves delete failures (failing=${failingDelete})`, async () => {
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
                // oxlint-disable-next-line no-useless-constructor -- the stub keeps web-tree-sitter's Query(language, source) arity
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
                    this.setQueryContext({}, Query);
                    return {
                        parse: () => ({ rootNode, delete() {} }),
                        delete: () => {
                            parserDeletes += 1;
                            order.push("parser");
                            if (failingDelete) throw parserFailure;
                        },
                    };
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
}

// ─── Mimetypes.extension-failure.test.ts ───
{
// This file's fixtures are third-party packages, so it exercises the operator who admitted them
// ({§executor-policy}); the shipped panel admits only `@plurnk/*`.
process.env.PLURNK_EXTENSIONS_TRUSTED_ONLY = "0";

const roots: string[] = [];
const info: HandlerInfo = {
    mimetype: "text/fixture",
    glyph: "F",
    packageName: "@fixture/mimetype-handler",
    projectionRevision: "test-1",
    extensions: [".fixture"],
    binary: false,
    source: "package",
};

const discovery = makeDiscovery([info]);

const orchestrator = (loader: () => Promise<unknown>): Mimetypes => new Mimetypes({
    discovery,
    loader,
});

function isExtensionError(error: unknown, cause?: unknown): boolean {
    assert.ok(error instanceof MimetypeExtensionError);
    assert.match(error.message, /@fixture\/mimetype-handler/);
    assert.match(error.message, /text\/fixture/);
    if (cause !== undefined) assert.strictEqual(error.cause, cause);
    return true;
}

afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("{§mimetype-handler-contract} declared mimetype extension failures", () => {
    it("{§mimetype-discovery} surfaces one declaration failure through ready, process, and query", async () => {
        const root = await mkdtemp(path.join(tmpdir(), "plurnk-invalid-mimetype-"));
        roots.push(root);
        const packageRoot = path.join(root, "invalid-handler");
        await mkdir(packageRoot);
        await writeFile(path.join(packageRoot, "package.json"), JSON.stringify({
            name: "@fixture/invalid-handler",
            plurnk: { kind: "mimetype", handlers: "not-an-array" },
        }));

        const make = (): Mimetypes => new Mimetypes({
            discoverOptions: { packageDirs: [packageRoot], includeTreeSitter: false },
        });
        const calls = [
            () => make().ready(),
            () => make().process({ content: "fixture", hint: "text/fixture" }),
            () => make().query({ content: "fixture", hint: "text/fixture" }, "/fixture/"),
        ];

        for (const call of calls) {
            await assert.rejects(call, (error: unknown) => {
                assert.ok(error instanceof MimetypeExtensionError);
                assert.match(error.message, /@fixture\/invalid-handler/);
                assert.match(error.message, /handlers/);
                assert.equal(error.packageName, "@fixture/invalid-handler");
                assert.equal(error.mimetype, null);
                assert.equal(error.manifestPath, path.join(packageRoot, "package.json"));
                return true;
            });
        }
    });

    it("{§mimetype-discovery} preserves a handler import failure through getHandler, process, and query", async () => {
        const cause = new Error("nested import exploded");
        const calls = [
            () => orchestrator(async () => { throw cause; }).getHandler(info.mimetype),
            () => orchestrator(async () => { throw cause; }).process({ content: "fixture", hint: info.mimetype }),
            () => orchestrator(async () => { throw cause; }).query(
                { content: "fixture", hint: info.mimetype },
                "/fixture/",
            ),
        ];

        for (const call of calls) await assert.rejects(call, (error: unknown) => isExtensionError(error, cause));
    });

    it("{§mimetype-discovery} preserves a handler constructor failure", async () => {
        const cause = new RangeError("constructor rejected metadata");
        class BrokenHandler {
            constructor() {
                throw cause;
            }
        }

        await assert.rejects(
            () => orchestrator(async () => ({ default: BrokenHandler })).getHandler(info.mimetype),
            (error: unknown) => isExtensionError(error, cause),
        );
    });

    it("{§mimetype-discovery} rejects an incomplete handler at load time rather than at a selected channel", async () => {
        class PartialHandler {
            readonly mimetype = info.mimetype;
            readonly glyph = info.glyph;
            readonly extensions = info.extensions;
            extractRaw(): never[] { return []; }
        }

        await assert.rejects(
            () => orchestrator(async () => ({ default: PartialHandler })).getHandler(info.mimetype),
            (error: unknown) => {
                assert.equal(isExtensionError(error), true);
                assert.ok(error instanceof Error);
                assert.match(String(error.cause), /handler surface/);
                assert.doesNotMatch(error.message, /0\.15|predates/);
                return true;
            },
        );
    });
});
}

// ─── Mimetypes.grammar-degradation.test.ts ───
{
class FakeMissingGrammarHandler extends BaseHandler {
    override extractRaw(): MimeSymbol[] {
        throw makeGrammarError();
    }
    override deepJson(): unknown {
        throw makeGrammarError();
    }
}

function makeGrammarError(): Error {
    const err = new Error("Grammar not installed for testing");
    err.name = "GrammarNotInstalledError";
    (err as Error & { plurnkPackage?: string }).plurnkPackage = "@plurnk/plurnk-mimetypes-grammar-fake";
    return err;
}

const FAKE_INFO: HandlerInfo = {
    mimetype: "text/x-fake",
    glyph: "🧪",
    packageName: "@plurnk/plurnk-mimetypes-grammar-fake",
    projectionRevision: "test-1",
    extensions: [".fake"],
    binary: false,
    source: "package",
};

function makeMimetypes() {
    return new Mimetypes({
        discovery: makeDiscovery([FAKE_INFO]),
        loader: async () => ({ default: FakeMissingGrammarHandler }),
    });
}

describe("{§mimetype-error-policy} missing grammar degrades (not an error)", () => {
    it("{§mimetype-grammar-packages} process() returns ok:true when grammar is missing", async () => {
        const m = makeMimetypes();
        const result = await m.process({ path: "foo.fake", content: "line one\nline two\nline three" });
        assert.equal(result.mimetype, "text/x-fake", "detected mimetype is preserved on the result");
        assert.equal(result.ok, true, "degraded result is still ok");
    });

    it("{§mimetype-grammar-packages} the degraded result carries empty channels for what was requested", async () => {
        const m = makeMimetypes();
        const result = await m.process({ path: "foo.fake", content: "anything" });
        assert.deepEqual(result.symbols, [], "symbols are empty when grammar is missing");
        assert.equal(result.deepJson, null, "deepJson is null when grammar is missing");
        assert.equal(result.deepXml, "", "deepXml is empty when grammar is missing");
        assert.deepEqual(result.references, [], "references are empty when grammar is missing");
    });

    it("{§mimetype-grammar-packages} unrequested channels stay absent on the degraded path", async () => {
        const m = makeMimetypes();
        const result = await m.process(
            { path: "foo.fake", content: "anything" },
            { channels: ["symbols"] },
        );
        assert.deepEqual(result.symbols, []);
        assert.equal("deepJson" in result, false);
        assert.equal("deepXml" in result, false);
        assert.equal("references" in result, false);
    });

    it("{§mimetype-grammar-packages} totalLines is still computed on the degraded path", async () => {
        const m = makeMimetypes();
        const result = await m.process({ path: "foo.fake", content: "a\nb\nc\nd" });
        assert.equal(result.totalLines, 4);
    });
});

describe("{§mimetype-error-policy} grammarMissing surfaces the install hint as data", () => {
    it("{§mimetype-grammar-packages} grammarMissing is set to the package name on the degraded result", async () => {
        const m = makeMimetypes();
        const result = await m.process({ path: "foo.fake", content: "x" });
        assert.equal(result.grammarMissing, "@plurnk/plurnk-mimetypes-grammar-fake");
    });

    it("{§mimetype-grammar-packages} grammarMissing is absent on the happy path", async () => {
        class WorkingHandler extends BaseHandler {}
        const m = new Mimetypes({
            discovery: makeDiscovery([FAKE_INFO]),
            loader: async () => ({ default: WorkingHandler }),
        });
        const result = await m.process({ path: "foo.fake", content: "plain content" });
        assert.equal(result.grammarMissing, undefined);
    });

    it("{§mimetype-grammar-packages} the Notice preserves the detected mimetype instead of claiming substitution", async () => {
        const result = await makeMimetypes().process({ path: "foo.fake", content: "x" });
        const notice = result.notices?.find(({ kind }) => kind === "grammar_degraded");
        assert.ok(notice);
        assert.equal(notice.mimetype, "text/x-fake");
        assert.match(String(notice.message), /structural channels/i);
        assert.doesNotMatch(String(notice.message), /text[- ]plain/i);
    });
});

describe("{§mimetype-error-policy} strict mode throws instead of degrading", () => {
    it("{§mimetype-grammar-packages} process(input, { strict: true }) throws GrammarNotInstalledError on missing-grammar paths", async () => {
        const m = makeMimetypes();
        await assert.rejects(
            () => m.process(
                { path: "foo.fake", content: "x" },
                { strict: true },
            ),
            (err: unknown) => (err as Error).name === "GrammarNotInstalledError",
        );
    });

    it("{§mimetype-grammar-packages} non-strict (default) does NOT throw for the same input", async () => {
        const m = makeMimetypes();
        await assert.doesNotReject(
            m.process({ path: "foo.fake", content: "x" }),
        );
    });
});
}

// ─── Mimetypes.projection-failure.test.ts ───
{
const HANDLER_PACKAGE = "@acme/mimetype-fixture";
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

const discovery = () => makeDiscovery([info]);

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

describe("{§mimetype-error-policy} causal projection failures", () => {
    it("{§mimetype-error-policy} classifies validate() rejection once and preserves its cause", async () => {
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

    it("{§mimetype-error-policy} validates only structure-dependent queries and preserves the source cause", async () => {
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

    it("{§mimetype-error-policy} does not convert a readable-projection defect into an empty content channel", async () => {
        const cause = new Error("readable projection implementation failed");
        class BrokenReadableHandler extends BaseHandler {
            override content(): never {
                throw cause;
            }
        }
        const mimetypes = new Mimetypes({
            discovery: discovery(),
            loader: async () => ({ default: BrokenReadableHandler }),
        });

        await assert.rejects(
            mimetypes.process(
                { hint: metadata.mimetype, content: "valid" },
                { channels: ["content"] },
            ),
            (error) => {
                assert.ok(error instanceof MimetypeDerivationError);
                assert.equal(error.path, null);
                assert.equal(error.mimetype, "application/x-fixture");
                assert.equal(error.cause, cause);
                return true;
            },
        );
    });

    it("{§mimetype-error-policy} maps a typed source-projection rejection to the query fallback class", async () => {
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

    it("{§mimetype-error-policy} preserves a tree-sitter query execution defect", async () => {
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

    it("{§mimetype-error-policy} preserves a tree-sitter query compilation defect", async () => {
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

    it("{§mimetype-error-policy} preserves a built-in mapping import defect", async () => {
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
}

// ─── module-absence.test.ts ───
{
describe("{§mimetype-error-policy} exact module absence", () => {
    it("{§mimetype-grammar-packages} recognizes the exact requested grammar manifest", () => {
        const specifier = "@plurnk/plurnk-mimetypes-grammar-fixture/package.json";
        const error = Object.assign(
            new Error(`Cannot find module '${specifier}'`),
            { code: "MODULE_NOT_FOUND" },
        );
        assert.equal(isExactModuleAbsent(error, specifier), true);
    });

    it("{§mimetype-grammar-packages} does not classify an exports defect as package absence", () => {
        const specifier = "@plurnk/plurnk-mimetypes-grammar-fixture/package.json";
        const error = Object.assign(
            new Error(`Package subpath './package.json' is not defined by exports in ${specifier}`),
            { code: "ERR_PACKAGE_PATH_NOT_EXPORTED" },
        );
        assert.equal(isExactModuleAbsent(error, specifier), false);
    });

    it("{§mimetype-grammar-packages} does not classify a missing transitive dependency as artifact absence", () => {
        const specifier = "@plurnk/plurnk-mimetypes-grammar-fixture/package.json";
        const error = Object.assign(
            new Error("Cannot find module 'broken-transitive-dependency'"),
            { code: "MODULE_NOT_FOUND" },
        );
        assert.equal(isExactModuleAbsent(error, specifier), false);
    });

    it("{§mimetype-grammar-packages} maps an exactly absent grammar package to GrammarNotInstalledError", async () => {
        await assert.rejects(
            resolveWasmPath({
                mimetype: "text/x-definitely-absent",
                glyph: "",
                extensions: [],
                slug: "definitely-absent",
                revision: "test-1",
                importMapping: async () => ({ extract: () => [] }),
            }),
            (error: unknown) => {
                assert.equal((error as Error).name, "GrammarNotInstalledError");
                assert.equal(
                    (error as { plurnkPackage?: unknown }).plurnkPackage,
                    "@plurnk/plurnk-mimetypes-grammar-definitely-absent",
                );
                return true;
            },
        );
    });
});
}
