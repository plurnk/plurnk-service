// Contract: {§mimetype-error-policy}. Issue #14 is provenance.

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
    return { registry, handlers: handlerMap, skipped: [] };
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

    it("totalLines is still computed on the degraded path", async () => {
        const m = makeMimetypes();
        const result = await m.process({ path: "foo.fake", content: "a\nb\nc\nd" });
        assert.equal(result.totalLines, 4);
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

    it("the Notice preserves the detected mimetype instead of claiming substitution", async () => {
        const result = await makeMimetypes().process({ path: "foo.fake", content: "x" });
        const notice = result.notices?.find(({ kind }) => kind === "grammar_degraded");
        assert.ok(notice);
        assert.equal(notice.mimetype, "text/x-fake");
        assert.match(String(notice.message), /structural channels/i);
        assert.doesNotMatch(String(notice.message), /text[- ]plain/i);
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
