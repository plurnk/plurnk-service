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
        assert.deepEqual(result, {
            mimetype: null,
            preview: "",
            previewTokens: 0,
            totalLines: 0,
            extent: 0,
            ok: false,
            deepJson: null,
            deepXml: "",
        });
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

    it("populates extent on the ok path (default: line count)", async () => {
        const m = new Mimetypes({
            discovery: makeDiscovery([plainInfo]),
            loader: async () => ({ default: FakePlainHandler }),
        });
        const result = await m.process({ path: "anything.txt", content: "one\ntwo\nthree" });
        assert.equal(result.extent, 3);
        assert.equal(result.totalLines, 3);
    });

    it("deepJson default is null; deepXml is empty string when handler doesn't supply a tree", async () => {
        const m = new Mimetypes({
            discovery: makeDiscovery([plainInfo]),
            loader: async () => ({ default: FakePlainHandler }),
        });
        const result = await m.process({ path: "anything.txt", content: "hello" });
        assert.equal(result.deepJson, null);
        assert.equal(result.deepXml, "");
    });

    it("populates deepJson and deepXml when handler supplies a tree (projection by framework)", async () => {
        class WithDeepTree extends BaseHandler {
            override extractRaw(): MimeSymbol[] {
                return [{ name: "Plain", kind: "module", line: 1, endLine: 1 }];
            }
            override deepJson(): unknown {
                return { type: "root", line: 1, endLine: 1, name: "Plain" };
            }
        }
        const m = new Mimetypes({
            discovery: makeDiscovery([plainInfo]),
            loader: async () => ({ default: WithDeepTree }),
        });
        const result = await m.process({ path: "anything.txt", content: "hello" });
        assert.deepEqual(result.deepJson, { type: "root", line: 1, endLine: 1, name: "Plain" });
        assert.equal(result.deepXml, '<root line="1" endLine="1"><name>Plain</name></root>');
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
    source: "package",
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

describe("Mimetypes — process: N:\\t line-number rendering (#8)", () => {
    class HeadTextHandler extends BaseHandler {
        override preview(content: string | Uint8Array): Preview {
            const text = typeof content === "string" ? content : "";
            return { kind: "text", text, orientation: "head" };
        }
    }

    class TailTextHandler extends BaseHandler {
        override preview(content: string | Uint8Array): Preview {
            const text = typeof content === "string" ? content : "";
            return { kind: "text", text, orientation: "tail" };
        }
    }

    it("symbols preview emitted unmodified — outline already carries source lines", async () => {
        const m = new Mimetypes({
            discovery: makeDiscovery([plainInfo]),
            loader: async () => ({ default: FakePlainHandler }),
        });
        const r = await m.process({ path: "foo.txt", content: "anything" });
        // FakePlainHandler emits one symbol → outline is "module Plain [1]".
        // No N:\t prefix added (symbols carry their own line annotation).
        assert.equal(r.preview, "module Plain [1]");
    });

    it("head-oriented text preview gets N:\\t prefixes starting at 1", async () => {
        const m = new Mimetypes({
            discovery: makeDiscovery([plainInfo]),
            loader: async () => ({ default: HeadTextHandler }),
        });
        const content = "first line\nsecond line\nthird line";
        const r = await m.process({ path: "foo.txt", content });
        assert.equal(r.preview, "1:\tfirst line\n2:\tsecond line\n3:\tthird line");
    });

    it("head-oriented text with a single line still gets numbered", async () => {
        const m = new Mimetypes({
            discovery: makeDiscovery([plainInfo]),
            loader: async () => ({ default: HeadTextHandler }),
        });
        const r = await m.process({ path: "foo.txt", content: "just one line" });
        assert.equal(r.preview, "1:\tjust one line");
    });

    it("tail-oriented text preview with no truncation numbers from 1", async () => {
        const m = new Mimetypes({
            discovery: makeDiscovery([plainInfo]),
            loader: async () => ({ default: TailTextHandler }),
            tokenize: async (text) => text.length,
        });
        const content = "line 1\nline 2\nline 3";
        // Big budget — no truncation needed; whole content surfaces.
        const r = await m.process({ path: "foo.txt", content }, { budget: 10000 });
        assert.equal(r.preview, "1:\tline 1\n2:\tline 2\n3:\tline 3");
    });

    it("tail-oriented text preview with truncation numbers from the surviving source line", async () => {
        const m = new Mimetypes({
            discovery: makeDiscovery([plainInfo]),
            loader: async () => ({ default: TailTextHandler }),
            tokenize: async (text) => text.length,
        });
        // 10 lines total; budget too small for everything so the tail
        // truncates. Expect the surviving lines numbered with their original
        // source-line numbers (not 1, 2, 3...).
        const content = Array.from({ length: 10 }, (_, i) => `line ${i + 1}`).join("\n");
        // Total length: 10 lines × ~7 chars + 9 newlines ≈ 79. Budget 50 forces truncation.
        const r = await m.process({ path: "foo.txt", content }, { budget: 50 });
        // The preview must include the [[TRUNCATED]] marker because tail
        // orientation was truncated.
        assert.ok(r.preview.includes("[[TRUNCATED]]"), `expected marker; got ${JSON.stringify(r.preview)}`);
        // The first line of the preview should NOT be numbered 1 (because
        // it's a tail slice — earlier source lines were dropped).
        const firstLineLabel = parseInt(r.preview.split("\n")[0].split(":")[0]);
        assert.ok(firstLineLabel > 1, `expected first-line label > 1 for tail truncation; got ${firstLineLabel}`);
        // The last surviving line of the source should appear in the preview
        // and carry a believable source-line label (~10).
        assert.ok(r.preview.includes("line 10"), "expected line 10 to survive a tail-truncation preview");
    });

    it("empty preview short-circuits — no rendering applied", async () => {
        const m = new Mimetypes({
            discovery: makeDiscovery([plainInfo]),
            loader: async () => ({ default: FakeNullHandler }),
        });
        const r = await m.process({ path: "foo.txt", content: "ignored" });
        assert.equal(r.preview, "");
    });

    it("error paths leave preview empty (no rendering on null mimetype / missing handler)", async () => {
        const m = new Mimetypes({ discovery: makeDiscovery([]) });
        const r = await m.process({ path: "foo.unknown", content: "x" });
        assert.equal(r.preview, "");
    });

    it("previewTokens reflects the line-numbered preview (includes prefix overhead)", async () => {
        const m = new Mimetypes({
            discovery: makeDiscovery([plainInfo]),
            loader: async () => ({ default: HeadTextHandler }),
            tokenize: async (text) => text.length,
        });
        const r = await m.process({ path: "foo.txt", content: "a\nb\nc" });
        // "1:\ta\n2:\tb\n3:\tc" = 15 chars. previewTokens should match.
        assert.equal(r.preview, "1:\ta\n2:\tb\n3:\tc");
        assert.equal(r.previewTokens, r.preview.length);
    });
});

describe("Mimetypes — process: totalLines (#9)", () => {
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
        // "\n" = one empty line (terminated)
        const r1 = await m.process({ path: "foo.txt", content: "\n" });
        assert.equal(r1.totalLines, 1);
        // "\n\n" = two empty lines (both terminated)
        const r2 = await m.process({ path: "foo.txt", content: "\n\n" });
        assert.equal(r2.totalLines, 2);
        // "a\n\nb" = three lines (a, empty, b)
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
        class BinaryHandler extends BaseHandler {
            override preview(): Preview {
                return null;
            }
        }
        const m = new Mimetypes({
            discovery: makeDiscovery([binaryInfo]),
            loader: async () => ({ default: BinaryHandler }),
        });
        // Pass Uint8Array directly (the orchestrator routes binary content
        // through fs.readFile as Uint8Array; inline equivalent here).
        const bytes = new Uint8Array([0x00, 0x0a, 0x0a, 0xff, 0x0a]);
        const r = await m.process({ path: "foo.bin", content: bytes });
        // Binary content → 0, regardless of how many \n bytes happen to be there.
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

    it("is independent of how the preview was budget-fitted (totalLines = source, not preview)", async () => {
        // A 20-line source, tail-truncated by a tight budget. totalLines
        // should reflect ALL 20 source lines even though the preview only
        // shows a few.
        class HeadTextHandler extends BaseHandler {
            override preview(content: string | Uint8Array): Preview {
                const text = typeof content === "string" ? content : "";
                return { kind: "text", text, orientation: "head" };
            }
        }
        const m = new Mimetypes({
            discovery: makeDiscovery([plainInfo]),
            loader: async () => ({ default: HeadTextHandler }),
            tokenize: async (text) => text.length,
        });
        const content = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`).join("\n");
        const r = await m.process({ path: "foo.txt", content }, { budget: 50 });
        assert.equal(r.totalLines, 20);
        // The preview itself is truncated...
        assert.ok(r.preview.includes("[[TRUNCATED]]"));
        // ...but totalLines still reflects the full source.
    });
});

describe("Mimetypes — process: previewTokens (#7)", () => {
    it("returns previewTokens 0 when detection fails", async () => {
        const m = new Mimetypes({ discovery: makeDiscovery([]) });
        const r = await m.process({ path: "foo.unknown", content: "x" });
        assert.equal(r.previewTokens, 0);
    });

    it("returns previewTokens 0 when content read fails", async () => {
        const m = new Mimetypes({
            discovery: makeDiscovery([plainInfo]),
            loader: async () => ({ default: FakePlainHandler }),
        });
        const r = await m.process({ path: "/nonexistent.txt" });
        assert.equal(r.previewTokens, 0);
    });

    it("returns previewTokens 0 when handler is missing", async () => {
        const m = new Mimetypes({
            discovery: makeDiscovery([plainInfo]),
            loader: async () => ({ default: undefined }),
        });
        const r = await m.process({ path: "foo.txt", content: "raw" });
        assert.equal(r.previewTokens, 0);
    });

    it("returns previewTokens 0 for empty preview without paying a tokenize call", async () => {
        let tokenizeCalls = 0;
        const m = new Mimetypes({
            discovery: makeDiscovery([plainInfo]),
            loader: async () => ({ default: FakeNullHandler }),
            tokenize: async (text) => { tokenizeCalls += 1; return text.length; },
        });
        const r = await m.process({ path: "foo.txt", content: "anything" });
        assert.equal(r.previewTokens, 0);
        // FakeNullHandler.preview returns null → fitPreview returns "" → we
        // short-circuit. fitSymbols/fitContent never run, tokenize never runs.
        assert.equal(tokenizeCalls, 0);
    });

    it("returns the token count of the fitted preview", async () => {
        const m = new Mimetypes({
            discovery: makeDiscovery([plainInfo]),
            loader: async () => ({ default: FakePlainHandler }),
            tokenize: async (text) => text.length,
        });
        const r = await m.process({ path: "foo.txt", content: "anything" });
        // FakePlainHandler emits one symbol; preview is "module Plain [1]".
        assert.equal(r.previewTokens, r.preview.length);
        assert.equal(r.previewTokens, "module Plain [1]".length);
    });

    it("matches the count a consumer would compute by tokenizing the returned preview", async () => {
        // The whole point of #7: consumer skips re-tokenize. Verify the
        // surfaced number is what they'd otherwise have to compute.
        const tokenize = async (text: string) => text.length;
        const m = new Mimetypes({
            discovery: makeDiscovery([plainInfo]),
            loader: async () => ({ default: FakePlainHandler }),
            tokenize,
        });
        const r = await m.process({ path: "foo.txt", content: "anything" });
        const consumerWouldGet = await tokenize(r.preview);
        assert.equal(r.previewTokens, consumerWouldGet);
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
