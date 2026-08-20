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
        "dist/index.js",
        "dist/schemes/cosine.js",
    ]), []);
    assert.deepEqual(packageArtifactViolations("plurnk-core", [
        "dist/core/world-state.js",
        "dist/core/world-state.sql",
        "dist/core/zero-pin.d.ts",
        "dist/schemes/cosine.js",
    ]), [
        "plurnk-core: required runtime artifact is absent: dist/core/content_weight.js",
        "plurnk-core: test-only artifact leaked into package: dist/core/world-state.js",
        "plurnk-core: test-only artifact leaked into package: dist/core/world-state.sql",
        "plurnk-core: test-only artifact leaked into package: dist/core/zero-pin.d.ts",
    ]);
});

test("PDF package projection rejects fixture builders", () => {
    assert.deepEqual(packageArtifactViolations("plurnk-mimetypes-application-pdf", [
        "dist/buildFormPdf.js",
        "dist/buildTaggedPdf.d.ts",
        "dist/index.js",
    ]), [
        "plurnk-mimetypes-application-pdf: test-only artifact leaked into package: dist/buildFormPdf.js",
        "plurnk-mimetypes-application-pdf: test-only artifact leaked into package: dist/buildTaggedPdf.d.ts",
    ]);
});
