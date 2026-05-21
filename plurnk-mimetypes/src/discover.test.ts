import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { discover } from "./discover.ts";

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

describe("discover", () => {
    let tmpRoot: string;

    before(async () => {
        tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "plurnk-mimetypes-test-"));
    });

    after(async () => {
        await fs.rm(tmpRoot, { recursive: true, force: true });
    });

    it("returns empty registry and handlers when no packages found", async () => {
        const result = await discover({ packageDirs: [] });
        assert.equal(result.handlers.size, 0);
        assert.equal(result.registry.byExtension.size, 0);
        assert.equal(result.registry.byFilename.size, 0);
    });

    it("returns empty when default cwd has no node_modules/@plurnk", async () => {
        const empty = await fs.mkdtemp(path.join(os.tmpdir(), "plurnk-empty-"));
        try {
            const result = await discover({ cwd: empty });
            assert.equal(result.handlers.size, 0);
        } finally {
            await fs.rm(empty, { recursive: true, force: true });
        }
    });

    it("registers a valid handler's mimetype and extensions", async () => {
        const dir = await makePackage(tmpRoot, "pkg-py", {
            name: "@plurnk/plurnk-mimetypes-text-x-python",
            plurnk: {
                kind: "mimetype",
                name: "text/x-python",
                glyph: "🐍",
                extensions: [".py", ".pyw"],
            },
        });
        const result = await discover({ packageDirs: [dir] });
        assert.equal(result.handlers.size, 1);
        const info = result.handlers.get("text/x-python");
        assert.ok(info);
        assert.equal(info.glyph, "🐍");
        assert.equal(info.packageName, "@plurnk/plurnk-mimetypes-text-x-python");
        assert.deepEqual([...info.extensions], [".py", ".pyw"]);
        assert.equal(result.registry.byExtension.get(".py"), "text/x-python");
        assert.equal(result.registry.byExtension.get(".pyw"), "text/x-python");
    });

    it("splits dotted extensions into byExtension and bare entries into byFilename", async () => {
        const dir = await makePackage(tmpRoot, "pkg-dockerfile", {
            name: "@plurnk/plurnk-mimetypes-text-x-dockerfile",
            plurnk: {
                kind: "mimetype",
                name: "text/x-dockerfile",
                glyph: "🐳",
                extensions: [".dockerfile", "Dockerfile", "Containerfile"],
            },
        });
        const result = await discover({ packageDirs: [dir] });
        assert.equal(result.registry.byExtension.get(".dockerfile"), "text/x-dockerfile");
        assert.equal(result.registry.byFilename.get("Dockerfile"), "text/x-dockerfile");
        assert.equal(result.registry.byFilename.get("Containerfile"), "text/x-dockerfile");
        assert.equal(result.registry.byExtension.size, 1);
        assert.equal(result.registry.byFilename.size, 2);
    });

    it("normalizes extension case to lowercase in byExtension", async () => {
        const dir = await makePackage(tmpRoot, "pkg-cased", {
            name: "@plurnk/plurnk-mimetypes-cased",
            plurnk: {
                kind: "mimetype",
                name: "text/cased",
                extensions: [".CAPS"],
            },
        });
        const result = await discover({ packageDirs: [dir] });
        assert.equal(result.registry.byExtension.get(".caps"), "text/cased");
    });

    it("preserves filename case (Dockerfile stays Dockerfile)", async () => {
        const dir = await makePackage(tmpRoot, "pkg-filename-case", {
            name: "@plurnk/plurnk-mimetypes-filename",
            plurnk: {
                kind: "mimetype",
                name: "text/x-makefile",
                extensions: ["Makefile"],
            },
        });
        const result = await discover({ packageDirs: [dir] });
        assert.equal(result.registry.byFilename.get("Makefile"), "text/x-makefile");
        assert.equal(result.registry.byFilename.get("makefile"), undefined);
    });

    it("skips packages missing plurnk metadata", async () => {
        const dir = await makePackage(tmpRoot, "pkg-noplurnk", {
            name: "@plurnk/plurnk-mimetypes-unrelated",
        });
        const result = await discover({ packageDirs: [dir] });
        assert.equal(result.handlers.size, 0);
    });

    it("skips packages with non-mimetype kind", async () => {
        const dir = await makePackage(tmpRoot, "pkg-provider", {
            name: "@plurnk/plurnk-providers-openai",
            plurnk: { kind: "provider", name: "openai" },
        });
        const result = await discover({ packageDirs: [dir] });
        assert.equal(result.handlers.size, 0);
    });

    it("skips packages with missing or empty plurnk.name", async () => {
        const dirA = await makePackage(tmpRoot, "pkg-noname", {
            name: "@plurnk/plurnk-mimetypes-noname",
            plurnk: { kind: "mimetype", extensions: [".x"] },
        });
        const dirB = await makePackage(tmpRoot, "pkg-emptyname", {
            name: "@plurnk/plurnk-mimetypes-emptyname",
            plurnk: { kind: "mimetype", name: "", extensions: [".y"] },
        });
        const result = await discover({ packageDirs: [dirA, dirB] });
        assert.equal(result.handlers.size, 0);
    });

    it("skips directories without a package.json", async () => {
        const dir = path.join(tmpRoot, "pkg-empty-dir");
        await fs.mkdir(dir, { recursive: true });
        const result = await discover({ packageDirs: [dir] });
        assert.equal(result.handlers.size, 0);
    });

    it("skips packages with malformed JSON", async () => {
        const dir = path.join(tmpRoot, "pkg-bad-json");
        await fs.mkdir(dir, { recursive: true });
        await fs.writeFile(path.join(dir, "package.json"), "{ not valid json");
        const result = await discover({ packageDirs: [dir] });
        assert.equal(result.handlers.size, 0);
    });

    it("filters non-string extension entries", async () => {
        const dir = await makePackage(tmpRoot, "pkg-mixed-ext", {
            name: "@plurnk/plurnk-mimetypes-mixed",
            plurnk: {
                kind: "mimetype",
                name: "text/mixed",
                extensions: [".js", 42, null, ".ts", ""],
            },
        });
        const result = await discover({ packageDirs: [dir] });
        const info = result.handlers.get("text/mixed");
        assert.ok(info);
        assert.deepEqual([...info.extensions], [".js", ".ts"]);
    });

    it("last-loaded wins on conflicting mimetype", async () => {
        const dirA = await makePackage(tmpRoot, "pkg-conflict-a", {
            name: "@plurnk/plurnk-mimetypes-conflict-a",
            plurnk: { kind: "mimetype", name: "text/conflict", glyph: "A", extensions: [".c"] },
        });
        const dirB = await makePackage(tmpRoot, "pkg-conflict-b", {
            name: "@plurnk/plurnk-mimetypes-conflict-b",
            plurnk: { kind: "mimetype", name: "text/conflict", glyph: "B", extensions: [".c"] },
        });
        const result = await discover({ packageDirs: [dirA, dirB] });
        assert.equal(result.handlers.size, 1);
        const info = result.handlers.get("text/conflict");
        assert.equal(info?.glyph, "B");
    });

    it("defaults glyph to empty string when not declared", async () => {
        const dir = await makePackage(tmpRoot, "pkg-noglyph", {
            name: "@plurnk/plurnk-mimetypes-noglyph",
            plurnk: { kind: "mimetype", name: "text/noglyph", extensions: [".n"] },
        });
        const result = await discover({ packageDirs: [dir] });
        const info = result.handlers.get("text/noglyph");
        assert.equal(info?.glyph, "");
    });

    // --- canonical `handlers: HandlerDecl[]` shape (SPEC §2) ---

    it("reads a single handler declared via the canonical `handlers` array", async () => {
        const dir = await makePackage(tmpRoot, "pkg-handlers-single", {
            name: "@plurnk/plurnk-mimetypes-text-plain",
            plurnk: {
                kind: "mimetype",
                handlers: [
                    { name: "text/plain", glyph: "📄", extensions: [".txt"] },
                ],
            },
        });
        const result = await discover({ packageDirs: [dir] });
        const info = result.handlers.get("text/plain");
        assert.ok(info);
        assert.equal(info.glyph, "📄");
        assert.deepEqual([...info.extensions], [".txt"]);
        assert.equal(result.registry.byExtension.get(".txt"), "text/plain");
    });

    it("registers each entry in a multi-handler `handlers` array as its own HandlerInfo", async () => {
        const dir = await makePackage(tmpRoot, "pkg-handlers-multi", {
            name: "@plurnk/plurnk-mimetypes-application-json",
            plurnk: {
                kind: "mimetype",
                handlers: [
                    { name: "application/json", glyph: "📋", extensions: [".json"] },
                    { name: "application/jsonc", glyph: "📋", extensions: [".jsonc"] },
                ],
            },
        });
        const result = await discover({ packageDirs: [dir] });
        assert.equal(result.handlers.size, 2);
        const json = result.handlers.get("application/json");
        const jsonc = result.handlers.get("application/jsonc");
        assert.ok(json && jsonc);
        // Each entry carries its own identity.
        assert.equal(json.mimetype, "application/json");
        assert.equal(jsonc.mimetype, "application/jsonc");
        // Both reference the same package (shared instantiation source).
        assert.equal(json.packageName, jsonc.packageName);
        // Routing: each extension maps to its own mimetype (matched-name, not collapsed).
        assert.equal(result.registry.byExtension.get(".json"), "application/json");
        assert.equal(result.registry.byExtension.get(".jsonc"), "application/jsonc");
    });

    it("skips malformed handler entries without breaking other entries", async () => {
        const dir = await makePackage(tmpRoot, "pkg-handlers-malformed", {
            name: "@plurnk/plurnk-mimetypes-test",
            plurnk: {
                kind: "mimetype",
                handlers: [
                    { name: "" },                       // empty name — skipped
                    { extensions: [".x"] },             // missing name — skipped
                    null,                                // not an object — skipped
                    "not-an-object",                     // not an object — skipped
                    { name: "application/json", extensions: [".json"] },  // valid
                    { name: "application/jsonc", extensions: [".jsonc"] }, // valid
                ],
            },
        });
        const result = await discover({ packageDirs: [dir] });
        assert.equal(result.handlers.size, 2);
        assert.ok(result.handlers.has("application/json"));
        assert.ok(result.handlers.has("application/jsonc"));
    });

    it("returns empty when `handlers` is present but contains no valid entries", async () => {
        const dir = await makePackage(tmpRoot, "pkg-handlers-empty", {
            name: "@plurnk/plurnk-mimetypes-test",
            plurnk: {
                kind: "mimetype",
                handlers: [null, "string", { name: "" }],
            },
        });
        const result = await discover({ packageDirs: [dir] });
        assert.equal(result.handlers.size, 0);
    });

    it("`handlers` array takes precedence over legacy flat fields when both are present", async () => {
        const dir = await makePackage(tmpRoot, "pkg-handlers-precedence", {
            name: "@plurnk/plurnk-mimetypes-test",
            plurnk: {
                kind: "mimetype",
                // Legacy fields say one thing...
                name: "text/legacy",
                extensions: [".legacy"],
                // ...handlers array says another. Handlers wins.
                handlers: [
                    { name: "text/canonical", extensions: [".canonical"] },
                ],
            },
        });
        const result = await discover({ packageDirs: [dir] });
        assert.equal(result.handlers.size, 1);
        assert.ok(result.handlers.has("text/canonical"));
        assert.ok(!result.handlers.has("text/legacy"));
    });

    it("default cwd scan finds packages under node_modules/@plurnk/", async () => {
        const sandbox = await fs.mkdtemp(path.join(os.tmpdir(), "plurnk-sandbox-"));
        try {
            await makePackage(path.join(sandbox, "node_modules", "@plurnk"), "plurnk-mimetypes-text-plain", {
                name: "@plurnk/plurnk-mimetypes-text-plain",
                plurnk: { kind: "mimetype", name: "text/plain", glyph: "📄", extensions: [".txt"] },
            });
            const result = await discover({ cwd: sandbox });
            assert.equal(result.handlers.size, 1);
            assert.ok(result.handlers.has("text/plain"));
            assert.equal(result.registry.byExtension.get(".txt"), "text/plain");
        } finally {
            await fs.rm(sandbox, { recursive: true, force: true });
        }
    });
});
