import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import Mimetypes from "./Mimetypes.ts";
import BaseHandler from "./BaseHandler.ts";
import MimetypeInputLimitError from "./MimetypeInputLimitError.ts";
import MimetypeExtensionError from "./MimetypeExtensionError.ts";
import MimetypeDerivationError from "./MimetypeDerivationError.ts";
import MimetypeInputError from "./MimetypeInputError.ts";
import { UnsupportedDialectError } from "./QueryError.ts";
import { ParserCoordinateError } from "./ParserCoordinates.ts";
import { inspect } from "node:util";
import type { Discovery, HandlerInfo, MimeSymbol, Registry } from "./types.ts";
import TreeSitterLanguageHandler from "./treesitter/handler.ts";
import { lookupTreeSitterLanguage } from "./treesitter/registry.ts";

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

// ─── Mimetypes.test.ts ───
{
class FakePlainHandler extends BaseHandler {
    override extractRaw(_content: string): MimeSymbol[] {
        return [{ name: "Plain", kind: "module", line: 1, endLine: 1 }];
    }
}

class FakeEmptyHandler extends BaseHandler {
    override extractRaw(_content: string): MimeSymbol[] {
        return [];
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
        let summaryCalls = 0;
        class CountingHandler extends BaseHandler {
            override extractRaw(): MimeSymbol[] {
                extractCalls += 1;
                return [];
            }
            override deepJson(): unknown {
                extractCalls += 1;
                return null;
            }
            override summary(): string {
                summaryCalls += 1;
                return "  A summary\nwith whitespace.  ";
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
        assert.equal(summaryCalls, 0);

        const withSummary = await m.process({ path: "foo.txt", content: "x" }, { channels: [], summary: true });
        assert.equal(withSummary.summary, "A summary with whitespace.");
        assert.equal(summaryCalls, 1);
        assert.equal("symbols" in withSummary, false);
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
            discovery: makeDiscovery([plainInfo]),
            loader: async () => ({ default: WithRefs }),
        });
        const r = await m.process({ path: "foo.txt", content: "x" }, { channels: ["references"] });
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

// ─── Mimetypes.content.test.ts ───
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

// ─── Mimetypes.query-input.test.ts ───
{
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
        const asRegex = await m.query(INPUT, { dialect: "regex", pattern: "//foo" });
        assert.equal(asRegex.length, 1);
        assert.equal(asRegex[0].matched, "//foo");
        assert.deepEqual(asRegex[0].regions, [{
            startLine: 2, startColumn: 1, endLine: 2, endColumn: 6,
        }]);

        const asString = await makeMimetypes().query(INPUT, "//foo");
        assert.deepEqual(asString, []);
    });
});
}

// ─── Mimetypes.symbols.test.ts ───
{
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
        try {
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
        } finally {
            await h.dispose();
        }
    });
});
}
