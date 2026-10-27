import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs, { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import os, { tmpdir } from "node:os";
import Mimetypes from "./Mimetypes.ts";
import BaseHandler from "./BaseHandler.ts";
import MimetypeInputLimitError from "./MimetypeInputLimitError.ts";
import MimetypeExtensionError from "./MimetypeExtensionError.ts";
import MimetypeDerivationError from "./MimetypeDerivationError.ts";
import MimetypeInputError from "./MimetypeInputError.ts";
import { UnsupportedDialectError } from "./QueryError.ts";
import { ParserCoordinateError } from "./ParserCoordinates.ts";
import { inspect } from "node:util";
import type { Discovery, HandlerInfo, MimeSymbol, Registry, HandlerMetadata, MimeRef } from "./types.ts";
import * as api from "./index.ts";
import TreeSitterExtractor, { type TreeSitterNode, type TreeSitterParser, type TreeSitterTree } from "./TreeSitterExtractor.ts";
import TreeSitterLanguageHandler, { resolveWasmPath } from "./treesitter/handler.ts";
import { lookupTreeSitterLanguage } from "./treesitter/registry.ts";
import { withExtractor } from "./withExtractor.ts";
import { isExactModuleAbsent } from "./module-absence.ts";

// ─── Mimetypes.test.ts ───
{
// Contracts: {§mimetype-channel-selection}, {§mimetype-channel-selection},
// {§mimetype-error-policy}.















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

class FakeBinaryHandler extends BaseHandler {}

class FakeReadableBinaryHandler extends BaseHandler {
    override content(content: string | Uint8Array): string {
        assert.ok(content instanceof Uint8Array);
        return `projected ${content.byteLength} bytes`;
    }
}

const plainInfo: HandlerInfo = {
    mimetype: "text/plain",
    glyph: "📄",
    packageName: "@plurnk/plurnk-mimetypes-text-plain",
    projectionRevision: "test-1",
    extensions: [".txt"],
    binary: false,
    source: "package",
};

it("{§mimetype-error-policy} failed projections retain bounded source identity and their untouched typed cause", async () => {
    const cause = Object.freeze(new ParserCoordinateError("invalid native span"));
    const originalStack = cause.stack;
    class BrokenHandler extends BaseHandler {
        override extractRaw(): MimeSymbol[] { throw cause; }
    }
    const m = new Mimetypes({ discovery: makeDiscovery([plainInfo]), loader: async () => ({ default: BrokenHandler }) });
    try {
        for (const sourcePath of ["tests/utils.txt", undefined, `${"long/".repeat(300)}\nutils.txt`]) {
            await assert.rejects(m.process({ path: sourcePath, hint: "text/plain", content: "PRIVATE SOURCE BYTES" }, { channels: ["symbols"] }), (error) => {
                assert.ok(error instanceof MimetypeDerivationError);
                assert.equal(error.cause, cause);
                assert.equal(cause.stack, originalStack);
                const diagnostic = inspect(error);
                assert.match(diagnostic, /text\/plain/);
                assert.match(diagnostic, /ParserCoordinateError: invalid native span/);
                assert.equal(diagnostic.includes("PRIVATE SOURCE BYTES"), false);
                assert.equal(error.message.includes("\n"), false, "path control characters cannot inject diagnostic lines");
                assert.ok(error.message.length < 3200, "source identity is bounded");
                if (sourcePath === undefined) assert.match(error.message, /content/);
                else assert.match(error.message, /utils\.txt/);
                assert.ok(error.path === null || error.path.length <= 512);
                return true;
            });
        }
    } finally { await m.dispose(); }
});

it("{§mimetype-error-policy} concurrent projections cannot overwrite each other's source context", async () => {
    const cause = Object.freeze(new TypeError("shared projection failure"));
    class BrokenHandler extends BaseHandler {
        override async extractRaw(): Promise<MimeSymbol[]> { throw cause; }
    }
    const m = new Mimetypes({ discovery: makeDiscovery([plainInfo]), loader: async () => ({ default: BrokenHandler }) });
    try {
        const outcomes = await Promise.allSettled(["first.txt", "second.txt"].map((file) =>
            m.process({ path: file, content: "source" }, { channels: ["symbols"] })));
        assert.deepEqual(outcomes.map((outcome) => {
            assert.equal(outcome.status, "rejected");
            if (outcome.status !== "rejected") throw new Error("A broken handler must reject");
            assert.ok(outcome.reason instanceof MimetypeDerivationError);
            assert.equal(outcome.reason.cause, cause);
            return outcome.reason.path;
        }), ["first.txt", "second.txt"]);
    } finally { await m.dispose(); }
});

it("{§mimetype-error-policy} projection source refusals remain typed input failures", async () => {
    const cause = new MimetypeInputError({ mimetype: "text/plain", cause: new SyntaxError("bad source") });
    class RefusingHandler extends BaseHandler {
        override extractRaw(): MimeSymbol[] { throw cause; }
    }
    const m = new Mimetypes({ discovery: makeDiscovery([plainInfo]), loader: async () => ({ default: RefusingHandler }) });
    try {
        await assert.rejects(m.process({ path: "bad.txt", content: "source" }, { channels: ["symbols"] }), (error) => error === cause);
    } finally { await m.dispose(); }
});

it("{§mimetype-error-policy} malformed projection metadata preserves its TypeError and source", async () => {
    class InvalidMetadataHandler extends BaseHandler {
        override parseIssues(): number { return -1; }
    }
    const m = new Mimetypes({ discovery: makeDiscovery([plainInfo]), loader: async () => ({ default: InvalidMetadataHandler }) });
    try {
        await assert.rejects(m.process({ path: "metadata.txt", content: "source" }, { channels: [], parseIssues: true }), (error) => {
            assert.ok(error instanceof MimetypeDerivationError);
            assert.equal(error.path, "metadata.txt");
            assert.ok(error.cause instanceof TypeError);
            assert.match(error.cause.message, /Invalid parseIssues result/);
            return true;
        });
    } finally { await m.dispose(); }
});

const strictInfo: HandlerInfo = {
    mimetype: "application/strict",
    glyph: "🛡",
    packageName: "@plurnk/plurnk-mimetypes-application-strict",
    projectionRevision: "test-1",
    extensions: [".strict"],
    binary: false,
    source: "package",
};

const binaryInfo: HandlerInfo = {
    mimetype: "application/x-test-binary",
    glyph: "📦",
    packageName: "@plurnk/plurnk-mimetypes-application-test-binary",
    projectionRevision: "test-1",
    extensions: [".binary"],
    binary: true,
    source: "package",
};

it("{§mimetype-discovery} projects deterministic framework-owned MIME display metadata without loading handlers", async () => {
    const unmarked: HandlerInfo = {
        ...plainInfo,
        mimetype: "application/x-unmarked",
        glyph: "",
    };
    const mimetypes = new Mimetypes({
        discovery: makeDiscovery([plainInfo, unmarked]),
        loader: async () => { throw new Error("display discovery must not load handler code"); },
    });

    assert.deepEqual(await mimetypes.displayMetadata(), [
        { mimetype: "application/x-unmarked", glyph: "" },
        { mimetype: "text/plain", glyph: "📄" },
    ]);
});

describe("{§mimetype-binary-input} bounded readable projections", () => {
    it("{§mimetype-handler-contract} does not consume binary bytes when the installed handler has no content projection", async () => {
        let consumed = false;
        async function* bytes() {
            consumed = true;
            yield Uint8Array.of(1, 2, 3);
        }
        const mimetypes = new Mimetypes({
            discovery: makeDiscovery([binaryInfo]),
            loader: async () => ({ default: FakeBinaryHandler }),
        });

        assert.equal(await mimetypes.projectReadableStream(bytes(), binaryInfo.mimetype), null);
        assert.equal(consumed, false);
    });

    it("{§mimetype-handler-contract} returns derived Unicode with source and projection identity", async () => {
        async function* bytes() {
            yield Uint8Array.of(1, 2);
            yield Uint8Array.of(3, 4, 5);
        }
        const mimetypes = new Mimetypes({
            discovery: makeDiscovery([binaryInfo]),
            loader: async () => ({ default: FakeReadableBinaryHandler }),
        });

        const projected = await mimetypes.projectReadableStream(bytes(), binaryInfo.mimetype);
        assert.equal(projected?.content, "projected 5 bytes");
        assert.equal(projected?.sourceMimetype, binaryInfo.mimetype);
        assert.match(projected?.projectionIdentity ?? "", /^[a-f0-9]{64}$/);
    });

    it("{§mimetype-handler-contract} rejects inline and streamed binary input at the common byte ceiling", async () => {
        const prior = process.env.PLURNK_MIMETYPES_BINARY_INPUT_MAX_BYTES;
        process.env.PLURNK_MIMETYPES_BINARY_INPUT_MAX_BYTES = "3";
        const root = await fs.mkdtemp(path.join(os.tmpdir(), "plurnk-mimetype-binary-limit-"));
        const file = path.join(root, "oversized.binary");
        await fs.writeFile(file, Uint8Array.of(1, 2, 3, 4));
        const mimetypes = new Mimetypes({
            discovery: makeDiscovery([binaryInfo]),
            loader: async () => ({ default: FakeReadableBinaryHandler }),
        });
        async function* bytes() {
            yield Uint8Array.of(1, 2);
            yield Uint8Array.of(3, 4);
        }
        try {
            await assert.rejects(
                () => mimetypes.projectReadable({ content: Uint8Array.of(1, 2, 3, 4), hint: binaryInfo.mimetype }),
                (error: unknown) => error instanceof MimetypeInputLimitError
                    && error.maximumBytes === 3
                    && error.observedBytes === 4,
            );
            await assert.rejects(
                () => mimetypes.projectReadableStream(bytes(), binaryInfo.mimetype),
                (error: unknown) => error instanceof MimetypeInputLimitError
                    && error.maximumBytes === 3
                    && error.observedBytes === 4,
            );
            await assert.rejects(
                () => mimetypes.projectReadable({ path: file }),
                (error: unknown) => error instanceof MimetypeInputLimitError
                    && error.maximumBytes === 3
                    && error.observedBytes === 4,
            );
        } finally {
            await fs.rm(root, { recursive: true, force: true });
            if (prior === undefined) delete process.env.PLURNK_MIMETYPES_BINARY_INPUT_MAX_BYTES;
            else process.env.PLURNK_MIMETYPES_BINARY_INPUT_MAX_BYTES = prior;
        }
    });
});

describe("{§treesitter-runtime-gate} detection and discovery", () => {
    it("{§mimetype-handler-contract} detect returns null when registry is empty", async () => {
        const m = new Mimetypes({ discovery: makeDiscovery([]) });
        assert.equal(await m.detect({ path: "foo.txt" }), null);
    });

    it("{§mimetype-handler-contract} detect routes by extension via injected discovery", async () => {
        const m = new Mimetypes({ discovery: makeDiscovery([plainInfo]) });
        assert.equal(await m.detect({ path: "foo.txt" }), "text/plain");
    });

    it("{§mimetype-handler-contract} detect falls back to defaultMimetype when no match found", async () => {
        const m = new Mimetypes({
            discovery: makeDiscovery([plainInfo]),
            defaultMimetype: "text/markdown",
        });
        assert.equal(await m.detect({ path: "foo.unknown-ext" }), "text/markdown");
    });

    it("{§mimetype-handler-contract} detect prefers a real match over the default", async () => {
        const m = new Mimetypes({
            discovery: makeDiscovery([plainInfo]),
            defaultMimetype: "text/markdown",
        });
        assert.equal(await m.detect({ path: "foo.txt" }), "text/plain");
    });

    it("{§mimetype-handler-contract} ready() is idempotent (multiple calls share state)", async () => {
        const m = new Mimetypes({
            discoverOptions: { packageDirs: [] },
        });
        await m.ready();
        await m.ready();
        await m.ready();
        assert.ok(true);
    });

    it("{§mimetype-handler-contract} exposes discovery's skipped-package evidence without mutable aliasing", async () => {
        const discovery = { ...makeDiscovery([]), skipped: ["@acme/private-mime"] };
        const m = new Mimetypes({ discovery });
        const skipped = await m.skippedPackages();
        assert.deepEqual(skipped, ["@acme/private-mime"]);
        assert.notEqual(skipped, discovery.skipped);
    });
});

describe("{§mimetype-handler-contract} getHandler", () => {
    it("{§mimetype-handler-contract} returns null for unknown mimetype", async () => {
        const m = new Mimetypes({ discovery: makeDiscovery([]) });
        assert.equal(await m.getHandler("text/unknown"), null);
    });

    it("{§mimetype-handler-contract} instantiates a handler via the loader and caches it", async () => {
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

    it("{§mimetype-handler-contract} preserves a registered handler import failure", async () => {
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
                assert.ok(error instanceof MimetypeExtensionError);
                assert.equal(error.packageName, plainInfo.packageName);
                assert.equal(error.mimetype, plainInfo.mimetype);
                assert.strictEqual(error.cause, cause);
                return true;
            },
        );
    });

    it("{§mimetype-handler-contract} rejects a module without a default handler constructor", async () => {
        const m = new Mimetypes({
            discovery: makeDiscovery([plainInfo]),
            loader: async () => ({ named: FakePlainHandler }),
        });
        await assert.rejects(
            () => m.getHandler("text/plain"),
            (error: unknown) => {
                assert.ok(error instanceof MimetypeExtensionError);
                assert.ok(error.cause instanceof TypeError);
                return true;
            },
        );
    });

    it("{§mimetype-handler-contract} rejects a non-constructor default export", async () => {
        const m = new Mimetypes({
            discovery: makeDiscovery([plainInfo]),
            loader: async () => ({ default: "not a class" }),
        });
        await assert.rejects(
            () => m.getHandler("text/plain"),
            (error: unknown) => {
                assert.ok(error instanceof MimetypeExtensionError);
                assert.ok(error.cause instanceof TypeError);
                return true;
            },
        );
    });

    it("{§mimetype-handler-contract} passes only metadata to handlers", async () => {
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

describe("{§mimetype-error-policy} process: metadata and error paths", () => {
    it("{§mimetype-handler-contract} returns ok:false metadata-only when detection fails", async () => {
        const m = new Mimetypes({ discovery: makeDiscovery([]) });
        const result = await m.process({ path: "foo.unknown", content: "x" });
        assert.deepEqual(result, {
            mimetype: null,
            ok: false,
            totalLines: 0,
        });
    });

    it("{§mimetype-handler-contract} ok:false metadata-only when content cannot be read", async () => {
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

    it("{§mimetype-handler-contract} propagates a registered handler contract failure", async () => {
        const m = new Mimetypes({
            discovery: makeDiscovery([plainInfo]),
            loader: async () => ({ default: undefined }),
        });
        await assert.rejects(
            () => m.process({ path: "foo.txt", content: "raw" }),
            MimetypeExtensionError,
        );
    });

    it("{§mimetype-handler-contract} propagates validate errors per error policy", async () => {
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

    it("{§mimetype-handler-contract} hint overrides extension during detection", async () => {
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

describe("{§mimetype-channel-selection} process: channel selection", () => {
    it("{§mimetype-channel-selection} projects only positive parser-recovery counts when requested", async () => {
        let issues = 3;
        class IssueReportingHandler extends FakePlainHandler {
            override parseIssues(): number {
                return issues;
            }
        }
        const m = new Mimetypes({
            discovery: makeDiscovery([plainInfo]),
            loader: async () => ({ default: IssueReportingHandler }),
        });

        const recovered = await m.process(
            { path: "foo.txt", content: "broken" },
            { channels: ["symbols"] },
        );
        assert.equal(recovered.parseIssues, 3);

        issues = 0;
        const clean = await m.process(
            { path: "foo.txt", content: "clean" },
            { channels: ["symbols"] },
        );
        assert.equal("parseIssues" in clean, false, "the ordinary clean case carries no metadata");

        issues = 3;
        const metadataOnly = await m.process(
            { path: "foo.txt", content: "broken" },
            { channels: [] },
        );
        assert.equal("parseIssues" in metadataOnly, false, "metadata-only processing performs no parse");

        const inspectedOnly = await m.process(
            { path: "foo.txt", content: "broken" },
            { channels: [], parseIssues: true },
        );
        assert.equal(inspectedOnly.parseIssues, 3, "inspection does not require a structural projection");
    });

    it("{§mimetype-handler-contract} default selects every structural channel", async () => {
        const m = new Mimetypes({
            discovery: makeDiscovery([plainInfo]),
            loader: async () => ({ default: FakePlainHandler }),
        });
        const r = await m.process({ path: "foo.txt", content: "hello" });
        assert.deepEqual(r.symbols, [{ name: "Plain", kind: "module", line: 1, endLine: 1 }]);
        assert.equal(r.deepJson, null);
        assert.match(r.deepXml!, /<Plain\b/);
        assert.deepEqual(r.references, []);
        assert.equal(r.ok, true);
    });

    it("{§mimetype-handler-contract} channels: [] yields metadata only — no channel fields, no extraction paid", async () => {
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

    it("{§mimetype-handler-contract} requesting a subset materializes exactly that subset", async () => {
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

    it("{§mimetype-handler-contract} honors a handler deepXml() override for the deepXml channel", async () => {
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

    it("{§mimetype-references} references channel defaults to []", async () => {
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

    it("{§mimetype-handler-contract} symbols channel carries the structured extractRaw output", async () => {
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

    it("{§mimetype-handler-contract} reads content from disk when only path is provided", async () => {
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

describe("{§mimetype-error-policy} process: totalLines", () => {
    it("{§mimetype-handler-contract} returns 0 for empty content", async () => {
        const m = new Mimetypes({
            discovery: makeDiscovery([plainInfo]),
            loader: async () => ({ default: FakePlainHandler }),
        });
        const r = await m.process({ path: "foo.txt", content: "" });
        assert.equal(r.totalLines, 0);
    });

    it("{§mimetype-handler-contract} returns 1 for single-line content without trailing newline", async () => {
        const m = new Mimetypes({
            discovery: makeDiscovery([plainInfo]),
            loader: async () => ({ default: FakePlainHandler }),
        });
        const r = await m.process({ path: "foo.txt", content: "just one line" });
        assert.equal(r.totalLines, 1);
    });

    it("{§mimetype-handler-contract} returns 1 for single-line content with trailing newline (terminator, not new line)", async () => {
        const m = new Mimetypes({
            discovery: makeDiscovery([plainInfo]),
            loader: async () => ({ default: FakePlainHandler }),
        });
        const r = await m.process({ path: "foo.txt", content: "one line\n" });
        assert.equal(r.totalLines, 1);
    });

    it("{§mimetype-handler-contract} returns N for N lines (editor-convention count)", async () => {
        const m = new Mimetypes({
            discovery: makeDiscovery([plainInfo]),
            loader: async () => ({ default: FakePlainHandler }),
        });
        const r1 = await m.process({ path: "foo.txt", content: "a\nb\nc" });
        assert.equal(r1.totalLines, 3);

        const r2 = await m.process({ path: "foo.txt", content: "a\nb\nc\n" });
        assert.equal(r2.totalLines, 3);
    });

    it("{§mimetype-handler-contract} counts empty lines correctly", async () => {
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

    it("{§mimetype-handler-contract} returns 0 for binary content (lines not meaningful for binary mimetypes)", async () => {
        const octetInfo: HandlerInfo = {
            mimetype: "application/octet-stream",
            glyph: "📦",
            packageName: "@plurnk/plurnk-mimetypes-application-octet-stream",
            projectionRevision: "test-1",
            extensions: [".bin"],
            binary: true,
            source: "package",
        };
        class BinaryHandler extends BaseHandler {}
        const m = new Mimetypes({
            discovery: makeDiscovery([octetInfo]),
            loader: async () => ({ default: BinaryHandler }),
        });
        const bytes = new Uint8Array([0x00, 0x0a, 0x0a, 0xff, 0x0a]);
        const r = await m.process({ path: "foo.bin", content: bytes });
        assert.equal(r.totalLines, 0);
    });

    it("{§mimetype-handler-contract} returns 0 on detection and read error results", async () => {
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

describe("{§mimetype-query} query", () => {
    it("{§mimetype-handler-contract} dispatches regex via /pattern/flags expression to the handler", async () => {
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

    it("{§mimetype-handler-contract} dispatches jsonpath via $ expression to the handler's outline", async () => {
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
        assert.equal(results[0].enclosingRegions?.[0]?.startLine, 5);
    });

    it("{§mimetype-handler-contract} dispatches glob (no prefix) line-anchored against text body", async () => {
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

    it("dispatches xpath via // against the projected symbol outline (symbols-only handlers gain xpath; {§mimetype-query} symmetry)", async () => {
        const m = new Mimetypes({
            discovery: makeDiscovery([plainInfo]),
            loader: async () => ({ default: FakePlainHandler }),
        });
        const results = await m.query({ path: "foo.txt", content: "any" }, "//Plain");
        assert.equal(results.length, 1);
        assert.deepEqual(results[0].enclosingRegions, [{
            startLine: 1, startColumn: 1, endLine: 1, endColumn: 4,
        }]);
    });

    it("{§mimetype-handler-contract} xpath still throws when the handler has no deep tree and no symbols (mapped to 415 upstream)", async () => {
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

    it("{§mimetype-handler-contract} throws when detection fails (no mimetype to resolve)", async () => {
        const m = new Mimetypes({ discovery: makeDiscovery([]) });
        await assert.rejects(
            async () => { await m.query({ path: "foo.unknown" }, "/x/"); },
            /no mimetype/,
        );
    });

    it("{§mimetype-handler-contract} throws when content is unreadable", async () => {
        const m = new Mimetypes({
            discovery: makeDiscovery([plainInfo]),
            loader: async () => ({ default: FakePlainHandler }),
        });
        await assert.rejects(
            async () => { await m.query({ path: "/nonexistent.txt" }, "/x/"); },
            /content unreadable/,
        );
    });

    it("{§mimetype-handler-contract} reports an unregistered mimetype as an unsupported dialect", async () => {
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

    it("{§mimetype-handler-contract} keeps a registered handler load failure distinct from an unsupported dialect", async () => {
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
                assert.ok(error instanceof MimetypeExtensionError);
                assert.equal(error instanceof UnsupportedDialectError, false);
                assert.equal(error.packageName, plainInfo.packageName);
                assert.equal(error.mimetype, plainInfo.mimetype);
                assert.match(String(error.cause), /module not found/);
                return true;
            },
        );
    });
});

describe("{§mimetype-error-policy} degradation notices", () => {
    it("{§mimetype-handler-contract} a fully-satisfied result carries no notices field", async () => {
        const m = new Mimetypes({
            discovery: makeDiscovery([plainInfo]),
            loader: async () => ({ default: FakePlainHandler }),
        });
        const r = await m.process({ path: "foo.txt", content: "hello" });
        assert.equal(r.notices, undefined);
    });
});
}

// ─── Mimetypes.channels.test.ts ───
{
// Contracts: {§mimetype-channel-selection}, {§mimetype-references}.







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

const INFO: HandlerInfo = {
    mimetype: "text/x-test",
    glyph: "🧪",
    packageName: "@plurnk/plurnk-mimetypes-text-test",
    projectionRevision: "test-1",
    extensions: [".tst"],
    binary: false,
    source: "package",
};

class StructuredHandler extends BaseHandler {
    static extractCalls = 0;
    static deepJsonCalls = 0;
    static summaryCalls = 0;
    override extractRaw(): MimeSymbol[] {
        StructuredHandler.extractCalls += 1;
        return [{ name: "Thing", kind: "class", line: 2, endLine: 9 }];
    }
    override deepJson(): unknown {
        StructuredHandler.deepJsonCalls += 1;
        return { type: "root", line: 1, endLine: 9 };
    }
    override summary(): string {
        StructuredHandler.summaryCalls += 1;
        return "  A summary\nwith whitespace.  ";
    }
}

function makeMimetypes() {
    return new Mimetypes({
        discovery: makeDiscovery([INFO]),
        loader: async () => ({ default: StructuredHandler }),
    });
}

describe("{§mimetype-channel-selection} channel selection semantics", () => {
    it("{§mimetype-channel-selection} default selects every structural channel", async () => {
        const m = makeMimetypes();
        const r = await m.process({ path: "a.tst", content: "x\ny" });
        assert.ok(Array.isArray(r.symbols));
        assert.ok("deepJson" in r);
        assert.equal(typeof r.deepXml, "string");
        assert.ok(Array.isArray(r.references));
    });

    it("{§mimetype-channel-selection} a subset materializes exactly that subset", async () => {
        const m = makeMimetypes();
        const r = await m.process(
            { path: "a.tst", content: "x" },
            { channels: ["symbols", "deepXml"] },
        );
        assert.ok(Array.isArray(r.symbols));
        assert.equal(typeof r.deepXml, "string");
        assert.equal("deepJson" in r, false);
        assert.equal("references" in r, false);
    });

    it("{§mimetype-channel-selection} channels: [] is metadata-only and pays no extraction", async () => {
        StructuredHandler.extractCalls = 0;
        StructuredHandler.deepJsonCalls = 0;
        StructuredHandler.summaryCalls = 0;
        const m = makeMimetypes();
        const r = await m.process({ path: "a.tst", content: "a\nb\nc" }, { channels: [] });
        assert.deepEqual(r, {
            mimetype: "text/x-test",
            ok: true,
            totalLines: 3,
        });
        assert.equal(StructuredHandler.extractCalls, 0);
        assert.equal(StructuredHandler.deepJsonCalls, 0);
        assert.equal(StructuredHandler.summaryCalls, 0);
    });

    it("{§mimetype-channel-selection} summary inspection is explicit, normalized, and independent of projection channels", async () => {
        StructuredHandler.summaryCalls = 0;
        const m = makeMimetypes();
        const r = await m.process(
            { path: "a.tst", content: "x" },
            { channels: [], summary: true },
        );
        assert.equal(r.summary, "A summary with whitespace.");
        assert.equal(StructuredHandler.summaryCalls, 1);
        assert.equal("symbols" in r, false);
    });
});

describe("{§mimetype-channel-selection} symbols are structured", () => {
    it("{§mimetype-channel-selection} symbols carry MimeSymbol[] verbatim from extractRaw", async () => {
        const m = makeMimetypes();
        const r = await m.process({ path: "a.tst", content: "x" }, { channels: ["symbols"] });
        assert.deepEqual(r.symbols, [{ name: "Thing", kind: "class", line: 2, endLine: 9 }]);
    });
});

describe("{§mimetype-channel-selection} references follow the handler contract", () => {
    it("{§mimetype-channel-selection} references is [] for a handler without an implementation", async () => {
        const m = makeMimetypes();
        const r = await m.process({ path: "a.tst", content: "x" }, { channels: ["references"] });
        assert.deepEqual(r.references, []);
    });

    it("{§mimetype-channel-selection} a handler references() override flows through the channel", async () => {
        class WithRefs extends BaseHandler {
            override references() {
                return [{
                    name: "helper",
                    kind: "call" as const,
                    line: 3,
                    column: 5,
                    endLine: 3,
                    endColumn: 11,
                    container: "Thing.run",
                }];
            }
        }
        const m = new Mimetypes({
            discovery: makeDiscovery([INFO]),
            loader: async () => ({ default: WithRefs }),
        });
        const r = await m.process({ path: "a.tst", content: "x" }, { channels: ["references"] });
        assert.deepEqual(r.references, [{
            name: "helper",
            kind: "call",
            line: 3,
            column: 5,
            endLine: 3,
            endColumn: 11,
            container: "Thing.run",
        }]);
    });
});

describe("{§mimetype-references} only outline render primitives are public", () => {
    it("{§mimetype-channel-selection} format / buildTree / renderTree are exported", () => {
        assert.equal(typeof api.format, "function");
        assert.equal(typeof api.buildTree, "function");
        assert.equal(typeof api.renderTree, "function");
    });
});
}

// ─── Mimetypes.content.test.ts ───
{
// Contract: {§mimetype-content}.






function makeDiscovery(handlers: HandlerInfo[]): Discovery {
    const byExtension = new Map<string, string>();
    const handlerMap = new Map<string, HandlerInfo>();
    for (const info of handlers) {
        handlerMap.set(info.mimetype, info);
        for (const ext of info.extensions) byExtension.set(ext.toLowerCase(), info.mimetype);
    }
    const registry: Registry = { byExtension, byFilename: new Map() };
    return { registry, handlers: handlerMap, packageAttributions: new Map(), skipped: [] };
}

const INFO: HandlerInfo = {
    mimetype: "text/x-test",
    glyph: "🧪",
    packageName: "@plurnk/x",
    projectionRevision: "test-1",
    extensions: [".tst"],
    binary: false,
    source: "package",
};

// Stand-in for text/html: content() returns a "markdown" projection that
// differs from the raw body; toText returns the same readable text.
class MarkdownHandler extends BaseHandler {
    override content(c: string | Uint8Array): string {
        return `# ${typeof c === "string" ? c.replace(/<[^>]+>/g, "") : ""}`;
    }
    protected override toText(c: string | Uint8Array): string {
        return this.content(c);
    }
}

class EmptyProjectionHandler extends BaseHandler {
    override content(): string {
        return "";
    }
}

function mk(handler: new (...a: never[]) => BaseHandler) {
    return new Mimetypes({
        discovery: makeDiscovery([INFO]),
        loader: async () => ({ default: handler }),
    });
}

describe("{§mimetype-content} the content channel is absent by default", () => {
    it("{§mimetype-content} a plain handler populates no content even when the channel is requested", async () => {
        const m = mk(BaseHandler);
        const r = await m.process({ path: "a.tst", content: "hello" }, { channels: ["content"] });
        assert.equal("content" in r, false, "no content key when handler returns undefined");
    });

    it("{§mimetype-content} content is in the default channel set (requested without asking)", async () => {
        const m = mk(MarkdownHandler);
        const r = await m.process({ path: "a.tst", content: "<b>hi</b>" });
        assert.equal(r.content, "# hi", "default process() computes content");
    });
});

describe("{§mimetype-content} an overriding handler surfaces the content channel", () => {
    it("{§mimetype-content} MarkdownHandler projects readable text distinct from the body", async () => {
        const m = mk(MarkdownHandler);
        const r = await m.process(
            { path: "a.tst", content: "<p>article body</p>" },
            { channels: ["content"] },
        );
        assert.equal(r.content, "# article body");
        assert.equal("symbols" in r, false, "only the requested channel");
    });

    it("{§mimetype-content} preserves a present empty projection instead of erasing the field", async () => {
        const m = mk(EmptyProjectionHandler);
        const r = await m.process(
            { path: "a.tst", content: "source" },
            { channels: ["content"] },
        );
        assert.equal("content" in r, true);
        assert.equal(r.content, "");
    });
});
}

// ─── Mimetypes.dispose.test.ts ───
{
// Contract: {§mimetype-lifecycle}.










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

// Two owned handlers, so teardown aggregation is tested across more than one disposable.
function makeDiscovery(): Discovery {
    const registry: Registry = {
        byExtension: new Map([[".tst", "text/x-test"], [".tst2", "text/x-test2"]]),
        byFilename: new Map(),
    };
    return { registry, handlers: new Map([["text/x-test", INFO], ["text/x-test2", INFO2]]), packageAttributions: new Map(), skipped: [] };
}

function lifecycleMimetypes({
    Handler = BaseHandler,
    Second = BaseHandler,
}: {
    Handler?: new (metadata: HandlerMetadata) => BaseHandler;
    Second?: new (metadata: HandlerMetadata) => BaseHandler;
} = {}): Mimetypes {
    return new Mimetypes({
        discovery: makeDiscovery(),
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
        // Re-resolving after dispose still produces a usable result.
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
// Contracts: {§mimetype-discovery}, {§mimetype-handler-contract}.
// Issue #88 is provenance.









// This file's fixtures are third-party packages, so it exercises the operator who admitted them
// ({§executor-policy}); the shipped panel admits only `@plurnk/*`. Tests of the gate itself state
// their own value below and override this one.
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

const discovery: Discovery = {
    registry: {
        byExtension: new Map([[".fixture", info.mimetype]]),
        byFilename: new Map(),
    },
    handlers: new Map([[info.mimetype, info]]),
    packageAttributions: new Map(), skipped: [],
};

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
// Contract: {§mimetype-error-policy}.






// A handler that simulates "grammar package not installed" — throws the
// signal-bearing error from extractRaw/deepJson just like TreeSitterExtractor
// does when its WASM can't be resolved.
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

const FAKE_INFO: HandlerInfo = {
    mimetype: "text/x-fake",
    glyph: "🧪",
    packageName: "@plurnk/plurnk-mimetypes-grammar-fake",
    projectionRevision: "test-1",
    extensions: [".fake"],
    binary: false,
    // 'package' so the test loader (FakeMissingGrammarHandler) is used.
    // In production this exact scenario is triggered by 'treesitter' entries
    // whose grammar package isn't installed — the failure path is identical:
    // the handler throws GrammarNotInstalledError from extractRaw/deepJson,
    // and process() catches and degrades.
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
// Contract: {§mimetype-error-policy}. Issue #92 is provenance.











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

function discovery(handler: HandlerInfo = info): Discovery {
    return {
        registry: {
            byExtension: new Map([[".fixture", handler.mimetype]]),
            byFilename: new Map(),
        },
        handlers: new Map([[handler.mimetype, handler]]),
        packageAttributions: new Map(), skipped: [],
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

// ─── Mimetypes.query-input.test.ts ───
{
// Contract: {§mimetype-query}.






function makeDiscovery(handlers: HandlerInfo[]): Discovery {
    const byExtension = new Map<string, string>();
    const byFilename = new Map<string, string>();
    const handlerMap = new Map<string, HandlerInfo>();
    for (const info of handlers) {
        handlerMap.set(info.mimetype, info);
        for (const ext of info.extensions) byExtension.set(ext.toLowerCase(), info.mimetype);
    }
    const registry: Registry = { byExtension, byFilename };
    return { registry, handlers: handlerMap, packageAttributions: new Map(), skipped: [] };
}

// A handler that supports all four dialects: regex/glob over text, jsonpath over
// deepJson, xpath over the projected deep-xml.
class FakeQueryHandler extends BaseHandler {
    override extractRaw(_content: string | Uint8Array): MimeSymbol[] {
        return [{ name: "module", kind: "module", line: 1, endLine: 3 }];
    }
    override deepJson(_content: string | Uint8Array): unknown {
        return {
            type: "module", line: 1, endLine: 3,
            children: [{ type: "method", line: 2, endLine: 2, name: "greet" }],
        };
    }
}

const info: HandlerInfo = {
    mimetype: "text/x-fake",
    glyph: "🧪",
    packageName: "@plurnk/plurnk-mimetypes-text-fake",
    projectionRevision: "test-1",
    extensions: [".fake"],
    binary: false,
    source: "package",
};

function makeMimetypes(): Mimetypes {
    return new Mimetypes({
        discovery: makeDiscovery([info]),
        loader: async () => ({ default: FakeQueryHandler }),
    });
}

// Two source lines, with the literal "//foo" on line 2 so a regex hit is
// line-locatable and distinct from an xpath interpretation of the same pattern.
const SOURCE = "alpha\n//foo bar\n";
const INPUT = { path: "f.fake", content: SOURCE };

describe("{§mimetype-query} parsed-form matcher is accepted alongside the raw string", () => {
    it("{§mimetype-query} dispatches a parsed { dialect, pattern } object", async () => {
        const m = makeMimetypes();
        const out = await m.query(INPUT, { dialect: "jsonpath", pattern: "$..children[*]" });
        assert.equal(out.length, 1);
        assert.deepEqual(out[0].enclosingRegions, [{
            startLine: 2, startColumn: 1, endLine: 2, endColumn: 10,
        }]);
    });
});

describe("{§mimetype-query} parsed and raw forms agree, with m.lines, on every dialect", () => {
    const cases: ReadonlyArray<{ raw: string; parsed: { dialect: "regex" | "glob" | "jsonpath" | "xpath"; pattern: string; flags?: string } }> = [
        { raw: "/foo/", parsed: { dialect: "regex", pattern: "foo" } },
        { raw: "*foo*", parsed: { dialect: "glob", pattern: "*foo*" } },
        { raw: "$..children[*]", parsed: { dialect: "jsonpath", pattern: "$..children[*]" } },
        { raw: "//method", parsed: { dialect: "xpath", pattern: "//method" } },
    ];
    for (const { raw, parsed } of cases) {
        it(`{§mimetype-query} ${parsed.dialect}: raw "${raw}" === parsed, both carry lines`, async () => {
            const rawOut = await makeMimetypes().query(INPUT, raw);
            const parsedOut = await makeMimetypes().query(INPUT, parsed);
            assert.deepEqual(parsedOut, rawOut, "parsed form must match raw-string dispatch exactly");
            assert.ok(parsedOut.length > 0, "expected at least one match");
            for (const m of parsedOut) {
                const regions = parsed.dialect === "regex" || parsed.dialect === "glob" ? m.regions : m.enclosingRegions;
                assert.ok(
                    regions && regions.length > 0 && regions[0].startLine >= 1,
                    "every match carries a readable text region",
                );
            }
        });
    }
});

describe("{§mimetype-query} parsed dialect is authoritative; no re-parse by prefix (anti-drift)", () => {
    it("{§mimetype-query} a parsed { regex, '//foo' } runs as regex even though '//foo' string-classifies as xpath", async () => {
        const m = makeMimetypes();
        // As a regex over the source text, "//foo" matches the literal on line 2.
        const asRegex = await m.query(INPUT, { dialect: "regex", pattern: "//foo" });
        assert.equal(asRegex.length, 1);
        assert.equal(asRegex[0].matched, "//foo");
        assert.deepEqual(asRegex[0].regions, [{
            startLine: 2, startColumn: 1, endLine: 2, endColumn: 6,
        }]);

        // The same text passed as the raw string "//foo" classifies as xpath and
        // selects <foo> elements — of which there are none. Different dialect,
        // different result: proof the parsed form did NOT re-derive the dialect.
        const asString = await makeMimetypes().query(INPUT, "//foo");
        assert.deepEqual(asString, []);
    });
});
}

// ─── Mimetypes.symbols.test.ts ───
{
// Contracts: {§mimetype-symbol}, {§mimetype-symbol}.









function makeDiscovery(handlers: HandlerInfo[]): Discovery {
    const byExtension = new Map<string, string>();
    const byFilename = new Map<string, string>();
    const handlerMap = new Map<string, HandlerInfo>();
    for (const info of handlers) {
        handlerMap.set(info.mimetype, info);
        for (const ext of info.extensions) {
            if (ext.startsWith(".")) byExtension.set(ext.toLowerCase(), info.mimetype);
        }
    }
    const registry: Registry = { byExtension, byFilename };
    return { registry, handlers: handlerMap, packageAttributions: new Map(), skipped: [] };
}

describe("{§mimetype-symbol} container + columns flow through the symbols channel", () => {
    it("{§mimetype-channel-selection} process() returns symbols with container and 1-indexed columns verbatim", async () => {
        class V2Handler extends BaseHandler {
            override extractRaw(): MimeSymbol[] {
                return [
                    { name: "Outer", kind: "class", line: 1, endLine: 9, column: 1, endColumn: 2 },
                    { name: "run", kind: "method", line: 2, endLine: 4, column: 5, endColumn: 6, container: "Outer" },
                ];
            }
        }
        const info: HandlerInfo = {
            mimetype: "text/x-v2",
            glyph: "🧪",
            packageName: "@plurnk/x",
            projectionRevision: "test-1",
            extensions: [".v2"],
            binary: false,
            source: "package",
        };
        const m = new Mimetypes({
            discovery: makeDiscovery([info]),
            loader: async () => ({ default: V2Handler }),
        });
        const r = await m.process({ path: "a.v2", content: "x" }, { channels: ["symbols"] });
        assert.equal(r.symbols![0].container, undefined, "top-level symbol has NO container key semantics");
        assert.equal(r.symbols![1].container, "Outer");
        assert.equal(r.symbols![1].column, 5);
        assert.equal(r.symbols![1].endColumn, 6);
    });
});

describe("{§mimetype-symbol} reference mapping nests containers by dotted path", () => {
    it("{§mimetype-channel-selection} python: Outer.Inner.deep chain with absent container at top level", async () => {
        const entry = lookupTreeSitterLanguage("text/x-python")!;
        const h = new TreeSitterLanguageHandler(
            { mimetype: entry.mimetype, glyph: entry.glyph, extensions: entry.extensions },
            entry,
        );
        const src = "class Outer:\n    class Inner:\n        def deep(self):\n            pass\n";
        const syms = await h.extractRaw(src);
        const outer = syms.find((s) => s.name === "Outer")!;
        const inner = syms.find((s) => s.name === "Inner")!;
        const deep = syms.find((s) => s.name === "deep")!;
        assert.equal("container" in outer, false, "container key absent, not empty");
        assert.equal(inner.container, "Outer");
        assert.equal(deep.container, "Outer.Inner");
        assert.equal(outer.column, 1);
        assert.equal(deep.line, 3);
        assert.equal(deep.column, 9);
    });
});

describe("{§mimetype-symbol} withExtractor mixin supports container + columns", () => {
    class FakeVisitorBase {
        visit(_tree: unknown): unknown { return null; }
        visitChildren(node: unknown): unknown {
            // Minimal antlr-shaped recursion: the fake "tree" carries a
            // children-visitor callback the test drives.
            const n = node as { onChildren?: () => void };
            n.onChildren?.();
            return null;
        }
    }

    interface FakeCtx {
        start: { line: number; column: number };
        stop: { line: number; column: number; text: string };
        onChildren?: () => void;
    }

    function fakeCtx(line: number, column: number, stopLine: number, stopColumn: number, stopText: string): FakeCtx {
        return {
            start: { line, column },
            stop: { line: stopLine, column: stopColumn, text: stopText },
        };
    }

    it("{§mimetype-channel-selection} addSymbol stamps 1-indexed columns from the 0-indexed antlr positions", () => {
        const V = withExtractor(FakeVisitorBase);
        const v = new V();
        v.addSymbol("function", "f", fakeCtx(3, 4, 5, 0, "end") as never);
        const [sym] = v.symbols;
        assert.equal(sym.line, 3);
        assert.equal(sym.column, 5, "antlr column 4 → 1-indexed 5");
        assert.equal(sym.endLine, 5);
        assert.equal(sym.endColumn, 4, "stop col 0 + len('end') + 1");
    });

    it("{§mimetype-channel-selection} gateContainer scopes nest, apply to addSymbol, and unwind", () => {
        const V = withExtractor(FakeVisitorBase);
        const v = new V();
        v.addSymbol("class", "Outer", fakeCtx(1, 0, 9, 0, "}") as never);
        v.gateContainer("Outer", {
            ...fakeCtx(1, 0, 9, 0, "}"),
            onChildren: () => {
                v.addSymbol("method", "shallow", fakeCtx(2, 4, 3, 4, "}") as never);
                v.gateContainer("Inner", {
                    ...fakeCtx(4, 4, 8, 4, "}"),
                    onChildren: () => {
                        v.addSymbol("method", "deep", fakeCtx(5, 8, 6, 8, "}") as never);
                    },
                } as never);
            },
        } as never);
        v.addSymbol("function", "after", fakeCtx(10, 0, 11, 0, "}") as never);

        const byName = new Map(v.symbols.map((s) => [s.name, s]));
        assert.equal(byName.get("Outer")!.container, undefined);
        assert.equal(byName.get("shallow")!.container, "Outer");
        assert.equal(byName.get("deep")!.container, "Outer.Inner");
        assert.equal(byName.get("after")!.container, undefined, "container unwinds after gate");
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
