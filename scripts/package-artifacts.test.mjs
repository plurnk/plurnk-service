import assert from "node:assert/strict";
import test from "node:test";
import { packageArtifactViolations } from "./package-artifacts.mjs";

test("package artifact projection leaves packages without special roots unchanged", () => {
    assert.deepEqual(packageArtifactViolations("plurnk-models", ["dist/index.js"]), []);
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
        "INSTALL.md",
        "dist/index.js",
    ]), []);
    assert.deepEqual(packageArtifactViolations("plurnk-core", [
        "dist/core/world-state.js",
        "dist/core/world-state.sql",
        "dist/core/zero-pin.d.ts",
    ]), [
        "plurnk-core: required runtime artifact is absent: dist/core/content_weight.js",
        "plurnk-core: required runtime artifact is absent: INSTALL.md",
        "plurnk-core: test-only artifact leaked into package: dist/core/world-state.js",
        "plurnk-core: test-only artifact leaked into package: dist/core/world-state.sql",
        "plurnk-core: test-only artifact leaked into package: dist/core/zero-pin.d.ts",
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

test("first-party skill sources are required packed runtime inputs", () => {
    for (const [owner, path] of [["plurnk-meta", "skills/plurnk/SKILL.md"], ["plurnk-providers", "docs/models.md"]]) {
        assert.deepEqual(packageArtifactViolations(owner, [path]), []);
        assert.deepEqual(packageArtifactViolations(owner, []), [`${owner}: required runtime artifact is absent: ${path}`]);
    }
});
