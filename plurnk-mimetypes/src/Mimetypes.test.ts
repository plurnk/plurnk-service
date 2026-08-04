// Contracts: {§mimetype-channel-selection}, {§mimetype-validation},
// {§mimetype-error-policy}.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import Mimetypes from "./Mimetypes.ts";
import BaseHandler from "./BaseHandler.ts";
import MimetypePluginError from "./MimetypePluginError.ts";
import { UnsupportedDialectError } from "./QueryError.ts";
import type {
    Discovery,
    HandlerInfo,
    MimeSymbol,
    Registry,
} from "./types.ts";

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
    return { registry, handlers: handlerMap, skipped: [] };
}

// A canned handler that emits a single symbol regardless of content.
class FakePlainHandler extends BaseHandler {
    override extractRaw(_content: string): MimeSymbol[] {
        return [{ name: "Plain", kind: "module", line: 1, endLine: 1 }];
    }
}

// A handler with no symbols and no deep tree — xpath has nothing to project.
class FakeEmptyHandler extends BaseHandler {
    override extractRaw(_content: string): MimeSymbol[] {
        return [];
    }
}

// A handler whose validate throws — exercises propagation policy.
class FakeStrictHandler extends BaseHandler {
    override validate(content: string): void {
        if (content === "BAD") throw new Error("invalid content");
    }
    override extractRaw(_content: string): MimeSymbol[] {
        return [{ name: "Strict", kind: "class", line: 1, endLine: 5 }];
    }
}

const plainInfo: HandlerInfo = {
    mimetype: "text/plain",
    glyph: "📄",
    packageName: "@plurnk/plurnk-mimetypes-text-plain",
    extensions: [".txt"],
    binary: false,
    source: "package",
};

const strictInfo: HandlerInfo = {
    mimetype: "application/strict",
    glyph: "🛡",
    packageName: "@plurnk/plurnk-mimetypes-application-strict",
    extensions: [".strict"],
    binary: false,
    source: "package",
};

describe("Mimetypes — detection + discovery", () => {
    it("detect returns null when registry is empty", async () => {
        const m = new Mimetypes({ discovery: makeDiscovery([]) });
        assert.equal(await m.detect({ path: "foo.txt" }), null);
    });

    it("detect routes by extension via injected discovery", async () => {
        const m = new Mimetypes({ discovery: makeDiscovery([plainInfo]) });
        assert.equal(await m.detect({ path: "foo.txt" }), "text/plain");
    });

    it("detect falls back to defaultMimetype when no match found", async () => {
        const m = new Mimetypes({
            discovery: makeDiscovery([plainInfo]),
            defaultMimetype: "text/markdown",
        });
        assert.equal(await m.detect({ path: "foo.unknown-ext" }), "text/markdown");
    });

    it("detect prefers a real match over the default", async () => {
        const m = new Mimetypes({
            discovery: makeDiscovery([plainInfo]),
            defaultMimetype: "text/markdown",
        });
        assert.equal(await m.detect({ path: "foo.txt" }), "text/plain");
    });

    it("ready() is idempotent (multiple calls share state)", async () => {
        const m = new Mimetypes({
            discoverOptions: { packageDirs: [] },
        });
        await m.ready();
        await m.ready();
        await m.ready();
        assert.ok(true);
    });

    it("exposes discovery's skipped-package evidence without mutable aliasing", async () => {
        const discovery = { ...makeDiscovery([]), skipped: ["@acme/private-mime"] };
        const m = new Mimetypes({ discovery });
        const skipped = await m.skippedPackages();
        assert.deepEqual(skipped, ["@acme/private-mime"]);
        assert.notEqual(skipped, discovery.skipped);
    });
});

describe("Mimetypes — getHandler", () => {
    it("returns null for unknown mimetype", async () => {
        const m = new Mimetypes({ discovery: makeDiscovery([]) });
        assert.equal(await m.getHandler("text/unknown"), null);
    });

    it("instantiates a handler via the loader and caches it", async () => {
        let loadCount = 0;
        const m = new Mimetypes({
            discovery: makeDiscovery([plainInfo]),
            loader: async (pkg) => {
                loadCount += 1;
                assert.equal(pkg, plainInfo.packageName);
                return { default: FakePlainHandler };
            },
        });
        const a = await m.getHandler("text/plain");
        const b = await m.getHandler("text/plain");
        assert.ok(a instanceof BaseHandler);
        assert.strictEqual(a, b, "second call should return cached instance");
        assert.equal(loadCount, 1, "loader should be called once and cached");
    });

    it("preserves a registered handler import failure", async () => {
        const cause = new Error("module not found");
        const m = new Mimetypes({
            discovery: makeDiscovery([plainInfo]),
            loader: async () => {
                throw cause;
            },
        });
        await assert.rejects(
            () => m.getHandler("text/plain"),
            (error: unknown) => {
                assert.ok(error instanceof MimetypePluginError);
                assert.equal(error.packageName, plainInfo.packageName);
                assert.equal(error.mimetype, plainInfo.mimetype);
                assert.strictEqual(error.cause, cause);
                return true;
            },
        );
    });

    it("rejects a module without a default handler constructor", async () => {
        const m = new Mimetypes({
            discovery: makeDiscovery([plainInfo]),
            loader: async () => ({ named: FakePlainHandler }),
        });
        await assert.rejects(
            () => m.getHandler("text/plain"),
            (error: unknown) => {
                assert.ok(error instanceof MimetypePluginError);
                assert.ok(error.cause instanceof TypeError);
                return true;
            },
        );
    });

    it("rejects a non-constructor default export", async () => {
        const m = new Mimetypes({
            discovery: makeDiscovery([plainInfo]),
            loader: async () => ({ default: "not a class" }),
        });
        await assert.rejects(
            () => m.getHandler("text/plain"),
            (error: unknown) => {
                assert.ok(error instanceof MimetypePluginError);
                assert.ok(error.cause instanceof TypeError);
                return true;
            },
        );
    });

    it("passes only metadata to handlers", async () => {
        let receivedArgs: unknown[] = [];
        class CapturingHandler extends BaseHandler {
            constructor(...args: unknown[]) {
                super(args[0] as ConstructorParameters<typeof BaseHandler>[0]);
                receivedArgs = args;
            }
        }
        const m = new Mimetypes({
            discovery: makeDiscovery([plainInfo]),
            loader: async () => ({ default: CapturingHandler }),
        });
        const h = await m.getHandler("text/plain");
        assert.ok(h);
        assert.equal(receivedArgs.length, 1, "handler constructor should receive metadata only");
        const md = receivedArgs[0] as { mimetype: string };
        assert.equal(md.mimetype, "text/plain");
    });
});

describe("Mimetypes — process: metadata + error paths", () => {
    it("returns ok:false metadata-only when detection fails", async () => {
        const m = new Mimetypes({ discovery: makeDiscovery([]) });
        const result = await m.process({ path: "foo.unknown", content: "x" });
        assert.deepEqual(result, {
            mimetype: null,
            ok: false,
            totalLines: 0,
        });
    });

    it("ok:false metadata-only when content cannot be read", async () => {
        const m = new Mimetypes({
            discovery: makeDiscovery([plainInfo]),
            loader: async () => ({ default: FakePlainHandler }),
        });
        const result = await m.process({ path: "/nonexistent/path/foo.txt" });
        assert.deepEqual(result, {
            mimetype: "text/plain",
            ok: false,
            totalLines: 0,
        });
    });

    it("propagates a registered handler contract failure", async () => {
        const m = new Mimetypes({
            discovery: makeDiscovery([plainInfo]),
            loader: async () => ({ default: undefined }),
        });
        await assert.rejects(
            () => m.process({ path: "foo.txt", content: "raw" }),
            MimetypePluginError,
        );
    });

    it("propagates validate errors per error policy", async () => {
        const m = new Mimetypes({
            discovery: makeDiscovery([strictInfo]),
            loader: async () => ({ default: FakeStrictHandler }),
        });
        await assert.rejects(
            async () => {
                await m.process({ path: "x.strict", content: "BAD" });
            },
            /invalid content/,
        );
    });

    it("hint overrides extension during detection", async () => {
        const m = new Mimetypes({
            discovery: makeDiscovery([plainInfo, strictInfo]),
            loader: async () => ({ default: FakePlainHandler }),
        });
        const result = await m.process({
            path: "foo.strict",
            content: "stuff",
            hint: "text/plain",
        });
        assert.equal(result.mimetype, "text/plain");
        assert.equal(result.ok, true);
    });
});

describe("Mimetypes — process: channel selection (#17)", () => {
    it("default selects every structural channel", async () => {
        const m = new Mimetypes({
            discovery: makeDiscovery([plainInfo]),
            loader: async () => ({ default: FakePlainHandler }),
        });
        const r = await m.process({ path: "foo.txt", content: "hello" });
        assert.deepEqual(r.symbols, [{ name: "Plain", kind: "module", line: 1, endLine: 1 }]);
        assert.equal(r.deepJson, null);
        assert.equal(r.deepXml, "");
        assert.deepEqual(r.references, []);
        assert.equal(r.ok, true);
    });

    it("channels: [] yields metadata only — no channel fields, no extraction paid", async () => {
        let extractCalls = 0;
        class CountingHandler extends BaseHandler {
            override extractRaw(): MimeSymbol[] {
                extractCalls += 1;
                return [];
            }
            override deepJson(): unknown {
                extractCalls += 1;
                return null;
            }
        }
        const m = new Mimetypes({
            discovery: makeDiscovery([plainInfo]),
            loader: async () => ({ default: CountingHandler }),
        });
        const r = await m.process({ path: "foo.txt", content: "a\nb\nc" }, { channels: [] });
        assert.deepEqual(r, {
            mimetype: "text/plain",
            ok: true,
            totalLines: 3,
        });
        assert.equal(extractCalls, 0, "no channel work for channels: []");
    });

    it("requesting a subset materializes exactly that subset", async () => {
        class WithDeepTree extends BaseHandler {
            override extractRaw(): MimeSymbol[] {
                return [{ name: "Plain", kind: "module", line: 1, endLine: 1 }];
            }
            override deepJson(): unknown {
                return { type: "root", line: 1, endLine: 1 };
            }
        }
        const m = new Mimetypes({
            discovery: makeDiscovery([plainInfo]),
            loader: async () => ({ default: WithDeepTree }),
        });
        const r = await m.process(
            { path: "foo.txt", content: "hello" },
            { channels: ["deepJson"] },
        );
        assert.deepEqual(r.deepJson, { type: "root", line: 1, endLine: 1 });
        assert.equal("symbols" in r, false);
        assert.equal("deepXml" in r, false);
        assert.equal("references" in r, false);
    });

    it("deepXml alone computes the projection without exposing deepJson", async () => {
        class WithDeepTree extends BaseHandler {
            override deepJson(): unknown {
                return { type: "root", line: 1, endLine: 1, name: "Plain" };
            }
        }
        const m = new Mimetypes({
            discovery: makeDiscovery([plainInfo]),
            loader: async () => ({ default: WithDeepTree }),
        });
        const r = await m.process(
            { path: "foo.txt", content: "hello" },
            { channels: ["deepXml"] },
        );
        assert.equal(
            r.deepXml,
            '<root xmlns:pk="https://plurnk.dev/deep-xml/1" pk:line="1" pk:endLine="1"><name>Plain</name></root>',
        );
        assert.equal("deepJson" in r, false);
    });

    it("materializes the same symbols-only projection XPath queries without duplicate extraction (#86)", async () => {
        let deepJsonCalls = 0;
        let symbolCalls = 0;
        class SymbolsOnlyHandler extends BaseHandler {
            override deepJson(): null {
                deepJsonCalls += 1;
                return null;
            }
            override extractRaw(): MimeSymbol[] {
                symbolCalls += 1;
                return [{ name: "Section", kind: "heading", level: 1, line: 3, endLine: 3 }];
            }
        }
        const m = new Mimetypes({
            discovery: makeDiscovery([plainInfo]),
            loader: async () => ({ default: SymbolsOnlyHandler }),
        });
        const input = { path: "foo.txt", content: "alpha\nbeta\ngamma" };

        const materialized = await m.process(input, { channels: ["symbols", "deepJson", "deepXml"] });
        assert.equal(deepJsonCalls, 1, "one deep-tree read for the combined request");
        assert.equal(symbolCalls, 1, "the deep-XML fallback reuses the requested symbols");

        const handler = await m.getHandler("text/plain");
        assert.ok(handler);
        assert.equal(materialized.deepXml, await handler.deepXml(input.content));

        const matches = await m.query(input, "//Section");
        assert.deepEqual(matches[0]?.regions, [{
            startLine: 3,
            startColumn: 1,
            endLine: 3,
            endColumn: 6,
        }]);
    });

    it("honors a handler deepXml() override for the deepXml channel", async () => {
        class SourceMarkupHandler extends BaseHandler {
            override deepJson(): unknown {
                return { type: "ignored" };
            }
            override async deepXml(): Promise<string> {
                return "<real-source-markup/>";
            }
        }
        const m = new Mimetypes({
            discovery: makeDiscovery([plainInfo]),
            loader: async () => ({ default: SourceMarkupHandler }),
        });
        const r = await m.process({ path: "foo.txt", content: "x" }, { channels: ["deepXml"] });
        assert.equal(r.deepXml, "<real-source-markup/>");
    });

    it("references channel defaults to [] (engine lands with #19)", async () => {
        const m = new Mimetypes({
            discovery: makeDiscovery([plainInfo]),
            loader: async () => ({ default: FakePlainHandler }),
        });
        const r = await m.process(
            { path: "foo.txt", content: "x" },
            { channels: ["references"] },
        );
        assert.deepEqual(r.references, []);
        assert.equal("symbols" in r, false);
    });

    it("symbols channel carries the structured extractRaw output", async () => {
        const m = new Mimetypes({
            discovery: makeDiscovery([plainInfo]),
            loader: async () => ({ default: FakePlainHandler }),
        });
        const r = await m.process(
            { path: "foo.txt", content: "x" },
            { channels: ["symbols"] },
        );
        assert.deepEqual(r.symbols, [{ name: "Plain", kind: "module", line: 1, endLine: 1 }]);
    });

    it("reads content from disk when only path is provided", async () => {
        const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "plurnk-mt-"));
        try {
            const filePath = path.join(tmp, "test.txt");
            await fs.writeFile(filePath, "file content");

            const m = new Mimetypes({
                discovery: makeDiscovery([plainInfo]),
                loader: async () => ({ default: FakePlainHandler }),
            });
            const result = await m.process({ path: filePath });
            assert.equal(result.mimetype, "text/plain");
            assert.equal(result.ok, true);
            assert.deepEqual(result.symbols, [{ name: "Plain", kind: "module", line: 1, endLine: 1 }]);
        } finally {
            await fs.rm(tmp, { recursive: true, force: true });
        }
    });
});

describe("Mimetypes - process: totalLines", () => {
    it("returns 0 for empty content", async () => {
        const m = new Mimetypes({
            discovery: makeDiscovery([plainInfo]),
            loader: async () => ({ default: FakePlainHandler }),
        });
        const r = await m.process({ path: "foo.txt", content: "" });
        assert.equal(r.totalLines, 0);
    });

    it("returns 1 for single-line content without trailing newline", async () => {
        const m = new Mimetypes({
            discovery: makeDiscovery([plainInfo]),
            loader: async () => ({ default: FakePlainHandler }),
        });
        const r = await m.process({ path: "foo.txt", content: "just one line" });
        assert.equal(r.totalLines, 1);
    });

    it("returns 1 for single-line content with trailing newline (terminator, not new line)", async () => {
        const m = new Mimetypes({
            discovery: makeDiscovery([plainInfo]),
            loader: async () => ({ default: FakePlainHandler }),
        });
        const r = await m.process({ path: "foo.txt", content: "one line\n" });
        assert.equal(r.totalLines, 1);
    });

    it("returns N for N lines (editor-convention count)", async () => {
        const m = new Mimetypes({
            discovery: makeDiscovery([plainInfo]),
            loader: async () => ({ default: FakePlainHandler }),
        });
        const r1 = await m.process({ path: "foo.txt", content: "a\nb\nc" });
        assert.equal(r1.totalLines, 3);

        const r2 = await m.process({ path: "foo.txt", content: "a\nb\nc\n" });
        assert.equal(r2.totalLines, 3);
    });

    it("counts empty lines correctly", async () => {
        const m = new Mimetypes({
            discovery: makeDiscovery([plainInfo]),
            loader: async () => ({ default: FakePlainHandler }),
        });
        const r1 = await m.process({ path: "foo.txt", content: "\n" });
        assert.equal(r1.totalLines, 1);
        const r2 = await m.process({ path: "foo.txt", content: "\n\n" });
        assert.equal(r2.totalLines, 2);
        const r3 = await m.process({ path: "foo.txt", content: "a\n\nb" });
        assert.equal(r3.totalLines, 3);
    });

    it("returns 0 for binary content (lines not meaningful for binary mimetypes)", async () => {
        const binaryInfo: HandlerInfo = {
            mimetype: "application/octet-stream",
            glyph: "📦",
            packageName: "@plurnk/plurnk-mimetypes-application-octet-stream",
            extensions: [".bin"],
            binary: true,
            source: "package",
        };
        class BinaryHandler extends BaseHandler {}
        const m = new Mimetypes({
            discovery: makeDiscovery([binaryInfo]),
            loader: async () => ({ default: BinaryHandler }),
        });
        const bytes = new Uint8Array([0x00, 0x0a, 0x0a, 0xff, 0x0a]);
        const r = await m.process({ path: "foo.bin", content: bytes });
        assert.equal(r.totalLines, 0);
    });

    it("returns 0 on detection and read error results", async () => {
        const noDetect = new Mimetypes({ discovery: makeDiscovery([]) });
        const r1 = await noDetect.process({ path: "foo.unknown", content: "x" });
        assert.equal(r1.totalLines, 0);

        const cantRead = new Mimetypes({
            discovery: makeDiscovery([plainInfo]),
            loader: async () => ({ default: FakePlainHandler }),
        });
        const r2 = await cantRead.process({ path: "/nonexistent.txt" });
        assert.equal(r2.totalLines, 0);
    });
});

describe("Mimetypes — query", () => {
    it("dispatches regex via /pattern/flags expression to the handler", async () => {
        const m = new Mimetypes({
            discovery: makeDiscovery([plainInfo]),
            loader: async () => ({ default: FakePlainHandler }),
        });
        const results = await m.query(
            { path: "foo.txt", content: "alpha\nbeta\ngamma\nbeta" },
            "/beta/",
        );
        assert.equal(results.length, 2);
        assert.equal(results[0].matched, "beta");
        assert.equal(results[0].regions?.[0]?.startLine, 2);
        assert.equal(results[1].regions?.[0]?.startLine, 4);
    });

    it("dispatches jsonpath via $ expression to the handler's outline", async () => {
        class OutlineHandler extends BaseHandler {
            override extractRaw(): MimeSymbol[] {
                return [
                    { name: "Top", kind: "heading", level: 1, line: 1, endLine: 1 },
                    { name: "Section", kind: "heading", level: 2, line: 5, endLine: 5 },
                ];
            }
        }
        const m = new Mimetypes({
            discovery: makeDiscovery([plainInfo]),
            loader: async () => ({ default: OutlineHandler }),
        });
        const results = await m.query(
            { path: "foo.txt", content: "top\n2\n3\n4\nsection" },
            "$.Top.Section",
        );
        assert.equal(results.length, 1);
        assert.equal(results[0].matched, 5);
        assert.equal(results[0].regions?.[0]?.startLine, 5);
    });

    it("dispatches glob (no prefix) line-anchored against text body", async () => {
        const m = new Mimetypes({
            discovery: makeDiscovery([plainInfo]),
            loader: async () => ({ default: FakePlainHandler }),
        });
        const results = await m.query(
            { path: "foo.txt", content: "error: a\nok: b\nerror: c" },
            "error: *",
        );
        assert.equal(results.length, 2);
        assert.equal(results[0].matched, "error: a");
        assert.equal(results[1].matched, "error: c");
    });

    it("dispatches xpath via // against the projected symbol outline (symbols-only handlers gain xpath; #41 symmetry)", async () => {
        const m = new Mimetypes({
            discovery: makeDiscovery([plainInfo]),
            loader: async () => ({ default: FakePlainHandler }),
        });
        const results = await m.query({ path: "foo.txt", content: "any" }, "//Plain");
        assert.equal(results.length, 1);
        assert.deepEqual(results[0].regions, [{
            startLine: 1, startColumn: 1, endLine: 1, endColumn: 4,
        }]);
    });

    it("xpath still throws when the handler has no deep tree and no symbols (mapped to 415 upstream)", async () => {
        const m = new Mimetypes({
            discovery: makeDiscovery([plainInfo]),
            loader: async () => ({ default: FakeEmptyHandler }),
        });
        await assert.rejects(
            async () => {
                await m.query({ path: "foo.txt", content: "any" }, "//foo");
            },
            /xpath/,
        );
    });

    it("throws when detection fails (no mimetype to resolve)", async () => {
        const m = new Mimetypes({ discovery: makeDiscovery([]) });
        await assert.rejects(
            async () => { await m.query({ path: "foo.unknown" }, "/x/"); },
            /no mimetype/,
        );
    });

    it("throws when content is unreadable", async () => {
        const m = new Mimetypes({
            discovery: makeDiscovery([plainInfo]),
            loader: async () => ({ default: FakePlainHandler }),
        });
        await assert.rejects(
            async () => { await m.query({ path: "/nonexistent.txt" }, "/x/"); },
            /content unreadable/,
        );
    });

    it("reports an unregistered mimetype as an unsupported dialect", async () => {
        const m = new Mimetypes({ discovery: makeDiscovery([]) });
        await assert.rejects(
            async () => {
                await m.query(
                    { hint: "application/octet-stream", content: "" },
                    { dialect: "regex", pattern: "needle" },
                );
            },
            (error: unknown) => {
                assert.ok(error instanceof UnsupportedDialectError);
                assert.equal(error.mimetype, "application/octet-stream");
                assert.equal(error.dialect, "regex");
                return true;
            },
        );
    });

    it("keeps a registered handler load failure distinct from an unsupported dialect", async () => {
        const m = new Mimetypes({
            discovery: makeDiscovery([plainInfo]),
            loader: async () => {
                throw new Error("module not found");
            },
        });
        await assert.rejects(
            async () => {
                await m.query(
                    { hint: "text/plain", content: "needle" },
                    { dialect: "regex", pattern: "needle" },
                );
            },
            (error: unknown) => {
                assert.ok(error instanceof MimetypePluginError);
                assert.equal(error instanceof UnsupportedDialectError, false);
                assert.equal(error.packageName, plainInfo.packageName);
                assert.equal(error.mimetype, plainInfo.mimetype);
                assert.match(String(error.cause), /module not found/);
                return true;
            },
        );
    });
});

describe("Mimetypes — degradation notices (plurnk-service#276)", () => {
    it("embeddingMissing surfaces a warn-level Notice on an ok:true result", async () => {
        const m = new Mimetypes({
            discovery: makeDiscovery([plainInfo]),
            loader: async (pkg: string) => {
                if (pkg === "@plurnk/plurnk-mimetypes-embeddings") {
                    throw Object.assign(
                        new Error(`Cannot find package '${pkg}' imported from test`),
                        { code: "ERR_MODULE_NOT_FOUND" },
                    );
                }
                return { default: FakePlainHandler };
            },
        });
        const r = await m.process({ path: "foo.txt", content: "hello" }, { channels: ["embedding"] });
        assert.equal(r.ok, true);
        assert.equal(r.embeddingMissing, "@plurnk/plurnk-mimetypes-embeddings");
        const ev = (r.notices ?? []).find((e) => e.kind === "embedding_degraded");
        assert.ok(ev, "expected an embedding_degraded Notice");
        assert.equal(ev?.level, "warn");
        assert.equal(ev?.source, "mimetype:text-plain");
        assert.equal(ev?.plurnkPackage, "@plurnk/plurnk-mimetypes-embeddings");
    });

    it("a fully-satisfied result carries no notices field", async () => {
        const m = new Mimetypes({
            discovery: makeDiscovery([plainInfo]),
            loader: async () => ({ default: FakePlainHandler }),
        });
        const r = await m.process({ path: "foo.txt", content: "hello" });
        assert.equal(r.notices, undefined);
    });
});
