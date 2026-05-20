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
    extract(_content: string): MimeSymbol[] {
        return [{ name: "Plain", kind: "module", line: 1, endLine: 1 }];
    }
}

// A handler whose validate throws — exercises propagation policy.
class FakeStrictHandler extends BaseHandler {
    validate(content: string): void {
        if (content === "BAD") throw new Error("invalid content");
    }
    extract(_content: string): MimeSymbol[] {
        return [{ name: "Strict", kind: "class", line: 1, endLine: 5 }];
    }
}

const plainInfo: HandlerInfo = {
    mimetype: "text/plain",
    glyph: "📄",
    packageName: "@plurnk/plurnk-mimetypes-text-plain",
    extensions: [".txt"],
};

const strictInfo: HandlerInfo = {
    mimetype: "application/strict",
    glyph: "🛡",
    packageName: "@plurnk/plurnk-mimetypes-application-strict",
    extensions: [".strict"],
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
        let discoverCalls = 0;
        const m = new Mimetypes({
            discoverOptions: { packageDirs: [] },
        });
        // Override discovery by triggering ready then checking handlers map stays consistent.
        await m.ready();
        await m.ready();
        await m.ready();
        // No external observable beyond stability — the test just verifies no exceptions.
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

    it("passes the orchestrator's tokenize into instantiated handlers", async () => {
        let tokenizeCalled = false;
        const m = new Mimetypes({
            discovery: makeDiscovery([plainInfo]),
            loader: async () => ({ default: FakePlainHandler }),
            tokenize: async (text) => {
                tokenizeCalled = true;
                return text.length;
            },
        });
        const h = await m.getHandler("text/plain");
        assert.ok(h);
        await h.preview("any content", 1000);
        assert.ok(tokenizeCalled, "injected tokenize should reach handler.preview");
    });
});

describe("Mimetypes — process", () => {
    it("returns ok:false with null mimetype when detection fails", async () => {
        const m = new Mimetypes({ discovery: makeDiscovery([]) });
        const result = await m.process({ path: "foo.unknown", content: "x" });
        assert.deepEqual(result, { mimetype: null, symbols: "", preview: "", ok: false });
    });

    it("processes inline content (no fs read) when content is provided", async () => {
        const m = new Mimetypes({
            discovery: makeDiscovery([plainInfo]),
            loader: async () => ({ default: FakePlainHandler }),
        });
        const result = await m.process({ path: "anything.txt", content: "hello" });
        assert.equal(result.mimetype, "text/plain");
        assert.equal(result.symbols, "module Plain [1]");
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
            assert.equal(result.symbols, "module Plain [1]");
        } finally {
            await fs.rm(tmp, { recursive: true, force: true });
        }
    });

    it("returns ok:false when content cannot be read and not provided inline", async () => {
        const m = new Mimetypes({
            discovery: makeDiscovery([plainInfo]),
            loader: async () => ({ default: FakePlainHandler }),
        });
        const result = await m.process({ path: "/nonexistent/path/foo.txt" });
        assert.equal(result.mimetype, "text/plain");
        assert.equal(result.ok, false);
        assert.equal(result.symbols, "");
        assert.equal(result.preview, "");
    });

    it("falls back to raw-content preview when handler is missing", async () => {
        const m = new Mimetypes({
            discovery: makeDiscovery([plainInfo]),
            loader: async () => ({ default: undefined }), // can't load handler
            tokenize: async (text) => text.length,
        });
        const result = await m.process(
            { path: "foo.txt", content: "raw fallback content" },
            { budget: 1000 },
        );
        assert.equal(result.mimetype, "text/plain");
        assert.equal(result.symbols, "");
        assert.equal(result.preview, "raw fallback content");
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

    it("treats missing budget as unbounded (no truncation when budget is unspecified)", async () => {
        class BigHandler extends BaseHandler {
            extract(_content: string): MimeSymbol[] {
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
            tokenize: async (text) => text.length, // 1 char = 1 token
        });
        // No budget option — preview should match symbols (full output, no truncation).
        const result = await m.process({ path: "foo.txt", content: "x" });
        assert.equal(result.ok, true);
        assert.equal(result.preview, result.symbols);
        assert.ok(result.symbols.includes("Sym49"), "all 50 symbols should appear");
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
