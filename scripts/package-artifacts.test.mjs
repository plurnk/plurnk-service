import assert from "node:assert/strict";
import test from "node:test";
import { packageArtifactViolations } from "./package-artifacts.mjs";

test("{§mimetype-query-assets} packed MIME queries are complete", async () => {
    const { readdir } = await import("node:fs/promises");
    const assets = (await readdir(new URL("../plurnk-mimetypes/queries/", import.meta.url)))
        .filter((name) => name.endsWith(".scm")).map((name) => `queries/${name}`);
    assert.ok(assets.length > 0);
    assert.deepEqual(packageArtifactViolations("plurnk-mimetypes", assets), []);
    for (const asset of assets) assert.deepEqual(
        packageArtifactViolations("plurnk-mimetypes", assets.filter((path) => path !== asset)),
        [`plurnk-mimetypes: required runtime artifact is absent: ${asset}`],
    );
});

test("package artifact projection leaves packages without special roots unchanged", () => {
    assert.deepEqual(packageArtifactViolations("plurnk-aliases", ["dist/index.js"]), []);
});

test("model package projection includes the generated runtime catalogs", () => {
    assert.deepEqual(packageArtifactViolations("plurnk-models", [
        "dist/index.js", "dist/catalog.json", "dist/providers.json",
    ]), []);
    assert.deepEqual(packageArtifactViolations("plurnk-models", ["dist/index.js"]), [
        "plurnk-models: required runtime artifact is absent: dist/catalog.json",
        "plurnk-models: required runtime artifact is absent: dist/providers.json",
    ]);
});

test("MCP package projection retains the runtime watchdog loaded beside client.js", () => {
    assert.deepEqual(packageArtifactViolations("plurnk-mcp", [
        "dist/client.js",
        "dist/mcp-watchdog.mjs",
    ]), []);
    assert.deepEqual(packageArtifactViolations("plurnk-mcp", [
        "dist/client.js",
    ]), [
        "plurnk-mcp: required runtime artifact is absent: dist/mcp-watchdog.mjs",
    ]);
});

test("core package projection retains runtime-loaded modules and rejects test helpers", () => {
    assert.deepEqual(packageArtifactViolations("plurnk-core", [
        "dist/core/content_weight.js",
        "dist/launch/Launch.js",
        "dist/evidence/EvidenceReader.js",
        "dist/evidence/digest.sql",
        "INSTALL.md",
        "plurnk.service",
        "docs/copy-move.md",
        "dist/index.js",
    ]), []);
    assert.deepEqual(packageArtifactViolations("plurnk-core", [
        "dist/core/world-state.js",
        "dist/core/world-state.sql",
        "dist/core/zero-pin.d.ts",
    ]), [
        "plurnk-core: required runtime artifact is absent: dist/core/content_weight.js",
        "plurnk-core: required runtime artifact is absent: dist/launch/Launch.js",
        "plurnk-core: required runtime artifact is absent: dist/evidence/EvidenceReader.js",
        "plurnk-core: required runtime artifact is absent: dist/evidence/digest.sql",
        "plurnk-core: required runtime artifact is absent: INSTALL.md",
        "plurnk-core: required runtime artifact is absent: plurnk.service",
        "plurnk-core: required runtime artifact is absent: docs/copy-move.md",
        "plurnk-core: test-only artifact leaked into package: dist/core/world-state.js",
        "plurnk-core: test-only artifact leaked into package: dist/core/world-state.sql",
        "plurnk-core: test-only artifact leaked into package: dist/core/zero-pin.d.ts",
    ]);
});

test("digest package projection retains its public entrypoint and snapshot statements", () => {
    assert.deepEqual(packageArtifactViolations("plurnk-digest", ["dist/index.js", "dist/share.sql"]), []);
    assert.deepEqual(packageArtifactViolations("plurnk-digest", ["dist/index.js"]), [
        "plurnk-digest: required runtime artifact is absent: dist/share.sql",
    ]);
});

test("PDF package projection rejects the fixture builder", () => {
    assert.deepEqual(packageArtifactViolations("plurnk-mimetypes-application-pdf", [
        "dist/buildPdf.js",
        "dist/buildPdf.d.ts",
        "dist/index.js",
    ]), [
        "plurnk-mimetypes-application-pdf: test-only artifact leaked into package: dist/buildPdf.d.ts",
        "plurnk-mimetypes-application-pdf: test-only artifact leaked into package: dist/buildPdf.js",
    ]);
});

test("first-party teaching sources are required packed runtime inputs", () => {
    for (const [owner, paths] of [
        ["plurnk-meta", ["skills/plurnk/SKILL.md", "skills/plurnk/references/extensibility.md", "docs/worker.md", "docs/pattern.md", "docs/delegation.md"]],
        ["plurnk-skills", ["docs/skills.md"]],
        ["plurnk-providers", ["docs/models.md"]],
    ]) {
        assert.deepEqual(packageArtifactViolations(owner, paths), []);
        for (const path of paths) {
            assert.deepEqual(packageArtifactViolations(owner, paths.filter((candidate) => candidate !== path)), [
                `${owner}: required runtime artifact is absent: ${path}`,
            ]);
        }
    }
});
