// Smoke coverage for the service-owned default mimetype composition
// ({§bundled-set}). The service manifest is the inventory authority; this suite
// asserts every declared handler from those dependencies is discovered, then
// drives representative handlers through the assembled processing path.
//
// Per-handler behavioral tests live in each sibling's repo. This file
// is the plurnk-service-side integration check: "the handler exists,
// the framework finds it, our path through it works."
//
// NOTE: tree-sitter-backed languages (python, typescript, toml, yaml, …) are
// NOT standalone deps — the 0.10.0 framework absorbed them into its internal
// TREE_SITTER_REGISTRY ({§mimetype-backend-selection} Tier 1), so they're covered by
// @plurnk/plurnk-mimetypes' own suite, not here. Only bespoke standalone
// handlers belong to this service-side composition check.

import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { Mimetypes, discover } from "@plurnk/plurnk-mimetypes";

const require = createRequire(import.meta.url);
const serviceManifest = require("../../package.json") as {
    dependencies?: Record<string, string>;
};
const defaultHandlerPackages = Object.keys(serviceManifest.dependencies ?? {})
    .filter((name) => name.startsWith("@plurnk/plurnk-mimetypes-"))
    .flatMap((packageName) => {
        const manifest = require(`${packageName}/package.json`) as {
            plurnk?: { handlers?: Array<{ name?: unknown }> };
        };
        return (manifest.plurnk?.handlers ?? [])
            .filter((handler): handler is { name: string } => typeof handler.name === "string")
            .map((handler) => ({ packageName, mimetype: handler.name }));
    });

interface Case {
    label: string;
    ext: string;
    sampleContent: string;
    expectedMimetype: string;
}

const CASES: Case[] = [
    {
        label: "text/markdown",
        ext: ".md",
        sampleContent: "# Title\n\nA paragraph.\n\n## Section\n",
        expectedMimetype: "text/markdown",
    },
    {
        label: "text/html",
        ext: ".html",
        sampleContent: "<!DOCTYPE html><html><head><title>Page</title></head><body><h1>Heading</h1></body></html>",
        expectedMimetype: "text/html",
    },
    {
        label: "text/csv",
        ext: ".csv",
        sampleContent: "name,age\nAlice,30\nBob,25\n",
        expectedMimetype: "text/csv",
    },
    {
        label: "application/json",
        ext: ".json",
        sampleContent: "{\"name\":\"Alice\",\"age\":30}",
        expectedMimetype: "application/json",
    },
    {
        label: "application/jsonl",
        ext: ".jsonl",
        sampleContent: "{\"name\":\"Alice\"}\n{\"name\":\"Bob\"}\n",
        expectedMimetype: "application/jsonl",
    },
    {
        label: "application/x-ipynb+json",
        ext: ".ipynb",
        sampleContent: "{\"cells\":[],\"metadata\":{},\"nbformat\":4,\"nbformat_minor\":5}",
        expectedMimetype: "application/x-ipynb+json",
    },
    {
        label: "application/xml",
        ext: ".xml",
        sampleContent: "<root><item>value</item></root>",
        expectedMimetype: "application/xml",
    },
    {
        label: "text/x-diff",
        ext: ".diff",
        sampleContent: "--- a/file.txt\n+++ b/file.txt\n@@ -1 +1 @@\n-old\n+new\n",
        expectedMimetype: "text/x-diff",
    },
    {
        label: "text/x-dotenv",
        ext: ".env",
        sampleContent: "PLURNK_EXAMPLE=settled\n",
        expectedMimetype: "text/x-dotenv",
    },
    {
        label: "text/x-ini",
        ext: ".ini",
        sampleContent: "[section]\nkey=value\n",
        expectedMimetype: "text/x-ini",
    },
    {
        label: "text/plain",
        ext: ".txt",
        sampleContent: "Just some text content here.",
        expectedMimetype: "text/plain",
    },
];

// One Mimetypes instance per file — auto-discovery scans node_modules
// once and the registered handlers are reused across tests. ready() is
// idempotent and cheap on the cached path.
const mimetypes = new Mimetypes();

test("discovery: Mimetypes initializes without throwing", async () => {
    await mimetypes.ready();
});

test("discovery: every service-owned format-handler declaration is registered", async () => {
    const found = await discover({ includeTreeSitter: false });
    for (const { packageName, mimetype } of defaultHandlerPackages) {
        assert.equal(
            found.handlers.get(mimetype)?.packageName,
            packageName,
            `${mimetype} should resolve to the service-owned ${packageName} leaf`,
        );
    }
});

test("the default service installs its embedding owner and omits unrelated artifact catalogs", () => {
    assert.equal(serviceManifest.dependencies?.["@plurnk/plurnk-mimetypes-application-pdf"], undefined);
    assert.equal(serviceManifest.dependencies?.["@plurnk/plurnk-mimetypes-embeddings"], "1.11.0");
    assert.equal(serviceManifest.dependencies?.["@plurnk/plurnk-mimetypes-tokenizers"], undefined);
});

for (const c of CASES) {
    test(`${c.label}: extension '${c.ext}' routes to '${c.expectedMimetype}'`, async () => {
        await mimetypes.ready();
        const detected = await mimetypes.detect({ ext: c.ext });
        assert.equal(detected, c.expectedMimetype,
            `extension '${c.ext}' should resolve to '${c.expectedMimetype}', got '${detected}'`);
    });

    test(`${c.label}: process produces the structural surface for sample content`, async () => {
        await mimetypes.ready();
        const result = await mimetypes.process({ content: c.sampleContent, ext: c.ext }, { channels: ["symbols"] });
        assert.equal(result.mimetype, c.expectedMimetype);
        assert.ok(result.ok, `process should succeed for ${c.label}`);
        assert.ok(result.totalLines > 0, `${c.label} should report a content extent`);
    });
}
