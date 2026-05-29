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
    Preview,
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

// A handler whose validate throws — exercises propagation policy.
class FakeStrictHandler extends BaseHandler {
    override validate(content: string): void {
        if (content === "BAD") throw new Error("invalid content");
    }
    override extractRaw(_content: string): MimeSymbol[] {
        return [{ name: "Strict", kind: "class", line: 1, endLine: 5 }];
    }
}

// A handler that returns null — exercises the framework's
// no-structural-signal path (mimetypes without extractable symbols).
class FakeNullHandler extends BaseHandler {
    override preview(_content: string | Uint8Array): Preview {
        return null;
    }
}

const plainInfo: HandlerInfo = {
    mimetype: "text/plain",
    glyph: "📄",
    packageName: "@plurnk/plurnk-mimetypes-text-plain",
    extensions: [".txt"],
    binary: false,
};

const strictInfo: HandlerInfo = {
    mimetype: "application/strict",
    glyph: "🛡",
    packageName: "@plurnk/plurnk-mimetypes-application-strict",
    extensions: [".strict"],
    binary: false,
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

    it("passes only metadata to handlers (no tokenize injection)", async () => {
        // v0.4.0: handlers see only their HandlerMetadata. The framework owns
        // tokenize entirely and never exposes it to the handler layer.
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
            tokenize: async (text) => text.length,
        });
        const h = await m.getHandler("text/plain");
        assert.ok(h);
        assert.equal(receivedArgs.length, 1, "handler constructor should receive metadata only");
        const md = receivedArgs[0] as { mimetype: string };
        assert.equal(md.mimetype, "text/plain");
    });
});

describe("Mimetypes — process", () => {
    it("returns ok:false with null mimetype when detection fails", async () => {
        const m = new Mimetypes({ discovery: makeDiscovery([]) });
        const result = await m.process({ path: "foo.unknown", content: "x" });
        assert.deepEqual(result, { mimetype: null, preview: "", ok: false });
    });

    it("processes inline content (no fs read) when content is provided", async () => {
        const m = new Mimetypes({
            discovery: makeDiscovery([plainInfo]),
            loader: async () => ({ default: FakePlainHandler }),
        });
        const result = await m.process({ path: "anything.txt", content: "hello" });
        assert.equal(result.mimetype, "text/plain");
        assert.equal(result.preview, "module Plain [1]");
        assert.equal(result.ok, true);
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
            assert.equal(result.preview, "module Plain [1]");
        } finally {
            await fs.rm(tmp, { recursive: true, force: true });
        }
    });

    it("returns ok:false with empty preview when content cannot be read", async () => {
        const m = new Mimetypes({
            discovery: makeDiscovery([plainInfo]),
            loader: async () => ({ default: FakePlainHandler }),
        });
        const result = await m.process({ path: "/nonexistent/path/foo.txt" });
        assert.equal(result.mimetype, "text/plain");
        assert.equal(result.ok, false);
        assert.equal(result.preview, "");
    });

    it("returns ok:false with empty preview when handler is missing (no raw fallback)", async () => {
        // v0.4.0: there is no raw-content fallback. Handler authority over
        // preview material is absolute; if the handler is unreachable, the
        // framework reports failure rather than inventing material.
        const m = new Mimetypes({
            discovery: makeDiscovery([plainInfo]),
            loader: async () => ({ default: undefined }),
            tokenize: async (text) => text.length,
        });
        const result = await m.process(
            { path: "foo.txt", content: "raw fallback content" },
            { budget: 1000 },
        );
        assert.equal(result.mimetype, "text/plain");
        assert.equal(result.preview, "");
        assert.equal(result.ok, false);
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

    it("uses provided budget for preview", async () => {
        const m = new Mimetypes({
            discovery: makeDiscovery([plainInfo]),
            loader: async () => ({ default: FakePlainHandler }),
            tokenize: async (text) => text.length,
        });
        const result = await m.process(
            { path: "foo.txt", content: "hello world" },
            { budget: 1000 },
        );
        assert.equal(result.preview, "module Plain [1]");
    });

    it("framework returns empty preview (with ok:true) when handler returns null", async () => {
        const nullInfo: HandlerInfo = {
            mimetype: "text/sample",
            glyph: "📄",
            packageName: "@plurnk/plurnk-mimetypes-text-sample",
            extensions: [".sample"],
            binary: false,
        };
        const m = new Mimetypes({
            discovery: makeDiscovery([nullInfo]),
            loader: async () => ({ default: FakeNullHandler }),
            tokenize: async (text) => text.length,
        });
        const result = await m.process(
            { path: "foo.sample", content: "abcdefghij" },
            { budget: 1000 },
        );
        assert.equal(result.ok, true);
        assert.equal(result.preview, "");
    });

    it("treats missing budget as unbounded (no truncation when budget is unspecified)", async () => {
        class BigHandler extends BaseHandler {
            override extractRaw(_content: string): MimeSymbol[] {
                return Array.from({ length: 50 }, (_, i) => ({
                    name: `Sym${i}`,
                    kind: "class" as const,
                    line: i + 1,
                    endLine: i + 1,
                }));
            }
        }
        const m = new Mimetypes({
            discovery: makeDiscovery([plainInfo]),
            loader: async () => ({ default: BigHandler }),
            tokenize: async (text) => text.length,
        });
        const result = await m.process({ path: "foo.txt", content: "x" });
        assert.equal(result.ok, true);
        assert.ok(result.preview.includes("Sym49"), "all 50 symbols should appear");
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
        assert.equal(results[0].line, 2);
        assert.equal(results[1].line, 4);
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
        assert.equal(results[0].line, 5);
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

    it("dispatches xpath via // expression; default handler throws (mapped to 415 upstream)", async () => {
        const m = new Mimetypes({
            discovery: makeDiscovery([plainInfo]),
            loader: async () => ({ default: FakePlainHandler }),
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
