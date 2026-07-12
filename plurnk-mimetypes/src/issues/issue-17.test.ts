// Coverage: SPEC §5 (channel selection).
// Issue #17: 0.15 P1 — channel-selective process() + preview-ectomy
// (ProcessResult v2). https://github.com/plurnk/plurnk-mimetypes/issues/17
//
// Load-bearing claims, restated as testable contracts:
//
//   C1. process(input, { channels }) materializes exactly the requested
//       channels: default is all four; a subset yields exactly that subset;
//       [] yields metadata only and pays no extraction work.
//   C2. The symbols channel is structured MimeSymbol[] — there is no rendered
//       preview string and no previewTokens anywhere on ProcessResult.
//   C3. The references channel exists with the final field shape and returns
//       [] until the extraction engine lands (#19) — consumers can build
//       against the shape today.
//   C4. The budget/fitting layer is gone from the public API: no fitPreview,
//       fitSymbols, fitContent, or defaultTokenize exports. The outline
//       primitives (format, buildTree, renderTree) survive.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import Mimetypes from "../Mimetypes.ts";
import BaseHandler from "../BaseHandler.ts";
import * as api from "../index.ts";
import type { Discovery, HandlerInfo, MimeSymbol, Registry } from "../types.ts";

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

const INFO: HandlerInfo = {
    mimetype: "text/x-test",
    glyph: "🧪",
    packageName: "@plurnk/plurnk-mimetypes-text-test",
    extensions: [".tst"],
    binary: false,
    source: "package",
};

class StructuredHandler extends BaseHandler {
    static extractCalls = 0;
    static deepJsonCalls = 0;
    override extractRaw(): MimeSymbol[] {
        StructuredHandler.extractCalls += 1;
        return [{ name: "Thing", kind: "class", line: 2, endLine: 9 }];
    }
    override deepJson(): unknown {
        StructuredHandler.deepJsonCalls += 1;
        return { type: "root", line: 1, endLine: 9 };
    }
}

function makeMimetypes() {
    return new Mimetypes({
        discovery: makeDiscovery([INFO]),
        loader: async () => ({ default: StructuredHandler }),
    });
}

describe("Issue #17 — C1: channel selection semantics", () => {
    it("default materializes all four channels", async () => {
        const m = makeMimetypes();
        const r = await m.process({ path: "a.tst", content: "x\ny" });
        assert.ok(Array.isArray(r.symbols));
        assert.ok("deepJson" in r);
        assert.equal(typeof r.deepXml, "string");
        assert.ok(Array.isArray(r.references));
    });

    it("a subset materializes exactly that subset", async () => {
        const m = makeMimetypes();
        const r = await m.process(
            { path: "a.tst", content: "x" },
            { channels: ["symbols", "deepXml"] },
        );
        assert.ok(Array.isArray(r.symbols));
        assert.equal(typeof r.deepXml, "string");
        assert.equal("deepJson" in r, false);
        assert.equal("references" in r, false);
    });

    it("channels: [] is metadata-only and pays no extraction", async () => {
        StructuredHandler.extractCalls = 0;
        StructuredHandler.deepJsonCalls = 0;
        const m = makeMimetypes();
        const r = await m.process({ path: "a.tst", content: "a\nb\nc" }, { channels: [] });
        assert.deepEqual(r, {
            mimetype: "text/x-test",
            ok: true,
            totalLines: 3,
            extent: 3,
        });
        assert.equal(StructuredHandler.extractCalls, 0);
        assert.equal(StructuredHandler.deepJsonCalls, 0);
    });

    it("unrequested deepJson is still computed internally (not exposed) when deepXml needs it", async () => {
        StructuredHandler.deepJsonCalls = 0;
        const m = makeMimetypes();
        const r = await m.process({ path: "a.tst", content: "x" }, { channels: ["deepXml"] });
        assert.ok(r.deepXml!.startsWith("<root"));
        assert.equal("deepJson" in r, false);
        assert.equal(StructuredHandler.deepJsonCalls, 1);
    });
});

describe("Issue #17 — C2: symbols are structured, preview is gone", () => {
    it("symbols carry MimeSymbol[] verbatim from extractRaw", async () => {
        const m = makeMimetypes();
        const r = await m.process({ path: "a.tst", content: "x" }, { channels: ["symbols"] });
        assert.deepEqual(r.symbols, [{ name: "Thing", kind: "class", line: 2, endLine: 9 }]);
    });

    it("no preview or previewTokens fields exist on any result shape", async () => {
        const m = makeMimetypes();
        const ok = await m.process({ path: "a.tst", content: "x" });
        const err = await m.process({ path: "nope.unknown", content: "x" });
        for (const r of [ok, err]) {
            assert.equal("preview" in r, false);
            assert.equal("previewTokens" in r, false);
        }
    });
});

describe("Issue #17 — C3: references field shape ships ahead of the engine", () => {
    it("references is [] for a handler without an implementation", async () => {
        const m = makeMimetypes();
        const r = await m.process({ path: "a.tst", content: "x" }, { channels: ["references"] });
        assert.deepEqual(r.references, []);
    });

    it("a handler references() override flows through the channel", async () => {
        class WithRefs extends BaseHandler {
            override references() {
                return [{
                    name: "helper",
                    kind: "call" as const,
                    line: 3,
                    column: 5,
                    endLine: 3,
                    endColumn: 11,
                    container: "Thing.run",
                }];
            }
        }
        const m = new Mimetypes({
            discovery: makeDiscovery([INFO]),
            loader: async () => ({ default: WithRefs }),
        });
        const r = await m.process({ path: "a.tst", content: "x" }, { channels: ["references"] });
        assert.deepEqual(r.references, [{
            name: "helper",
            kind: "call",
            line: 3,
            column: 5,
            endLine: 3,
            endColumn: 11,
            container: "Thing.run",
        }]);
    });
});

describe("Issue #17 — C4: the fitting layer is gone; outline primitives survive", () => {
    it("fitPreview / fitSymbols / fitContent / defaultTokenize are not exported", () => {
        const dead = ["fitPreview", "fitSymbols", "fitContent", "defaultTokenize"];
        for (const name of dead) {
            assert.equal(
                (api as Record<string, unknown>)[name],
                undefined,
                `${name} must not be exported`,
            );
        }
    });

    it("format / buildTree / renderTree remain exported", () => {
        assert.equal(typeof api.format, "function");
        assert.equal(typeof api.buildTree, "function");
        assert.equal(typeof api.renderTree, "function");
    });
});
