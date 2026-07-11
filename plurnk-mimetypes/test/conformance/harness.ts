// Coverage: SPEC §14 (testing discipline: conformance harness).
import assert from "node:assert/strict";
import TreeSitterLanguageHandler from "../../src/treesitter/handler.ts";
import { lookupTreeSitterLanguage } from "../../src/treesitter/registry.ts";
import { assertHandlerConformance } from "../../src/conformance.ts";
import type { ConformanceFixture, ConformanceResult } from "../../src/conformance.ts";

// Cross-language conformance harness for the defs + refs channels
// (issue #20; invariants from SPEC §16). Each language's conformance test
// supplies a fixture and its expectations; the SHARED invariants live in the
// public src/conformance.ts harness (the same one third-party handler authors
// run via @plurnk/plurnk-mimetypes/conformance — one implementation, issue
// #32). This wrapper only adds the registry lookup that builds the in-registry
// handler from a mimetype. A language participates in the service's graph only
// when its suite is green.

export type RegistryConformanceFixture = ConformanceFixture & { mimetype: string };

export async function runConformance(fixture: RegistryConformanceFixture): Promise<ConformanceResult> {
    const entry = lookupTreeSitterLanguage(fixture.mimetype);
    assert.ok(entry, `no registry entry for ${fixture.mimetype}`);
    const handler = new TreeSitterLanguageHandler(
        { mimetype: entry.mimetype, glyph: entry.glyph, extensions: entry.extensions },
        entry,
    );
    return assertHandlerConformance(handler, fixture);
}
