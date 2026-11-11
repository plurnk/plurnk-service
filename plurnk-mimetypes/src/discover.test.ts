import test, { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { pathToFileURL } from "node:url";
import { discover } from "./discover.ts";
import Mimetypes from "./Mimetypes.ts";
import MimetypeExtensionError from "./MimetypeExtensionError.ts";
import type { ExtensionAttributionContext } from "@plurnk/plurnk-meta";
import BaseHandler from "./BaseHandler.ts";
import type { Discovery, HandlerInfo, HandlerMetadata, Registry } from "./types.ts";

// ─── discover.test.ts ───
{
// Contracts: {§mimetype-discovery}, {§mimetype-discovery}.









async function makePackage(
    root: string,
    folder: string,
    pkg: Record<string, unknown>,
    options: { defaultHandlerRevision?: boolean } = {},
): Promise<string> {
    const dir = path.join(root, folder);
    await fs.mkdir(dir, { recursive: true });
    const plurnk = pkg.plurnk;
    const packageJson = options.defaultHandlerRevision === false
        || typeof plurnk !== "object"
        || plurnk === null
        || !Array.isArray((plurnk as { handlers?: unknown }).handlers)
        ? pkg
        : {
            ...pkg,
            plurnk: {
                ...plurnk,
                handlers: (plurnk as { handlers: unknown[] }).handlers.map((entry) =>
                    typeof entry === "object" && entry !== null
                        ? { revision: "test-1", ...entry }
                        : entry),
            },
        };
    await fs.writeFile(path.join(dir, "package.json"), JSON.stringify(packageJson, null, 2));
    return dir;
}

const THIRD_PARTY_HANDLER_SOURCE = `
    export default class Cobol {
        constructor({ mimetype, glyph, extensions }) {
            this.mimetype = mimetype;
            this.glyph = glyph;
            this.extensions = extensions;
        }
        validate() {}
        parseIssues() { return 0; }
        summary() { return undefined; }
        projectionConfiguration() { return ""; }
        extractRaw() { return []; }
        deepJson() { return null; }
        deepXml() { return ""; }
        references() { return []; }
        content() { return undefined; }
        query() { return []; }
        symbolsRaw() { return ""; }
        toText(content) { return content; }
    }
`;

describe("{§mimetype-discovery} discover", () => {
    let tmpRoot: string;

    before(async () => {
        tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "plurnk-mimetypes-test-"));
    });

    after(async () => {
        await fs.rm(tmpRoot, { recursive: true, force: true });
    });

    it("{§mimetype-discovery} returns empty registry and handlers when no packages found", async () => {
        const result = await discover({ packageDirs: [], includeTreeSitter: false });
        assert.equal(result.handlers.size, 0);
        assert.equal(result.registry.byExtension.size, 0);
        assert.equal(result.registry.byFilename.size, 0);
    });

    it("{§mimetype-discovery} returns empty when default cwd has no node_modules/@plurnk", async () => {
        const empty = await fs.mkdtemp(path.join(os.tmpdir(), "plurnk-empty-"));
        try {
            const result = await discover({ cwd: empty, includeTreeSitter: false });
            assert.equal(result.handlers.size, 0);
        } finally {
            await fs.rm(empty, { recursive: true, force: true });
        }
    });

    it("{§mimetype-discovery} registers a single-entry handlers array", async () => {
        const dir = await makePackage(tmpRoot, "pkg-py", {
            name: "@plurnk/plurnk-mimetypes-text-x-python",
            plurnk: {
                kind: "mimetype",
                handlers: [
                    { name: "text/x-python", glyph: "🐍", extensions: [".py", ".pyw"] },
                ],
            },
        });
        const result = await discover({ packageDirs: [dir], includeTreeSitter: false });
        assert.equal(result.handlers.size, 1);
        const info = result.handlers.get("text/x-python");
        assert.ok(info);
        assert.equal(info.glyph, "🐍");
        assert.equal(info.packageName, "@plurnk/plurnk-mimetypes-text-x-python");
        assert.equal(info.projectionRevision, "test-1");
        assert.deepEqual([...info.extensions], [".py", ".pyw"]);
        assert.equal(result.registry.byExtension.get(".py"), "text/x-python");
        assert.equal(result.registry.byExtension.get(".pyw"), "text/x-python");
    });

    it("{§mimetype-discovery} splits dotted extensions into byExtension and bare entries into byFilename", async () => {
        const dir = await makePackage(tmpRoot, "pkg-dockerfile", {
            name: "@plurnk/plurnk-mimetypes-text-x-dockerfile",
            plurnk: {
                kind: "mimetype",
                handlers: [
                    {
                        name: "text/x-dockerfile",
                        glyph: "🐳",
                        extensions: [".dockerfile", "Dockerfile", "Containerfile"],
                    },
                ],
            },
        });
        const result = await discover({ packageDirs: [dir], includeTreeSitter: false });
        assert.equal(result.registry.byExtension.get(".dockerfile"), "text/x-dockerfile");
        assert.equal(result.registry.byFilename.get("Dockerfile"), "text/x-dockerfile");
        assert.equal(result.registry.byFilename.get("Containerfile"), "text/x-dockerfile");
        assert.equal(result.registry.byExtension.size, 1);
        assert.equal(result.registry.byFilename.size, 2);
    });

    it("{§mimetype-discovery} normalizes extension case to lowercase in byExtension", async () => {
        const dir = await makePackage(tmpRoot, "pkg-cased", {
            name: "@plurnk/plurnk-mimetypes-cased",
            plurnk: {
                kind: "mimetype",
                handlers: [{ name: "text/cased", extensions: [".CAPS"] }],
            },
        });
        const result = await discover({ packageDirs: [dir], includeTreeSitter: false });
        assert.equal(result.registry.byExtension.get(".caps"), "text/cased");
    });

    it("{§mimetype-discovery} preserves filename case (Dockerfile stays Dockerfile)", async () => {
        const dir = await makePackage(tmpRoot, "pkg-filename-case", {
            name: "@plurnk/plurnk-mimetypes-filename",
            plurnk: {
                kind: "mimetype",
                handlers: [{ name: "text/x-makefile", extensions: ["Makefile"] }],
            },
        });
        const result = await discover({ packageDirs: [dir], includeTreeSitter: false });
        assert.equal(result.registry.byFilename.get("Makefile"), "text/x-makefile");
        assert.equal(result.registry.byFilename.get("makefile"), undefined);
    });

    it("{§mimetype-discovery} skips packages missing plurnk metadata", async () => {
        const dir = await makePackage(tmpRoot, "pkg-noplurnk", {
            name: "@plurnk/plurnk-mimetypes-unrelated",
        });
        const result = await discover({ packageDirs: [dir], includeTreeSitter: false });
        assert.equal(result.handlers.size, 0);
    });

    it("{§mimetype-discovery} skips packages with non-mimetype kind", async () => {
        const dir = await makePackage(tmpRoot, "pkg-provider", {
            name: "@plurnk/plurnk-providers-openai",
            plurnk: { kind: "provider", name: "openai" },
        });
        const result = await discover({ packageDirs: [dir], includeTreeSitter: false });
        assert.equal(result.handlers.size, 0);
    });

    it("{§mimetype-discovery} rejects a mimetype declaration missing the handlers array", async () => {
        const dir = await makePackage(tmpRoot, "pkg-no-handlers", {
            name: "@plurnk/plurnk-mimetypes-bad",
            plurnk: { kind: "mimetype" },
        });
        await assert.rejects(
            () => discover({ packageDirs: [dir], includeTreeSitter: false }),
            (error: Error) => error.name === "MimetypeExtensionError" && /handlers/.test(error.message),
        );
    });

    it("{§mimetype-discovery} rejects a mimetype declaration whose handlers field is not an array", async () => {
        const dir = await makePackage(tmpRoot, "pkg-handlers-nonarray", {
            name: "@plurnk/plurnk-mimetypes-bad",
            plurnk: { kind: "mimetype", handlers: "not an array" },
        });
        await assert.rejects(
            () => discover({ packageDirs: [dir], includeTreeSitter: false }),
            (error: Error) => error.name === "MimetypeExtensionError" && /handlers/.test(error.message),
        );
    });

    it("{§mimetype-discovery} rejects the whole declaration when a handler entry has no name", async () => {
        const dir = await makePackage(tmpRoot, "pkg-entry-noname", {
            name: "@plurnk/plurnk-mimetypes-test",
            plurnk: {
                kind: "mimetype",
                handlers: [
                    { extensions: [".x"] },        // missing name — skipped
                    { name: "", extensions: [".y"] }, // empty name — skipped
                    { name: "text/valid", extensions: [".z"] }, // valid
                ],
            },
        });
        await assert.rejects(
            () => discover({ packageDirs: [dir], includeTreeSitter: false }),
            (error: Error) => error.name === "MimetypeExtensionError" && /entry 0.*name/.test(error.message),
        );
    });

    it("{§mimetype-discovery} rejects a handler entry whose name is not a media type", async () => {
        const dir = await makePackage(tmpRoot, "pkg-entry-invalid-name", {
            name: "@plurnk/plurnk-mimetypes-test",
            plurnk: {
                kind: "mimetype",
                handlers: [{ name: "text/not/a-media-type", extensions: [".x"] }],
            },
        });
        await assert.rejects(
            () => discover({ packageDirs: [dir], includeTreeSitter: false }),
            (error: Error) => error.name === "MimetypeExtensionError" && /media-type name/.test(error.message),
        );
    });

    it("{§mimetype-discovery} rejects a handler entry without a canonical projection revision", async () => {
        for (const [folder, revision] of [
            ["pkg-revision-missing", undefined],
            ["pkg-revision-empty", ""],
            ["pkg-revision-whitespace", " reader-1 "],
        ] as const) {
            const dir = await makePackage(tmpRoot, folder, {
                name: `@plurnk/${folder}`,
                plurnk: {
                    kind: "mimetype",
                    handlers: [{
                        name: `text/${folder}`,
                        extensions: [`.${folder}`],
                        ...(revision !== undefined && { revision }),
                    }],
                },
            }, { defaultHandlerRevision: false });
            await assert.rejects(
                () => discover({ packageDirs: [dir], includeTreeSitter: false }),
                (error: Error) => error.name === "MimetypeExtensionError" && /revision/.test(error.message),
            );
        }
    });

    it("{§mimetype-discovery} rejects the whole declaration when a handler entry is not an object", async () => {
        const dir = await makePackage(tmpRoot, "pkg-entry-junk", {
            name: "@plurnk/plurnk-mimetypes-test",
            plurnk: {
                kind: "mimetype",
                handlers: [
                    null,
                    "not-an-object",
                    42,
                    { name: "text/valid", extensions: [".z"] },
                ],
            },
        });
        await assert.rejects(
            () => discover({ packageDirs: [dir], includeTreeSitter: false }),
            (error: Error) => error.name === "MimetypeExtensionError" && /entry 0.*object/.test(error.message),
        );
    });

    it("{§mimetype-discovery} skips directories without a package.json", async () => {
        const dir = path.join(tmpRoot, "pkg-empty-dir");
        await fs.mkdir(dir, { recursive: true });
        const result = await discover({ packageDirs: [dir], includeTreeSitter: false });
        assert.equal(result.handlers.size, 0);
    });

    it("{§mimetype-discovery} skips packages with malformed JSON", async () => {
        const dir = path.join(tmpRoot, "pkg-bad-json");
        await fs.mkdir(dir, { recursive: true });
        await fs.writeFile(path.join(dir, "package.json"), "{ not valid json");
        const result = await discover({ packageDirs: [dir], includeTreeSitter: false });
        assert.equal(result.handlers.size, 0);
    });

    it("{§mimetype-discovery} rejects non-string extension entries within a handler", async () => {
        const dir = await makePackage(tmpRoot, "pkg-mixed-ext", {
            name: "@plurnk/plurnk-mimetypes-mixed",
            plurnk: {
                kind: "mimetype",
                handlers: [
                    { name: "text/mixed", extensions: [".js", 42, null, ".ts", ""] },
                ],
            },
        });
        await assert.rejects(
            () => discover({ packageDirs: [dir], includeTreeSitter: false }),
            (error: Error) => error.name === "MimetypeExtensionError" && /extensions/.test(error.message),
        );
    });

    it("{§mimetype-discovery} rejects an unsafe package name on a @plurnk/* mimetype declaration", async () => {
        const dir = await makePackage(tmpRoot, "pkg-invalid-name", {
            name: "@plurnk/../not-a-package",
            plurnk: {
                kind: "mimetype",
                handlers: [{ name: "text/invalid", extensions: [".invalid"] }],
            },
        });
        await assert.rejects(
            () => discover({ packageDirs: [dir], includeTreeSitter: false }),
            (error: Error) => error.name === "MimetypeExtensionError" && /package name/.test(error.message),
        );
    });

    it("{§mimetype-discovery} last-loaded wins on conflicting mimetype across packages", async () => {
        const dirA = await makePackage(tmpRoot, "pkg-conflict-a", {
            name: "@plurnk/plurnk-mimetypes-conflict-a",
            plurnk: {
                kind: "mimetype",
                handlers: [{ name: "text/conflict", glyph: "A", extensions: [".c"] }],
            },
        });
        const dirB = await makePackage(tmpRoot, "pkg-conflict-b", {
            name: "@plurnk/plurnk-mimetypes-conflict-b",
            plurnk: {
                kind: "mimetype",
                handlers: [{ name: "text/conflict", glyph: "B", extensions: [".c"] }],
            },
        });
        const result = await discover({ packageDirs: [dirA, dirB], includeTreeSitter: false });
        assert.equal(result.handlers.size, 1);
        const info = result.handlers.get("text/conflict");
        assert.equal(info?.glyph, "B");
    });

    it("{§mimetype-discovery} attributes only packages represented by a surviving handler", async () => {
        const dirA = await makePackage(tmpRoot, "pkg-attribution-conflict-a", {
            name: "@plurnk/mime-a",
            plurnk: {
                kind: "mimetype",
                attribution: "plurnk-a",
                handlers: [{ name: "text/attribution-conflict", extensions: [".credit"] }],
            },
        });
        const dirB = await makePackage(tmpRoot, "pkg-attribution-conflict-b", {
            name: "@plurnk/mime-b",
            plurnk: {
                kind: "mimetype",
                attribution: "plurnk-b",
                handlers: [{ name: "text/attribution-conflict", extensions: [".credit"] }],
            },
        });
        const result = await discover({ packageDirs: [dirA, dirB], includeTreeSitter: false });
        assert.deepEqual([...result.packageAttributions], [["@plurnk/mime-b", ["plurnk-b"]]]);
    });

    it("{§mimetype-discovery} defaults glyph to empty string when not declared in a handler entry", async () => {
        const dir = await makePackage(tmpRoot, "pkg-noglyph", {
            name: "@plurnk/plurnk-mimetypes-noglyph",
            plurnk: {
                kind: "mimetype",
                handlers: [{ name: "text/noglyph", extensions: [".n"] }],
            },
        });
        const result = await discover({ packageDirs: [dir], includeTreeSitter: false });
        const info = result.handlers.get("text/noglyph");
        assert.equal(info?.glyph, "");
    });

    it("{§mimetype-discovery} registers each entry in a multi-handler array as its own HandlerInfo", async () => {
        const dir = await makePackage(tmpRoot, "pkg-multi", {
            name: "@plurnk/plurnk-mimetypes-application-json",
            plurnk: {
                kind: "mimetype",
                handlers: [
                    { name: "application/json", glyph: "📋", extensions: [".json"] },
                    { name: "application/jsonc", glyph: "📋", extensions: [".jsonc"] },
                ],
            },
        });
        const result = await discover({ packageDirs: [dir], includeTreeSitter: false });
        assert.equal(result.handlers.size, 2);
        const json = result.handlers.get("application/json");
        const jsonc = result.handlers.get("application/jsonc");
        assert.ok(json && jsonc);
        // Each entry carries its own identity.
        assert.equal(json.mimetype, "application/json");
        assert.equal(jsonc.mimetype, "application/jsonc");
        // Both reference the same package (shared instantiation source).
        assert.equal(json.packageName, jsonc.packageName);
        // Routing: each extension maps to its own mimetype (not collapsed).
        assert.equal(result.registry.byExtension.get(".json"), "application/json");
        assert.equal(result.registry.byExtension.get(".jsonc"), "application/jsonc");
    });

    it("{§mimetype-discovery} default cwd scan finds packages under node_modules/@plurnk/", async () => {
        const sandbox = await fs.mkdtemp(path.join(os.tmpdir(), "plurnk-sandbox-"));
        try {
            await makePackage(path.join(sandbox, "node_modules", "@plurnk"), "plurnk-mimetypes-text-plain", {
                name: "@plurnk/plurnk-mimetypes-text-plain",
                plurnk: {
                    kind: "mimetype",
                    handlers: [{ name: "text/plain", glyph: "📄", extensions: [".txt"] }],
                },
            });
            const result = await discover({ cwd: sandbox, includeTreeSitter: false });
            assert.equal(result.handlers.size, 1);
            assert.ok(result.handlers.has("text/plain"));
            assert.equal(result.registry.byExtension.get(".txt"), "text/plain");
        } finally {
            await fs.rm(sandbox, { recursive: true, force: true });
        }
    });
});

describe("{§mimetype-discovery} first-party @plurnk/* scan and loader", () => {
    it("{§mimetype-discovery} admits @plurnk/* mimetype handlers and ignores third-party, unscoped, and non-mimetype packages", async () => {
        const root = await fs.mkdtemp(path.join(os.tmpdir(), "plurnk-scan-"));
        try {
            const nm = path.join(root, "node_modules");
            await makePackage(nm, "@plurnk/plurnk-mimetypes-text-plain", {
                name: "@plurnk/plurnk-mimetypes-text-plain",
                plurnk: { kind: "mimetype", handlers: [{ name: "text/plain", extensions: [".txt"] }] },
            });
            await makePackage(nm, "@acme/acme-mime-cobol", {
                name: "@acme/acme-mime-cobol",
                plurnk: { kind: "mimetype", handlers: [{ name: "text/x-cobol", extensions: [".cob"] }] },
            });
            await makePackage(nm, "mime-fortran", {
                name: "mime-fortran",
                plurnk: { kind: "mimetype", handlers: [{ name: "text/x-fortran", extensions: [".f90"] }] },
            });
            await makePackage(nm, "@acme/broken-handler", {
                name: "@acme/broken-handler",
                plurnk: { kind: "mimetype", handlers: "not-an-array" },
            });
            await makePackage(nm, "@plurnk/plurnk-providers-openai", {
                name: "@plurnk/plurnk-providers-openai", plurnk: { kind: "provider", name: "openai" },
            });
            await makePackage(nm, "left-pad", { name: "left-pad" });

            const result = await discover({ cwd: root, includeTreeSitter: false });
            assert.deepEqual([...result.handlers.keys()], ["text/plain"]);
        } finally {
            await fs.rm(root, { recursive: true, force: true });
        }
    });

    it("{§mimetype-discovery} loads a discovered @plurnk/* handler from the consumer-visible module graph (#85)", async () => {
        const root = await fs.mkdtemp(path.join(os.tmpdir(), "plurnk-consumer-loader-"));
        try {
            const dir = await makePackage(root, "node_modules/@plurnk/plurnk-mimetypes-cobol", {
                name: "@plurnk/plurnk-mimetypes-cobol",
                type: "module",
                exports: "./index.js",
                plurnk: {
                    kind: "mimetype",
                    handlers: [{ name: "text/x-cobol", extensions: [".cob"] }],
                },
            });
            await fs.writeFile(path.join(dir, "index.js"), THIRD_PARTY_HANDLER_SOURCE);

            const mimetypes = new Mimetypes({
                discoverOptions: { cwd: root, includeTreeSitter: false },
            });
            const result = await mimetypes.process(
                { content: "IDENTIFICATION DIVISION.", ext: ".cob" },
                { channels: ["symbols"] },
            );

            assert.equal(result.ok, true);
            assert.equal(result.mimetype, "text/x-cobol");
            assert.deepEqual(result.symbols, []);
            assert.match(
                await mimetypes.projectionIdentity("text/x-cobol"),
                /^[a-f0-9]{64}$/u,
            );
        } finally {
            await fs.rm(root, { recursive: true, force: true });
        }
    });

    it("{§mimetype-discovery} makes import-only package roots an explicit-loader contract (#156)", async () => {
        const root = await fs.mkdtemp(path.join(os.tmpdir(), "plurnk-import-only-loader-"));
        try {
            const dir = await makePackage(root, "node_modules/@plurnk/plurnk-mimetypes-cobol", {
                name: "@plurnk/plurnk-mimetypes-cobol",
                type: "module",
                exports: { import: "./index.js" },
                plurnk: {
                    kind: "mimetype",
                    handlers: [{ name: "text/x-cobol", extensions: [".cob"] }],
                },
            });
            await fs.writeFile(path.join(dir, "index.js"), THIRD_PARTY_HANDLER_SOURCE);

            const automatic = new Mimetypes({
                discoverOptions: { cwd: root, includeTreeSitter: false },
            });
            await assert.rejects(
                () => automatic.getHandler("text/x-cobol"),
                (error: unknown) => {
                    assert.ok(error instanceof MimetypeExtensionError);
                    assert.equal(error.packageName, "@plurnk/plurnk-mimetypes-cobol");
                    assert.equal(error.mimetype, "text/x-cobol");
                    assert.equal((error.cause as NodeJS.ErrnoException).code, "ERR_PACKAGE_PATH_NOT_EXPORTED");
                    return true;
                },
            );

            const explicit = new Mimetypes({
                discoverOptions: { cwd: root, includeTreeSitter: false },
                loader: async (packageName) => {
                    assert.equal(packageName, "@plurnk/plurnk-mimetypes-cobol");
                    return import(pathToFileURL(path.join(dir, "index.js")).href);
                },
            });
            const handler = await explicit.getHandler("text/x-cobol");
            assert.equal(handler?.mimetype, "text/x-cobol");
        } finally {
            await fs.rm(root, { recursive: true, force: true });
        }
    });
});
}

// ─── discover.attribution.test.ts ───
{
async function makePackage(
    root: string,
    folder: string,
    pkg: Record<string, unknown>,
): Promise<string> {
    const dir = path.join(root, folder);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, "package.json"), JSON.stringify(pkg, null, 2));
    return dir;
}

describe("{§extension-discovery} discover attribution", () => {
    let tmpRoot: string;

    before(async () => {
        tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "plurnk-attribution-"));
    });

    after(async () => {
        await fs.rm(tmpRoot, { recursive: true, force: true });
    });

    it("{§mimetype-discovery} a single-string attribution becomes one canonical package fact", async () => {
        const dir = await makePackage(tmpRoot, "c1", {
            name: "@plurnk/mime-foo",
            plurnk: {
                kind: "mimetype",
                attribution: "plurnk-foo",
                handlers: [{ name: "application/x-foo", revision: "test-1", glyph: "🅰", extensions: [".foo"] }],
            },
        });
        const { handlers, packageAttributions } = await discover({ packageDirs: [dir], includeTreeSitter: false });
        assert.equal("attribution" in handlers.get("application/x-foo")!, false, "the handler descriptor carries identity only");
        assert.deepEqual(packageAttributions.get("@plurnk/mime-foo"), ["plurnk-foo"]);
    });

    it("{§mimetype-discovery} a multi-handler package contributes one canonical attribution fact", async () => {
        const dir = await makePackage(tmpRoot, "c2", {
            name: "@plurnk/mime-multi",
            plurnk: {
                kind: "mimetype",
                attribution: ["plurnk", "plurnk-pro"],
                handlers: [
                    { name: "application/x-a", revision: "test-1", glyph: "A", extensions: [".a"] },
                    { name: "application/x-b", revision: "test-1", glyph: "B", extensions: [".b"] },
                ],
            },
        });
        const { handlers, packageAttributions } = await discover({ packageDirs: [dir], includeTreeSitter: false });
        assert.deepEqual([...handlers.keys()].toSorted(), ["application/x-a", "application/x-b"]);
        assert.deepEqual([...packageAttributions], [["@plurnk/mime-multi", ["plurnk", "plurnk-pro"]]]);
    });

    it("{§mimetype-discovery} an absent attribution produces no package fact", async () => {
        const dir = await makePackage(tmpRoot, "c3", {
            name: "@plurnk/mime-bare",
            plurnk: {
                kind: "mimetype",
                handlers: [{ name: "application/x-bare", revision: "test-1", glyph: "·", extensions: [".bare"] }],
            },
        });
        const { handlers, packageAttributions } = await discover({ packageDirs: [dir], includeTreeSitter: false });
        assert.ok(handlers.get("application/x-bare"));
        assert.equal(packageAttributions.size, 0);
    });

    it("{§mimetype-discovery} a malformed first-party attribution fails whole-package admission", async () => {
        const cases: Array<[string, unknown]> = [["empty-string", ""], ["number", 7], ["object", { tag: "x" }], ["mixed", ["keep", 1]]];
        for (const [folder, value] of cases) {
            const dir = await makePackage(tmpRoot, `c4-${folder}`, {
                name: `@plurnk/mime-${folder}`,
                plurnk: {
                    kind: "mimetype",
                    attribution: value,
                    handlers: [{ name: `application/x-${folder}`, revision: "test-1", glyph: "?", extensions: [`.${folder}`] }],
                },
            });
            await assert.rejects(
                discover({ packageDirs: [dir], includeTreeSitter: false }),
                /plurnk\.attribution must be a non-empty string or string\[\]/,
                folder,
            );
        }
    });

    it("{§mimetype-discovery} a non-@plurnk/* package with malformed attribution is ignored without validation", async () => {
        const dir = await makePackage(tmpRoot, "untrusted-invalid", {
            name: "@acme/acme-mime-untrusted",
            plurnk: {
                kind: "mimetype",
                attribution: ["keep", 1],
                handlers: [{ name: "application/x-untrusted", revision: "test-1", extensions: [".untrusted"] }],
            },
        });
        const result = await discover({
            packageDirs: [dir],
            includeTreeSitter: false,
        });
        assert.equal(result.handlers.size, 0);
        assert.equal(result.packageAttributions.size, 0);
    });

    it("{§mimetype-discovery} tree-sitter built-ins carry no package attribution", async () => {
        const { handlers, packageAttributions } = await discover({ packageDirs: [] });
        const treesitter = [...handlers.values()].find((h) => h.source === "treesitter");
        assert.ok(treesitter, "expected at least one tree-sitter handler");
        assert.equal(packageAttributions.size, 0);
    });
});
}

// ─── attributions.test.ts ───
{
// {§extension-discovery}

const context = (attempt: number): ExtensionAttributionContext => ({
    workspaceId: "workspace",
    sessionId: "session",
    loop: 1,
    turn: 2,
    attempt,
});

const info: HandlerInfo = {
    mimetype: "text/x-attribution-test",
    glyph: "",
    packageName: "@plurnk/mimetype-attribution-test",
    projectionRevision: "1",
    extensions: [".attr"],
    binary: false,
    source: "package",
};

const discovery: Discovery = {
    registry: {
        byExtension: new Map([[".attr", info.mimetype]]),
        byFilename: new Map(),
    },
    handlers: new Map([[info.mimetype, info]]),
    packageAttributions: new Map([[info.packageName, ["static:mimetype"]]]),
};

class AttributingHandler extends BaseHandler {
    attributions({ attempt }: ExtensionAttributionContext): string[] {
        return attempt === 2 ? ["runtime:mimetype", "static:mimetype"] : [];
    }
}

test("{§extension-discovery} Mimetypes composes static tags with hooks from already-loaded handlers only", async () => {
    const mimetypes = new Mimetypes({
        discovery,
        loader: async () => ({ default: AttributingHandler }),
    });

    assert.deepEqual(
        await mimetypes.attributions(context(1)),
        ["static:mimetype"],
        "collecting telemetry does not force the lazy handler to load",
    );

    await mimetypes.getHandler(info.mimetype);
    assert.deepEqual(
        await mimetypes.attributions(context(2)),
        ["runtime:mimetype", "static:mimetype"],
        "a loaded handler controls its attempt-time tags and the host canonicalizes the union",
    );
});
}

// ─── projectionIdentity.test.ts ───
{
// Contract: {§mimetype-lifecycle}. Issue #175 is provenance.








let configuration = "configuration-a";

class ConfigurableHandler extends BaseHandler {
    override projectionConfiguration(): string {
        return configuration;
    }
}

const info = (
    packageName: string,
    projectionRevision: string,
): HandlerInfo => ({
    mimetype: "text/x-community",
    glyph: "🧩",
    packageName,
    extensions: [".community"],
    binary: false,
    source: "package",
    projectionRevision,
});

type HandlerConstructor = new (metadata: HandlerMetadata) => BaseHandler;

const mimetypes = (
    handlerInfo: HandlerInfo,
    Handler: HandlerConstructor = ConfigurableHandler,
): Mimetypes => {
    const registry: Registry = {
        byExtension: new Map([[".community", handlerInfo.mimetype]]),
        byFilename: new Map(),
    };
    const discovery: Discovery = {
        registry,
        handlers: new Map([[handlerInfo.mimetype, handlerInfo]]),
        packageAttributions: new Map(),
    };
    return new Mimetypes({
        discovery,
        loader: async () => ({ default: Handler }),
    });
};

describe("{§mimetype-lifecycle} mimetype projection identity", () => {
    it("{§mimetype-lifecycle} is stable for identical behavior and changes with live configuration", async () => {
        configuration = "configuration-a";
        const service = mimetypes(info("@plurnk/cobol", "reader-1"));

        const first = await service.projectionIdentity("text/x-community");
        assert.match(first, /^[a-f0-9]{64}$/u);
        assert.equal(await service.projectionIdentity("text/x-community"), first);

        configuration = "configuration-b";
        assert.notEqual(await service.projectionIdentity("text/x-community"), first);
    });

    it("{§mimetype-lifecycle} keeps package ownership and self-declared revision in the identity", async () => {
        configuration = "configuration-a";
        const first = await mimetypes(info("@plurnk/cobol", "reader-1"))
            .projectionIdentity("text/x-community");
        const revised = await mimetypes(info("@plurnk/cobol", "reader-2"))
            .projectionIdentity("text/x-community");
        const independent = await mimetypes(info("@plurnk/other-cobol", "reader-1"))
            .projectionIdentity("text/x-community");

        assert.notEqual(revised, first);
        assert.notEqual(independent, first);
    });

    it("{§mimetype-lifecycle} fails a non-string handler configuration at the extension boundary", async () => {
        class InvalidConfigurationHandler extends BaseHandler {
            override projectionConfiguration(): never {
                return 42 as never;
            }
        }
        const service = mimetypes(
            info("@plurnk/invalid", "reader-1"),
            InvalidConfigurationHandler,
        );

        await assert.rejects(
            () => service.projectionIdentity("text/x-community"),
            (error: unknown) => {
                assert.ok(error instanceof MimetypeExtensionError);
                assert.match(error.message, /projectionConfiguration\(\) must return a string/u);
                assert.ok(error.cause instanceof TypeError);
                return true;
            },
        );
    });

    it("{§mimetype-lifecycle} identifies an unregistered projection without loading extension code", async () => {
        let loads = 0;
        const service = new Mimetypes({
            discovery: {
                registry: { byExtension: new Map(), byFilename: new Map() },
                handlers: new Map(),
                packageAttributions: new Map(),
            },
            loader: async () => {
                loads++;
                return { default: ConfigurableHandler };
            },
        });

        const first = await service.projectionIdentity("text/x-unregistered");
        assert.equal(await service.projectionIdentity("text/x-unregistered"), first);
        assert.equal(loads, 0);
    });

    it("{§mimetype-lifecycle} includes the installed Tree-sitter grammar artifact", async () => {
        const service = new Mimetypes({
            discovery: await discover({ packageDirs: [] }),
        });

        const first = await service.projectionIdentity("text/x-python");
        assert.match(first, /^[a-f0-9]{64}$/u);
        assert.equal(await service.projectionIdentity("text/x-python"), first);
    });
});
}
