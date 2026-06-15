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
        const result = await discover({ packageDirs: [], includeTreeSitter: false });
        assert.equal(result.handlers.size, 0);
        assert.equal(result.registry.byExtension.size, 0);
        assert.equal(result.registry.byFilename.size, 0);
    });

    it("returns empty when default cwd has no node_modules/@plurnk", async () => {
        const empty = await fs.mkdtemp(path.join(os.tmpdir(), "plurnk-empty-"));
        try {
            const result = await discover({ cwd: empty, includeTreeSitter: false });
            assert.equal(result.handlers.size, 0);
        } finally {
            await fs.rm(empty, { recursive: true, force: true });
        }
    });

    it("registers a single-entry handlers array", async () => {
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
        assert.deepEqual([...info.extensions], [".py", ".pyw"]);
        assert.equal(result.registry.byExtension.get(".py"), "text/x-python");
        assert.equal(result.registry.byExtension.get(".pyw"), "text/x-python");
    });

    it("splits dotted extensions into byExtension and bare entries into byFilename", async () => {
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

    it("normalizes extension case to lowercase in byExtension", async () => {
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

    it("preserves filename case (Dockerfile stays Dockerfile)", async () => {
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

    it("skips packages missing plurnk metadata", async () => {
        const dir = await makePackage(tmpRoot, "pkg-noplurnk", {
            name: "@plurnk/plurnk-mimetypes-unrelated",
        });
        const result = await discover({ packageDirs: [dir], includeTreeSitter: false });
        assert.equal(result.handlers.size, 0);
    });

    it("skips packages with non-mimetype kind", async () => {
        const dir = await makePackage(tmpRoot, "pkg-provider", {
            name: "@plurnk/plurnk-providers-openai",
            plurnk: { kind: "provider", name: "openai" },
        });
        const result = await discover({ packageDirs: [dir], includeTreeSitter: false });
        assert.equal(result.handlers.size, 0);
    });

    it("skips packages missing the handlers array entirely", async () => {
        const dir = await makePackage(tmpRoot, "pkg-no-handlers", {
            name: "@plurnk/plurnk-mimetypes-bad",
            plurnk: { kind: "mimetype" },
        });
        const result = await discover({ packageDirs: [dir], includeTreeSitter: false });
        assert.equal(result.handlers.size, 0);
    });

    it("skips packages where handlers is not an array", async () => {
        const dir = await makePackage(tmpRoot, "pkg-handlers-nonarray", {
            name: "@plurnk/plurnk-mimetypes-bad",
            plurnk: { kind: "mimetype", handlers: "not an array" },
        });
        const result = await discover({ packageDirs: [dir], includeTreeSitter: false });
        assert.equal(result.handlers.size, 0);
    });

    it("skips handler entries with missing or empty name", async () => {
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
        const result = await discover({ packageDirs: [dir], includeTreeSitter: false });
        assert.equal(result.handlers.size, 1);
        assert.ok(result.handlers.has("text/valid"));
    });

    it("skips non-object handler entries without breaking valid ones", async () => {
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
        const result = await discover({ packageDirs: [dir], includeTreeSitter: false });
        assert.equal(result.handlers.size, 1);
        assert.ok(result.handlers.has("text/valid"));
    });

    it("skips directories without a package.json", async () => {
        const dir = path.join(tmpRoot, "pkg-empty-dir");
        await fs.mkdir(dir, { recursive: true });
        const result = await discover({ packageDirs: [dir], includeTreeSitter: false });
        assert.equal(result.handlers.size, 0);
    });

    it("skips packages with malformed JSON", async () => {
        const dir = path.join(tmpRoot, "pkg-bad-json");
        await fs.mkdir(dir, { recursive: true });
        await fs.writeFile(path.join(dir, "package.json"), "{ not valid json");
        const result = await discover({ packageDirs: [dir], includeTreeSitter: false });
        assert.equal(result.handlers.size, 0);
    });

    it("filters non-string extension entries within a handler", async () => {
        const dir = await makePackage(tmpRoot, "pkg-mixed-ext", {
            name: "@plurnk/plurnk-mimetypes-mixed",
            plurnk: {
                kind: "mimetype",
                handlers: [
                    { name: "text/mixed", extensions: [".js", 42, null, ".ts", ""] },
                ],
            },
        });
        const result = await discover({ packageDirs: [dir], includeTreeSitter: false });
        const info = result.handlers.get("text/mixed");
        assert.ok(info);
        assert.deepEqual([...info.extensions], [".js", ".ts"]);
    });

    it("last-loaded wins on conflicting mimetype across packages", async () => {
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

    it("defaults glyph to empty string when not declared in a handler entry", async () => {
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

    it("registers each entry in a multi-handler array as its own HandlerInfo", async () => {
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

    it("default cwd scan finds packages under node_modules/@plurnk/", async () => {
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

describe("discover — scope-agnostic scan (issue #28)", () => {
    it("finds mimetype handlers under @plurnk, third-party scopes, AND unscoped; skips non-mimetype", async () => {
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
            // Non-mimetype packages must be ignored.
            await makePackage(nm, "@plurnk/plurnk-providers-openai", {
                name: "@plurnk/plurnk-providers-openai", plurnk: { kind: "provider", name: "openai" },
            });
            await makePackage(nm, "left-pad", { name: "left-pad" });

            const result = await discover({ cwd: root, includeTreeSitter: false });
            assert.deepEqual(
                [...result.handlers.keys()].sort(),
                ["text/plain", "text/x-cobol", "text/x-fortran"],
            );
            assert.equal(result.handlers.get("text/x-cobol")?.packageName, "@acme/acme-mime-cobol");
            assert.equal(result.handlers.get("text/x-fortran")?.packageName, "mime-fortran");
        } finally {
            await fs.rm(root, { recursive: true, force: true });
        }
    });

    it("@plurnk wins a mimetype collision (a third party can't silently shadow the floor)", async () => {
        const root = await fs.mkdtemp(path.join(os.tmpdir(), "plurnk-prec-"));
        try {
            const nm = path.join(root, "node_modules");
            await makePackage(nm, "@acme/acme-mime-html", {
                name: "@acme/acme-mime-html",
                plurnk: { kind: "mimetype", handlers: [{ name: "text/html", extensions: [".html"] }] },
            });
            await makePackage(nm, "@plurnk/plurnk-mimetypes-text-html", {
                name: "@plurnk/plurnk-mimetypes-text-html",
                plurnk: { kind: "mimetype", handlers: [{ name: "text/html", extensions: [".html"] }] },
            });
            const result = await discover({ cwd: root, includeTreeSitter: false });
            assert.equal(
                result.handlers.get("text/html")?.packageName,
                "@plurnk/plurnk-mimetypes-text-html",
                "first-party floor handler wins the collision",
            );
        } finally {
            await fs.rm(root, { recursive: true, force: true });
        }
    });
});
