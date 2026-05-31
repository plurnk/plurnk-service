// Smoke coverage for every @plurnk/plurnk-mimetypes-* handler we ship
// as a hard dependency. Asserts auto-discovery actually loaded each
// handler, extension routing produces the expected mimetype, and a
// sensible preview comes back. Without this, we'd ship a dep whose
// integration is unverified at our level — handlers have their own
// suites for behavioral coverage, but nothing here proves they're
// wired into plurnk-service's runtime path.
//
// Per-handler behavioral tests live in each sibling's repo. This file
// is the plurnk-service-side integration check: "the handler exists,
// the framework finds it, our path through it works."

import test from "node:test";
import assert from "node:assert/strict";
import { Mimetypes } from "@plurnk/plurnk-mimetypes";

interface Case {
    label: string;
    ext: string;
    sampleContent: string;
    expectedMimetype: string;
    // Substring the preview should contain. Most handlers return a
    // structural symbol outline; we look for a recognizable token from
    // the input that should land in any reasonable preview.
    previewIncludes: string;
}

const CASES: Case[] = [
    {
        label: "text/python",
        ext: ".py",
        sampleContent: "def greet(name):\n    return f\"hello {name}\"\n\nclass Greeter:\n    pass\n",
        expectedMimetype: "text/python",
        previewIncludes: "greet",
    },
    {
        label: "text/typescript",
        ext: ".ts",
        sampleContent: "export function greet(name: string): string {\n    return `hello ${name}`;\n}\n",
        expectedMimetype: "text/typescript",
        previewIncludes: "greet",
    },
    {
        label: "text/markdown",
        ext: ".md",
        sampleContent: "# Title\n\nA paragraph.\n\n## Section\n",
        expectedMimetype: "text/markdown",
        previewIncludes: "Title",
    },
    {
        label: "text/html",
        ext: ".html",
        sampleContent: "<!DOCTYPE html><html><head><title>Page</title></head><body><h1>Heading</h1></body></html>",
        expectedMimetype: "text/html",
        // html handler emits structural outline; `<h1>Heading</h1>` is
        // the canonical extractable element. Title isn't always surfaced.
        previewIncludes: "Heading",
    },
    {
        label: "text/csv",
        ext: ".csv",
        sampleContent: "name,age\nAlice,30\nBob,25\n",
        expectedMimetype: "text/csv",
        previewIncludes: "name",
    },
    {
        label: "application/json",
        ext: ".json",
        sampleContent: "{\"name\":\"Alice\",\"age\":30}",
        expectedMimetype: "application/json",
        previewIncludes: "name",
    },
    {
        label: "application/yaml",
        ext: ".yaml",
        sampleContent: "name: Alice\nage: 30\n",
        expectedMimetype: "application/yaml",
        previewIncludes: "name",
    },
    {
        label: "application/toml",
        ext: ".toml",
        sampleContent: "[user]\nname = \"Alice\"\nage = 30\n",
        expectedMimetype: "application/toml",
        previewIncludes: "user",
    },
    {
        label: "text/plain",
        ext: ".txt",
        sampleContent: "Just some text content here.",
        expectedMimetype: "text/plain",
        previewIncludes: "Just",
    },
];

// One Mimetypes instance per file — auto-discovery scans node_modules
// once and the registered handlers are reused across tests. ready() is
// idempotent and cheap on the cached path.
const mimetypes = new Mimetypes({ tokenize: async (text) => Math.ceil(text.length / 4) });

test("discovery: Mimetypes initializes without throwing", async () => {
    await mimetypes.ready();
});

for (const c of CASES) {
    test(`${c.label}: extension '${c.ext}' routes to '${c.expectedMimetype}'`, async () => {
        await mimetypes.ready();
        const detected = await mimetypes.detect({ ext: c.ext });
        assert.equal(detected, c.expectedMimetype,
            `extension '${c.ext}' should resolve to '${c.expectedMimetype}', got '${detected}'`);
    });

    test(`${c.label}: handler returns a non-empty preview for sample content`, async () => {
        await mimetypes.ready();
        const result = await mimetypes.process(
            { content: c.sampleContent, ext: c.ext },
            { budget: 2000 },
        );
        assert.equal(result.mimetype, c.expectedMimetype);
        assert.ok(result.ok, `process should succeed for ${c.label}`);
        assert.ok(result.preview.length > 0, `preview should be non-empty for ${c.label}`);
        assert.ok(result.preview.includes(c.previewIncludes),
            `${c.label} preview should include '${c.previewIncludes}'; got: ${result.preview.slice(0, 200)}`);
    });
}

// PDF is application/pdf; sample binary too complex to ship inline, so
// this just checks discovery without preview content.
test("application/pdf: handler is registered by extension routing", async () => {
    await mimetypes.ready();
    const detected = await mimetypes.detect({ ext: ".pdf" });
    assert.equal(detected, "application/pdf");
});
