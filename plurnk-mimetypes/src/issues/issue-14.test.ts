// Issue #14: Framework should own its runtime dependency surface (grammars +
// loaders), not offload it onto consumers.
// https://github.com/plurnk/plurnk-mimetypes/issues/14
//
// Load-bearing claims, restated as testable contracts (re-grounded for the
// 0.15 channel architecture, issue #17 — the degrade contract survives the
// preview removal: a degraded result is honest metadata + empty channels):
//
//   C1. A missing grammar is the EXPECTED normal state in the a-la-carte
//       world, not an error. process() degrades — ok stays true, metadata
//       (totalLines/extent) is computed, requested channels come back empty.
//   C2. The grammarMissing field carries the package name the consumer
//       should install. No string parsing, no exception catching.
//   C3. Consumers that NEED a specific grammar can opt into strict mode
//       (process(input, { strict: true })) which throws
//       GrammarNotInstalledError on missing-grammar paths.
//
//   (The original C4 — "text-plain floor always exists for degradation" —
//   is moot since 0.15: the degraded result is built from metadata alone
//   and no longer routes through the text/plain handler.)

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import Mimetypes from "../Mimetypes.ts";
import BaseHandler from "../BaseHandler.ts";
import type { Discovery, HandlerInfo, MimeSymbol, Registry } from "../types.ts";

// A handler that simulates "grammar package not installed" — throws the
// signal-bearing error from extractRaw/deepJson just like TreeSitterExtractor
// does when its WASM can't be resolved.
class FakeMissingGrammarHandler extends BaseHandler {
    override extractRaw(): MimeSymbol[] {
        throw makeGrammarError();
    }
    override deepJson(): unknown {
        throw makeGrammarError();
    }
}

function makeGrammarError(): Error {
    const err = new Error("Grammar not installed for testing");
    err.name = "GrammarNotInstalledError";
    (err as Error & { plurnkPackage?: string }).plurnkPackage = "@plurnk/plurnk-mimetypes-grammar-fake";
    return err;
}

function makeDiscovery(handlers: HandlerInfo[]): Discovery {
    const byExtension = new Map<string, string>();
    const byFilename = new Map<string, string>();
    const handlerMap = new Map<string, HandlerInfo>();
    for (const info of handlers) {
        handlerMap.set(info.mimetype, info);
        for (const ext of info.extensions) {
            if (ext.startsWith(".")) byExtension.set(ext.toLowerCase(), info.mimetype);
            else byFilename.set(ext, info.mimetype);
        }
    }
    const registry: Registry = { byExtension, byFilename };
    return { registry, handlers: handlerMap };
}

const FAKE_INFO: HandlerInfo = {
    mimetype: "text/x-fake",
    glyph: "🧪",
    packageName: "@plurnk/plurnk-mimetypes-grammar-fake",
    extensions: [".fake"],
    binary: false,
    // 'package' so the test loader (FakeMissingGrammarHandler) is used.
    // In production this exact scenario is triggered by 'treesitter' entries
    // whose grammar package isn't installed — the failure path is identical:
    // the handler throws GrammarNotInstalledError from extractRaw/deepJson,
    // and process() catches and degrades.
    source: "package",
};

function makeMimetypes() {
    return new Mimetypes({
        discovery: makeDiscovery([FAKE_INFO]),
        loader: async () => ({ default: FakeMissingGrammarHandler }),
    });
}

describe("Issue #14 — C1: missing grammar degrades (not an error)", () => {
    it("process() returns ok:true when grammar is missing", async () => {
        const m = makeMimetypes();
        const result = await m.process({ path: "foo.fake", content: "line one\nline two\nline three" });
        assert.equal(result.mimetype, "text/x-fake", "detected mimetype is preserved on the result");
        assert.equal(result.ok, true, "degraded result is still ok");
    });

    it("the degraded result carries empty channels for what was requested", async () => {
        const m = makeMimetypes();
        const result = await m.process({ path: "foo.fake", content: "anything" });
        assert.deepEqual(result.symbols, [], "symbols are empty when grammar is missing");
        assert.equal(result.deepJson, null, "deepJson is null when grammar is missing");
        assert.equal(result.deepXml, "", "deepXml is empty when grammar is missing");
        assert.deepEqual(result.references, [], "references are empty when grammar is missing");
    });

    it("unrequested channels stay absent on the degraded path", async () => {
        const m = makeMimetypes();
        const result = await m.process(
            { path: "foo.fake", content: "anything" },
            { channels: ["symbols"] },
        );
        assert.deepEqual(result.symbols, []);
        assert.equal("deepJson" in result, false);
        assert.equal("deepXml" in result, false);
        assert.equal("references" in result, false);
    });

    it("totalLines and extent are still computed on the degraded path", async () => {
        const m = makeMimetypes();
        const result = await m.process({ path: "foo.fake", content: "a\nb\nc\nd" });
        assert.equal(result.totalLines, 4);
        assert.equal(result.extent, 4);
    });
});

describe("Issue #14 — C2: grammarMissing surfaces the install hint as data", () => {
    it("grammarMissing is set to the package name on the degraded result", async () => {
        const m = makeMimetypes();
        const result = await m.process({ path: "foo.fake", content: "x" });
        assert.equal(result.grammarMissing, "@plurnk/plurnk-mimetypes-grammar-fake");
    });

    it("grammarMissing is absent on the happy path", async () => {
        class WorkingHandler extends BaseHandler {}
        const m = new Mimetypes({
            discovery: makeDiscovery([FAKE_INFO]),
            loader: async () => ({ default: WorkingHandler }),
        });
        const result = await m.process({ path: "foo.fake", content: "plain content" });
        assert.equal(result.grammarMissing, undefined);
    });
});

describe("Issue #14 — C3: strict mode throws instead of degrading", () => {
    it("process(input, { strict: true }) throws GrammarNotInstalledError on missing-grammar paths", async () => {
        const m = makeMimetypes();
        await assert.rejects(
            () => m.process(
                { path: "foo.fake", content: "x" },
                { strict: true },
            ),
            (err: unknown) => (err as Error).name === "GrammarNotInstalledError",
        );
    });

    it("non-strict (default) does NOT throw for the same input", async () => {
        const m = makeMimetypes();
        await assert.doesNotReject(
            m.process({ path: "foo.fake", content: "x" }),
        );
    });
});
