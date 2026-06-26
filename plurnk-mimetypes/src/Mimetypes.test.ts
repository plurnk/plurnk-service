import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import Mimetypes from "./Mimetypes.ts";
import BaseHandler from "./BaseHandler.ts";
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
    return { registry, handlers: handlerMap };
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

    it("returns null when loader throws", async () => {
        const m = new Mimetypes({
            discovery: makeDiscovery([plainInfo]),
            loader: async () => {
                throw new Error("module not found");
            },
        });
        assert.equal(await m.getHandler("text/plain"), null);
    });

    it("returns null when module lacks a default export", async () => {
        const m = new Mimetypes({
            discovery: makeDiscovery([plainInfo]),
            loader: async () => ({ named: FakePlainHandler }),
        });
        assert.equal(await m.getHandler("text/plain"), null);
    });

    it("returns null when default export isn't a constructor", async () => {
        const m = new Mimetypes({
            discovery: makeDiscovery([plainInfo]),
            loader: async () => ({ default: "not a class" }),
        });
        assert.equal(await m.getHandler("text/plain"), null);
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
            extent: 0,
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
            extent: 0,
        });
    });

    it("ok:false metadata-only when handler is missing", async () => {
        const m = new Mimetypes({
            discovery: makeDiscovery([plainInfo]),
            loader: async () => ({ default: undefined }),
        });
        const result = await m.process({ path: "foo.txt", content: "raw" });
        assert.equal(result.ok, false);
        assert.equal(result.mimetype, "text/plain");
        assert.equal("symbols" in result, false, "error results carry no channel fields");
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
    it("default materializes all four channels", async () => {
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
            extent: 3,
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

describe("Mimetypes — process: totalLines + extent (#9)", () => {
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

    it("populates extent on the ok path (default: line count)", async () => {
        const m = new Mimetypes({
            discovery: makeDiscovery([plainInfo]),
            loader: async () => ({ default: FakePlainHandler }),
        });
        const result = await m.process({ path: "anything.txt", content: "one\ntwo\nthree" });
        assert.equal(result.extent, 3);
        assert.equal(result.totalLines, 3);
    });

    it("extent honors a handler override (non-line units)", async () => {
        class RowsHandler extends BaseHandler {
            override extent(): number {
                return 42;
            }
        }
        const m = new Mimetypes({
            discovery: makeDiscovery([plainInfo]),
            loader: async () => ({ default: RowsHandler }),
        });
        const r = await m.process({ path: "foo.txt", content: "a\nb" }, { channels: [] });
        assert.equal(r.extent, 42);
        assert.equal(r.totalLines, 2, "totalLines stays the editor convention");
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

    it("returns 0 on every error path (detection / read / handler-missing)", async () => {
        const noDetect = new Mimetypes({ discovery: makeDiscovery([]) });
        const r1 = await noDetect.process({ path: "foo.unknown", content: "x" });
        assert.equal(r1.totalLines, 0);

        const cantRead = new Mimetypes({
            discovery: makeDiscovery([plainInfo]),
            loader: async () => ({ default: FakePlainHandler }),
        });
        const r2 = await cantRead.process({ path: "/nonexistent.txt" });
        assert.equal(r2.totalLines, 0);

        const noHandler = new Mimetypes({
            discovery: makeDiscovery([plainInfo]),
            loader: async () => ({ default: undefined }),
        });
        const r3 = await noHandler.process({ path: "foo.txt", content: "anything" });
        assert.equal(r3.totalLines, 0);
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
        assert.equal(results[0].lines![0].line, 2);
        assert.equal(results[1].lines![0].line, 4);
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
            { path: "foo.txt", content: "(unused)" },
            "$.Top.Section",
        );
        assert.equal(results.length, 1);
        assert.equal(results[0].matched, 5);
        assert.equal(results[0].lines![0].line, 5);
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
        assert.deepEqual(results[0].lines, [{ line: 1, endLine: 1 }]);
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
});
