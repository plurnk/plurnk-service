import assert from "node:assert/strict";
import test from "node:test";
import { DEV_CONDITION, projectManifest } from "./package-projection.mjs";

const files = ["package.json", "dist/index.js", "dist/index.d.ts", "dist/Materializer.js", "dist/Materializer.d.ts", "README.md"];

test("#797: the published manifest carries no plurnk-dev condition, and everything else it declares is shipped", () => {
    const { manifest, violations } = projectManifest({
        name: "@plurnk/example",
        exports: {
            ".": { [DEV_CONDITION]: "./src/index.ts", types: "./dist/index.d.ts", default: "./dist/index.js" },
            "./materializer": { [DEV_CONDITION]: "./src/Materializer.ts", types: "./dist/Materializer.d.ts", default: "./dist/Materializer.js" },
            "./package.json": "./package.json",
        },
    }, files);
    assert.deepEqual(violations, []);
    assert.deepEqual(manifest.exports, {
        ".": { types: "./dist/index.d.ts", default: "./dist/index.js" },
        "./materializer": { types: "./dist/Materializer.d.ts", default: "./dist/Materializer.js" },
        "./package.json": "./package.json",
    });
    assert.equal(JSON.stringify(manifest).includes(DEV_CONDITION), false);
});

test("#797: a condition aimed outside the tarball is a violation that names the export and the file", () => {
    const { violations } = projectManifest({
        name: "@plurnk/example",
        exports: {
            ".": { types: "./dist/index.d.ts", default: "./dist/missing.js" },
            "./docs": "./docs/guide.md",
        },
    }, files);
    assert.deepEqual(violations, [
        'exports["."].default -> ./dist/missing.js: the tarball does not ship it',
        'exports["./docs"] -> ./docs/guide.md: the tarball does not ship it',
    ]);
});

test("#797: a subpath pattern ships when a packed file matches it", () => {
    const docs = { name: "@plurnk/docs", exports: { "./docs/*.md": "./docs/*.md", "./skills/*": "./skills/*" } };
    assert.deepEqual(projectManifest(docs, [...files, "docs/guide.md", "skills/plurnk/SKILL.md"]).violations, []);
    assert.deepEqual(projectManifest(docs, files).violations, [
        'exports["./docs/*.md"] -> ./docs/*.md: the tarball does not ship it',
        'exports["./skills/*"] -> ./skills/*: the tarball does not ship it',
    ]);
});

test("#797: a manifest without the condition, or without exports, is returned unchanged", () => {
    const plain = { name: "@plurnk/plain", exports: { ".": { types: "./dist/index.d.ts", default: "./dist/index.js" } } };
    assert.deepEqual(projectManifest(plain, files), { manifest: plain, violations: [] });
    const bare = { name: "@plurnk/bare", main: "./dist/index.js" };
    assert.deepEqual(projectManifest(bare, files), { manifest: bare, violations: [] });
    assert.deepEqual(projectManifest({ name: "@plurnk/string", exports: "./dist/index.js" }, files).manifest.exports, "./dist/index.js");
});
