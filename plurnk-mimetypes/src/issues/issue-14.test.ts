// Issue #14: Framework should own its runtime dependency surface (grammars +
// loaders), not offload it onto consumers.
// https://github.com/plurnk/plurnk-mimetypes/issues/14
//
// Load-bearing claims, restated as testable contracts:
//
//   C1. A missing grammar is the EXPECTED normal state in the a-la-carte
//       world, not an error. process() degrades to a text-plain fallback
//       and surfaces the missing package as a data field (grammarMissing).
//       Default ok=true; nothing is wrong.
//   C2. The grammarMissing field carries the package name the consumer
//       should install. No string parsing, no exception catching.
//   C3. Consumers that NEED a specific grammar can opt into strict mode
//       (process(input, { strict: true })) which throws
//       GrammarNotInstalledError on missing-grammar paths.
//   C4. The text-plain floor handler is always available — it's a direct
//       dep of the framework. process() can always degrade to it; the
//       framework doesn't need consumers to install it separately.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import Mimetypes from "../Mimetypes.ts";
import BaseHandler from "../BaseHandler.ts";
import type { Discovery, HandlerInfo, MimeSymbol, Preview, Registry } from "../types.ts";

// A handler that simulates "grammar package not installed" — throws the
// signal-bearing error from extractRaw/deepJson/preview just like
// TreeSitterExtractor does when its WASM can't be resolved.
class FakeMissingGrammarHandler extends BaseHandler {
    override extractRaw(): MimeSymbol[] {
        const err = new Error("Grammar not installed for testing");
        err.name = "GrammarNotInstalledError";
        (err as Error & { plurnkPackage?: string }).plurnkPackage = "@plurnk/plurnk-mimetypes-grammar-fake";
        throw err;
    }
    override deepJson(): unknown {
        const err = new Error("Grammar not installed for testing");
        err.name = "GrammarNotInstalledError";
        (err as Error & { plurnkPackage?: string }).plurnkPackage = "@plurnk/plurnk-mimetypes-grammar-fake";
        throw err;
    }
    override preview(): Preview {
        const err = new Error("Grammar not installed for testing");
        err.name = "GrammarNotInstalledError";
        (err as Error & { plurnkPackage?: string }).plurnkPackage = "@plurnk/plurnk-mimetypes-grammar-fake";
        throw err;
    }
}

// A canned text/plain handler so the floor exists in the injected discovery
// for these tests (production wires the real published text-plain package).
class FakePlainHandler extends BaseHandler {
    override extractRaw(): MimeSymbol[] { return []; }
    override preview(content: string | Uint8Array): Preview {
        const text = typeof content === "string" ? content : new TextDecoder().decode(content);
        return { kind: "text", text, orientation: "head" };
    }
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
    // the handler throws GrammarNotInstalledError from extractRaw/deepJson/preview,
    // and process() catches and degrades.
    source: "package",
};

const PLAIN_INFO: HandlerInfo = {
    mimetype: "text/plain",
    glyph: "📄",
    packageName: "@plurnk/plurnk-mimetypes-text-plain",
    extensions: [".txt"],
    binary: false,
    source: "package",
};

function makeMimetypes() {
    return new Mimetypes({
        discovery: makeDiscovery([FAKE_INFO, PLAIN_INFO]),
        loader: async (packageName) => {
            if (packageName === FAKE_INFO.packageName) return { default: FakeMissingGrammarHandler };
            if (packageName === PLAIN_INFO.packageName) return { default: FakePlainHandler };
            throw new Error(`unknown loader request: ${packageName}`);
        },
    });
}

describe("Issue #14 — C1: missing grammar degrades to text-plain (not an error)", () => {
    it("process() returns ok:true with a text-plain preview when grammar is missing", async () => {
        const m = makeMimetypes();
        const result = await m.process({ path: "foo.fake", content: "line one\nline two\nline three" });
        assert.equal(result.mimetype, "text/x-fake", "detected mimetype is preserved on the result");
        assert.equal(result.ok, true, "degraded result is still ok");
        assert.ok(
            result.preview.includes("line one"),
            "degraded preview falls through to text-plain content",
        );
    });

    it("the degraded result has empty deep channels", async () => {
        const m = makeMimetypes();
        const result = await m.process({ path: "foo.fake", content: "anything" });
        assert.equal(result.deepJson, null, "deepJson is null when grammar is missing");
        assert.equal(result.deepXml, "", "deepXml is empty when grammar is missing");
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
        const m = makeMimetypes();
        const result = await m.process({ path: "foo.txt", content: "plain content" });
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

describe("Issue #14 — C4: text-plain floor always exists for degradation", () => {
    it("when no text-plain handler is in discovery, the degradation surfaces an honest error", async () => {
        // This is the broken-framework case (text-plain is supposed to be a
        // hard dep of the framework). If it ever isn't installed, process
        // surfaces ok:false rather than fabricating fake data.
        const m = new Mimetypes({
            discovery: makeDiscovery([FAKE_INFO]),  // no PLAIN_INFO
            loader: async () => ({ default: FakeMissingGrammarHandler }),
        });
        const result = await m.process({ path: "foo.fake", content: "x" });
        // grammarMissing still set so consumer can see what was missing.
        assert.equal(result.grammarMissing, "@plurnk/plurnk-mimetypes-grammar-fake");
        assert.equal(result.ok, false, "result is honest about being broken when floor is missing");
    });
});
